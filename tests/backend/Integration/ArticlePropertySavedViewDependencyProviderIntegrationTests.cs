using System.Security.Claims;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Authoring;

using SqlSugar;

using ProviderTests = FsusBlog.Server.Tests.ArticlePropertySavedViewDependencyProviderTests;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePropertySavedViewDependencyProviderIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly ArticlePropertyDefinitionActor s_actor = new(
        42, [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig]);

    [Fact]
    public async Task Authorized_User_And_Site_Reads_All_Types_And_Flags_Without_Query_Authority()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        var provider = new ArticlePropertySavedViewDependencyProvider(store, ProviderTests.Request(), ProviderTests.Configuration());
        var catalog = new AuthorSavedViewDependencyCatalog([provider]);
        foreach (ArticlePropertyDefinitionOwner owner in new[]
        {
            ArticlePropertyDefinitionOwner.User(42, ProviderTests.SiteScope),
            ArticlePropertyDefinitionOwner.Site(ProviderTests.SiteScope)
        })
        {
            long ownerRevision = 0;
            foreach (ArticlePropertyValueType type in Enum.GetValues<ArticlePropertyValueType>())
                foreach (ArticlePropertyCardinality cardinality in Enum.GetValues<ArticlePropertyCardinality>())
                {
                    bool valid = type == ArticlePropertyValueType.ArticleReference
                        || cardinality == (type == ArticlePropertyValueType.MultiSelect
                            ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single);
                    if (!valid)
                    {
                        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => store.CreateAsync(
                            CreateCommand(ProviderTests.Definition(type, cardinality) with
                            {
                                Owner = owner
                            }, ownerRevision)));
                        continue;
                    }
                    for (int flags = 0; flags < 8; flags++)
                    {
                        ArticlePropertyDefinition template = ProviderTests.Definition(type, cardinality, flags) with
                        {
                            Owner = owner
                        };
                        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(template, ownerRevision));
                        ownerRevision = created.OwnerRevision;
                        ArticlePropertyDefinition actual = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
                        var field = ProviderTests.Field(actual.DefinitionId);
                        AuthorSavedViewDependencyResolution projection = await catalog.ResolveProjectionAsync(ProviderTests.Owner, field);
                        Assert.Equal(AuthorSavedViewDependencyStatus.Current, projection.Status);
                        Assert.Equal($"property:{actual.SchemaRevision}:{actual.ContentDigest}", projection.AuthorityRevision);
                        Assert.Empty(projection.CanonicalValues);
                        var condition = await catalog.ResolveConditionAsync(ProviderTests.Owner, new(field, "property.equals", ["stable-value"]));
                        Assert.Equal(actual.Filterable ? AuthorSavedViewDependencyStatus.MigrationRequired
                            : AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible, condition.Status);
                        var sort = await catalog.ResolveSortAsync(ProviderTests.Owner, ProviderTests.Sort(field));
                        Assert.Equal(actual.Sortable ? AuthorSavedViewDependencyStatus.MigrationRequired
                            : AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible, sort.Status);
                    }
                }
            Assert.Equal(72, ownerRevision);
        }
    }

    [Fact]
    public async Task Schema_Option_Metadata_Retirement_And_Filtered_Delete_Bind_Actual_Store_Facts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        var definition = ProviderTests.Definition(ArticlePropertyValueType.SingleSelect);
        var owner = definition.Owner;
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(definition, 0));
        var provider = new ArticlePropertySavedViewDependencyProvider(store, ProviderTests.Request(), ProviderTests.Configuration());
        var field = ProviderTests.Field(created.DefinitionId);
        var before = (await provider.ResolveProjectionAsync(ProviderTests.Owner, field))!;
        var renamed = await store.RenameAsync(new(s_actor, owner, created.DefinitionId, Guid.NewGuid(), 1, 1,
            [new("en", "Renamed display label")]));
        ArticlePropertyDefinition actual = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        var changed = await store.UpdateAsync(new(s_actor, owner, actual.DefinitionId, Guid.NewGuid(),
            renamed.OwnerRevision, renamed.SchemaRevision, actual.ValueType, actual.Cardinality,
            actual.Required, actual.Presence, actual.DefaultValue, actual.Constraints,
            [actual.Options[0] with { Label = "Renamed option", Status = ArticlePropertyOptionStatus.Deprecated }],
            actual.ReferencePolicy, actual.UrlPolicy, actual.SearchEligible, actual.Filterable, actual.Sortable,
            actual.DisplayPlacement, actual.VisibilityScope));
        var after = (await provider.ResolveProjectionAsync(ProviderTests.Owner, field))!;
        Assert.Equal(AuthorSavedViewDependencyStatus.Current, after.Status);
        Assert.NotEqual(before.AuthorityRevision, after.AuthorityRevision);
        Assert.Contains(changed.AfterDefinitionDigest, after.AuthorityRevision);
        actual = (await store.GetAsync(s_actor, owner, created.DefinitionId))!;
        Assert.Equal(definition.Options[0].OptionId, actual.Options[0].OptionId);
        Assert.Equal(ArticlePropertyOptionStatus.Deprecated, actual.Options[0].Status);
        var retired = await store.DeprecateAsync(new(s_actor, owner, actual.DefinitionId, Guid.NewGuid(),
            changed.OwnerRevision, changed.SchemaRevision));
        Assert.Equal(AuthorSavedViewDependencyStatus.Retired,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner, field))!.Status);
        // Seed an existing deleted read fixture, not a successful delete command:
        // the original unavailable impact authority must keep DeleteAsync closed.
        actual = (await store.GetAsync(s_actor, owner, actual.DefinitionId))!;
        ArticlePropertyDefinition deleted = actual with
        {
            Status = ArticlePropertyDefinitionStatus.Deleted,
            SchemaRevision = retired.SchemaRevision + 1
        };
        deleted = deleted with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(deleted)
        };
        ArticlePropertyDefinitionContract.ValidateDefinition(deleted);
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync(
            "UPDATE article_property_definition SET status = @Status, schema_revision = @Revision, content_digest = @Digest "
                + "WHERE definition_id = @Id AND owner_user_id = @Owner AND site_scope = @Site "
                + "AND schema_revision = @BeforeRevision AND content_digest = @BeforeDigest;",
            new SugarParameter("@Status", (short)deleted.Status), new SugarParameter("@Revision", deleted.SchemaRevision),
            new SugarParameter("@Digest", deleted.ContentDigest), new SugarParameter("@Id", deleted.DefinitionId),
            new SugarParameter("@Owner", owner.UserId ?? 0), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@BeforeRevision", actual.SchemaRevision), new SugarParameter("@BeforeDigest", actual.ContentDigest)));
        Assert.Null(await store.GetAsync(s_actor, owner, actual.DefinitionId));
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner, field))!.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner, ProviderTests.Field(Guid.NewGuid())))!.Status);
    }

    [Fact]
    public async Task Original_Permission_Path_And_Request_Binding_Exclude_Other_Owners()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinition definition = ProviderTests.Definition();
        await store.CreateAsync(CreateCommand(definition, 0));
        var otherActor = new ArticlePropertyDefinitionActor(43, [AdminPermissions.ArticleWrite]);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => store.GetAsync(otherActor, definition.Owner, definition.DefinitionId));
        var otherDefinition = ProviderTests.Definition() with
        {
            Owner = ArticlePropertyDefinitionOwner.User(43, ProviderTests.SiteScope)
        };
        await store.CreateAsync(CreateCommand(otherDefinition, 0) with
        {
            Actor = otherActor
        });
        var request = ProviderTests.Request();
        var provider = new ArticlePropertySavedViewDependencyProvider(store, request, ProviderTests.Configuration());
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner, ProviderTests.Field(otherDefinition.DefinitionId)))!.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner with
            {
                AdminPrincipalId = 43
            }, ProviderTests.Field(otherDefinition.DefinitionId)))!.Status);
        var identity = (ClaimsIdentity)request.HttpContext!.User.Identity!;
        identity.RemoveClaim(identity.FindFirst(AdminPermissions.PermissionClaimType)!);
        Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked,
            (await provider.ResolveProjectionAsync(ProviderTests.Owner, ProviderTests.Field(definition.DefinitionId)))!.Status);
    }

    [Fact]
    public async Task Original_Catalog_Validator_Duplicate_Control_And_Repeat_Cancel()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinition definition = ProviderTests.Definition();
        await store.CreateAsync(CreateCommand(definition, 0));
        var provider = new ArticlePropertySavedViewDependencyProvider(store, ProviderTests.Request(), ProviderTests.Configuration());
        var field = ProviderTests.Field(definition.DefinitionId);
        var catalog = new AuthorSavedViewDependencyCatalog([provider]);
        var query = new AuthorSavedViewQuery(1, [new(field, "property.any-of", ["stable-b", "stable-a"])],
            ProviderTests.Sort(field), [field], 20);
        var validator = new AuthorSavedViewQueryValidator(catalog);
        var result = await validator.ValidateAsync(ProviderTests.Owner, query);
        Assert.False(result.IsValid);
        Assert.Equal(2, result.Resolutions.Count(static resolution => resolution.Status == AuthorSavedViewDependencyStatus.MigrationRequired));
        Assert.Equal(AuthorSavedViewDependencyStatus.Current, result.Resolutions.Last().Status);
        Assert.Equal(new[] { "stable-a", "stable-b" }, result.Query.Conditions[0].Values);
        Assert.Equal(result.DependencyDigest, (await validator.ValidateAsync(ProviderTests.Owner, query)).DependencyDigest);
        var duplicate = new AuthorSavedViewDependencyCatalog([provider, provider]);
        Assert.Equal(AuthorSavedViewDependencyStatus.DuplicateAuthority,
            (await duplicate.ResolveProjectionAsync(ProviderTests.Owner, field)).Status);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.ResolveProjectionAsync(ProviderTests.Owner, field, cancellation.Token).AsTask());
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AuditLog));
        foreach (ISchemaMigrationDescriptor migration in new[]
        {
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration()
        })
            foreach (SchemaMigrationStep step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        return db;
    }

    private static ArticlePropertyDefinitionStore CreateStore(SqlSugarClient db)
        => ProviderTests.Store(new PostgresArticlePropertyDefinitionPersistence(db, ProviderTests.Configuration()));

    private static CreateArticlePropertyDefinitionCommand CreateCommand(ArticlePropertyDefinition definition, long ownerRevision)
        => new(s_actor, definition.Owner, definition.DefinitionId, Guid.NewGuid(), ownerRevision,
            $"field-{definition.DefinitionId:N}", definition.DisplayNames, definition.ValueType, definition.Cardinality,
            definition.Required, definition.Presence, definition.DefaultValue, definition.Constraints, definition.Options,
            definition.ReferencePolicy, definition.UrlPolicy, definition.SearchEligible, definition.Filterable,
            definition.Sortable, definition.DisplayPlacement, definition.VisibilityScope);
}

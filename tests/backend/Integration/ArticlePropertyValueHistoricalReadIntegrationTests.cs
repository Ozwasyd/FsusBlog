using System.Globalization;
using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

// Uses the original PostgreSQL fixture and real article/definition/value authorities.
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePropertyValueHistoricalReadIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string AuditKey = "isolated-property-historical-read-HMAC-key-20261018";
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.Site("primary-site");
    private static readonly string[] s_countTables =
    [
        "article_revision", "article_revision_content_block", "article_rights_snapshot", "article_responsibility_snapshot",
        "article_publication", "article_mutation_outbox", "sys_audit_log", "article_property_value_factset",
        "article_property_value_entry", "article_property_value_option", "article_property_value_reference",
        "article_property_value_snapshot", "article_property_value_head", "article_property_value_receipt"
    ];

    [Fact]
    public async Task ExactRevision_ReturnsHistoricalFactsAndNeverHydratesUnselectedCurrentFacts()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "historical secret");
        ArticlePropertyValueReadModel current = await SaveAsync(data, definition, "current secret");
        Assert.NotEqual(historical.Current!.FactsetId, current.Current!.FactsetId);
        await data.Db.Ado.ExecuteCommandAsync(
            "UPDATE article_property_value_entry SET text_value = 'corrupt current secret' WHERE factset_id = @Id;",
            new SugarParameter("@Id", current.Current.FactsetId));
        WriteState before = await StateAsync(data);
        ArticlePropertyValueReadModel read = await HistoricalAsync(data, historical);
        Assert.Equal(historical.Current.SnapshotId, read.Current!.SnapshotId);
        Assert.Equal(historical.Current.Snapshot.ContentDigest, read.Current.Snapshot.ContentDigest);
        Assert.Equal(historical.ArticleRevisionId, read.ArticleRevisionId);
        Assert.Equal(historical.PropertyRevision, read.PropertyRevision);
        Assert.Equal("historical secret", Text(read, definition));
        Assert.DoesNotContain(read.Current.Snapshot.Values, entry => entry.Value is ArticlePropertyTextValue text
            && text.Text.Contains("current secret", StringComparison.Ordinal));
        await AssertUnchangedAsync(data, before);
    }

    [Fact]
    public async Task OldPublication_RequiresExactRevisionAndPublicationAfterRepublish()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel first = await SaveAsync(data, definition, "old publication");
        Assert.True(await data.Service.UpdateAsync(data.ArticleId,
            Write(data, "first published body", ArticleStatus.Published, first.ArticleRevisionId)));
        ArticlePropertyValueReadModel published = await ReadAsync(data);
        long publication = published.Current!.Snapshot.Coordinates.PublicationId!.Value;
        Assert.True(await data.Service.UpdateAsync(data.ArticleId,
            Write(data, "new draft body", ArticleStatus.Draft, published.ArticleRevisionId)));
        ArticlePropertyValueReadModel second = await SaveAsync(data, definition, "new publication");
        Assert.True(await data.Service.UpdateAsync(data.ArticleId,
            Write(data, "second published body", ArticleStatus.Published, second.ArticleRevisionId)));
        ArticlePropertyValueReadModel current = await ReadAsync(data);
        Assert.NotEqual(publication, current.Current!.Snapshot.Coordinates.PublicationId);
        ArticlePropertyValueReadModel read = await HistoricalAsync(data, published);
        Assert.Equal(published.Current.SnapshotId, read.Current!.SnapshotId);
        Assert.Equal(publication, read.Current.Snapshot.Coordinates.PublicationId);
        Assert.Equal("old publication", Text(read, definition));
        await UnavailableAsync(data, published.ArticleRevisionId, null);
        await UnavailableAsync(data, current.ArticleRevisionId, publication);
        await UnavailableAsync(data, published.ArticleRevisionId, current.Current.Snapshot.Coordinates.PublicationId);
    }

    [Fact]
    public async Task NonRootCurrentArticleOwner_WithLiveArticleWritePermissionCanReadHistory()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "owned history");
        _ = await SaveAsync(data, definition, "new value");
        await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = false, permissions = @Permission;",
            new SugarParameter("@Permission", AdminPermissions.ArticleWrite));
        ArticlePropertyValueReadModel read = await HistoricalAsync(data, historical);
        Assert.Equal(historical.Current!.SnapshotId, read.Current!.SnapshotId);
        Assert.Equal("owned history", Text(read, definition));
    }

    [Fact]
    public async Task MissingHistoricalCoordinate_NeverFallsBackToCurrentOrAnEmptySnapshot()
    {
        using Seed data = await SeedAsync();
        long beforeValues = await RevisionAsync(data.Db, data.ArticleId);
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel current = await SaveAsync(data, definition, "present");
        await UnavailableAsync(data, beforeValues, null);
        await UnavailableAsync(data, long.MaxValue, null);
        await UnavailableAsync(data, current.ArticleRevisionId, long.MaxValue);
        Assert.Equal(current.Current!.SnapshotId, (await ReadAsync(data)).Current!.SnapshotId);
    }

    [Fact]
    public async Task WrongOwnerSiteArticleAndActor_RefuseBeforeReturningHistoricalValues()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "private");
        await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() => data.Service.ReadHistoricalPropertyValuesAsync(
            data.AdminId, new(data.AdminId, s_owner.SiteScope), data.ArticleId, historical.ArticleRevisionId, null));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => data.Service.ReadHistoricalPropertyValuesAsync(
            data.AdminId, new(data.AdminId + 1, s_owner.SiteScope), data.ArticleId, historical.ArticleRevisionId, null));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => data.Service.ReadHistoricalPropertyValuesAsync(
            data.AdminId + 1, s_owner, data.ArticleId, historical.ArticleRevisionId, null));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => data.Service.ReadHistoricalPropertyValuesAsync(
            data.AdminId, ArticlePropertyDefinitionOwner.Site("formalScope"), data.ArticleId, historical.ArticleRevisionId, null));
        int otherArticle = await data.Service.CreateAsync(new ArticleWriteRequestCoreModel("other source", "other body", "summary",
            null, data.CategoryId, [], (int)ArticleStatus.Draft));
        await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(() => data.Service.ReadHistoricalPropertyValuesAsync(
            data.AdminId, s_owner, otherArticle, historical.ArticleRevisionId, null));
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("empty-permissions")]
    [InlineData("article-access")]
    [InlineData("inactive")]
    [InlineData("archived")]
    [InlineData("deleted")]
    [InlineData("session")]
    public async Task CurrentAuthorizationDrift_RefusesBeforeSnapshotLookup(string drift)
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "private");
        switch (drift)
        {
            case "permission":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = false, permissions = @Permission;",
                    new SugarParameter("@Permission", AdminPermissions.SystemConfig));
                break;
            case "empty-permissions":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = false, permissions = ''; ");
                break;
            case "article-access":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = false, permissions = @Permission;",
                    new SugarParameter("@Permission", AdminPermissions.ArticleWrite));
                await data.Db.Ado.ExecuteCommandAsync("UPDATE article_revision SET created_by_admin_principal_id = @Other;",
                    new SugarParameter("@Other", data.AdminId + 1000));
                break;
            case "inactive":
                await data.Db.Ado.ExecuteCommandAsync("DELETE FROM admin_principal;");
                break;
            case "archived":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE article SET status = @Status;",
                    new SugarParameter("@Status", (int)ArticleStatus.Archived));
                break;
            case "deleted":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE article SET isdeleted = true;");
                break;
            case "session":
                data.Context.HttpContext!.User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim("admin_id", data.AdminId.ToString(CultureInfo.InvariantCulture)),
                     new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "fixture"));
                break;
        }
        var queries = new List<string>();
        data.Db.Aop.OnLogExecuting = (sql, _) => queries.Add(sql);
        Exception? error = await Record.ExceptionAsync(() => HistoricalAsync(data, historical));
        // The frozen transport predecessor normalizes an empty SQL permission list to access denial.
        Assert.True(error is ArticlePropertyDefinitionAccessDeniedException or AuthoringCanvasAccessDeniedException);
        Assert.DoesNotContain(queries, sql => sql.Contains("article_property_value_snapshot", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("mac", "article_property_value_authenticated_audit_invalid")]
    [InlineData("chain", "article_property_value_authenticated_audit_invalid")]
    [InlineData("facts", "article_property_value_digest_invalid")]
    [InlineData("coordinate", "article_property_value_actual_coordinates_invalid")]
    [InlineData("draft", "article_property_value_snapshot_schema_or_draft_unavailable")]
    public async Task SelectedSnapshot_UsesOriginalFactCoordinateAndMacVerification(string tamper, string code)
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "authenticated");
        _ = await SaveAsync(data, definition, "current");
        switch (tamper)
        {
            case "mac":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE sys_audit_log SET record_mac = @Mac WHERE target_id = @Id;",
                    new SugarParameter("@Mac", new string('0', 64)),
                    new SugarParameter("@Id", historical.Current!.AuditReference.ToString("N")));
                break;
            case "chain":
                await data.Db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_audit_log SET record_hash = @Hash WHERE id = (
                        SELECT previous.id FROM sys_audit_log previous JOIN sys_audit_log selected
                            ON previous.chain_id = selected.chain_id AND previous.id < selected.id
                        WHERE selected.target_id = @Id ORDER BY previous.id DESC LIMIT 1);
                    """, new SugarParameter("@Hash", new string('0', 64)),
                    new SugarParameter("@Id", historical.Current!.AuditReference.ToString("N")));
                break;
            case "facts":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE article_property_value_entry SET text_value = 'forged' WHERE factset_id = @Id;",
                    new SugarParameter("@Id", historical.Current!.FactsetId));
                break;
            case "coordinate":
                await data.Db.Ado.ExecuteCommandAsync("DELETE FROM article_revision WHERE id = @Id;",
                    new SugarParameter("@Id", historical.ArticleRevisionId));
                break;
            case "draft":
                await data.Db.Ado.ExecuteCommandAsync("UPDATE article_property_value_snapshot SET draft_id = 1, draft_server_revision = 1 WHERE snapshot_id = @Id;",
                    new SugarParameter("@Id", historical.Current!.SnapshotId));
                break;
        }
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => HistoricalAsync(data, historical));
        Assert.Equal(code, error.Code);
    }

    [Fact]
    public async Task AmbiguousCoordinates_RefuseBeforeHydrationEvenWhenOneCandidateIsValid()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "old");
        ArticlePropertyValueReadModel current = await SaveAsync(data, definition, "new");
        await data.Db.Ado.ExecuteCommandAsync(
            "UPDATE article_property_value_snapshot SET article_revision_id = @Revision WHERE snapshot_id = @Id;",
            new SugarParameter("@Revision", historical.ArticleRevisionId),
            new SugarParameter("@Id", current.Current!.SnapshotId));
        var queries = new List<string>();
        data.Db.Aop.OnLogExecuting = (sql, _) => queries.Add(sql);
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => HistoricalAsync(data, historical));
        Assert.Equal("article_property_value_historical_snapshot_ambiguous", error.Code);
        Assert.DoesNotContain(queries, sql => sql.Contains("FROM article_property_value_entry", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Cancellation_RefusesBeforeLookupAndAfterCoordinateSelection()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveAsync(data, definition, "private");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => HistoricalAsync(data, historical, cancelled.Token));
        using var during = new CancellationTokenSource();
        data.Db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("SELECT s.snapshot_id", StringComparison.Ordinal))
            {
                during.Cancel();
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => HistoricalAsync(data, historical, during.Token));
    }

    [Theory]
    [InlineData(0, null)]
    [InlineData(-1, null)]
    [InlineData(1L, 0L)]
    [InlineData(1L, -1L)]
    public async Task InvalidCoordinates_Refuse(long revision, long? publication)
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => data.Service.ReadHistoricalPropertyValuesAsync(data.AdminId, s_owner, data.ArticleId, revision, publication));
        Assert.Equal("article_property_value_historical_coordinates_invalid", error.Code);
    }

    private static Task<ArticlePropertyValueReadModel> HistoricalAsync(Seed data, ArticlePropertyValueReadModel read,
        CancellationToken cancellationToken = default)
        => data.Service.ReadHistoricalPropertyValuesAsync(data.AdminId, s_owner, data.ArticleId,
            read.ArticleRevisionId, read.Current!.Snapshot.Coordinates.PublicationId, cancellationToken);

    private static async Task UnavailableAsync(Seed data, long revision, long? publication)
    {
        ArticlePropertyDefinitionIntegrityException error = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => data.Service.ReadHistoricalPropertyValuesAsync(data.AdminId, s_owner, data.ArticleId, revision, publication));
        Assert.Equal("article_property_value_historical_snapshot_unavailable", error.Code);
    }

    private static async Task<ArticlePropertyValueReadModel> SaveAsync(Seed data, ArticlePropertyDefinition definition, string value)
    {
        ArticlePropertyValueReadModel before = await ReadAsync(data);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, before.ArticleRevisionId, before.PropertyRevision,
            [Change(definition, new ArticlePropertyTextValue(value), before.Current is null
                ? ArticlePropertyValueChangeKind.Create : ArticlePropertyValueChangeKind.Update)]));
        return await ReadAsync(data);
    }

    private async Task<Seed> SeedAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleBody), typeof(ArticleTag), typeof(Category), typeof(Tag),
            typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticleRightsProof),
            typeof(ArticlePublicationRecord), typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(AdminPrincipal), typeof(AuditLog));
        foreach (var migration in new[] { ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration(), ArticlePropertyValueMigrationDefinitions.BuildMigration() })
            foreach (var step in migration.Steps)
                await step.ExecuteAsync(db, CancellationToken.None);
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "isolated-property-writer",
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = string.Join('\n', AdminPermissions.All)
        }).ExecuteReturnBigIdentityAsync();
        int category = await db.Insertable(new Category { Name = "isolated-property-category" }).ExecuteReturnIdentityAsync();
        Composition composition = Compose(db, admin, "first-device");
        Assert.NotNull(composition.Context.HttpContext);
        Assert.Equal(admin.ToString(CultureInfo.InvariantCulture), composition.Context.HttpContext.User.FindFirst("admin_id")?.Value);
        int article = await composition.Service.CreateAsync(new ArticleWriteRequestCoreModel("property source", "unchanged body", "summary",
            null, category, [], (int)ArticleStatus.Draft));
        return new(db, composition, admin, article, category);
    }

    private static Composition Compose(SqlSugarClient db, long admin, string device, string? auditKey = AuditKey)
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = auditKey
        }).Build();
        TimeProvider clock = TestTemporalContext.FromEnvironment().BusinessClock;
        var permissions = new ArticlePropertyDefinitionPermissionAuthority();
        var store = new ArticlePropertyDefinitionStore(new PostgresArticlePropertyDefinitionPersistence(db, configuration), permissions,
            new PostgresArticlePropertyDefinitionValueImpactAuthority(db), new ArticlePropertyDefinitionVerifier(configuration), clock);
        var persistence = new ArticlePropertyValuePersistence(db, configuration, clock);
        var validator = new ArticlePropertyValueValidator(store, permissions, new UnavailableArticlePropertyReferenceValueAuthority());
        var context = Substitute.For<IHttpContextAccessor>();
        context.HttpContext.Returns(new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("admin_id", admin.ToString(CultureInfo.InvariantCulture)), new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
             new Claim("admin_sid", device)], "fixture"))
        });
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var service = new ArticleService(_db: db, _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis), _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(), _stringReader: Substitute.For<ICacheStringReader>(), _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(), _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope, _httpContextAccessor: context, _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(), _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(), _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(), _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(), _timeProvider: clock,
            _articlePropertyValues: persistence, _articlePropertyValueValidator: validator, _articlePropertyDefinitions: store);
        return new(service, store, persistence, context);
    }

    private static async Task<ArticlePropertyDefinition> DefineAsync(Seed data, ArticlePropertyValueType type,
        bool required = false, ArticlePropertyDefaultValue? defaultValue = null)
    {
        Guid id = Guid.CreateVersion7();
        ArticlePropertyCardinality cardinality = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference
            ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        ArticlePropertyOption[] options = type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
            ? [new(Guid.CreateVersion7(), "first", 0, ArticlePropertyOptionStatus.Active), new(Guid.CreateVersion7(), "second", 1, ArticlePropertyOptionStatus.Active)] : [];
        ArticlePropertyDefinitionWriteReceipt receipt = await data.Definitions.CreateAsync(new(data.Actor, s_owner, id,
            Guid.CreateVersion7(), data.OwnerRevision, "field-" + id.ToString("N"), [new("en", "Isolated typed field")], type, cardinality, required,
            new(defaultValue is null ? ArticlePropertyMissingBehavior.PreserveMissing : ArticlePropertyMissingBehavior.ApplyDefault,
                required ? ArticlePropertyNullBehavior.RejectNull : ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), defaultValue, new(), options,
            type == ArticlePropertyValueType.ArticleReference ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget,
                false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2048, ArticlePropertyUrlNormalization.PreservePathCase) : null,
            false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.SiteEditors));
        data.OwnerRevision = receipt.OwnerRevision;
        return (await data.Definitions.GetAsync(data.Actor, s_owner, id))!;
    }

    private static ArticlePropertyValueInput Input(ArticlePropertyDefinition definition, ArticlePropertyValuePresence presence,
        ArticlePropertyTypedValue? value = null) => new(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest, presence, value);
    private static ArticlePropertyValueChange Change(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value,
        ArticlePropertyValueChangeKind kind = ArticlePropertyValueChangeKind.Create) => new(kind, Input(definition, ArticlePropertyValuePresence.Present, value));
    private static ArticlePropertyValueMutationCommand Command(Seed data, long revision, long propertyRevision,
        IReadOnlyList<ArticlePropertyValueChange> changes, ArticlePropertyValueMutationMode mode = ArticlePropertyValueMutationMode.Patch)
        => new(Guid.CreateVersion7(), null, s_owner.SiteScope, data.ArticleId, revision, propertyRevision, mode, changes);
    private static ArticlePropertyValueEntry Entry(ArticlePropertyValueReadModel read, ArticlePropertyDefinition definition)
        => Assert.Single(read.Current!.Snapshot.Values, row => row.DefinitionId == definition.DefinitionId);
    private static string Text(ArticlePropertyValueReadModel read, ArticlePropertyDefinition definition)
        => Assert.IsType<ArticlePropertyTextValue>(Entry(read, definition).Value).Text;
    private static Task<ArticlePropertyValueReadModel> ReadAsync(Seed data) => data.Writer.ReadAsync(data.AdminId, s_owner, data.ArticleId);
    private static ArticleWriteRequestCoreModel Write(Seed data, string body, ArticleStatus status, long revision)
        => new("property source", body, "summary", null, data.CategoryId, [], (int)status, BaseRevisionId: revision);
    private static async Task<long> CountAsync(SqlSugarClient db, string table)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT count(*) FROM " + table), CultureInfo.InvariantCulture);
    private static async Task<long> RevisionAsync(SqlSugarClient db, int article)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT current_revision_id FROM article WHERE id = @Id", new SugarParameter("@Id", article)), CultureInfo.InvariantCulture);
    private static Task<string> BodyAsync(SqlSugarClient db, int article)
        => db.Ado.GetStringAsync("SELECT markdown_content FROM article_body WHERE article_id = @Id", new SugarParameter("@Id", article));
    private static async Task<WriteState> StateAsync(Seed data)
    {
        var counts = new List<long>();
        foreach (string table in s_countTables)
            counts.Add(await CountAsync(data.Db, table));
        return new(await RevisionAsync(data.Db, data.ArticleId), await BodyAsync(data.Db, data.ArticleId), counts.ToArray());
    }
    private static async Task AssertUnchangedAsync(Seed data, WriteState before)
    {
        WriteState after = await StateAsync(data);
        Assert.Equal(before.ArticleRevision, after.ArticleRevision);
        Assert.Equal(before.Body, after.Body);
        Assert.Equal(before.Counts, after.Counts);
    }
    private sealed record WriteState(long ArticleRevision, string Body, long[] Counts);
    private sealed record Composition(ArticleService Service, ArticlePropertyDefinitionStore Store,
        ArticlePropertyValuePersistence Persistence, IHttpContextAccessor Context);
    private sealed class Seed(SqlSugarClient db, Composition composition, long admin, int article, int category) : IDisposable
    {
        public SqlSugarClient Db => db;
        public ArticleService Service => composition.Service;
        public IArticlePropertyValueAuthority Writer => composition.Service;
        public ArticlePropertyDefinitionStore Definitions => composition.Store;
        public ArticlePropertyValuePersistence Persistence => composition.Persistence;
        public IHttpContextAccessor Context => composition.Context;
        public long AdminId => admin;
        public int ArticleId => article;
        public int CategoryId => category;
        public ArticlePropertyDefinitionActor Actor => new(admin, AdminPermissions.All);
        public long OwnerRevision
        {
            get; set;
        }
        public void Dispose() => db.Dispose();
    }
}

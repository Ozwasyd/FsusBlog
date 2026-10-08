using System.Globalization;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePropertyDefinitionBatchReadTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly ArticlePropertyDefinitionOwner s_owner = ArticlePropertyDefinitionOwner.User(42, "batch-site");
    private static readonly ArticlePropertyDefinitionActor s_actor = new(42, [AdminPermissions.ArticleWrite]);

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1000)]
    public async Task ProductionValidationUsesBoundedQueriesAndPreservesTypedDefaults(int count)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinition[] expected = await SeedAsync(db, store, count);
        var statements = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Add(sql);
        try
        {
            var validator = new ArticlePropertyValueValidator(store, new ArticlePropertyDefinitionPermissionAuthority(),
                new UnavailableArticlePropertyReferenceValueAuthority());
            IReadOnlyList<ArticlePropertyValueEntry> values = await validator.ValidateAsync(s_actor, s_owner, 7,
                expected.Reverse().Select(definition => new ArticlePropertyValueInput(definition.DefinitionId,
                    definition.SchemaRevision, definition.ContentDigest, ArticlePropertyValuePresence.Missing, null)).ToArray());
            Assert.Equal(count, values.Count);
            Assert.Equal(expected.Select(static definition => definition.DefinitionId).Order(), values.Select(static value => value.DefinitionId));
            Assert.All(values, value =>
            {
                Assert.True(value.DefaultApplied);
                Assert.Equal(new ArticlePropertySingleSelectValue(expected[0].Options[0].OptionId), value.Value);
            });
            Assert.Equal(count == 0 ? 0 : 4, statements.Count);
            Assert.All(statements, sql => Assert.StartsWith("SELECT", sql.TrimStart(), StringComparison.OrdinalIgnoreCase));

            statements.Clear();
            IReadOnlyList<ArticlePropertyDefinition> actual = await store.GetManyAsync(s_actor, s_owner,
                expected.Select(static definition => definition.DefinitionId).Reverse().ToArray());
            Assert.Equal(count == 0 ? 0 : 4, statements.Count);
            var byId = expected.ToDictionary(static definition => definition.DefinitionId);
            Assert.Equal(byId.Keys.Order(), actual.Select(static definition => definition.DefinitionId));
            Assert.All(actual, definition =>
            {
                Assert.Equal(byId[definition.DefinitionId].ContentDigest, definition.ContentDigest);
                Assert.Equal(definition.ContentDigest, ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition));
                Assert.Equal(byId[definition.DefinitionId].DisplayNames, definition.DisplayNames);
                Assert.Equal(ArticlePropertyDefinitionContract.ComputeOptionsDigest(byId[definition.DefinitionId].Options),
                    ArticlePropertyDefinitionContract.ComputeOptionsDigest(definition.Options));
            });
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("foreign-owner")]
    [InlineData("deleted")]
    [InlineData("deprecated")]
    [InlineData("revision")]
    [InlineData("digest")]
    [InlineData("tampered-storage")]
    public async Task BatchValidationRefusesUnavailableInactiveAndStaleDefinitions(string failure)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinition definition = Assert.Single(await SeedAsync(db, store, 1));
        ArticlePropertyDefinitionOwner owner = s_owner;
        Guid id = definition.DefinitionId;
        if (failure == "missing")
        {
            id = Guid.CreateVersion7();
        }
        if (failure == "foreign-owner")
        {
            owner = ArticlePropertyDefinitionOwner.User(42, "another-site");
        }
        if (failure is "deleted" or "deprecated")
        {
            definition = definition with
            {
                Status = failure == "deleted" ? ArticlePropertyDefinitionStatus.Deleted : ArticlePropertyDefinitionStatus.Deprecated
            };
            definition = definition with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
            };
            await db.Ado.ExecuteCommandAsync("UPDATE article_property_definition SET status = @Status, content_digest = @Digest WHERE definition_id = @Id;",
                new SugarParameter("@Status", (short)definition.Status), new SugarParameter("@Digest", definition.ContentDigest), new SugarParameter("@Id", id));
            Assert.Equal(definition.Status, Assert.Single(await store.GetManyAsync(s_actor, owner, [id])).Status);
            if (failure == "deleted")
            {
                Assert.Null(await store.GetAsync(s_actor, owner, id));
            }
        }
        if (failure == "tampered-storage")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE article_property_definition SET content_digest = @Digest WHERE definition_id = @Id;",
                new SugarParameter("@Digest", new string('0', 64)), new SugarParameter("@Id", id));
        }
        var validator = new ArticlePropertyValueValidator(store, new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyReferenceValueAuthority());
        var input = new ArticlePropertyValueInput(id, definition.SchemaRevision + (failure == "revision" ? 1 : 0),
            failure == "digest" ? new string('0', 64) : definition.ContentDigest, ArticlePropertyValuePresence.Missing, null);
        ArticlePropertyDefinitionValidationException refused = await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
            () => validator.ValidateAsync(s_actor, owner, 7, [input]));
        Assert.Equal(failure switch
        {
            "missing" or "foreign-owner" => "article_property_definition_unavailable",
            "tampered-storage" => "article_property_definition_digest_invalid",
            _ => "article_property_definition_stale_or_inactive"
        }, refused.Code);
    }

    [Fact]
    public async Task PermissionCancellationAndInvalidBatchesRefuseBeforeSql()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        int statements = 0;
        db.Aop.OnLogExecuting = (_, _) => statements++;
        try
        {
            await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => store.GetManyAsync(
                new ArticlePropertyDefinitionActor(42, []), s_owner, []));
            await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() => store.GetManyAsync(
                s_actor, ArticlePropertyDefinitionOwner.User(77, s_owner.SiteScope), []));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.GetManyAsync(s_actor, s_owner,
                [], new CancellationToken(canceled: true)));
            Guid id = Guid.CreateVersion7();
            foreach (Guid[] invalid in new[] { new[] { Guid.Empty }, new[] { id, id }, Enumerable.Range(0, 1001).Select(_ => Guid.CreateVersion7()).ToArray() })
            {
                Assert.Equal("article_property_definition_batch_invalid", (await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
                    () => store.GetManyAsync(s_actor, s_owner, invalid))).Code);
            }
            Assert.Equal(0, statements);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AuditLog));
        foreach (var migration in new[] { ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(), ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration() })
        {
            foreach (var step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
        return db;
    }

    private static ArticlePropertyDefinitionStore CreateStore(SqlSugarClient db)
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = "isolated-batch-definition-tamper-key"
        }).Build();
        return new(new PostgresArticlePropertyDefinitionPersistence(db, configuration), new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyDefinitionImpactAuthority(), new ArticlePropertyDefinitionVerifier(configuration), new FixedClock());
    }

    private static async Task<ArticlePropertyDefinition[]> SeedAsync(SqlSugarClient db, ArticlePropertyDefinitionStore store, int count)
    {
        if (count == 0)
        {
            return [];
        }
        Guid id = Guid.CreateVersion7();
        Guid option = Guid.CreateVersion7();
        await store.CreateAsync(new CreateArticlePropertyDefinitionCommand(s_actor, s_owner, id, Guid.CreateVersion7(), 0,
            "batch-field-0000", [new("en", "Field"), new("zh", "字段")], ArticlePropertyValueType.SingleSelect,
            ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.ApplyDefault, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [option]), new(),
            [new(option, "One", 0, ArticlePropertyOptionStatus.Active, [new("en", "One"), new("zh", "一")])],
            null, null, true, true, true, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.SiteEditors));
        ArticlePropertyDefinition template = (await store.GetAsync(s_actor, s_owner, id))!;
        ArticlePropertyDefinition[] definitions = Enumerable.Range(0, count).Select(index => index == 0 ? template : template with
        {
            DefinitionId = Guid.CreateVersion7(),
            MachineKey = "batch-field-" + index.ToString("D4", CultureInfo.InvariantCulture)
        }).Select(definition => definition with { ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition) }).ToArray();
        if (count > 1)
        {
            // Task-local scale data clones a real canonical definition; no production migration or receipt is fabricated.
            await db.Ado.ExecuteCommandAsync("""
                INSERT INTO article_property_definition
                SELECT (jsonb_populate_record(NULL::article_property_definition, to_jsonb(template)
                    || jsonb_build_object('definition_id', seed.id, 'machine_key', seed.key, 'content_digest', seed.digest))).*
                FROM article_property_definition template,
                    unnest(@Ids, @Keys, @Digests) AS seed(id, key, digest)
                WHERE template.definition_id = @Template;
                INSERT INTO article_property_definition_display_name
                SELECT seed.id, label.locale, label.value
                FROM unnest(@Ids) AS seed(id), article_property_definition_display_name label WHERE label.definition_id = @Template;
                INSERT INTO article_property_definition_option
                SELECT seed.id, option.option_id, option.label, option.option_order, option.status
                FROM unnest(@Ids) AS seed(id), article_property_definition_option option WHERE option.definition_id = @Template;
                INSERT INTO article_property_definition_option_label
                SELECT seed.id, label.option_id, label.locale, label.value
                FROM unnest(@Ids) AS seed(id), article_property_definition_option_label label WHERE label.definition_id = @Template;
                """, new SugarParameter("@Ids", definitions.Skip(1).Select(static definition => definition.DefinitionId).ToArray()) { IsArray = true },
                new SugarParameter("@Keys", definitions.Skip(1).Select(static definition => definition.MachineKey).ToArray()) { IsArray = true },
                new SugarParameter("@Digests", definitions.Skip(1).Select(static definition => definition.ContentDigest).ToArray()) { IsArray = true },
                new SugarParameter("@Template", id));
        }
        return definitions;
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(2026, 10, 8, 12, 0, 0, TimeSpan.Zero);
    }
}

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleTemplateExpansionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "article-template-expansion-key-0123456789";
    private static readonly ArticleTemplateActor s_writer = new(
        9,
        [AdminPermissions.ArticleWrite]);

    [Fact]
    public async Task Planner_ProducesDeterministicPlanFromPostgresAuthorities()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var persistence = new PostgresArticleTemplatePersistence(db, CreateConfiguration());
        var references = new PostgresArticleTemplateReferenceAuthority(db);
        var expansionAuthority = new PostgresArticleTemplateExpansionAuthority(db);
        var store = new ArticleTemplateStore(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references,
            new ArticleTemplateVerifier(),
            TimeProvider.System);
        var planner = new ArticleTemplateExpansionPlanner(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references,
            expansionAuthority,
            TimeProvider.System);
        var verifier = new ArticleTemplateExpansionVerifier(planner, TimeProvider.System);
        ArticleTemplateScope scope = ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId);

        ArticleTemplateWriteReceipt created = await store.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            scope,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Release Notes",
            null,
            ArticleTemplateSource.FromUtf8("# {{title}}\n\nby {{author}} on {{date}} ({{site_locale}})\n"),
            new ArticleTemplateDefaults(
                categoryId: 11,
                tagIds: [21],
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_publicAssetId)])));

        var input = new ArticleTemplateExpansionInput(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value,
            "Quarterly *Report*",
            new DateTimeOffset(2026, 9, 8, 23, 30, 0, TimeSpan.Zero),
            "Asia/Shanghai",
            "en");
        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(input);

        string expanded = System.Text.Encoding.UTF8.GetString(plan.ExpandedSource);
        Assert.Equal(
            "# Quarterly \\*Report\\*\n\nby Alice Admin on 2026-09-09 (en-US)\n",
            expanded);
        Assert.Equal(11, plan.Dependencies.CategoryId);
        Assert.Equal([21], plan.Dependencies.TagIds);
        ArticleTemplateAssetPin pin = Assert.Single(plan.Dependencies.AssetPins);
        Assert.Equal(s_publicAssetId, pin.AssetId);
        Assert.Equal("active", pin.State);
        Assert.Equal("public", pin.StorageClass);

        ArticleTemplateVerificationResult valid = await verifier.VerifyAsync(plan);
        Assert.True(valid.Valid, string.Join(',', valid.Violations.Select(static v => v.Code)));

        // Drift in durable reference state is detected by independent recomputation.
        await db.Ado.ExecuteCommandAsync("DELETE FROM tag WHERE id = 21;");
        ArticleTemplateVerificationResult drifted = await verifier.VerifyAsync(plan);
        Assert.False(drifted.Valid);
        Assert.Contains(drifted.Violations, v => v.Code == "expansion_plan_reference_stale");
    }

    [Fact]
    public async Task Planner_FailsClosedWhenActorPrincipalOrAssetIsGone()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var expansionAuthority = new PostgresArticleTemplateExpansionAuthority(db);

        await Assert.ThrowsAsync<ArticleTemplateExpansionException>(
            () => expansionAuthority.ResolveActorDisplayNameAsync(99999));
        Assert.Equal(
            "article_template_asset_reference_stale",
            (await Assert.ThrowsAsync<ArticleTemplateExpansionException>(
                () => expansionAuthority.PinAssetsAsync([Guid.CreateVersion7()]))).Code);
    }

    private static readonly Guid s_publicAssetId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(ContentAsset),
            typeof(AdminPrincipal),
            typeof(AuditLog));
        await db.Ado.ExecuteCommandAsync("""
            INSERT INTO "category"(id, name) VALUES (11, 'engineering');
            INSERT INTO "tag"(id, name) VALUES (21, 'release'), (22, 'notes');
            INSERT INTO content_asset(
                id, storage_class, storage_key, media_type, extension, byte_length,
                owner_admin_principal_id, state, created_at_utc, updated_at_utc)
            VALUES
                (@PublicId, 'public', 'assets/public.png', 'image/png', 'png', 128,
                 NULL, 'active', now(), now());
            INSERT INTO admin_principal(
                handle, displayname, status, isroot, permissions, createdatutc)
            VALUES
                ('alice', 'Alice Admin', 'active', false, '[]', now());
            """,
            new SugarParameter("@PublicId", s_publicAssetId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET id = 9 WHERE handle = 'alice';");
        ISchemaMigrationDescriptor migration = ArticleTemplateAuthorityMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();
}

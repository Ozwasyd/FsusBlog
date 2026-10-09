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
public sealed class ArticleCreateIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "article-create-integration-key-0123456789";
    private static readonly ArticleTemplateActor s_writer = new(
        9,
        [AdminPermissions.ArticleWrite]);
    private static readonly Guid s_assetId = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public async Task BlankCreate_ProducesExactOnceDraftGraphReceiptAndAudit()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleCreateStore store = CreateStore(db);

        var command = new ArticleCreateCommand(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Blank);
        ArticleCreateReceipt receipt = await store.CreateAsync(command);

        Assert.Equal("blank", receipt.CreateMode);
        Assert.Null(receipt.TemplateId);
        Assert.Null(receipt.PlanDigest);
        Assert.False(receipt.IsIdempotentReplay);
        Assert.True(receipt.ArticleId > 0);
        Assert.True(receipt.DraftId > 0);
        Assert.Equal(1, receipt.RevisionNo);
        Assert.Equal(1, receipt.DraftServerRevision);

        // Draft-only graph: article stays Draft with no publication coordinates.
        Assert.Equal(0, await ScalarAsync<int>(db, $"SELECT status FROM article WHERE id = {receipt.ArticleId};"));
        Assert.Equal(1, await ScalarAsync<int>(db,
            $"SELECT COUNT(*) FROM article WHERE id = {receipt.ArticleId} AND published_at IS NULL "
            + "AND last_published_at IS NULL AND current_publication_id IS NULL;"));
        Assert.Equal(receipt.RevisionId, await ScalarAsync<long>(db,
            $"SELECT current_revision_id FROM article WHERE id = {receipt.ArticleId};"));
        Assert.Equal("", await ScalarAsync<string>(db,
            $"SELECT markdown_content FROM article_body WHERE article_id = {receipt.ArticleId};"));
        Assert.Equal(receipt.ArticleId, await ScalarAsync<int>(db,
            $"SELECT article_id FROM article_draft WHERE id = {receipt.DraftId};"));
        Assert.Equal(1, await ScalarAsync<long>(db,
            $"SELECT COUNT(*) FROM article_revision WHERE id = {receipt.RevisionId} AND revision_no = 1;"));
        Assert.Equal(1, await ScalarAsync<long>(db,
            $"SELECT COUNT(*) FROM article_mutation_outbox WHERE event_id = '{receipt.OutboxEventId}';"));
        Assert.Equal(1, await ScalarAsync<long>(db,
            "SELECT COUNT(*) FROM sys_audit_log WHERE target_type = 'article-create-receipt' "
            + $"AND replace(target_id, '-', '') = '{receipt.AuditReference:N}';"));

        // Exact-once: replaying the same request id returns the same receipt identities.
        ArticleCreateReceipt replay = await store.CreateAsync(
            new ArticleCreateCommand(s_writer, command.RequestId, ArticleCreateMode.Blank));
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(receipt.ReceiptId, replay.ReceiptId);
        Assert.Equal(receipt.ArticleId, replay.ArticleId);
        Assert.Equal(1, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));

        // A different request shape under the same id is a hard conflict, never a replay.
        ArticleTemplateExpansionPlan foreignPlan =
            FsusBlog.Server.Tests.Unit.ArticleCreateContractTests.ExpansionFixture.BuildPlan(s_writer);
        ArticleCreateConflictException conflict = await Assert.ThrowsAsync<ArticleCreateConflictException>(
            () => store.CreateAsync(new ArticleCreateCommand(
                s_writer, command.RequestId, ArticleCreateMode.Template,
                foreignPlan.Input.TemplateId, foreignPlan.VersionId, foreignPlan,
                foreignPlan.ContentDigest)));
        Assert.Equal("article_create_idempotency_conflict", conflict.Code);
        Assert.Equal(1, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));

        ArticleCreateVerificationResult verified = await store.VerifyReceiptAsync(s_writer, receipt.ReceiptId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static v => v.Code)));
    }

    [Fact]
    public async Task TemplateCreate_ConsumesVerifiedPlanAndNeverFallsBack()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleCreateStore store, ArticleTemplateExpansionPlanner planner, ArticleTemplateExpansionVerifier verifier) =
            CreateStack(db);
        ArticleTemplateStore templateStore = CreateTemplateStore(db);

        ArticleTemplateWriteReceipt created = await templateStore.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Release Notes",
            null,
            ArticleTemplateSource.FromUtf8("# {{title}}\n\nby {{author}} on {{date}}\n"),
            new ArticleTemplateDefaults(categoryId: 11, tagIds: [21])));

        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(new ArticleTemplateExpansionInput(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value,
            "Ship It",
            new DateTimeOffset(2026, 9, 8, 0, 0, 0, TimeSpan.Zero),
            "UTC",
            "zh-CN"));
        ArticleCreateCommand command = new(
            s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template,
            created.TemplateId, created.VersionId.Value, plan, plan.ContentDigest);
        ArticleCreateReceipt receipt = await store.CreateAsync(command);

        Assert.Equal("template", receipt.CreateMode);
        Assert.Equal(created.TemplateId, receipt.TemplateId);
        Assert.Equal(created.VersionId, receipt.TemplateVersionId);
        Assert.Equal(plan.ContentDigest, receipt.PlanDigest);
        Assert.Equal(plan.ExpandedSourceDigest, receipt.SourceDigest);

        string markdown = await ScalarAsync<string>(db,
            $"SELECT markdown_content FROM article_body WHERE article_id = {receipt.ArticleId};");
        Assert.Equal("# Ship It\n\nby Alice Admin on 2026-09-08\n", markdown);
        Assert.Equal("Ship It", await ScalarAsync<string>(db,
            $"SELECT title FROM article WHERE id = {receipt.ArticleId};"));
        Assert.Equal(11, await ScalarAsync<int>(db,
            $"SELECT categoryid FROM article WHERE id = {receipt.ArticleId};"));
        Assert.Equal(1, await ScalarAsync<long>(db,
            $"SELECT COUNT(*) FROM article_tag WHERE articleid = {receipt.ArticleId} AND tagid = 21;"));

        // Stale plan (tag removed after planning) aborts the whole create: zero graph rows.
        await db.Ado.ExecuteCommandAsync("DELETE FROM tag WHERE id = 21;");
        await Assert.ThrowsAsync<ArticleCreateException>(() => store.CreateAsync(
            new ArticleCreateCommand(
                s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template,
                created.TemplateId, created.VersionId.Value, plan, plan.ContentDigest)));
        Assert.Equal(1, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));
        Assert.Equal(1, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_draft;"));
        Assert.Equal(1, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_mutation_outbox;"));

        // Template failure never breaks the blank path.
        ArticleCreateReceipt blank = await store.CreateAsync(
            new ArticleCreateCommand(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Blank));
        Assert.Equal("blank", blank.CreateMode);
        Assert.Equal(2, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));
    }

    [Fact]
    public async Task MissingAsset_AbortsTemplateCreateWithZeroWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleCreateStore store, ArticleTemplateExpansionPlanner planner, _) = CreateStack(db);
        ArticleTemplateStore templateStore = CreateTemplateStore(db);

        ArticleTemplateWriteReceipt created = await templateStore.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Asset Brief",
            null,
            ArticleTemplateSource.FromUtf8("# {{title}}\n"),
            new ArticleTemplateDefaults(
                categoryId: 11,
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_assetId)])));

        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(new ArticleTemplateExpansionInput(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value,
            "Pinned",
            new DateTimeOffset(2026, 9, 8, 0, 0, 0, TimeSpan.Zero),
            "UTC",
            "zh-CN"));

        // The pinned asset disappearing must abort the whole create: zero graph rows.
        await db.Ado.ExecuteCommandAsync("DELETE FROM content_asset;");
        await Assert.ThrowsAsync<ArticleCreateException>(() => store.CreateAsync(
            new ArticleCreateCommand(
                s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template,
                created.TemplateId, created.VersionId.Value, plan, plan.ContentDigest)));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_draft;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_mutation_outbox;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_create_request;"));
    }

    [Fact]
    public async Task CancelledCreate_WritesNothing()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleCreateStore store = CreateStore(db);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.CreateAsync(
            new ArticleCreateCommand(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Blank),
            cancelled.Token));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_draft;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_mutation_outbox;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_create_request;"));
    }

    [Fact]
    public async Task TemplateUpdateAfterCreate_DoesNotMutateExistingArticle()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleCreateStore store, ArticleTemplateExpansionPlanner planner, _) = CreateStack(db);
        ArticleTemplateStore templateStore = CreateTemplateStore(db);

        ArticleTemplateWriteReceipt created = await templateStore.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Changelog",
            null,
            ArticleTemplateSource.FromUtf8("# {{title}}\nv1\n"),
            new ArticleTemplateDefaults(categoryId: 11, tagIds: [21])));
        ArticleTemplateExpansionPlan plan = await planner.PlanAsync(new ArticleTemplateExpansionInput(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value,
            "First",
            new DateTimeOffset(2026, 9, 8, 0, 0, 0, TimeSpan.Zero),
            "UTC",
            "zh-CN"));
        ArticleCreateReceipt receipt = await store.CreateAsync(new ArticleCreateCommand(
            s_writer, Guid.CreateVersion7(), ArticleCreateMode.Template,
            created.TemplateId, created.VersionId.Value, plan, plan.ContentDigest));

        // Later template versions never reach back into the created article.
        await templateStore.CreateVersionAsync(new CreateArticleTemplateVersionCommand(
            s_writer,
            created.TemplateId,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 1,
            ExpectedTemplateRevision: 1,
            ExpectedCurrentVersionNumber: 1,
            ArticleTemplateSource.FromUtf8("# {{title}}\nv2 rewritten\n"),
            new ArticleTemplateDefaults(categoryId: 11, tagIds: [22])));

        Assert.Equal("First", await ScalarAsync<string>(db,
            $"SELECT title FROM article WHERE id = {receipt.ArticleId};"));
        Assert.Equal("# First\nv1\n", await ScalarAsync<string>(db,
            $"SELECT markdown_content FROM article_body WHERE article_id = {receipt.ArticleId};"));
        Assert.Equal(1, await ScalarAsync<long>(db,
            $"SELECT COUNT(*) FROM article_tag WHERE articleid = {receipt.ArticleId} AND tagid = 21;"));
        Assert.Equal(0, await ScalarAsync<long>(db,
            $"SELECT COUNT(*) FROM article_tag WHERE articleid = {receipt.ArticleId} AND tagid = 22;"));

        ArticleCreateVerificationResult verified = await store.VerifyReceiptAsync(s_writer, receipt.ReceiptId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static v => v.Code)));
    }

    [Fact]
    public async Task Verifier_RejectsTamperedGraph()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleCreateStore store = CreateStore(db);
        ArticleCreateReceipt receipt = await store.CreateAsync(
            new ArticleCreateCommand(s_writer, Guid.CreateVersion7(), ArticleCreateMode.Blank));

        // Tamper: forge publication state and drop the outbox event.
        await db.Ado.ExecuteCommandAsync(
            $"UPDATE article SET status = 2, published_at = now() WHERE id = {receipt.ArticleId};");
        await db.Ado.ExecuteCommandAsync(
            $"DELETE FROM article_mutation_outbox WHERE event_id = '{receipt.OutboxEventId}';");

        ArticleCreateVerificationResult verified = await store.VerifyReceiptAsync(s_writer, receipt.ReceiptId);
        Assert.False(verified.Valid);
        Assert.Contains(verified.Violations, violation => violation.Code == "create_draft_only_violated");
        Assert.Contains(verified.Violations, violation => violation.Code == "create_publication_forbidden");
        Assert.Contains(verified.Violations, violation => violation.Code == "create_outbox_missing");
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(AdminPrincipal),
            typeof(AuditLog),
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticleDraft),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleSourceGeneration),
            typeof(ArticleSourceSequence),
            typeof(ArticleSourceMutation),
            typeof(ArticleMutationOutboxEvent));
        await db.Ado.ExecuteCommandAsync("""
            INSERT INTO "category"(id, name) VALUES (11, 'engineering');
            INSERT INTO "tag"(id, name) VALUES (21, 'release'), (22, 'notes');
            INSERT INTO content_asset(
                id, storage_class, storage_key, media_type, extension, byte_length,
                owner_admin_principal_id, state, created_at_utc, updated_at_utc)
            VALUES
                (@AssetId, 'public', 'assets/public.png', 'image/png', 'png', 128,
                 NULL, 'active', now(), now());
            INSERT INTO admin_principal(
                handle, displayname, status, isroot, permissions, createdatutc)
            VALUES
                ('alice', 'Alice Admin', 'active', false, '[]', now());
            """,
            new SugarParameter("@AssetId", s_assetId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET id = 9 WHERE handle = 'alice';");
        foreach (ISchemaMigrationDescriptor migration in
            new[]
            {
                ArticleTemplateAuthorityMigrationDefinitions.BuildMigration(),
                ArticleCreateAuthorityMigrationDefinitions.BuildMigration()
            })
        {
            foreach (SchemaMigrationStep step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
        await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString,
            ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
        return db;
    }

    private ArticleCreateStore CreateStore(SqlSugarClient db)
    {
        (ArticleCreateStore store, _, _) = CreateStack(db);
        return store;
    }

    private (ArticleCreateStore, ArticleTemplateExpansionPlanner, ArticleTemplateExpansionVerifier) CreateStack(
        SqlSugarClient db)
    {
        var persistence = new PostgresArticleTemplatePersistence(db, CreateConfiguration());
        var references = new PostgresArticleTemplateReferenceAuthority(db);
        var expansionAuthority = new PostgresArticleTemplateExpansionAuthority(db);
        var planner = new ArticleTemplateExpansionPlanner(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references,
            expansionAuthority,
            TimeProvider.System);
        var verifier = new ArticleTemplateExpansionVerifier(planner, TimeProvider.System);
        var store = new ArticleCreateStore(
            new PostgresArticleCreatePersistence(db, CreateConfiguration()),
            verifier);
        return (store, planner, verifier);
    }

    private ArticleTemplateStore CreateTemplateStore(SqlSugarClient db)
        => new(
            new PostgresArticleTemplatePersistence(db, CreateConfiguration()),
            new ArticleTemplatePermissionAuthority(),
            new PostgresArticleTemplateReferenceAuthority(db),
            new ArticleTemplateVerifier(),
            TimeProvider.System);

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();

    private static async Task<T> ScalarAsync<T>(SqlSugarClient db, string sql)
        => (T)Convert.ChangeType(
            await db.Ado.GetScalarAsync(sql).ConfigureAwait(false),
            typeof(T))!;
}

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleTemplateAuthorityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "article-template-integration-tamper-key-0123456789";
    private static readonly ArticleTemplateActor s_manager = new(
        7,
        [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig]);
    private static readonly ArticleTemplateActor s_writer = new(
        9,
        [AdminPermissions.ArticleWrite]);

    [Fact]
    public async Task Store_PersistsImmutableVersionsReceiptsIdempotencyAndSignedAuditLinks()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleTemplateStore store = CreateStore(db);
        ArticleTemplateScope scope = ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId);

        ArticleTemplateWriteReceipt created = await store.CreateAsync(new CreateArticleTemplateCommand(
            s_writer,
            scope,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            ExpectedScopeRevision: 0,
            "Release Notes",
            "standard opener",
            ArticleTemplateSource.FromUtf8("# {{title}}\n\nby {{author}} on {{date}} ({{site_locale}})\n"),
            new ArticleTemplateDefaults(
                titlePlaceholder: "Draft {{date}}",
                tagIds: [21, 22],
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_publicAssetId)])));

        Assert.Equal("create", created.CommandKind);
        Assert.Equal(1, created.TemplateRevision);
        Assert.Equal(1, created.ScopeRevision);
        Assert.False(created.IsIdempotentReplay);
        Assert.NotEqual(Guid.Empty, created.AuditReference);

        ArticleTemplateAuditLink[] links = await ReadAuditLinksAsync(db, created.AuditReference);
        ArticleTemplateAuditLink link = Assert.Single(links);
        Assert.Equal("article", link.Source);
        Assert.Equal("business", link.Type);
        Assert.Equal(AdminPermissions.ArticleWrite, link.Action);
        Assert.Equal("article-template-receipt", link.TargetType);
        Assert.Equal(created.AuditReference.ToString("N"), link.TargetId);
        Assert.Equal(created.AuditDigest, link.EventInfo);
        Assert.Equal("create", link.ReasonCode);
        Assert.Equal("success", link.Outcome);
        Assert.True(link.IsHighValue);
        long auditRows = await ScalarAsync<long>(
            db,
            "SELECT COUNT(*) FROM sys_audit_log WHERE target_type = 'article-template-receipt';");
        Assert.Equal(1, auditRows);
        long signedRows = await ScalarAsync<long>(
            db,
            "SELECT COUNT(*) FROM sys_audit_log WHERE record_hash IS NOT NULL AND chain_id IS NOT NULL;");
        Assert.Equal(1, signedRows);

        ArticleTemplateDefinition? definition = await store.GetAsync(s_writer, created.TemplateId);
        Assert.NotNull(definition);
        Assert.Equal("Release Notes", definition.Name);
        Assert.Equal(ArticleTemplateStatus.Active, definition.Status);
        ArticleTemplateVersion? version = await store.GetVersionAsync(
            s_writer,
            created.TemplateId,
            created.VersionId!.Value);
        Assert.NotNull(version);
        Assert.Equal(4, version.Source.VariableTokens.Count);

        ArticleTemplateVerificationResult verified = await store.VerifyAsync(s_writer, created.TemplateId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static v => v.Code)));

        CreateArticleTemplateCommand replayCommand = new(
            s_writer,
            scope,
            created.TemplateId,
            created.VersionId!.Value,
            created.RequestId,
            ExpectedScopeRevision: 0,
            "Release Notes",
            "standard opener",
            ArticleTemplateSource.FromUtf8("# {{title}}\n\nby {{author}} on {{date}} ({{site_locale}})\n"),
            new ArticleTemplateDefaults(
                titlePlaceholder: "Draft {{date}}",
                tagIds: [21, 22],
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_publicAssetId)]));
        ArticleTemplateWriteReceipt replay = await store.CreateAsync(replayCommand);
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        auditRows = await ScalarAsync<long>(
            db,
            "SELECT COUNT(*) FROM sys_audit_log WHERE target_type = 'article-template-receipt';");
        Assert.Equal(1, auditRows);

        await Assert.ThrowsAsync<ArticleTemplateConflictException>(() => store.CreateAsync(
            replayCommand with
            {
                Name = "Renamed Conflict"
            }));

        await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(
            "UPDATE article_template_version SET variable_count = variable_count + 1 WHERE version_id = @VersionId;",
            new SugarParameter("@VersionId", created.VersionId!.Value)));
        await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(
            "DELETE FROM article_template_version_tag WHERE version_id = @VersionId;",
            new SugarParameter("@VersionId", created.VersionId!.Value)));
        await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(
            "UPDATE article_template_receipt SET command_kind = 'delete' WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@ReceiptId", created.ReceiptId)));

        await fixture.ExecuteAsync(
            db.CurrentConnectionConfig.ConnectionString,
            "UPDATE sys_audit_log SET event_info = 'tampered' WHERE target_type = 'article-template-receipt';");
        ArticleTemplateVerificationResult tampered = await store.VerifyAsync(s_writer, created.TemplateId);
        Assert.False(tampered.Valid);
        Assert.Contains(tampered.Violations, static violation => violation.Code == "audit_link_tamper");
    }

    [Fact]
    public async Task Store_FailsClosedOnReferencesPermissionsAndConcurrency()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleTemplateStore store = CreateStore(db);
        ArticleTemplateScope writerScope = ArticleTemplateContract.PersonalScope(s_writer.AdminPrincipalId);
        ArticleTemplateScope managerScope = ArticleTemplateContract.PersonalScope(s_manager.AdminPrincipalId);
        ArticleTemplateScope siteScope = ArticleTemplateContract.SiteScope();

        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() => store.CreateAsync(
            new CreateArticleTemplateCommand(
                s_writer,
                managerScope,
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                0,
                "foreign",
                null,
                ArticleTemplateSource.FromUtf8("plain"),
                new ArticleTemplateDefaults())));
        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() => store.CreateAsync(
            new CreateArticleTemplateCommand(
                s_writer,
                siteScope,
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                0,
                "site",
                null,
                ArticleTemplateSource.FromUtf8("plain"),
                new ArticleTemplateDefaults())));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_template_definition;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_template_scope;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM sys_audit_log;"));

        await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => store.CreateAsync(
            new CreateArticleTemplateCommand(
                s_writer,
                writerScope,
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                0,
                "stale category",
                null,
                ArticleTemplateSource.FromUtf8("plain"),
                new ArticleTemplateDefaults(categoryId: 4242))));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_template_definition;"));
        Assert.Equal(0, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_template_receipt;"));

        await Assert.ThrowsAsync<ArticleTemplateReferenceException>(() => store.CreateAsync(
            new CreateArticleTemplateCommand(
                s_writer,
                writerScope,
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                Guid.CreateVersion7(),
                0,
                "private asset",
                null,
                ArticleTemplateSource.FromUtf8("plain"),
                new ArticleTemplateDefaults(assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_privateAssetId)]))));

        Guid templateId = Guid.CreateVersion7();
        Guid versionId = Guid.CreateVersion7();
        Guid requestId = Guid.CreateVersion7();
        var command = new CreateArticleTemplateCommand(
            s_writer,
            writerScope,
            templateId,
            versionId,
            requestId,
            0,
            "referenced",
            null,
            ArticleTemplateSource.FromUtf8("{{title}}"),
            new ArticleTemplateDefaults(
                categoryId: 11,
                tagIds: [21, 22],
                assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(s_publicAssetId)]));
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(
            db.CurrentConnectionConfig.ConnectionString);
        ArticleTemplateStore secondStore = CreateStore(secondDb);
        ArticleTemplateWriteReceipt[] raced = await Task.WhenAll(
            store.CreateAsync(command),
            secondStore.CreateAsync(command));
        Assert.Equal(raced[0].ReceiptId, raced[1].ReceiptId);
        Assert.Single(raced, static receipt => receipt.IsIdempotentReplay);

        ArticleTemplateVerificationResult verified = await store.VerifyAsync(s_writer, templateId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static v => v.Code)));

        ArticleTemplatePage writerPage = await store.ListAsync(s_writer, writerScope, null, 10);
        Assert.Single(writerPage.Items);
        ArticleTemplatePage managerPage = await store.ListAsync(s_manager, managerScope, null, 10);
        Assert.Empty(managerPage.Items);
        ArticleTemplatePage sitePage = await store.ListAsync(s_writer, siteScope, null, 10);
        Assert.Empty(sitePage.Items);
    }

    private static readonly Guid s_publicAssetId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid s_privateAssetId = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(ContentAsset),
            typeof(AuditLog));
        await db.Ado.ExecuteCommandAsync("""
            INSERT INTO "category"(id, name) VALUES (11, 'engineering');
            INSERT INTO "tag"(id, name) VALUES (21, 'release'), (22, 'notes');
            INSERT INTO content_asset(
                id, storage_class, storage_key, media_type, extension, byte_length,
                owner_admin_principal_id, state, created_at_utc, updated_at_utc)
            VALUES
                (@PublicId, 'public', 'assets/public.png', 'image/png', 'png', 128,
                 NULL, 'active', now(), now()),
                (@PrivateId, 'private', 'assets/private.png', 'image/png', 'png', 128,
                 NULL, 'active', now(), now());
            """,
            new SugarParameter("@PublicId", s_publicAssetId),
            new SugarParameter("@PrivateId", s_privateAssetId));
        ISchemaMigrationDescriptor migration = ArticleTemplateAuthorityMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static ArticleTemplateStore CreateStore(SqlSugarClient db)
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

    private static async Task<ArticleTemplateAuditLink[]> ReadAuditLinksAsync(
        SqlSugarClient db,
        Guid auditReference)
    {
        var rows = new List<ArticleTemplateAuditLink>();
        using var reader = (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT source, type, action, target_type, target_id, event_info,
                   reason_code, outcome, is_high_value
            FROM sys_audit_log
            WHERE target_type = 'article-template-receipt'
              AND replace(target_id, '-', '') = @AuditReference
            ORDER BY id;
            """,
            new SugarParameter("@AuditReference", auditReference.ToString("N")))
            .ConfigureAwait(false);
        while (await reader.ReadAsync().ConfigureAwait(false))
        {
            rows.Add(new(
                auditReference,
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetString(7),
                reader.GetBoolean(8)));
        }
        return [.. rows];
    }
}

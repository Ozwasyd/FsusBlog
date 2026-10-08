using System.Reflection;
using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Schema;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Algorithms.Schema;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorRecentArticleHistoryStoreIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorRecentArticleHistoryOwner s_owner = new(1, "primary-site");

    [Theory]
    [InlineData("current")]
    [InlineData("compiled")]
    [InlineData("direction")]
    [InlineData("null-placement")]
    [InlineData("operand-order")]
    [InlineData("missing-expression")]
    [InlineData("function")]
    [InlineData("arity")]
    [InlineData("last-key-direction")]
    public async Task HistoryIndex_ActualPostgresRetainsExpressionAndRejectsNativeDrift(string mutation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        const string original = "GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc)";
        if (mutation == "compiled")
        {
            Assembly assembly = typeof(CurrentSchemaOwnedProjectionExporter).Assembly;
            string source = assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .Single(static attribute => attribute.Key == "FsusBlog.SourceCommit").Value!;
            string taskRoot = Directory.CreateTempSubdirectory("fsusblog-history-index-owner-").FullName;
            var owned = await FsusBlog.Migration.OwnedCurrentSchemaTarget.InvokeOriginalOwnerAsync(
                assembly.Location, source, taskRoot, CancellationToken.None);
            Assert.Equal(0, owned.Execution.ExitCode);
            string sql = Assert.Single(owned.Compile(SchemaProviderKind.PostgreSql).Commands,
                static command => command.Sql.StartsWith("CREATE INDEX \"ix_author_recent_history_entry_order\"", StringComparison.Ordinal)).Sql;
            await db.Ado.ExecuteCommandAsync("DROP INDEX ix_author_recent_history_entry_order;");
            await db.Ado.ExecuteCommandAsync(sql);
        }
        else if (mutation != "current")
        {
            string expression = mutation switch
            {
                "operand-order" => "GREATEST(last_edited_at_utc, last_opened_at_utc, last_activated_at_utc)",
                "missing-expression" => "last_opened_at_utc",
                "function" => "LEAST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc)",
                "arity" => "GREATEST(last_opened_at_utc, last_edited_at_utc)",
                _ => original
            };
            string direction = mutation == "direction" ? "ASC" : "DESC";
            string nulls = mutation == "null-placement" ? " NULLS LAST" : string.Empty;
            string lastDirection = mutation == "last-key-direction" ? "ASC" : "DESC";
            await db.Ado.ExecuteCommandAsync($"""
                DROP INDEX ix_author_recent_history_entry_order;
                CREATE INDEX ix_author_recent_history_entry_order ON author_recent_history_entry(
                    owner_admin_principal_id, site_scope, {expression} {direction}{nulls}, article_id {lastDirection});
                """);
        }
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(
            inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        CurrentSchemaCompletePhysicalProjection whole = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            entity, CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes(), SchemaProviderKind.PostgreSql);
        SchemaTableModel table = whole.Tables.Tables["author_recent_history_entry"];
        var expected = new CurrentSchemaCompletePhysicalProjection(new SchemaModelSnapshot(
            new Dictionary<string, SchemaTableModel> { [table.Name] = table }, provider: SchemaProviderKind.PostgreSql), [], []);
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead);
        if (mutation is "function" or "arity")
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ReadTableAsync(
                connection, transaction, table.Name, CancellationToken.None));
            return;
        }
        SchemaModelSnapshot actual = await PgCurrentSchemaCatalogObserver.ReadTableAsync(
            connection, transaction, table.Name, CancellationToken.None);
        PgCurrentSchemaEffectObservation effects = await PgCurrentSchemaEffectObserver.ReadControlTableAsync(
            connection, transaction, table.Name, CancellationToken.None);
        IReadOnlyList<string> errors = PgCurrentSchemaNativeObserver.Compare(expected, actual, effects);
        if (mutation is not ("current" or "compiled"))
        {
            Assert.Contains(errors, static error => error.Contains("index mismatch", StringComparison.Ordinal));
            return;
        }
        Assert.Empty(errors);
        SchemaIndexKeyModel key = actual.Tables[table.Name].IndexDefinitions["ix_author_recent_history_entry_order"].Keys[2];
        Assert.Equal(string.Empty, key.Column);
        Assert.True(SchemaExpressionIdentity.Equal(table.IndexDefinitions["ix_author_recent_history_entry_order"].Keys[2].Expression!, key.Expression!));
        // The neutral tree survives serialization without relying on child-list reference identity.
        SchemaModelSnapshot replay = System.Text.Json.JsonSerializer.Deserialize<SchemaModelSnapshot>(
            System.Text.Json.JsonSerializer.Serialize(actual))!;
        Assert.Empty(PgCurrentSchemaNativeObserver.Compare(expected, replay, effects));
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT GREATEST(NULL::timestamp, TIMESTAMP '2026-01-01', NULL::timestamp);";
        Assert.Equal(new DateTime(2026, 1, 1), await command.ExecuteScalarAsync());
    }

    [Fact]
    public async Task Store_EnforcesCasIdempotencyProjectionOrderAndDurableSideEffects()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db,
            TimeProvider.System,
            new LocalMutationAuthorizer());

        AuthorRecentArticleHistoryCollectionSnapshot empty = await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.Equal(0, empty.Revision);
        Assert.Empty(empty.Entries);

        Guid requestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt opened = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            requestId);
        AuthorRecentArticleHistoryReceipt replay = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            requestId);
        Assert.Equal(1, opened.Revision);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(opened.ReceiptId, replay.ReceiptId);
        await Assert.ThrowsAsync<AuthorRecentArticleHistoryIdempotencyConflictException>(() =>
            store.RecordEditedAsync(s_owner, 1, 701, 0, requestId));

        Guid editRequestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt edited = await store.RecordEditedAsync(
            s_owner,
            1,
            701,
            opened.Revision,
            editRequestId);
        AuthorRecentArticleHistoryReceipt editReplay = await store.RecordEditedAsync(
            s_owner,
            1,
            701,
            opened.Revision,
            editRequestId);
        Guid activateRequestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt activated = await store.RecordActivatedAsync(
            s_owner,
            1,
            701,
            edited.Revision,
            activateRequestId);
        AuthorRecentArticleHistoryReceipt activateReplay = await store.RecordActivatedAsync(
            s_owner,
            1,
            701,
            edited.Revision,
            activateRequestId);
        Assert.Equal(3, activated.Revision);
        Assert.True(editReplay.IdempotentReplay);
        Assert.Equal(edited.ReceiptId, editReplay.ReceiptId);
        Assert.True(activateReplay.IdempotentReplay);
        Assert.Equal(activated.ReceiptId, activateReplay.ReceiptId);

        AuthorRecentArticleHistoryCollectionSnapshot snapshot = await store.GetAuthoritySnapshotAsync(s_owner);
        AuthorRecentArticleHistoryEntry entry = Assert.Single(snapshot.Entries);
        Assert.Equal(1, entry.ArticleId);
        Assert.Equal(701, entry.ServerRevision);
        Assert.NotNull(entry.LastOpenedAtUtc);
        Assert.NotNull(entry.LastEditedAtUtc);
        Assert.NotNull(entry.LastActivatedAtUtc);
        Assert.Equal("activate", entry.LastCommand);
        Assert.Equal(snapshot.ContentDigest, AuthorRecentArticleHistoryContract.ComputeCollectionDigest(
            s_owner,
            snapshot.Revision,
            snapshot.Entries));
        Assert.True((await store.VerifyAsync(s_owner)).Valid);

        Assert.Equal(3, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM author_recent_history_receipt WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site';"));
        Assert.Equal(3, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM author_recent_history_outbox WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site';"));
        Assert.Equal(3, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM author_recent_history_audit WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site';"));

        await Assert.ThrowsAsync<AuthorRecentArticleHistoryRevisionConflictException>(() =>
            store.RecordOpenedAsync(s_owner, 1, 701, 1, Guid.CreateVersion7()));
        await Assert.ThrowsAsync<AuthorRecentArticleHistoryAccessDeniedException>(() =>
            store.RecordOpenedAsync(s_owner, 999, 999, 3, Guid.CreateVersion7()));
        await db.Ado.ExecuteCommandAsync("UPDATE article SET status = 3 WHERE id = 1;");
        await Assert.ThrowsAsync<AuthorRecentArticleHistoryAccessDeniedException>(() =>
            store.RecordOpenedAsync(s_owner, 1, 701, 3, Guid.CreateVersion7()));
    }

    [Fact]
    public async Task Store_UsesStrictServerFactOrderWhenClockDoesNotAdvance()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db,
            new FixedTimeProvider(
                new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero)),
            new LocalMutationAuthorizer());

        AuthorRecentArticleHistoryReceipt first = await store.RecordOpenedAsync(
            s_owner,
            2,
            702,
            0,
            Guid.CreateVersion7());
        AuthorRecentArticleHistoryReceipt second = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            first.Revision,
            Guid.CreateVersion7());

        AuthorRecentArticleHistoryCollectionSnapshot snapshot =
            await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.True(second.AcceptedAtUtc > first.AcceptedAtUtc);
        Assert.Equal(
            [1, 2],
            snapshot.Entries
                .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
                .ThenByDescending(static entry => entry.ArticleId)
                .Select(static entry => entry.ArticleId));
    }

    [Fact]
    public async Task Store_RetentionEvictsOldestFactsWithoutLosingReceiptsOrCrossingSiteScope()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article(id, status, isdeleted, current_revision_id)
            SELECT id, 0, FALSE, id + 700
            FROM generate_series(3, 1001) AS id;
            """);
        var store = new AuthorRecentArticleHistoryStore(
            db,
            new FixedTimeProvider(
                new DateTimeOffset(2026, 9, 15, 12, 0, 0, TimeSpan.Zero)),
            new LocalMutationAuthorizer());
        var otherSite = new AuthorRecentArticleHistoryOwner(s_owner.AdminPrincipalId, "other-site");
        AuthorRecentArticleHistoryReceipt otherSiteReceipt = await store.RecordOpenedAsync(
            otherSite,
            1,
            701,
            0,
            Guid.CreateVersion7());

        Guid firstRequestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt first = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            firstRequestId);
        long revision = first.Revision;
        for (int articleId = 2; articleId <= 1001; articleId++)
        {
            AuthorRecentArticleHistoryReceipt receipt = await store.RecordOpenedAsync(
                s_owner,
                articleId,
                articleId + 700,
                revision,
                Guid.CreateVersion7());
            revision = receipt.Revision;
        }

        AuthorRecentArticleHistoryCollectionSnapshot retained = await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.Equal(1001, retained.Revision);
        Assert.Equal(1000, retained.ItemCount);
        Assert.Equal(
            Enumerable.Range(2, 1000).Reverse(),
            retained.Entries
                .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
                .ThenByDescending(static entry => entry.ArticleId)
                .Select(static entry => entry.ArticleId));

        AuthorRecentArticleHistoryReceipt replay = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            firstRequestId);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(first.ReceiptId, replay.ReceiptId);
        AuthorRecentArticleHistoryCollectionSnapshot afterReplay = await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.Equal(retained.Revision, afterReplay.Revision);
        Assert.Equal(retained.ContentDigest, afterReplay.ContentDigest);
        Assert.DoesNotContain(afterReplay.Entries, static entry => entry.ArticleId == 1);

        AuthorRecentArticleHistoryReceipt reactivated = await store.RecordActivatedAsync(
            s_owner,
            1,
            701,
            retained.Revision,
            Guid.CreateVersion7());
        AuthorRecentArticleHistoryCollectionSnapshot afterReactivation =
            await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.Equal(1002, reactivated.Revision);
        Assert.Equal(1000, afterReactivation.ItemCount);
        Assert.Contains(afterReactivation.Entries, static entry => entry.ArticleId == 1);
        Assert.DoesNotContain(afterReactivation.Entries, static entry => entry.ArticleId == 2);
        Assert.True((await store.VerifyAsync(s_owner)).Valid);

        foreach (string table in new[]
        {
            "author_recent_history_receipt",
            "author_recent_history_idempotency",
            "author_recent_history_outbox",
            "author_recent_history_audit"
        })
        {
            Assert.Equal(1002, await db.Ado.GetIntAsync(
                $"SELECT COUNT(*) FROM {table} WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site';"));
        }
        AuthorRecentArticleHistoryCollectionSnapshot otherSiteSnapshot =
            await store.GetAuthoritySnapshotAsync(otherSite);
        Assert.Equal(otherSiteReceipt.Revision, otherSiteSnapshot.Revision);
        Assert.Equal(otherSiteReceipt.ContentDigest, otherSiteSnapshot.ContentDigest);
        Assert.Equal(1, Assert.Single(otherSiteSnapshot.Entries).ArticleId);
        Assert.True((await store.VerifyAsync(otherSite)).Valid);
    }

    [Fact]
    public async Task Verifier_RejectsEntryAndReceiptTamperWithoutExposingArticleMetadata()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db,
            TimeProvider.System,
            new LocalMutationAuthorizer());
        Guid requestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt receipt = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            requestId);
        AuthorRecentArticleHistoryEntry originalEntry = Assert.Single(
            (await store.GetAuthoritySnapshotAsync(s_owner)).Entries);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_entry SET content_digest = @Digest WHERE article_id = 1 AND owner_admin_principal_id = 1;",
            new SugarParameter("@Digest", new string('f', 64)));
        AuthorRecentArticleHistoryVerificationResult entryTamper = await store.VerifyAsync(s_owner);
        Assert.False(entryTamper.Valid);
        Assert.Contains(entryTamper.Reasons, reason => reason.Contains("entry", StringComparison.Ordinal));

        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_entry SET content_digest = @Digest WHERE article_id = 1 AND owner_admin_principal_id = 1;",
            new SugarParameter("@Digest", originalEntry.ContentDigest));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_outbox SET payload_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", new string('d', 64)),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult outboxTamper = await store.VerifyAsync(s_owner);
        Assert.False(outboxTamper.Valid);
        Assert.Contains(outboxTamper.Reasons, reason => reason.Contains("durable_side_effect_missing", StringComparison.Ordinal));
        await Assert.ThrowsAsync<AuthorRecentArticleHistoryTamperDetectedException>(() =>
            store.RecordOpenedAsync(s_owner, 1, 701, 0, requestId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_outbox SET payload_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", receipt.ContentDigest),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_audit SET content_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", new string('c', 64)),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult auditTamper = await store.VerifyAsync(s_owner);
        Assert.False(auditTamper.Valid);
        Assert.Contains(auditTamper.Reasons, reason => reason.Contains("durable_side_effect_missing", StringComparison.Ordinal));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_audit SET content_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", receipt.ContentDigest),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        string forgedContentDigest = AuthorRecentArticleHistoryContract.HashText("forged-content");
        AuthorRecentArticleHistoryReceipt contentForged = receipt with
        {
            ContentDigest = forgedContentDigest,
            CacheReference = $"server-read-model:{s_owner.AdminPrincipalId}:{s_owner.SiteScope}:{forgedContentDigest}",
            ReceiptDigest = string.Empty
        };
        contentForged = contentForged with
        {
            ReceiptDigest = AuthorRecentArticleHistoryContract.ComputeReceiptDigest(contentForged)
        };
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE author_recent_history_receipt
            SET content_digest = @ContentDigest,
                cache_reference = @CacheReference,
                receipt_digest = @ReceiptDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_outbox
            SET payload_digest = @ContentDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_audit
            SET content_digest = @ContentDigest
            WHERE receipt_id = @ReceiptId;
            """,
            new SugarParameter("@ContentDigest", contentForged.ContentDigest),
            new SugarParameter("@CacheReference", contentForged.CacheReference),
            new SugarParameter("@ReceiptDigest", contentForged.ReceiptDigest),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult contentResealed =
            await store.VerifyAsync(s_owner);
        Assert.False(contentResealed.Valid);
        Assert.Contains(
            contentResealed.Reasons,
            reason => reason.Contains("receipt_projection_digest_mismatch", StringComparison.Ordinal));
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE author_recent_history_receipt
            SET content_digest = @ContentDigest,
                cache_reference = @CacheReference,
                receipt_digest = @ReceiptDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_outbox
            SET payload_digest = @ContentDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_audit
            SET content_digest = @ContentDigest
            WHERE receipt_id = @ReceiptId;
            """,
            new SugarParameter("@ContentDigest", receipt.ContentDigest),
            new SugarParameter("@CacheReference", receipt.CacheReference),
            new SugarParameter("@ReceiptDigest", receipt.ReceiptDigest),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_receipt SET receipt_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", new string('e', 64)),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult receiptTamper = await store.VerifyAsync(s_owner);
        Assert.False(receiptTamper.Valid);
        Assert.Contains(receiptTamper.Reasons, reason => reason.Contains("receipt_digest_mismatch", StringComparison.Ordinal));

        string forgedCommandDigest = AuthorRecentArticleHistoryContract.HashText("forged-command");
        AuthorRecentArticleHistoryReceipt forged = receipt with
        {
            CommandDigest = forgedCommandDigest,
            ReceiptDigest = string.Empty
        };
        forged = forged with
        {
            ReceiptDigest = AuthorRecentArticleHistoryContract.ComputeReceiptDigest(forged)
        };
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE author_recent_history_receipt
            SET command_digest = @CommandDigest, receipt_digest = @ReceiptDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_idempotency
            SET command_digest = @CommandDigest
            WHERE receipt_id = @ReceiptId;
            UPDATE author_recent_history_audit
            SET command_digest = @CommandDigest
            WHERE receipt_id = @ReceiptId;
            """,
            new SugarParameter("@CommandDigest", forged.CommandDigest),
            new SugarParameter("@ReceiptDigest", forged.ReceiptDigest),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult resealedTamper = await store.VerifyAsync(s_owner);
        Assert.False(resealedTamper.Valid);
        Assert.Contains(
            resealedTamper.Reasons,
            reason => reason.Contains("command_digest_mismatch", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TransactionFailure_RollsBackAuthorityReceiptAuditAndOutbox()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db,
            TimeProvider.System,
            new LocalMutationAuthorizer());
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE FUNCTION reject_recent_history_audit() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'injected audit failure';
            END;
            $$;
            CREATE TRIGGER reject_recent_history_audit
            BEFORE INSERT ON author_recent_history_audit
            FOR EACH ROW EXECUTE FUNCTION reject_recent_history_audit();
            """);

        await Assert.ThrowsAnyAsync<Exception>(() =>
            store.RecordOpenedAsync(s_owner, 1, 701, 0, Guid.CreateVersion7()));

        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_collection;"));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_entry;"));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_receipt;"));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_idempotency;"));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_outbox;"));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM author_recent_history_audit;"));
    }

    [Fact]
    public async Task Projection_UsesLivePermissionLifecycleAccountAndSiteScope()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db,
            TimeProvider.System,
            new LocalMutationAuthorizer());
        AuthorRecentArticleHistoryReceipt first = await store.RecordOpenedAsync(
            s_owner,
            1,
            701,
            0,
            Guid.CreateVersion7());
        await store.RecordEditedAsync(
            s_owner,
            2,
            702,
            first.Revision,
            Guid.CreateVersion7());

        var permission = CreatePermissionAuthority(db);
        var service = new AuthorRecentArticleHistoryProjectionService(
            store,
            permission,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        AuthorRecentArticleHistoryProjectionPage current = await service.ReadAsync(
            new(s_owner, Guid.CreateVersion7(), 10));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Current, current.Status);
        Assert.Equal([2, 1], current.Entries.Select(static entry => entry.ArticleId));
        Assert.True((await service.VerifyAsync(s_owner)).Valid);

        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article SET status = 3 WHERE id = 2;
            UPDATE article SET isdeleted = TRUE WHERE id = 1;
            """);
        AuthorRecentArticleHistoryProjectionPage filtered = await service.ReadAsync(
            new(s_owner, Guid.CreateVersion7(), 10));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Current, filtered.Status);
        Assert.Empty(filtered.Entries);
        AuthorRecentArticleHistoryVerificationResult verifiedFiltered =
            await service.VerifyAsync(s_owner);
        AssertEmptyVerification(verifiedFiltered, "author_recent_history_permission_verification_failed");

        SqlAuthorRecentArticleHistoryPermissionAuthority otherSite =
            CreatePermissionAuthority(db, siteScope: "other-site");
        var otherSiteService = new AuthorRecentArticleHistoryProjectionService(
            store,
            otherSite,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        AuthorRecentArticleHistoryProjectionPage siteDenied = await otherSiteService.ReadAsync(
            new(s_owner, Guid.CreateVersion7(), 10));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Unavailable, siteDenied.Status);
        Assert.Empty(siteDenied.Entries);
        AssertEmptyVerification(
            await otherSiteService.VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");

        SqlAuthorRecentArticleHistoryPermissionAuthority otherAccount =
            CreatePermissionAuthority(db, adminPrincipalId: 2);
        var otherAccountService = new AuthorRecentArticleHistoryProjectionService(
            store,
            otherAccount,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        AuthorRecentArticleHistoryProjectionPage accountDenied = await otherAccountService.ReadAsync(
            new(s_owner, Guid.CreateVersion7(), 10));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Unavailable, accountDenied.Status);
        Assert.Empty(accountDenied.Entries);
        AssertEmptyVerification(
            await otherAccountService.VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");

        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP WHERE sessionid = 'history-session';");
        AuthorRecentArticleHistoryProjectionPage revoked = await service.ReadAsync(
            new(s_owner, Guid.CreateVersion7(), 10));
        Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Unavailable, revoked.Status);
        Assert.Empty(revoked.Entries);
        AssertEmptyVerification(
            await service.VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");
    }

    [Theory]
    [InlineData("revoked", false)]
    [InlineData("revoked", true)]
    [InlineData("idle-expired", false)]
    [InlineData("idle-expired", true)]
    [InlineData("absolute-expired", false)]
    [InlineData("absolute-expired", true)]
    [InlineData("permission-removed", false)]
    [InlineData("permission-removed", true)]
    public async Task Verifier_LiveSessionDenialHidesFactsEvenWhenAuthorityIsTampered(
        string denial,
        bool tamperAuthority)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db, TimeProvider.System, new LocalMutationAuthorizer());
        Guid requestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt receipt = await store.RecordOpenedAsync(
            s_owner, 1, 701, 0, requestId);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = await store.GetAuthoritySnapshotAsync(s_owner);
        var permission = CreatePermissionAuthority(db);
        var service = new AuthorRecentArticleHistoryProjectionService(
            store,
            permission,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        AuthorRecentArticleHistoryVerificationResult current = await service.VerifyAsync(s_owner);
        Assert.True(current.Valid);
        Assert.Equal(snapshot.Revision, current.Revision);
        Assert.Equal(snapshot.ItemCount, current.ItemCount);
        Assert.Equal(snapshot.ContentDigest, current.AuthorityContentDigest);
        Assert.True(snapshot.Revision > 0);
        Assert.Equal(1, snapshot.ItemCount);

        if (tamperAuthority)
        {
            await db.Ado.ExecuteCommandAsync(
                "UPDATE author_recent_history_outbox SET payload_digest = @Digest WHERE receipt_id = @ReceiptId;",
                new SugarParameter("@Digest", AuthorRecentArticleHistoryContract.HashText("tampered-outbox")),
                new SugarParameter("@ReceiptId", receipt.ReceiptId));
        }
        AuthorRecentArticleHistoryVerificationResult authority = await store.VerifyAsync(s_owner);
        Assert.Equal(!tamperAuthority, authority.Valid);
        if (tamperAuthority)
        {
            Assert.Contains(authority.Reasons, reason => reason.Contains(requestId.ToString("D"), StringComparison.Ordinal));
        }

        string denySql = denial switch
        {
            "revoked" => "UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP WHERE sessionid = 'history-session';",
            "idle-expired" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2000-01-01 00:00:00' WHERE sessionid = 'history-session';",
            "absolute-expired" => "UPDATE admin_session SET absoluteexpiresatutc = TIMESTAMP '2000-01-01 00:00:00' WHERE sessionid = 'history-session';",
            "permission-removed" => "UPDATE admin_principal SET permissions = '' WHERE id = 1;",
            _ => throw new ArgumentOutOfRangeException(nameof(denial))
        };
        await db.Ado.ExecuteCommandAsync(denySql);
        AuthorRecentArticleHistoryPermissionSnapshot denied = await permission.ResolveAsync(
            new(s_owner, Guid.CreateVersion7(), [1]));
        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, denied.Status);

        AssertEmptyVerification(
            await service.VerifyAsync(s_owner),
            "author_recent_history_permission_verification_failed");
    }

    [Fact]
    public async Task Verifier_LiveCurrentPermissionHidesTamperedAuthorityFactsAndRequestReasons()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db, TimeProvider.System, new LocalMutationAuthorizer());
        Guid requestId = Guid.CreateVersion7();
        AuthorRecentArticleHistoryReceipt receipt = await store.RecordOpenedAsync(
            s_owner, 1, 701, 0, requestId);
        var permission = CreatePermissionAuthority(db);
        var service = new AuthorRecentArticleHistoryProjectionService(
            store,
            permission,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        Assert.True((await service.VerifyAsync(s_owner)).Valid);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_recent_history_outbox SET payload_digest = @Digest WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@Digest", AuthorRecentArticleHistoryContract.HashText("tampered-outbox")),
            new SugarParameter("@ReceiptId", receipt.ReceiptId));
        AuthorRecentArticleHistoryVerificationResult authority = await store.VerifyAsync(s_owner);
        Assert.False(authority.Valid);
        Assert.Contains(authority.Reasons, reason => reason.Contains(requestId.ToString("D"), StringComparison.Ordinal));
        AuthorRecentArticleHistoryPermissionSnapshot current = await permission.ResolveAsync(
            new(s_owner, Guid.CreateVersion7(), [1]));
        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, current.Status);
        Assert.True(Assert.Single(current.Decisions).CanProject);

        AssertEmptyVerification(
            await service.VerifyAsync(s_owner),
            "author_recent_history_authority_verification_mismatch");
    }

    [Theory]
    [InlineData("archived")]
    [InlineData("deleted")]
    public async Task Verifier_LiveArticleFilteringHidesPartialAndAllDeniedCollectionFacts(string lifecycle)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new AuthorRecentArticleHistoryStore(
            db, TimeProvider.System, new LocalMutationAuthorizer());
        AuthorRecentArticleHistoryReceipt first = await store.RecordOpenedAsync(
            s_owner, 1, 701, 0, Guid.CreateVersion7());
        await store.RecordEditedAsync(s_owner, 2, 702, first.Revision, Guid.CreateVersion7());
        AuthorRecentArticleHistoryCollectionSnapshot snapshot = await store.GetAuthoritySnapshotAsync(s_owner);
        var permission = CreatePermissionAuthority(db);
        var service = new AuthorRecentArticleHistoryProjectionService(
            store,
            permission,
            new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
            new DirectAuthorRecentArticleHistoryProjectionCache());
        AuthorRecentArticleHistoryVerificationResult authorized = await service.VerifyAsync(s_owner);
        Assert.True(authorized.Valid);
        Assert.Equal(2, authorized.ItemCount);
        Assert.Equal(2, authorized.VisibleItemCount);
        Assert.Equal(snapshot.ContentDigest, authorized.AuthorityContentDigest);

        foreach (int articleId in new[] { 2, 1 })
        {
            string filterSql = lifecycle switch
            {
                "archived" => "UPDATE article SET status = 3 WHERE id = @ArticleId;",
                "deleted" => "UPDATE article SET isdeleted = TRUE WHERE id = @ArticleId;",
                _ => throw new ArgumentOutOfRangeException(nameof(lifecycle))
            };
            await db.Ado.ExecuteCommandAsync(filterSql, new SugarParameter("@ArticleId", articleId));
            AuthorRecentArticleHistoryPermissionSnapshot resolved = await permission.ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), [1, 2]));
            Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, resolved.Status);
            Assert.False(resolved.Decisions.Single(decision => decision.ArticleId == articleId).CanProject);
            Assert.Equal(articleId == 2 ? 1 : 0, resolved.Decisions.Count(static decision => decision.CanProject));
            Assert.True((await store.VerifyAsync(s_owner)).Valid);

            AuthorRecentArticleHistoryProjectionPage filtered = await service.ReadAsync(
                new(s_owner, Guid.CreateVersion7(), 10));
            Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Current, filtered.Status);
            Assert.Equal(articleId == 2 ? 1 : 0, filtered.Entries.Count);
            Assert.DoesNotContain(filtered.Entries, entry => entry.ArticleId == articleId);
            AssertEmptyVerification(
                await service.VerifyAsync(s_owner),
                "author_recent_history_permission_verification_failed");

            AuthorRecentArticleHistoryProjectionPage terminal = await service.ReadAsync(
                new(s_owner, Guid.CreateVersion7(), 10, ExpectedCollectionRevision: snapshot.Revision + 1));
            Assert.Equal(AuthorRecentArticleHistoryProjectionStatus.Stale, terminal.Status);
            Assert.Equal("author_recent_history_collection_stale", terminal.ReasonCode);
            Assert.Equal(0, terminal.CollectionRevision);
            Assert.Empty(terminal.Entries);
            Assert.Null(terminal.NextCursor);
            Assert.False(terminal.HasMore);
            Assert.Empty(terminal.PermissionRevision);
            Assert.Empty(terminal.SiteRevision);
            Assert.Empty(terminal.SessionRevision);
            Assert.Empty(terminal.PermissionContentDigest);
            Assert.Empty(terminal.ProjectionReference);
            Assert.Empty(terminal.CacheReference);
            Assert.Equal(AuthorRecentArticleHistoryProjectionPage.Empty(
                s_owner, terminal.Status, "author_recent_history_collection_stale").ContentDigest, terminal.ContentDigest);
        }
    }

    private static void AssertEmptyVerification(
        AuthorRecentArticleHistoryVerificationResult result,
        string reason)
    {
        Assert.False(result.Valid);
        Assert.Equal(reason, Assert.Single(result.Reasons));
        Assert.Equal(0, result.Revision);
        Assert.Equal(0, result.ItemCount);
        Assert.Equal(0, result.VisibleItemCount);
        Assert.Empty(result.ContentDigest);
        Assert.Empty(result.AuthorityContentDigest);
        Assert.Empty(result.PermissionContentDigest);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1000)]
    [InlineData(1001)]
    public async Task QuerySource_LivePostgresArrayBindingsProduceOnlyBoundedRealFieldsAndMissingSlug(int count)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await SeedQueryFieldsAsync(db, count);
        var reader = CreateCanonicalQueryReader(db);
        var inspection = new AuthorArticleQuerySourceInspection(CreatePermissionAuthority(db), reader);
        AuthorArticleQuerySourceInspectionResult result = await inspection.InspectAsync(QueryRequest());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(Math.Min(count, 1000), result.ObservedFields.Count);
        Assert.Equal(count > 1000, result.HasMore);
        foreach (AuthorArticleQuerySourceFields field in result.ObservedFields)
        {
            Assert.Equal($"Article {field.Coordinate.ArticleId}", field.Title);
            Assert.Equal("Category source", field.Category);
            Assert.Equal(new[] { "Tag source" }, field.Tags);
            Assert.Equal(700 + field.Coordinate.ArticleId, field.Coordinate.ServerRevision);
            Assert.Equal(AuthorArticleQueryStatus.Draft, field.Coordinate.Status);
            Assert.False(string.IsNullOrWhiteSpace(field.Coordinate.RowVersion));
        }
    }

    [Fact]
    public async Task QuerySource_WrongSiteAndPersistedSessionRevocationReadNoMetadata()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await SeedQueryFieldsAsync(db, 1);
        var source = new QuerySourceInterruptionProbe(CreateCanonicalQueryReader(db));
        var inspection = new AuthorArticleQuerySourceInspection(CreatePermissionAuthority(db), source);
        AuthorArticleQuerySourceInspectionResult otherSite = await inspection.InspectAsync(
            QueryRequest() with
            {
                Owner = new(1, "other-site")
            });
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable, otherSite.UnavailableReason);
        Assert.Empty(otherSite.ObservedFields);
        await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;");
        AuthorArticleQuerySourceInspectionResult revoked = await inspection.InspectAsync(QueryRequest());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable, revoked.UnavailableReason);
        Assert.Empty(revoked.ObservedFields);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task QuerySource_LiveRevisionChangeCannotEscapePermissionAdmittedMetadata()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await SeedQueryFieldsAsync(db, 1);
        var source = new QuerySourceInterruptionProbe(CreateCanonicalQueryReader(db))
        {
            AfterCoordinates = async () =>
            {
                await db.Ado.ExecuteCommandAsync("UPDATE article SET current_revision_id = current_revision_id + 1;");
            }
        };
        var inspection = new AuthorArticleQuerySourceInspection(CreatePermissionAuthority(db), source);
        AuthorArticleQuerySourceInspectionResult result = await inspection.InspectAsync(QueryRequest());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(1, source.FieldReads);
    }

    [Fact]
    public async Task QuerySource_LiveSessionRevocationAfterMetadataDiscardsEveryObservedField()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await SeedQueryFieldsAsync(db, 1);
        var source = new QuerySourceInterruptionProbe(CreateCanonicalQueryReader(db))
        {
            AfterFields = async () =>
            {
                await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;");
            }
        };
        var inspection = new AuthorArticleQuerySourceInspection(CreatePermissionAuthority(db), source);
        AuthorArticleQuerySourceInspectionResult result = await inspection.InspectAsync(QueryRequest());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(1, source.FieldReads);
    }

    [Theory]
    [InlineData("current")]
    [InlineData("wrong-token")]
    [InlineData("revision")]
    [InlineData("deleted")]
    [InlineData("archived")]
    [InlineData("session-revoked")]
    [InlineData("permission-revoked")]
    [InlineData("revision-during-read")]
    [InlineData("session-during-read")]
    public async Task Selection_LivePostgresRevalidatesOriginalPermissionAndCurrentArticle(string fault)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await SeedQueryFieldsAsync(db, 1);
        var permission = CreatePermissionAuthority(db);
        var admitted = await permission.ResolveAsync(new(s_owner, Guid.CreateVersion7(), [1]));
        string token = Assert.Single(admitted.Decisions).DecisionDigest;
        switch (fault)
        {
            case "revision":
                await db.Ado.ExecuteCommandAsync("UPDATE article SET current_revision_id = 702;");
                break;
            case "deleted":
                await db.Ado.ExecuteCommandAsync("UPDATE article SET isdeleted = true;");
                break;
            case "archived":
                await db.Ado.ExecuteCommandAsync("UPDATE article SET status = 3;");
                break;
            case "session-revoked":
                await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;");
                break;
            case "permission-revoked":
                await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions = '';");
                break;
        }
        var source = new QuerySourceInterruptionProbe(CreateCanonicalQueryReader(db))
        {
            AfterFields = async () =>
            {
                if (fault == "revision-during-read")
                {
                    await db.Ado.ExecuteCommandAsync("UPDATE article SET current_revision_id = 702;");
                }
                else if (fault == "session-during-read")
                {
                    await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP;");
                }
            }
        };
        var result = await new AuthorArticleQuerySelectionRevalidator(permission, source).RevalidateAsync(
            s_owner, 1, 701, fault == "wrong-token" ? AuthorRecentArticleHistoryContract.HashText("wrong-token") : token,
            Guid.CreateVersion7());
        Assert.Equal(fault == "current", result.Current);
        Assert.Equal(fault == "current" ? token : null, result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(fault is "current" or "revision-during-read" ? 2
            : fault is "revision" or "session-during-read" ? 1 : 0, source.FieldReads);
        if (fault == "current")
        {
            Guid repeatedRequest = Guid.CreateVersion7();
            var repeated = await new AuthorArticleQuerySelectionRevalidator(permission, source).RevalidateAsync(
                s_owner, 1, 701, token, repeatedRequest);
            Assert.True(repeated.Current);
            Assert.Equal(repeatedRequest, repeated.RequestId);
            Assert.Equal(4, source.FieldReads);
        }
    }

    private static AuthorArticleQueryRequest QueryRequest()
        => new(1, new(s_owner.AdminPrincipalId, s_owner.SiteScope), Guid.CreateVersion7(), 1, "Article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Draft], "zh-CN",
            AuthorArticleQueryContract.Collation, 50, null);

    private static async Task SeedQueryFieldsAsync(SqlSugarClient db, int count)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            ALTER TABLE article ADD COLUMN title text NOT NULL DEFAULT '';
            ALTER TABLE article ADD COLUMN categoryid integer NOT NULL DEFAULT 1;
            CREATE TABLE category(id integer PRIMARY KEY, name text NOT NULL);
            CREATE TABLE tag(id integer PRIMARY KEY, name text NOT NULL);
            CREATE TABLE article_tag(articleid integer NOT NULL, tagid integer NOT NULL,
                                     PRIMARY KEY(articleid, tagid));
            INSERT INTO category VALUES(1, 'Category source');
            INSERT INTO tag VALUES(1, 'Tag source');
            DELETE FROM article;
            INSERT INTO article(id, status, isdeleted, current_revision_id, title, categoryid)
            SELECT id, 0, FALSE, 700 + id, 'Article ' || id::text, 1
            FROM generate_series(1, @Count) AS id;
            INSERT INTO article_tag(articleid, tagid) SELECT id, 1 FROM article;
            """,
            new SugarParameter("@Count", count));
    }

    private static IAuthorArticleQuerySourceReader CreateCanonicalQueryReader(SqlSugarClient db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());
    }

    private sealed class QuerySourceInterruptionProbe(IAuthorArticleQuerySourceReader source) : IAuthorArticleQuerySourceReader
    {
        public Func<Task>? AfterCoordinates
        {
            get; init;
        }
        public Func<Task>? AfterFields
        {
            get; init;
        }
        public int CoordinateReads
        {
            get; private set;
        }
        public int FieldReads
        {
            get; private set;
        }

        public async Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
        {
            CoordinateReads++;
            AuthorArticleQuerySourceBatch result = await source.ReadCoordinatesAsync(statuses, cancellationToken);
            if (AfterCoordinates is not null)
            {
                await AfterCoordinates();
            }
            return result;
        }

        public async Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
        {
            FieldReads++;
            IReadOnlyList<AuthorArticleQuerySourceFields> result = await source.ReadFieldsAsync(admittedArticleIds, cancellationToken);
            if (AfterFields is not null)
            {
                await AfterFields();
            }
            return result;
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(
                id bigint PRIMARY KEY,
                status varchar(32) NOT NULL,
                isroot boolean NOT NULL,
                permissions text NOT NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES (1, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(
                sessionid varchar(64) PRIMARY KEY,
                adminprincipalid bigint NOT NULL REFERENCES admin_principal(id),
                revokedatutc timestamp without time zone NULL,
                idleexpiresatutc timestamp without time zone NOT NULL,
                absoluteexpiresatutc timestamp without time zone NOT NULL);
            INSERT INTO admin_session(
                sessionid, adminprincipalid, revokedatutc,
                idleexpiresatutc, absoluteexpiresatutc)
            VALUES(
                'history-session', 1, NULL,
                TIMESTAMP '2099-01-01 00:00:00',
                TIMESTAMP '2099-01-02 00:00:00');
            CREATE TABLE article(
                id integer PRIMARY KEY,
                status integer NOT NULL,
                isdeleted boolean NOT NULL,
                current_revision_id bigint NULL);
            INSERT INTO article(id, status, isdeleted, current_revision_id)
            VALUES (1, 0, FALSE, 701), (2, 2, FALSE, 702);
            """);
        ISchemaMigrationDescriptor migration = AuthorRecentArticleHistoryMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static SqlAuthorRecentArticleHistoryPermissionAuthority CreatePermissionAuthority(
        ISqlSugarClient db,
        string siteScope = "primary-site",
        long adminPrincipalId = 1)
    {
        var identity = new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", adminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("admin_sid", "history-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ],
        "test");
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity)
            }
        };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = siteScope
            })
            .Build();
        return new SqlAuthorRecentArticleHistoryPermissionAuthority(
            db,
            accessor,
            configuration,
            TimeProvider.System);
    }

    private sealed class LocalMutationAuthorizer : IAuthorRecentArticleHistoryMutationAuthorizer
    {
        public Task AuthorizeAsync(
            AuthorRecentArticleHistoryOwner owner,
            int articleId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}

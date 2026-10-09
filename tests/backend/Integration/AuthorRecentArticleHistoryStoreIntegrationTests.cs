using System.Security.Claims;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorRecentArticleHistoryStoreIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorRecentArticleHistoryOwner s_owner = new(1, "primary-site");

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
            new AuthorRecentArticleHistoryPersistedPermissionReader(db, configuration, TimeProvider.System),
            accessor,
            configuration);
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

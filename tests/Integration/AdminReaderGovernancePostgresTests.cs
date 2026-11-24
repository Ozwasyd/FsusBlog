using static FsusBlog.V2.Integration.Tests.SiteAedsFixture;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminReaderGovernancePostgresTests
{
    [PostgresFact]
    public async Task ListReadersFiltersSearchesPaginatesAndEnforcesAdminSessionIsolation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var admin = await fixture.AdminAsync("reader-gov-admin", 15, RandomNumberGenerator.GetBytes(32), [2], ct);
        var siteSession = await fixture.SignInSiteUser("reader-gov-site-caller", ct);
        var (gate, store) = OpenStore(fixture);

        await Denied(Rejection.Unauthorized, () => store.ListReaders(null, Query(), ct));
        await Denied(Rejection.Unauthorized, () => store.ListReaders(siteSession.Token, Query(), ct));

        // Seed 26 readers in addition to the site caller (27 total) to exercise keyset pagination past page size 24.
        var (specialUser, disabledUser, richUser) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var seededIds = new HashSet<Guid> { siteSession.Id, specialUser, disabledUser, richUser };
        foreach (var (id, name, enabled, key) in new[]
        {
            (specialUser, "reader_%_literal", true, (byte)3),
            (disabledUser, "suspended-member", false, (byte)4),
            (richUser, "alice-account", true, (byte)5),
        })
        {
            await fixture.SiteAccountAsync(id, name, enabled, ct);
            await fixture.SitePasskeyAsync(id, RandomNumberGenerator.GetBytes(16), [key], ct);
        }
        await fixture.Exec("insert into public.comment_public_handle(user_id, display_name) values($1, $2)", richUser, "Alice Display Handle");
        await fixture.Exec("""
            insert into public.site_recovery_key(user_id, lookup_digest, salt, verifier, version, created_at, failed_count)
            values($1, $2, $3, $4, 1, clock_timestamp(), 0)
            """, richUser, RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(16), RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.mfa_totp(user_id, sealed_seed, last_step, verified_at, retry_after, failed_count)
            values($1, $2, 1, clock_timestamp(), clock_timestamp(), 0)
            """, richUser, RandomNumberGenerator.GetBytes(49));
        // Two active generation-1 sessions, one expired session, and one stale generation-99 session.
        foreach (var (minutes, generation) in new[] { (30, 1L), (30, 1L), (-5, 1L), (30, 99L) })
            await fixture.SiteSessionAsync(richUser, DateTimeOffset.UtcNow.AddMinutes(minutes), generation, null, ct: ct);

        // Seed an article and comment owned by richUser to verify CommentCount.
        await fixture.Exec("""
            with article as (
                insert into public.article(id, owner_id, revision, title, body, deleted) overriding system value
                values(1, $1, 1, 'Reader test article', 'Body', false) returning id
            )
            insert into public.article_revision(article_id, revision, title, body, happened_at)
            select id, 1, 'Reader test article', 'Body', clock_timestamp() from article
            """, admin.Id);
        await fixture.Exec("""
            insert into public.comment(article_id, id, root_id, depth, moderation_status, deleted, body, author_mode, display_name, display_language, created_at)
            values(1, 1, 1, 0, 1, false, 'Hello from Alice', 3, 'Alice Display Handle', 'en', clock_timestamp())
            """);
        await fixture.Exec("insert into public.comment_account_owner(article_id, comment_id, user_id) values(1, 1, $1)", richUser);

        for (var i = 0; i < 23; i++)
        {
            var id = Guid.NewGuid();
            seededIds.Add(id);
            await fixture.SiteAccountAsync(id, $"batch-reader-{i:D2}", true, ct);
            await fixture.SitePasskeyAsync(id, RandomNumberGenerator.GetBytes(16), [6], ct);
        }

        // Verify page 1 + page 2 keyset pagination covers every seeded account without overlap or loss.
        var first = await store.ListReaders(admin.Token, Query(), ct);
        Assert.Equal((await gate.SessionWithPermissionBinding(admin.Token, ct)).PermissionSession, first.PermissionSession);
        Assert.Equal((27, 26, 1, true, WireLimits.AdminReaderPageSize),
            (first.Page.Total, first.Page.EnabledTotal, first.Page.DisabledTotal, first.Page.HasMore, first.Page.Items.Count));
        Assert.NotEqual(Guid.Empty, first.Page.NextCursorUserId);

        var second = await store.ListReaders(admin.Token, Query(
            ("afterAccountId", first.Page.NextCursorAccountId.ToString()),
            ("afterUserId", first.Page.NextCursorUserId.ToString())), ct);
        Assert.Equal((false, 0L, Guid.Empty, 3),
            (second.Page.HasMore, second.Page.NextCursorAccountId, second.Page.NextCursorUserId, second.Page.Items.Count));

        var allListedIds = first.Page.Items.Concat(second.Page.Items).Select(x => x.UserId).ToArray();
        Assert.Equal(seededIds.Count, allListedIds.Length);
        Assert.Equal(seededIds, allListedIds.ToHashSet());

        // Verify status filter counts and results.
        var disabledOnly = await store.ListReaders(admin.Token, Query(("status", "disabled")), ct);
        Assert.Equal((1, 26, 1, disabledUser),
            (disabledOnly.Page.Total, disabledOnly.Page.EnabledTotal, disabledOnly.Page.DisabledTotal, Assert.Single(disabledOnly.Page.Items).UserId));

        var enabledOnly = await store.ListReaders(admin.Token, Query(("status", "enabled")), ct);
        Assert.Equal(26, enabledOnly.Page.Total);
        Assert.All(enabledOnly.Page.Items, row => Assert.True(row.Enabled));

        // Verify keyword search by display name, #accountId, and LIKE metacharacter escaping.
        var byDisplay = await store.ListReaders(admin.Token, Query(("keyword", "Alice Display")), ct);
        var alice = Assert.Single(byDisplay.Page.Items);
        Assert.Equal((richUser, "alice-account", "Alice Display Handle", true, 1L, 1, true, true, 2, 1, 0L, "", ""),
            (alice.UserId, alice.Name, alice.DisplayName, alice.Enabled, alice.Generation, alice.PasskeyCount,
                alice.HasRecoveryKey, alice.HasTotp, alice.ActiveSessionCount, alice.CommentCount,
                alice.LastGovernanceAtUnixMs, alice.LastGovernanceActor, alice.LastGovernanceReason));
        Assert.True(alice.RegisteredAtUnixMs > 0);

        var byAccountId = await store.ListReaders(admin.Token, Query(("keyword", $"#{alice.AccountId}")), ct);
        Assert.Equal(richUser, Assert.Single(byAccountId.Page.Items).UserId);
        var byLikeMetachar = await store.ListReaders(admin.Token, Query(("keyword", "_%_")), ct);
        Assert.Equal(specialUser, Assert.Single(byLikeMetachar.Page.Items).UserId);

        // Verify wire roundtrip of the rich page.
        var decoded = Wire.DecodeAdminReaderAccountPage(Wire.EncodeAdminReaderAccountPage(byDisplay.Page));
        Assert.Equal(byDisplay.Page.Total, decoded.Total);
        Assert.Equal(alice, Assert.Single(decoded.Items));

        // Invalid query parameters fail closed.
        await Denied(Rejection.Invalid, () => store.ListReaders(admin.Token, Query(("status", "unknown")), ct));
        await Denied(Rejection.Invalid, () => store.ListReaders(admin.Token, Query(("afterAccountId", "1")), ct));
    }

    [PostgresFact]
    public async Task BanAndUnbanRequireStepUpPurgeAllReaderSessionsIncrementGenerationAndHonorIdempotency()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var admin = await fixture.AdminAsync("gov-operator", 15, RandomNumberGenerator.GetBytes(32), [2], ct);
        var otherAdmin = await fixture.AdminAsync("gov-other", 15, RandomNumberGenerator.GetBytes(32), [2], ct);
        var (_, store) = OpenStore(fixture);

        var (target, bystander) = (Guid.NewGuid(), Guid.NewGuid());
        foreach (var (id, name, key) in new[] { (target, "abuser-reader", (byte)7), (bystander, "bystander-reader", (byte)8) })
        {
            await fixture.SiteAccountAsync(id, name, true, ct);
            await fixture.SitePasskeyAsync(id, RandomNumberGenerator.GetBytes(16), [key], ct);
        }

        // Seed live + expired sessions, refresh family, tickets, passkey challenge, MFA & recovery flows for target, plus a live session for bystander.
        var liveSession1 = await fixture.SiteSessionAsync(target, DateTimeOffset.UtcNow.AddMinutes(30), 1, null, ct: ct);
        var liveSession2 = await fixture.SiteSessionAsync(target, DateTimeOffset.UtcNow.AddMinutes(30), 1, null, ct: ct);
        await fixture.SiteSessionAsync(target, DateTimeOffset.UtcNow.AddMinutes(-10), 1, null, ct: ct);
        var bystanderSession = await fixture.SiteSessionAsync(bystander, DateTimeOffset.UtcNow.AddMinutes(30), 1, null, ct: ct);

        await fixture.Exec("""
            insert into public.site_session_refresh(family_id, access_digest, refresh_digest, generation, idle_expires_at, absolute_expires_at, rotated_at)
            values($1, $2, $3, 1, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 day', clock_timestamp())
            """, Guid.NewGuid(), liveSession1.Digest, RandomNumberGenerator.GetBytes(32));
        await fixture.WithConnection(db => FixtureSql.IssueLoginTicketAsync(db, null, ct, target), ct);
        await fixture.Exec("""
            insert into public.passkey_challenge(digest, user_id, generation, options, expires_at, binding_digest)
            values($1, $2, 1, '{}', clock_timestamp() + interval '5 minutes', $3)
            """, RandomNumberGenerator.GetBytes(32), target, RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.mfa_setup(user_id, generation, session_digest, sealed_seed, expires_at, failed_count)
            values($1, 1, $2, $3, clock_timestamp() + interval '5 minutes', 0)
            """, target, liveSession1.Digest, RandomNumberGenerator.GetBytes(49));
        await fixture.Exec("""
            insert into public.mfa_flow(digest, user_id, generation, kind, scope, options, expires_at)
            values($1, $2, 1, 1, $3, '{}', clock_timestamp() + interval '5 minutes')
            """, RandomNumberGenerator.GetBytes(32), target, RandomNumberGenerator.GetBytes(16));
        await fixture.Exec("""
            insert into public.site_recovery_flow(digest, user_id, generation, session_digest, purpose, kind, options, expires_at)
            values($1, $2, 1, $3, 1, 1, '{}', clock_timestamp() + interval '5 minutes')
            """, RandomNumberGenerator.GetBytes(32), target, liveSession1.Digest);
        await fixture.Exec("""
            insert into public.site_recovery_rebind(user_id, generation, ticket_digest, expires_at)
            values($1, 1, $2, clock_timestamp() + interval '5 minutes')
            """, target, RandomNumberGenerator.GetBytes(32));

        // Before banning, target's live session works.
        var siteStore = new Store(fixture.DataSource);
        Assert.Equal(target, await siteStore.WithSession(liveSession1.Token, false, (_, _, actor) => Task.FromResult(actor.Id), ct));

        var banCommand = new AdminReaderStatusCommand(target, 1, false, Guid.NewGuid(), "Automated spam comments");
        var banFingerprint = AdminReaderGovernanceStore.CommandFingerprint(banCommand);

        // Begin Step-Up fails on stale generation or same state, succeeds on valid command.
        await Denied(Rejection.Conflict, () => store.BeginStatusStepUp(admin.Token, banCommand with { ExpectedGeneration = 2 }, ct));
        await Denied(Rejection.Conflict, () => store.BeginStatusStepUp(admin.Token, banCommand with { TargetEnabled = true }, ct));
        Aeds.Decode(await store.BeginStatusStepUp(admin.Token, banCommand, ct), FrameType.PasskeyLoginBegin);
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.admin_reader_governance_step_up
            where session_digest=$1 and action=12 and body_digest=$2 and kind=1
            """, admin.Digest, banFingerprint));

        // Missing, expired, other-admin, and mismatched-intent proofs are rejected with ReaderGovernanceProofRequiredException.
        var expiredProof = await SeedProof(fixture, admin, banFingerprint, lifetimeSeconds: -5);
        var proof = await SeedProof(fixture, admin, banFingerprint, lifetimeSeconds: 45);
        foreach (var (token, stepUpProof, cmd) in new[]
        {
            (admin.Token, (string?)null, banCommand),
            (admin.Token, expiredProof, banCommand),
            (otherAdmin.Token, proof, banCommand),
            (admin.Token, proof, banCommand with { Reason = "Changed reason after step-up" }),
        })
            await Assert.ThrowsAsync<ReaderGovernanceProofRequiredException>(() => store.ExecuteStatusChange(token, stepUpProof, cmd, ct));

        // Execute ban with valid proof.
        var banned = (await store.ExecuteStatusChange(admin.Token, proof, banCommand, ct)).Receipt;
        Assert.Equal((target, false, 2L, 2, false), (banned.UserId, banned.Enabled, banned.Generation, banned.RevokedSessionCount, banned.Replayed));
        Assert.True(banned.HappenedAtUnixMs > 0);

        // Proof-less idempotency replay returns the exact stored receipt without re-mutating DB; conflicting payload fails with 409.
        Assert.Equal(banned with { Replayed = true }, (await store.ExecuteStatusChange(admin.Token, null, banCommand, ct)).Receipt);
        await Denied(Rejection.Conflict, () =>
            store.ExecuteStatusChange(admin.Token, null, banCommand with { Reason = "Different reason same key" }, ct));

        // Target's active sessions and all transient auth/recovery rows are completely purged; bystander is untouched.
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_session_refresh"));
        foreach (var table in new[] { "user_session", "login_ticket", "passkey_challenge", "mfa_setup", "mfa_flow", "site_recovery_flow", "site_recovery_rebind" })
            Assert.Equal(0L, await fixture.Scalar<long>($"select count(*) from public.{table} where user_id=$1", target));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.user_session where user_id=$1", bystander));

        // Previously valid reader sessions fail immediately; bystander session still works.
        foreach (var tok in new[] { liveSession1.Token, liveSession2.Token })
            await Denied(Rejection.Unauthorized, () => siteStore.WithSession(tok, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        Assert.Equal(bystander, await siteStore.WithSession(bystanderSession.Token, false, (_, _, actor) => Task.FromResult(actor.Id), ct));

        // ListReaders reflects banned status, incremented generation, 0 active sessions, and immutable audit metadata.
        var listedAfterBan = Assert.Single((await store.ListReaders(admin.Token, Query(("keyword", "abuser-reader")), ct)).Page.Items);
        Assert.Equal((false, 2L, 0, "gov-operator", "Automated spam comments", banned.HappenedAtUnixMs),
            (listedAfterBan.Enabled, listedAfterBan.Generation, listedAfterBan.ActiveSessionCount,
                listedAfterBan.LastGovernanceActor, listedAfterBan.LastGovernanceReason, listedAfterBan.LastGovernanceAtUnixMs));

        // Unban with generation 2 and fresh Step-Up proof.
        var unbanCommand = new AdminReaderStatusCommand(target, 2, true, Guid.NewGuid(), "Appeal approved after review");
        var unbanProof = await SeedProof(fixture, otherAdmin, AdminReaderGovernanceStore.CommandFingerprint(unbanCommand), lifetimeSeconds: 45);
        var unbanned = (await store.ExecuteStatusChange(otherAdmin.Token, unbanProof, unbanCommand, ct)).Receipt;
        Assert.Equal((true, 3L, 0, false), (unbanned.Enabled, unbanned.Generation, unbanned.RevokedSessionCount, unbanned.Replayed));

        Assert.Equal(2L, await fixture.Scalar<long>("select count(*) from public.admin_reader_governance_audit where user_id=$1", target));
        var listedAfterUnban = Assert.Single((await store.ListReaders(admin.Token, Query(("keyword", "abuser-reader")), ct)).Page.Items);
        Assert.Equal((true, 3L, "gov-other", "Appeal approved after review"),
            (listedAfterUnban.Enabled, listedAfterUnban.Generation, listedAfterUnban.LastGovernanceActor, listedAfterUnban.LastGovernanceReason));
    }

    [PostgresFact]
    public async Task HttpEndpointsEnforceOriginPermissionSessionAndHttp428StepUp()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var admin = await fixture.AdminAsync("http-gov-admin", 15, RandomNumberGenerator.GetBytes(32), [2], ct);
        var reader = await fixture.SignInSiteUser("http-target-reader", ct);
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var expectedPermissionSession = (await gate.SessionWithPermissionBinding(admin.Token, ct)).PermissionSession;

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Non-admin host must not expose admin reader routes (fail closed 404).
        await AdminStatus(server.Client, HttpMethod.Get, WireRoutes.AdminReaderAccounts, admin.Token, ct, NotFound,
            configure: req => req.Headers.Host = "other.localhost");

        // Unauthenticated and reader-cookie requests on admin host return 401.
        await AdminStatus(server.Client, HttpMethod.Get, WireRoutes.AdminReaderAccounts, null, ct, Unauthorized);
        await AdminStatus(server.Client, HttpMethod.Get, WireRoutes.AdminReaderAccounts, reader.Token, ct, Unauthorized);

        // Live admin session reads page with no-store and exact X-Fsus-Admin-Permission-Session binding.
        using (var res = Ok(await AdminSend(server.Client, HttpMethod.Get, $"{WireRoutes.AdminReaderAccounts}?keyword=http-target-reader", admin.Token, ct)))
        {
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var row = Assert.Single(Wire.DecodeAdminReaderAccountPage(await res.Content.ReadAsByteArrayAsync(ct)).Items);
            Assert.Equal((reader.Id, 1), (row.UserId, row.ActiveSessionCount));
        }

        var command = new AdminReaderStatusCommand(reader.Id, 1, false, Guid.NewGuid(), "HTTP E2E ban");
        var frame = Wire.EncodeAdminReaderStatusCommand(command);
        Action<HttpRequestMessage> addMutation = req => req.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));

        // Missing Origin header returns 403; missing Step-Up proof returns HTTP 428 Precondition Required.
        await AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, ct, Forbidden, frame, includeOrigin: false, addMutation);
        await AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, ct, PreconditionRequired, frame, configure: addMutation);

        // With valid Step-Up proof, returns HTTP 200 receipt and immediately revokes reader's live HTTP session.
        var proof = await SeedProof(fixture, admin, AdminReaderGovernanceStore.CommandFingerprint(command), lifetimeSeconds: 45);
        using (var res = Ok(await AdminSend(server.Client, HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, ct, frame,
            configure: req => { addMutation(req); req.Headers.Add(WireHeaders.MfaProof, proof); })))
        {
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var receipt = Wire.DecodeAdminReaderStatusReceipt(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((reader.Id, false, 2L, 1, false),
                (receipt.UserId, receipt.Enabled, receipt.Generation, receipt.RevokedSessionCount, receipt.Replayed));
        }

        // Reader's live session cookie is immediately dead.
        using var checkReader = Request(HttpMethod.Get, WireRoutes.Session, null, reader.Token, null);
        checkReader.Headers.Host = ServerProcess.DefaultAdminHost;
        await CheckStatusAsync(Unauthorized, server.Client.SendAsync(checkReader, ct));
    }

    private static (AdminSessionGate Gate, AdminReaderGovernanceStore Store) OpenStore(ScratchDatabase fixture)
    {
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var passkeys = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        return (gate, new AdminReaderGovernanceStore(gate, new AdminStepUpService(gate, passkeys)));
    }

    private static IQueryCollection Query(params (string Key, string Value)[] pairs) =>
        new QueryCollection(pairs.ToDictionary(pair => pair.Key, pair => new StringValues(pair.Value), StringComparer.OrdinalIgnoreCase));

    private static async Task<string> SeedProof(ScratchDatabase fixture,
        (Guid Id, string Token, byte[] Digest) admin, byte[] bodyDigest, int lifetimeSeconds) =>
        (await fixture.SeedStepUpProof("admin_reader_governance_step_up", admin.Id, admin.Digest, 12, bodyDigest, lifetimeSeconds)).Token;
}

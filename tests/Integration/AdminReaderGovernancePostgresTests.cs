using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;
using Npgsql;
using static FsusBlog.V2.Integration.Tests.BusinessAssert;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminReaderGovernancePostgresTests
{
    [PostgresFact]
    public async Task ListReadersFiltersSearchesPaginatesAndEnforcesAdminSessionIsolation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var admin = await FixtureSql.AdminAsync(db, ct, "reader-gov-admin", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var siteSession = await fixture.SignInSiteUser("reader-gov-site-caller", ct);
        var (gate, store) = OpenStore(fixture);

        await Denied(Rejection.Unauthorized, () => store.ListReaders(null, Query(), ct));
        await Denied(Rejection.Unauthorized, () => store.ListReaders(siteSession.Token, Query(), ct));

        // Seed 26 readers in addition to the site caller (27 total) to exercise keyset pagination past page size 24.
        var specialUser = Guid.NewGuid();
        var disabledUser = Guid.NewGuid();
        var richUser = Guid.NewGuid();
        var seededIds = new HashSet<Guid> { siteSession.Id, specialUser, disabledUser, richUser };

        await FixtureSql.SiteAccountAsync(db, null, ct, specialUser, "reader_%_literal", enabled: true);
        await FixtureSql.SitePasskeyAsync(db, null, ct, specialUser, RandomNumberGenerator.GetBytes(16), [3]);

        await FixtureSql.SiteAccountAsync(db, null, ct, disabledUser, "suspended-member", enabled: false);
        await FixtureSql.SitePasskeyAsync(db, null, ct, disabledUser, RandomNumberGenerator.GetBytes(16), [4]);

        await FixtureSql.SiteAccountAsync(db, null, ct, richUser, "alice-account", enabled: true);
        await FixtureSql.SitePasskeyAsync(db, null, ct, richUser, RandomNumberGenerator.GetBytes(16), [5]);
        await FixtureSql.ExecuteAsync(db, null, ct,
            "insert into public.comment_public_handle(user_id, display_name) values($1, $2)",
            richUser, "Alice Display Handle");
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.site_recovery_key(user_id, lookup_digest, salt, verifier, version, created_at, failed_count)
            values($1, $2, $3, $4, 1, clock_timestamp(), 0)
            """, richUser, RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(16), RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.mfa_totp(user_id, sealed_seed, last_step, verified_at, retry_after, failed_count)
            values($1, $2, 1, clock_timestamp(), clock_timestamp(), 0)
            """, richUser, RandomNumberGenerator.GetBytes(49));
        // Two active generation-1 sessions, one expired session, and one stale generation-99 session.
        await FixtureSql.SiteSessionAsync(db, richUser, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 1, credential: null);
        await FixtureSql.SiteSessionAsync(db, richUser, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 1, credential: null);
        await FixtureSql.SiteSessionAsync(db, richUser, DateTimeOffset.UtcNow.AddMinutes(-5), ct, generation: 1, credential: null);
        await FixtureSql.SiteSessionAsync(db, richUser, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 99, credential: null);

        // Seed an article and comment owned by richUser to verify CommentCount.
        await FixtureSql.ExecuteAsync(db, null, ct, """
            with article as (
                insert into public.article(id, owner_id, revision, title, body, deleted) overriding system value
                values(1, $1, 1, 'Reader test article', 'Body', false) returning id
            )
            insert into public.article_revision(article_id, revision, title, body, happened_at)
            select id, 1, 'Reader test article', 'Body', clock_timestamp() from article
            """, admin.Id);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.comment(article_id, id, root_id, depth, moderation_status, deleted, body, author_mode, display_name, display_language, created_at)
            values(1, 1, 1, 0, 1, false, 'Hello from Alice', 3, 'Alice Display Handle', 'en', clock_timestamp())
            """);
        await FixtureSql.ExecuteAsync(db, null, ct,
            "insert into public.comment_account_owner(article_id, comment_id, user_id) values(1, 1, $1)", richUser);

        for (var i = 0; i < 23; i++)
        {
            var id = Guid.NewGuid();
            seededIds.Add(id);
            await FixtureSql.SiteAccountAsync(db, null, ct, id, $"batch-reader-{i:D2}", enabled: true);
            await FixtureSql.SitePasskeyAsync(db, null, ct, id, RandomNumberGenerator.GetBytes(16), [6]);
        }

        // Verify page 1 + page 2 keyset pagination covers every seeded account without overlap or loss.
        var first = await store.ListReaders(admin.Token, Query(), ct);
        Assert.Equal((await gate.SessionWithPermissionBinding(admin.Token, ct)).PermissionSession, first.PermissionSession);
        Assert.Equal(27, first.Page.Total);
        Assert.Equal(26, first.Page.EnabledTotal);
        Assert.Equal(1, first.Page.DisabledTotal);
        Assert.True(first.Page.HasMore);
        Assert.Equal(WireLimits.AdminReaderPageSize, first.Page.Items.Count);
        Assert.NotEqual(Guid.Empty, first.Page.NextCursorUserId);

        var second = await store.ListReaders(admin.Token, Query(
            ("afterAccountId", first.Page.NextCursorAccountId.ToString()),
            ("afterUserId", first.Page.NextCursorUserId.ToString())), ct);
        Assert.False(second.Page.HasMore);
        Assert.Equal(0, second.Page.NextCursorAccountId);
        Assert.Equal(Guid.Empty, second.Page.NextCursorUserId);
        Assert.Equal(3, second.Page.Items.Count);

        var allListedIds = first.Page.Items.Concat(second.Page.Items).Select(x => x.UserId).ToArray();
        Assert.Equal(seededIds.Count, allListedIds.Length);
        Assert.Equal(seededIds, allListedIds.ToHashSet());

        // Verify status filter counts and results.
        var disabledOnly = await store.ListReaders(admin.Token, Query(("status", "disabled")), ct);
        Assert.Equal(1, disabledOnly.Page.Total);
        Assert.Equal(26, disabledOnly.Page.EnabledTotal);
        Assert.Equal(1, disabledOnly.Page.DisabledTotal);
        Assert.Equal(disabledUser, Assert.Single(disabledOnly.Page.Items).UserId);

        var enabledOnly = await store.ListReaders(admin.Token, Query(("status", "enabled")), ct);
        Assert.Equal(26, enabledOnly.Page.Total);
        Assert.All(enabledOnly.Page.Items, row => Assert.True(row.Enabled));

        // Verify keyword search by display name, #accountId, and LIKE metacharacter escaping.
        var byDisplay = await store.ListReaders(admin.Token, Query(("keyword", "Alice Display")), ct);
        var alice = Assert.Single(byDisplay.Page.Items);
        Assert.Equal(richUser, alice.UserId);
        Assert.Equal("alice-account", alice.Name);
        Assert.Equal("Alice Display Handle", alice.DisplayName);
        Assert.True(alice.Enabled);
        Assert.Equal(1L, alice.Generation);
        Assert.Equal(1, alice.PasskeyCount);
        Assert.True(alice.HasRecoveryKey);
        Assert.True(alice.HasTotp);
        Assert.Equal(2, alice.ActiveSessionCount);
        Assert.Equal(1, alice.CommentCount);
        Assert.True(alice.RegisteredAtUnixMs > 0);
        Assert.Equal(0L, alice.LastGovernanceAtUnixMs);
        Assert.Equal("", alice.LastGovernanceActor);
        Assert.Equal("", alice.LastGovernanceReason);

        var byAccountId = await store.ListReaders(admin.Token, Query(("keyword", $"#{alice.AccountId}")), ct);
        Assert.Equal(richUser, Assert.Single(byAccountId.Page.Items).UserId);

        var byLikeMetachar = await store.ListReaders(admin.Token, Query(("keyword", "_%_")), ct);
        Assert.Equal(specialUser, Assert.Single(byLikeMetachar.Page.Items).UserId);

        // Verify wire roundtrip of the rich page.
        var encoded = Wire.EncodeAdminReaderAccountPage(byDisplay.Page);
        var decoded = Wire.DecodeAdminReaderAccountPage(encoded);
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
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var admin = await FixtureSql.AdminAsync(db, ct, "gov-operator", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var otherAdmin = await FixtureSql.AdminAsync(db, ct, "gov-other", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var (_, store) = OpenStore(fixture);

        var target = Guid.NewGuid();
        var bystander = Guid.NewGuid();
        await FixtureSql.SiteAccountAsync(db, null, ct, target, "abuser-reader", enabled: true);
        await FixtureSql.SitePasskeyAsync(db, null, ct, target, RandomNumberGenerator.GetBytes(16), [7]);
        await FixtureSql.SiteAccountAsync(db, null, ct, bystander, "bystander-reader", enabled: true);
        await FixtureSql.SitePasskeyAsync(db, null, ct, bystander, RandomNumberGenerator.GetBytes(16), [8]);

        // Seed live + expired sessions, refresh family, tickets, passkey challenge, MFA & recovery flows for target, plus a live session for bystander.
        var liveSession1 = await FixtureSql.SiteSessionAsync(db, target, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 1, credential: null);
        var liveSession2 = await FixtureSql.SiteSessionAsync(db, target, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 1, credential: null);
        await FixtureSql.SiteSessionAsync(db, target, DateTimeOffset.UtcNow.AddMinutes(-10), ct, generation: 1, credential: null);
        var bystanderSession = await FixtureSql.SiteSessionAsync(db, bystander, DateTimeOffset.UtcNow.AddMinutes(30), ct, generation: 1, credential: null);

        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.site_session_refresh(family_id, access_digest, refresh_digest, generation, idle_expires_at, absolute_expires_at, rotated_at)
            values($1, $2, $3, 1, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 day', clock_timestamp())
            """, Guid.NewGuid(), liveSession1.Digest, RandomNumberGenerator.GetBytes(32));
        await FixtureSql.IssueLoginTicketAsync(db, null, ct, target);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.passkey_challenge(digest, user_id, generation, options, expires_at, binding_digest)
            values($1, $2, 1, '{}', clock_timestamp() + interval '5 minutes', $3)
            """, RandomNumberGenerator.GetBytes(32), target, RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.mfa_setup(user_id, generation, session_digest, sealed_seed, expires_at, failed_count)
            values($1, 1, $2, $3, clock_timestamp() + interval '5 minutes', 0)
            """, target, liveSession1.Digest, RandomNumberGenerator.GetBytes(49));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.mfa_flow(digest, user_id, generation, kind, scope, options, expires_at)
            values($1, $2, 1, 1, $3, '{}', clock_timestamp() + interval '5 minutes')
            """, RandomNumberGenerator.GetBytes(32), target, RandomNumberGenerator.GetBytes(16));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.site_recovery_flow(digest, user_id, generation, session_digest, purpose, kind, options, expires_at)
            values($1, $2, 1, $3, 1, 1, '{}', clock_timestamp() + interval '5 minutes')
            """, RandomNumberGenerator.GetBytes(32), target, liveSession1.Digest);
        await FixtureSql.ExecuteAsync(db, null, ct, """
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
        var beginFrame = await store.BeginStatusStepUp(admin.Token, banCommand, ct);
        Aeds.Decode(beginFrame, FrameType.PasskeyLoginBegin);
        Assert.Equal(1L, await Scalar<long>(db, ct, """
            select count(*) from public.admin_reader_governance_step_up
            where session_digest=$1 and action=12 and body_digest=$2 and kind=1
            """, admin.Digest, banFingerprint));

        // Missing, expired, other-admin, and mismatched-intent proofs are rejected with ReaderGovernanceProofRequiredException.
        await Assert.ThrowsAsync<ReaderGovernanceProofRequiredException>(() => store.ExecuteStatusChange(admin.Token, null, banCommand, ct));
        var expiredProof = await SeedProof(db, ct, admin, banFingerprint, lifetimeSeconds: -5);
        await Assert.ThrowsAsync<ReaderGovernanceProofRequiredException>(() => store.ExecuteStatusChange(admin.Token, expiredProof, banCommand, ct));

        var proof = await SeedProof(db, ct, admin, banFingerprint, lifetimeSeconds: 45);
        await Assert.ThrowsAsync<ReaderGovernanceProofRequiredException>(() => store.ExecuteStatusChange(otherAdmin.Token, proof, banCommand, ct));
        await Assert.ThrowsAsync<ReaderGovernanceProofRequiredException>(() =>
            store.ExecuteStatusChange(admin.Token, proof, banCommand with { Reason = "Changed reason after step-up" }, ct));

        // Execute ban with valid proof.
        var banned = (await store.ExecuteStatusChange(admin.Token, proof, banCommand, ct)).Receipt;
        Assert.Equal(target, banned.UserId);
        Assert.False(banned.Enabled);
        Assert.Equal(2L, banned.Generation);
        Assert.Equal(2, banned.RevokedSessionCount);
        Assert.False(banned.Replayed);
        Assert.True(banned.HappenedAtUnixMs > 0);

        // Proof-less idempotency replay returns the exact stored receipt without re-mutating DB; conflicting payload fails with 409.
        var replay = (await store.ExecuteStatusChange(admin.Token, null, banCommand, ct)).Receipt;
        Assert.Equal(banned with { Replayed = true }, replay);
        await Denied(Rejection.Conflict, () =>
            store.ExecuteStatusChange(admin.Token, null, banCommand with { Reason = "Different reason same key" }, ct));

        // Target's active sessions and all transient auth/recovery rows are completely purged; bystander is untouched.
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.user_session where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.site_session_refresh"));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.login_ticket where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.passkey_challenge where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.mfa_setup where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.mfa_flow where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.site_recovery_flow where user_id=$1", target));
        Assert.Equal(0L, await Scalar<long>(db, ct, "select count(*) from public.site_recovery_rebind where user_id=$1", target));
        Assert.Equal(1L, await Scalar<long>(db, ct, "select count(*) from public.user_session where user_id=$1", bystander));

        // Previously valid reader sessions fail immediately; bystander session still works.
        await Denied(Rejection.Unauthorized, () => siteStore.WithSession(liveSession1.Token, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        await Denied(Rejection.Unauthorized, () => siteStore.WithSession(liveSession2.Token, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        Assert.Equal(bystander, await siteStore.WithSession(bystanderSession.Token, false, (_, _, actor) => Task.FromResult(actor.Id), ct));

        // ListReaders reflects banned status, incremented generation, 0 active sessions, and immutable audit metadata.
        var listedAfterBan = Assert.Single((await store.ListReaders(admin.Token, Query(("keyword", "abuser-reader")), ct)).Page.Items);
        Assert.False(listedAfterBan.Enabled);
        Assert.Equal(2L, listedAfterBan.Generation);
        Assert.Equal(0, listedAfterBan.ActiveSessionCount);
        Assert.Equal("gov-operator", listedAfterBan.LastGovernanceActor);
        Assert.Equal("Automated spam comments", listedAfterBan.LastGovernanceReason);
        Assert.Equal(banned.HappenedAtUnixMs, listedAfterBan.LastGovernanceAtUnixMs);

        // Unban with generation 2 and fresh Step-Up proof.
        var unbanCommand = new AdminReaderStatusCommand(target, 2, true, Guid.NewGuid(), "Appeal approved after review");
        var unbanProof = await SeedProof(db, ct, otherAdmin, AdminReaderGovernanceStore.CommandFingerprint(unbanCommand), lifetimeSeconds: 45);
        var unbanned = (await store.ExecuteStatusChange(otherAdmin.Token, unbanProof, unbanCommand, ct)).Receipt;
        Assert.True(unbanned.Enabled);
        Assert.Equal(3L, unbanned.Generation);
        Assert.Equal(0, unbanned.RevokedSessionCount);
        Assert.False(unbanned.Replayed);

        Assert.Equal(2L, await Scalar<long>(db, ct, "select count(*) from public.admin_reader_governance_audit where user_id=$1", target));
        var listedAfterUnban = Assert.Single((await store.ListReaders(admin.Token, Query(("keyword", "abuser-reader")), ct)).Page.Items);
        Assert.True(listedAfterUnban.Enabled);
        Assert.Equal(3L, listedAfterUnban.Generation);
        Assert.Equal("gov-other", listedAfterUnban.LastGovernanceActor);
        Assert.Equal("Appeal approved after review", listedAfterUnban.LastGovernanceReason);
    }

    [PostgresFact]
    public async Task HttpEndpointsEnforceOriginPermissionSessionAndHttp428StepUp()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var admin = await FixtureSql.AdminAsync(db, ct, "http-gov-admin", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var reader = await fixture.SignInSiteUser("http-target-reader", ct);
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var expectedPermissionSession = (await gate.SessionWithPermissionBinding(admin.Token, ct)).PermissionSession;

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Non-admin host must not expose admin reader routes (fail closed 404).
        using (var wrongHost = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AdminReaderAccounts))
        {
            wrongHost.Headers.Host = "other.localhost";
            wrongHost.Headers.Add("Cookie", $"{ServerProcess.DefaultAdminCookie}={admin.Token}");
            using var res = await server.Client.SendAsync(wrongHost, ct);
            Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        }

        // Unauthenticated and reader-cookie requests on admin host return 401.
        using (var anon = AdminRequest(HttpMethod.Get, WireRoutes.AdminReaderAccounts, null))
        using (var res = await server.Client.SendAsync(anon, ct))
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);

        using (var readerCookie = AdminRequest(HttpMethod.Get, WireRoutes.AdminReaderAccounts, reader.Token))
        using (var res = await server.Client.SendAsync(readerCookie, ct))
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);

        // Live admin session reads page with no-store and exact X-Fsus-Admin-Permission-Session binding.
        using (var listReq = AdminRequest(HttpMethod.Get, $"{WireRoutes.AdminReaderAccounts}?keyword=http-target-reader", admin.Token))
        using (var res = await server.Client.SendAsync(listReq, ct))
        {
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var page = Wire.DecodeAdminReaderAccountPage(await res.Content.ReadAsByteArrayAsync(ct));
            var row = Assert.Single(page.Items);
            Assert.Equal(reader.Id, row.UserId);
            Assert.Equal(1, row.ActiveSessionCount);
        }

        var command = new AdminReaderStatusCommand(reader.Id, 1, false, Guid.NewGuid(), "HTTP E2E ban");
        var frame = Wire.EncodeAdminReaderStatusCommand(command);

        // Missing Origin header returns 403.
        using (var noOrigin = AdminRequest(HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, frame, includeOrigin: false))
        {
            noOrigin.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            using var res = await server.Client.SendAsync(noOrigin, ct);
            Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        }

        // Missing Step-Up proof returns HTTP 428 Precondition Required.
        using (var noProof = AdminRequest(HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, frame))
        {
            noProof.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            using var res = await server.Client.SendAsync(noProof, ct);
            Assert.Equal(HttpStatusCode.PreconditionRequired, res.StatusCode);
        }

        // With valid Step-Up proof, returns HTTP 200 receipt and immediately revokes reader's live HTTP session.
        var proof = await SeedProof(db, ct, admin, AdminReaderGovernanceStore.CommandFingerprint(command), lifetimeSeconds: 45);
        using (var execute = AdminRequest(HttpMethod.Post, WireRoutes.AdminReaderStatusExecute, admin.Token, frame))
        {
            execute.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            execute.Headers.Add(WireHeaders.MfaProof, proof);
            using var res = await server.Client.SendAsync(execute, ct);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var receipt = Wire.DecodeAdminReaderStatusReceipt(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(reader.Id, receipt.UserId);
            Assert.False(receipt.Enabled);
            Assert.Equal(2L, receipt.Generation);
            Assert.Equal(1, receipt.RevokedSessionCount);
            Assert.False(receipt.Replayed);
        }

        // Reader's live session cookie is immediately dead.
        using (var checkReader = new HttpRequestMessage(HttpMethod.Get, WireRoutes.Session))
        {
            checkReader.Headers.Host = ServerProcess.DefaultAdminHost;
            checkReader.Headers.Add("Cookie", $"fsus-v2-session={reader.Token}");
            using var res = await server.Client.SendAsync(checkReader, ct);
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        }
    }

    private static (AdminSessionGate Gate, AdminReaderGovernanceStore Store) OpenStore(ScratchDatabase fixture)
    {
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var passkeys = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var stepUp = new AdminStepUpService(gate, passkeys);
        return (gate, new AdminReaderGovernanceStore(gate, stepUp));
    }

    private static IQueryCollection Query(params (string Key, string Value)[] pairs) =>
        new QueryCollection(pairs.ToDictionary(pair => pair.Key, pair => new StringValues(pair.Value), StringComparer.OrdinalIgnoreCase));

    private static async Task<string> SeedProof(NpgsqlConnection db, CancellationToken ct,
        (Guid Id, string Token, byte[] Digest) admin, byte[] bodyDigest, int lifetimeSeconds)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_reader_governance_step_up
                (digest, principal_id, session_digest, generation, action, body_digest, options, expires_at, kind)
            values($1, $2, $3, 1, 12, $4, null, clock_timestamp() + $5 * interval '1 second', 2)
            on conflict (session_digest, kind) do update set digest = excluded.digest, body_digest = excluded.body_digest, expires_at = excluded.expires_at
            """, SHA256.HashData(Encoding.ASCII.GetBytes(token)), admin.Id, admin.Digest, bodyDigest, lifetimeSeconds);
        return token;
    }

    private static HttpRequestMessage AdminRequest(HttpMethod method, string path, string? cookie, byte[]? body = null, bool includeOrigin = true)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Host = ServerProcess.DefaultAdminHost;
        if (includeOrigin && method != HttpMethod.Get) request.Headers.Add("Origin", ServerProcess.DefaultAdminOrigin);
        if (cookie is not null) request.Headers.Add("Cookie", $"{ServerProcess.DefaultAdminCookie}={cookie}");
        if (body is not null)
        {
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(Aeds.ContentType);
        }
        return request;
    }

    private static async Task<T> Scalar<T>(NpgsqlConnection db, CancellationToken ct, string sql, params object[] parameters) =>
        (T)(await FixtureSql.ScalarAsync(db, null, ct, sql, parameters))!;
}

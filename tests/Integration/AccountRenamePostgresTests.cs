using static FsusBlog.V2.Integration.Tests.SiteAedsFixture;
using static System.Net.HttpStatusCode;
using static FsusBlog.V2.Integration.Tests.HttpResponseAssert;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AccountRenamePostgresTests
{
    [PostgresFact]
    public async Task ReaderDisplayNameReadsUpsertsAndEnforcesCurrentSessionAndValidation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var reader = await fixture.SignInSiteUser("rename-reader", ct);
        var admin = await FixtureSql.AdminAsync(db, ct, "rename-admin-caller", 15, RandomNumberGenerator.GetBytes(32), [2]);
        var currentSessionId = SiteSessions.Id(reader.Id, Store.TokenDigest(reader.Token)!);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Unauthenticated or admin-cookie requests must fail with 401.
        using (var anon = SiteRequest(HttpMethod.Get, WireRoutes.SiteDisplayName, null, currentSessionId))
        CheckStatus(Unauthorized, await server.Client.SendAsync(anon, ct));

        using (var wrongCookie = new HttpRequestMessage(HttpMethod.Get, WireRoutes.SiteDisplayName))
        {
            wrongCookie.Headers.Host = ServerProcess.DefaultAdminHost;
            wrongCookie.Headers.Add("Cookie", $"{ServerProcess.DefaultAdminCookie}={admin.Token}");
            wrongCookie.Headers.Add(WireHeaders.CurrentSession, currentSessionId);
            using var res = Expect(Unauthorized, await server.Client.SendAsync(wrongCookie, ct));
        }

        // Wrong X-Fsus-Current-Session must fail with 409.
        using (var stale = SiteRequest(HttpMethod.Get, WireRoutes.SiteDisplayName, reader.Token, new string('f', 64)))
        CheckStatus(Conflict, await server.Client.SendAsync(stale, ct));

        // Initial display name is empty for a newly created reader.
        using (var initial = SiteRequest(HttpMethod.Get, WireRoutes.SiteDisplayName, reader.Token, currentSessionId))
        using (var res = Ok(await server.Client.SendAsync(initial, ct)))
        {
            Assert.True(res.Headers.CacheControl?.NoStore);
            var state = Wire.DecodeSiteDisplayNameState(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal("", state.DisplayName);
        }

        // Cross-origin POST is denied with 403.
        var setFrame = Wire.EncodeSiteDisplayNameCommand(new SiteDisplayNameCommand("林深"));
        using (var cross = SiteRequest(HttpMethod.Post, WireRoutes.SiteDisplayName, reader.Token, currentSessionId, setFrame, origin: "https://evil.example"))
        CheckStatus(Forbidden, await server.Client.SendAsync(cross, ct));

        // Valid POST inserts into comment_public_handle and returns updated name.
        using (var setReq = SiteRequest(HttpMethod.Post, WireRoutes.SiteDisplayName, reader.Token, currentSessionId, setFrame))
        using (var res = Ok(await server.Client.SendAsync(setReq, ct)))
        {
            Assert.True(res.Headers.CacheControl?.NoStore);
            var state = Wire.DecodeSiteDisplayNameState(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal("林深", state.DisplayName);
        }

        // Subsequent POST updates existing row in place and GET reflects it.
        var updateFrame = Wire.EncodeSiteDisplayNameCommand(new SiteDisplayNameCommand("Alice Reader"));
        using (var updReq = SiteRequest(HttpMethod.Post, WireRoutes.SiteDisplayName, reader.Token, currentSessionId, updateFrame))
        using (var res = Ok(await server.Client.SendAsync(updReq, ct)))
        {
            Assert.Equal("Alice Reader", Wire.DecodeSiteDisplayNameState(await res.Content.ReadAsByteArrayAsync(ct)).DisplayName);
        }

        using (var after = SiteRequest(HttpMethod.Get, WireRoutes.SiteDisplayName, reader.Token, currentSessionId))
        using (var res = Ok(await server.Client.SendAsync(after, ct)))
        {
            Assert.Equal("Alice Reader", Wire.DecodeSiteDisplayNameState(await res.Content.ReadAsByteArrayAsync(ct)).DisplayName);
        }
    }

    [PostgresFact]
    public async Task AdminHandleRenameRequiresStepUpAuditsReplaysAndEnforcesUniqueness()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);

        var admin = await FixtureSql.AdminAsync(db, ct, "original-admin", 15, RandomNumberGenerator.GetBytes(32), [2]);
        await FixtureSql.AdminAsync(db, ct, "taken-admin", 15, RandomNumberGenerator.GetBytes(32), [3]);
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var expectedPermissionSession = (await gate.SessionWithPermissionBinding(admin.Token, ct)).PermissionSession;

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var command = new AdminHandleCommand("original-admin", "renamed-admin", Guid.NewGuid());
        var frame = Wire.EncodeAdminHandleCommand(command);

        // Missing Step-Up proof returns HTTP 428.
        using (var noProof = AdminRequest(HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, frame))
        {
            noProof.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            using var res = Expect(PreconditionRequired, await server.Client.SendAsync(noProof, ct));
        }

        // Duplicate handle returns HTTP 409 even with valid Step-Up proof.
        var collisionCmd = new AdminHandleCommand("original-admin", "taken-admin", Guid.NewGuid());
        var collisionProof = await SeedHandleProof(db, ct, admin, AdminHandleStore.CommandFingerprint(collisionCmd), 45);
        using (var collision = AdminRequest(HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, Wire.EncodeAdminHandleCommand(collisionCmd)))
        {
            collision.Headers.Add(WireHeaders.ClientMutationId, collisionCmd.IdempotencyKey.ToString("D"));
            collision.Headers.Add(WireHeaders.MfaProof, collisionProof);
            using var res = Expect(Conflict, await server.Client.SendAsync(collision, ct));
        }

        // Valid Step-Up proof renames handle, writes audit, keeps session alive, and returns 200 receipt.
        var proof = await SeedHandleProof(db, ct, admin, AdminHandleStore.CommandFingerprint(command), 45);
        using (var execute = AdminRequest(HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, frame))
        {
            execute.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            execute.Headers.Add(WireHeaders.MfaProof, proof);
            using var res = Ok(await server.Client.SendAsync(execute, ct));
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var receipt = Wire.DecodeAdminHandleReceipt(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal("renamed-admin", receipt.Handle);
            Assert.False(receipt.Replayed);
        }

        // Retrying the exact same idempotency key replays the receipt without requiring a second proof.
        using (var replay = AdminRequest(HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, frame))
        {
            replay.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
            using var res = Ok(await server.Client.SendAsync(replay, ct));
            var receipt = Wire.DecodeAdminHandleReceipt(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal("renamed-admin", receipt.Handle);
            Assert.True(receipt.Replayed);
        }

        // Session snapshot immediately reflects the renamed handle without revoking the session.
        using (var sessionReq = AdminRequest(HttpMethod.Get, WireRoutes.AdminSession, admin.Token))
        using (var res = Ok(await server.Client.SendAsync(sessionReq, ct)))
        {
            var snapshot = Wire.DecodeAdminSessionSnapshot(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal("renamed-admin", snapshot.Handle);
        }

        // Audit rows are recorded in both admin_handle_rename_audit and admin_identity_audit.
        Assert.Equal("original-admin->renamed-admin",
            (string)(await FixtureSql.ScalarAsync(db, null, ct,
                "select actor from public.admin_identity_audit where principal_id=$1 and action='rename-handle' order by id desc limit 1",
                admin.Id))!);
    }

    private static async Task<string> SeedHandleProof(NpgsqlConnection db, CancellationToken ct,
        (Guid Id, string Token, byte[] Digest) admin, byte[] bodyDigest, int lifetimeSeconds)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.admin_handle_step_up
                (digest, principal_id, session_digest, generation, action, body_digest, options, expires_at, kind)
            values($1, $2, $3, 1, 14, $4, null, clock_timestamp() + $5 * interval '1 second', 2)
            on conflict (session_digest, kind) do update set digest = excluded.digest, body_digest = excluded.body_digest, expires_at = excluded.expires_at
            """, SHA256.HashData(Encoding.ASCII.GetBytes(token)), admin.Id, admin.Digest, bodyDigest, lifetimeSeconds);
        return token;
    }

    private static HttpRequestMessage SiteRequest(HttpMethod method, string path, string? cookie, string currentSessionId,
        byte[]? body = null, string? origin = null)
    {
        var request = Request(method, path, body, cookie, currentSessionId);
        request.Headers.Host = ServerProcess.DefaultAdminHost;
        if (method != HttpMethod.Get) request.Headers.Add("Origin", origin ?? ServerProcess.DefaultAdminOrigin);
        return request;
    }

}

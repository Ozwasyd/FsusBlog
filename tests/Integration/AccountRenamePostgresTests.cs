using static FsusBlog.V2.Integration.Tests.SiteAedsFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AccountRenamePostgresTests
{
    [PostgresFact]
    public async Task ReaderDisplayNameReadsUpsertsAndEnforcesCurrentSessionAndValidation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var reader = await fixture.SignInSiteUser("rename-reader", ct);
        var admin = await fixture.AdminAsync("rename-admin-caller", 15, key: [2]);
        var currentSessionId = SiteSessions.Id(reader.Id, Store.TokenDigest(reader.Token)!);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        // Unauthenticated or admin-cookie requests must fail with 401.
        await CheckStatusAsync(Unauthorized, SendSite(HttpMethod.Get, null, currentSessionId));
        await AdminStatus(server.Client, HttpMethod.Get, WireRoutes.SiteDisplayName, admin.Token, ct, Unauthorized,
            configure: r => r.Headers.Add(WireHeaders.CurrentSession, currentSessionId));

        // Wrong X-Fsus-Current-Session must fail with 409.
        await CheckStatusAsync(Conflict, SendSite(HttpMethod.Get, reader.Token, new string('f', 64)));

        // Initial display name is empty for a newly created reader.
        Assert.Equal("", await ReadName(HttpMethod.Get));

        // Cross-origin POST is denied with 403.
        var setFrame = Wire.EncodeSiteDisplayNameCommand(new SiteDisplayNameCommand("林深"));
        await CheckStatusAsync(Forbidden, SendSite(HttpMethod.Post, reader.Token, currentSessionId, setFrame, "https://evil.example"));

        // Valid POST inserts into comment_public_handle and returns updated name.
        Assert.Equal("林深", await ReadName(HttpMethod.Post, setFrame));

        // Subsequent POST updates existing row in place and GET reflects it.
        var updateFrame = Wire.EncodeSiteDisplayNameCommand(new SiteDisplayNameCommand("Alice Reader"));
        Assert.Equal("Alice Reader", await ReadName(HttpMethod.Post, updateFrame));
        Assert.Equal("Alice Reader", await ReadName(HttpMethod.Get));

        async Task<HttpResponseMessage> SendSite(HttpMethod method, string? cookie, string sessionId, byte[]? body = null, string? origin = null)
        {
            using var request = Request(method, WireRoutes.SiteDisplayName, body, cookie, sessionId);
            request.Headers.Host = ServerProcess.DefaultAdminHost;
            if (method != HttpMethod.Get) request.Headers.Add("Origin", origin ?? ServerProcess.DefaultAdminOrigin);
            return await server.Client.SendAsync(request, ct);
        }

        async Task<string> ReadName(HttpMethod method, byte[]? body = null)
        {
            using var res = Ok(await SendSite(method, reader.Token, currentSessionId, body));
            Assert.True(res.Headers.CacheControl?.NoStore);
            return Wire.DecodeSiteDisplayNameState(await res.Content.ReadAsByteArrayAsync(ct)).DisplayName;
        }
    }

    [PostgresFact]
    public async Task AdminHandleRenameRequiresStepUpAuditsReplaysAndEnforcesUniqueness()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var admin = await fixture.AdminAsync("original-admin", 15, key: [2]);
        await fixture.AdminAsync("taken-admin", 15, key: [3]);
        var expectedPermissionSession = (await new AdminSessionGate(fixture.DataSource, null)
            .SessionWithPermissionBinding(admin.Token, ct)).PermissionSession;

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var command = new AdminHandleCommand("original-admin", "renamed-admin", Guid.NewGuid());
        var frame = Wire.EncodeAdminHandleCommand(command);

        // Missing Step-Up proof returns HTTP 428.
        await AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, ct, PreconditionRequired,
            frame, configure: r => r.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D")));

        // Duplicate handle returns HTTP 409 even with valid Step-Up proof.
        var collisionCmd = new AdminHandleCommand("original-admin", "taken-admin", Guid.NewGuid());
        var (collisionProof, _) = await fixture.SeedStepUpProof("admin_handle_step_up", admin.Id, admin.Digest,
            14, AdminHandleStore.CommandFingerprint(collisionCmd));
        await AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, ct, Conflict,
            Wire.EncodeAdminHandleCommand(collisionCmd), configure: r =>
            {
                r.Headers.Add(WireHeaders.ClientMutationId, collisionCmd.IdempotencyKey.ToString("D"));
                r.Headers.Add(WireHeaders.MfaProof, collisionProof);
            });

        // Valid Step-Up proof renames handle, writes audit, keeps session alive, and returns 200 receipt.
        var (proof, _) = await fixture.SeedStepUpProof("admin_handle_step_up", admin.Id, admin.Digest,
            14, AdminHandleStore.CommandFingerprint(command));
        using (var res = Ok(await AdminSend(server.Client, HttpMethod.Post, WireRoutes.AdminHandleExecute, admin.Token, ct, frame,
            configure: r =>
            {
                r.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"));
                r.Headers.Add(WireHeaders.MfaProof, proof);
            })))
        {
            Assert.True(res.Headers.CacheControl?.NoStore);
            Assert.Equal(expectedPermissionSession, Assert.Single(res.Headers.GetValues(WireHeaders.AdminPermissionSession)));
            var receipt = Wire.DecodeAdminHandleReceipt(await res.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(("renamed-admin", false), (receipt.Handle, receipt.Replayed));
        }

        // Retrying the exact same idempotency key replays the receipt without requiring a second proof.
        var replayed = Wire.DecodeAdminHandleReceipt(await AdminBytes(server.Client, HttpMethod.Post, WireRoutes.AdminHandleExecute,
            admin.Token, ct, frame: frame, configure: r => r.Headers.Add(WireHeaders.ClientMutationId, command.IdempotencyKey.ToString("D"))));
        Assert.Equal(("renamed-admin", true), (replayed.Handle, replayed.Replayed));

        // Session snapshot immediately reflects the renamed handle without revoking the session.
        var snapshot = Wire.DecodeAdminSessionSnapshot(await AdminBytes(server.Client, HttpMethod.Get, WireRoutes.AdminSession, admin.Token, ct));
        Assert.Equal("renamed-admin", snapshot.Handle);

        // Audit rows are recorded in both admin_handle_rename_audit and admin_identity_audit.
        Assert.Equal("original-admin->renamed-admin", await fixture.Scalar<string>(
            "select actor from public.admin_identity_audit where principal_id=$1 and action='rename-handle' order by id desc limit 1",
            admin.Id));
    }
}

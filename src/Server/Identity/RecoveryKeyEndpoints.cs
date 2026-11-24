namespace FsusBlog.V2.Server.Passkeys;

internal static class RecoveryKeyEndpoints
{
    private const string RebindCookie = "fsus-v2-site-recovery";
    private const string RebindPath = "/api/v2/identity/recovery-key/rebind";
    private const string PowContext = "site-identity";

    internal static void Map(WebApplication app, PasskeyStore store, RecoveryKeySecret secret, string sessionCookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, Action<HttpContext> requireHost,
        Func<string, CookieOptions> cookie)
    {
        var pow = app.Services.GetRequiredService<ScopedPow>();
        var post = new SiteMfaPostRoutes(app, RequirePost);
        app.MapGet(WireRoutes.RecoveryKeyAvailability, (HttpContext ctx) =>
        {
            requireHost(ctx);
            return ServerHttp.EmptyFrame();
        });
        app.MapGet(WireRoutes.RecoveryKeyStatus, async (HttpContext ctx, CancellationToken ct) =>
        {
            requireHost(ctx);
            return ServerHttp.Frame(Wire.EncodeRecoveryKeyStatus(new(await store.RecoveryKeyStatus(Session(ctx), ct))));
        }).RequireRateLimiting("mfa");
        post.Post(WireRoutes.RecoveryKeyStepUpBegin, async (ctx, ct) =>
            ServerHttp.Frame(await store.BeginRecoveryKeyStepUp(Session(ctx), await Operation(ctx, ct), ct)));
        post.Post(WireRoutes.RecoveryKeyStepUpComplete, async (ctx, ct) =>
        {
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            return ServerHttp.Frame(await store.CompleteRecoveryKeyStepUp(Session(ctx), PasskeyWire.ReadLogin(frame, discoverable: false), ct));
        });
        post.Post(WireRoutes.RecoveryKeyIssue, async (ctx, ct) =>
        {
            var operation = await Operation(ctx, ct);
            var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
            try
            {
                var issued = await store.IssueRecoveryKey(secret, Session(ctx), operation, proof, ct);
                return ServerHttp.Frame(Wire.EncodeRecoveryKeyIssued(issued));
            }
            catch (RecoveryKeyProofRequiredException)
            {
                const int status = StatusCodes.Status428PreconditionRequired;
                return new AedsError(status, Wire.EncodeError(status, "MFA_PROOF_REQUIRED", traceId: ctx.TraceIdentifier));
            }
        });
        app.MapPost(WireRoutes.RecoveryKeyPow, (HttpContext ctx, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                RequirePost(ctx);
                var frame = await readFrame(ctx, WireLimits.RecoveryKeyVerifyFrameBytes, ct);
                try
                {
                    var key = Wire.DecodeRecoveryKeyVerify(frame);
                    return PowWire.EncodeChallenge(pow.Issue(PowScope.SiteRecoveryKey, PowContext,
                        Convert.ToHexString(secret.Lookup(key.Key)), ScopedPow.Source(ctx), ScopedPow.ReadClientNonce(ctx), frame));
                }
                finally { CryptographicOperations.ZeroMemory(frame); }
            }, PowScope.SiteRecoveryKey)).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyVerify, (HttpContext ctx, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                RequirePost(ctx);
                var frame = await readFrame(ctx, WireLimits.RecoveryKeyVerifyFrameBytes, ct);
                try
                {
                    var key = Wire.DecodeRecoveryKeyVerify(frame);
                    var proof = ScopedPow.ReadProof(ctx);
                    var ticket = await store.VerifySiteRecoveryKey(secret, key.Key, (db, tx) =>
                        pow.Consume(db, tx, PowScope.SiteRecoveryKey, PowContext, Convert.ToHexString(secret.Lookup(key.Key)),
                            ScopedPow.Source(ctx), frame, proof, ct), ct);
                    var options = cookie(RebindPath);
                    options.MaxAge = TimeSpan.FromMinutes(10);
                    ctx.Response.Cookies.Append(RebindCookie, ticket, options);
                    return Wire.EncodeEmptySuccess();
                }
                finally { CryptographicOperations.ZeroMemory(frame); }
            }, PowScope.SiteRecoveryKey)).RequireRateLimiting("mfa");
        post.Post(WireRoutes.SitePasskeyRemoveCurrentBegin, async (ctx, ct) =>
        {
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody != false)
                throw new BusinessException(Rejection.Invalid, "Passkey removal begins without a body.");
            return ServerHttp.Frame(await store.BeginSitePasskeyRemoveCurrent(Session(ctx), SiteSessions.Requested(ctx), ctx.Request.Cookies[RebindCookie], ct));
        });
        post.Post(WireRoutes.SitePasskeyRemoveCurrentComplete, async (ctx, ct) =>
        {
            var request = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            await store.CompleteSitePasskeyRemoveCurrent(Session(ctx), SiteSessions.Requested(ctx), ctx.Request.Cookies[RebindCookie], request, ct);
            ctx.Response.Cookies.Delete(sessionCookie, cookie("/"));
            ctx.Response.Cookies.Delete(RebindCookie, cookie(RebindPath));
            SiteRefreshEndpoints.ClearRefreshCookie(ctx);
            return ServerHttp.EmptyFrame();
        });
        post.Post(WireRoutes.RecoveryKeyRebindBegin, async (ctx, ct) =>
            ServerHttp.Frame(await store.BeginRecoveryRebind(ctx.Request.Cookies[RebindCookie], ct)));
        post.Post(WireRoutes.RecoveryKeyRebindComplete, async (ctx, ct) =>
        {
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            await store.CompleteRecoveryRebind(ctx.Request.Cookies[RebindCookie], PasskeyWire.ReadProvision(frame),
                SHA256.HashData(frame), ct);
            return ServerHttp.EmptyFrame();
        });

        string? Session(HttpContext ctx) => ctx.Request.Cookies[sessionCookie];
        async Task<RecoveryKeyOperation> Operation(HttpContext ctx, CancellationToken ct) =>
            Wire.DecodeRecoveryKeyOperation(await readFrame(ctx, WireLimits.RecoveryKeyOperationFrameBytes, ct));

        void RequirePost(HttpContext ctx)
        {
            requireHost(ctx);
            var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
            if (ctx.Request.Headers.Origin is { Count: 1 } origin &&
                string.Equals(origin[0], expected, StringComparison.OrdinalIgnoreCase)) return;
            throw new BusinessException(Rejection.Forbidden, "A same-origin recovery request is required.");
        }
    }
}

namespace FsusBlog.V2.Server.Passkeys;

internal static class MfaEndpoints
{
    internal const string LoginCookie = "fsus-v2-mfa-login";

    internal static void Map(WebApplication app, MfaStore store, PasskeyStore passkeys, string sessionName,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, Action<HttpContext> origin,
        Action<HttpContext, SiteRefreshStore.Issued> issueSession, Func<string, CookieOptions> cookie, bool persistentEnabled)
    {
        var post = new SiteMfaPostRoutes(app, origin);
        app.MapGet(WireRoutes.MfaProfile, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            return ServerHttp.Frame(await store.Profile(Session(ctx), ct));
        });
        post.Post(WireRoutes.PasskeyStepUpBegin, async (ctx, ct) =>
        {
            var action = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaChallengeStartRequest, 64);
            if (action != MfaWire.Setup) throw Forbidden();
            return ServerHttp.Frame(await passkeys.BeginSetupProof(Session(ctx), ct));
        });
        post.Post(WireRoutes.PasskeyStepUpComplete, async (ctx, ct) =>
        {
            var request = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return ServerHttp.Frame(await passkeys.CompleteSetupProof(Session(ctx), request, ct));
        });

        post.Post(WireRoutes.MfaSetupStart, async (ctx, ct) =>
        {
            if (Proof(ctx) is not { } proof) return Precondition(ctx);
            try { return ServerHttp.Frame(await store.BeginSetup(Session(ctx), proof, ct)); }
            catch (MfaProofRequiredException) { return Precondition(ctx); }
        });
        post.Post(WireRoutes.MfaSetupVerify, async (ctx, ct) =>
        {
            var code = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaSetupVerifyRequest, 6);
            try
            {
                var (frame, token, expiry) = await store.CompleteSetup(Session(ctx), code, ct);
                issueSession(ctx, new(token, expiry));
                return ServerHttp.Frame(frame);
            }
            catch (BusinessException error) when (error.Rejection == Rejection.Invalid)
            {
                return Error(ctx, StatusCodes.Status422UnprocessableEntity, error.Message);
            }
        });

        post.Post(WireRoutes.MfaChallengeStart, async (ctx, ct) =>
        {
            var action = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaChallengeStartRequest, 64);
            return action switch
            {
                MfaWire.Disable => ServerHttp.Frame(await store.BeginDisable(Session(ctx), ct)),
                MfaWire.Regenerate => ServerHttp.Frame(await store.BeginRecoveryRegeneration(Session(ctx), ct, SiteSessions.Requested(ctx))),
                _ => throw Forbidden()
            };
        });
        post.Post(WireRoutes.MfaChallengeVerify, async (ctx, ct) =>
        {
            var attempt = MfaWire.ReadAttempt(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct));
            if (attempt.Action == MfaWire.Disable)
                return ServerHttp.Frame(await store.VerifyDisable(Session(ctx), attempt, ct));
            if (attempt.Action == MfaWire.Regenerate)
                return ServerHttp.Frame(await store.VerifyRecoveryRegeneration(Session(ctx), attempt, ct, SiteSessions.Requested(ctx)));
            if (attempt.Action != MfaWire.Login) throw Forbidden();
            var (session, number) = await store.FinishLogin(attempt, ctx.Request.Cookies[LoginCookie], persistentEnabled, ct);
            ctx.Response.Cookies.Delete(LoginCookie, cookie(WireRoutes.MfaChallengeVerify));
            issueSession(ctx, session);
            return ServerHttp.Frame(MfaWire.EncodeChallenge(true, MfaWire.Login, account: number));
        });
        post.Post(WireRoutes.MfaDisable, async (ctx, ct) =>
        {
            if (Proof(ctx) is not { } proof) return Precondition(ctx);
            try
            {
                var (token, expiry) = await store.Disable(Session(ctx), proof, ct);
                issueSession(ctx, new(token, expiry));
                return ServerHttp.EmptyFrame();
            }
            catch (MfaProofRequiredException) { return Precondition(ctx); }
        });
        post.Post(WireRoutes.MfaRecoveryRegenerate, async (ctx, ct) =>
        {
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>() is { CanHaveBody: true })
                throw new BusinessException(Rejection.Invalid, "This operation does not accept a body.");
            try { return ServerHttp.Frame(await store.RegenerateRecoveryCodes(Session(ctx), Proof(ctx), ct, SiteSessions.Requested(ctx))); }
            catch (MfaProofRequiredException) { return Precondition(ctx); }
            catch (BusinessException error) when (error.Rejection == Rejection.Invalid)
            {
                return Error(ctx, StatusCodes.Status422UnprocessableEntity, error.Message);
            }
        });

        string? Session(HttpContext ctx) => ctx.Request.Cookies[sessionName];
    }

    private static string? Proof(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
    private static IResult Precondition(HttpContext ctx) =>
        Error(ctx, StatusCodes.Status428PreconditionRequired, "ANONYMOUS_MFA_STEP_UP_REQUIRED");
    private static IResult Error(HttpContext ctx, int status, string message) =>
        new AedsError(status, Wire.EncodeError(status, message, traceId: ctx.TraceIdentifier));

    private static BusinessException Forbidden() => new(Rejection.Forbidden, "This MFA action is not supported.");
}

using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Passkeys;

internal static class MfaEndpoints
{
    internal const string LoginCookie = "fsus-v2-mfa-login";

    internal static void Map(WebApplication app, MfaStore store, PasskeyStore passkeys, string sessionName,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, Action<HttpContext> origin,
        Action<HttpContext, string, DateTimeOffset> issueSession, Func<string, CookieOptions> cookie)
    {
        app.MapGet(WireRoutes.MfaProfile, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            return Frame(await store.Profile(Session(ctx), ct));
        });
        app.MapPost(WireRoutes.PasskeyStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            var action = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaChallengeStartRequest, 64);
            if (action != MfaWire.Setup) throw Forbidden();
            return Frame(await passkeys.BeginSetupProof(Session(ctx), ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.PasskeyStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            var request = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await passkeys.CompleteSetupProof(Session(ctx), request, ct));
        }).RequireRateLimiting("mfa");

        app.MapPost(WireRoutes.MfaSetupStart, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            if (Proof(ctx) is not { } proof) return Precondition(ctx);
            try { return Frame(await store.BeginSetup(Session(ctx), proof, ct)); }
            catch (MfaProofRequiredException) { return Precondition(ctx); }
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.MfaSetupVerify, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            var code = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaSetupVerifyRequest, 6);
            try
            {
                var (frame, token, expiry) = await store.CompleteSetup(Session(ctx), code, ct);
                issueSession(ctx, token, expiry);
                return Frame(frame);
            }
            catch (BusinessException error) when (error.Rejection == Rejection.Invalid)
            {
                return Error(ctx, StatusCodes.Status422UnprocessableEntity, error.Message);
            }
        }).RequireRateLimiting("mfa");

        app.MapPost(WireRoutes.MfaChallengeStart, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            var action = MfaWire.ReadSingle(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct), FrameType.MfaChallengeStartRequest, 64);
            if (action != MfaWire.Disable) throw Forbidden();
            return Frame(await store.BeginDisable(Session(ctx), ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.MfaChallengeVerify, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            var attempt = MfaWire.ReadAttempt(await readFrame(ctx, WireLimits.MaxMfaFrameBytes, ct));
            if (attempt.Action == MfaWire.Disable)
                return Frame(await store.VerifyDisable(Session(ctx), attempt, ct));
            if (attempt.Action != MfaWire.Login) throw Forbidden();
            var (token, number, expiry) = await store.FinishLogin(attempt, ctx.Request.Cookies[LoginCookie], ct);
            ctx.Response.Cookies.Delete(LoginCookie, cookie(WireRoutes.MfaChallengeVerify));
            issueSession(ctx, token, expiry);
            return Frame(MfaWire.EncodeChallenge(true, MfaWire.Login, account: number));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.MfaDisable, async (HttpContext ctx, CancellationToken ct) =>
        {
            origin(ctx);
            if (Proof(ctx) is not { } proof) return Precondition(ctx);
            try
            {
                var (token, expiry) = await store.Disable(Session(ctx), proof, ct);
                issueSession(ctx, token, expiry);
                return Frame(Wire.EncodeEmptySuccess());
            }
            catch (MfaProofRequiredException) { return Precondition(ctx); }
        }).RequireRateLimiting("mfa");

        string? Session(HttpContext ctx) => ctx.Request.Cookies[sessionName];
    }

    private static string? Proof(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
    private static IResult Precondition(HttpContext ctx) =>
        Error(ctx, StatusCodes.Status428PreconditionRequired, "ANONYMOUS_MFA_STEP_UP_REQUIRED");
    private static IResult Error(HttpContext ctx, int status, string message) =>
        new AedsError(status, Wire.EncodeError(status, message, traceId: ctx.TraceIdentifier));
    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
    private static BusinessException Forbidden() => new(Rejection.Forbidden, "This MFA action is not supported.");
}

using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.Http.Features;

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
        app.MapGet(WireRoutes.RecoveryKeyAvailability, (HttpContext ctx) =>
        {
            requireHost(ctx);
            return Frame(Wire.EncodeEmptySuccess());
        });
        app.MapGet(WireRoutes.RecoveryKeyStatus, async (HttpContext ctx, CancellationToken ct) =>
        {
            requireHost(ctx);
            return Frame(Wire.EncodeRecoveryKeyStatus(new(await store.RecoveryKeyStatus(Session(ctx), ct))));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            return Frame(await store.BeginRecoveryKeyStepUp(Session(ctx), await Operation(ctx, ct), ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            return Frame(await store.CompleteRecoveryKeyStepUp(Session(ctx), PasskeyWire.ReadLogin(frame, discoverable: false), ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyIssue, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var operation = await Operation(ctx, ct);
            var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
            try
            {
                var issued = await store.IssueRecoveryKey(secret, Session(ctx), operation, proof, ct);
                return Frame(Wire.EncodeRecoveryKeyIssued(issued));
            }
            catch (RecoveryKeyProofRequiredException)
            {
                const int status = StatusCodes.Status428PreconditionRequired;
                return new AedsError(status, Wire.EncodeError(status, "MFA_PROOF_REQUIRED", traceId: ctx.TraceIdentifier));
            }
        }).RequireRateLimiting("mfa");
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
        app.MapPost(WireRoutes.SitePasskeyRemoveCurrentBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody != false)
                throw new BusinessException(Rejection.Invalid, "Passkey removal begins without a body.");
            return Frame(await store.BeginSitePasskeyRemoveCurrent(Session(ctx), SiteSessions.Requested(ctx), ctx.Request.Cookies[RebindCookie], ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.SitePasskeyRemoveCurrentComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var request = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            await store.CompleteSitePasskeyRemoveCurrent(Session(ctx), SiteSessions.Requested(ctx), ctx.Request.Cookies[RebindCookie], request, ct);
            ctx.Response.Cookies.Delete(sessionCookie, cookie("/"));
            ctx.Response.Cookies.Delete(RebindCookie, cookie(RebindPath));
            SiteRefreshEndpoints.ClearRefreshCookie(ctx);
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyRebindBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            return Frame(await store.BeginRecoveryRebind(ctx.Request.Cookies[RebindCookie], ct));
        }).RequireRateLimiting("mfa");
        app.MapPost(WireRoutes.RecoveryKeyRebindComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            await store.CompleteRecoveryRebind(ctx.Request.Cookies[RebindCookie], PasskeyWire.ReadProvision(frame),
                SHA256.HashData(frame), ct);
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting("mfa");

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

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

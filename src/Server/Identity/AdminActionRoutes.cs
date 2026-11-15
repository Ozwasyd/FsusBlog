using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminActionRoutes(WebApplication app, string authority, string session,
    Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
{
    internal void Availability(string route, Func<string?, CancellationToken, Task> check) =>
        app.MapGet(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            await check(ctx.Request.Cookies[session], ct);
            return Results.NoContent();
        }).RequireRateLimiting("command");

    internal Task<byte[]> Read(HttpContext ctx, int maximum, CancellationToken ct)
    {
        AdminModerationEndpoints.RequireOrigin(ctx, authority);
        return readFrame(ctx, maximum, ct);
    }

    internal RouteHandlerBuilder Post(string route, int maximum,
        Func<string?, byte[], CancellationToken, Task<byte[]>> apply) =>
        app.MapPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await Read(ctx, maximum, ct);
            return Frame(await apply(ctx.Request.Cookies[session], frame, ct));
        });

    internal void Complete(string route, string limit,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> apply) =>
        app.MapPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            var assertion = PasskeyWire.ReadLogin(await Read(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await apply(ctx.Request.Cookies[session], assertion, ct));
        }).RequireRateLimiting(limit);

    internal static string? Proof(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;

    internal static IResult ProofRequired(HttpContext ctx)
    {
        const int status = StatusCodes.Status428PreconditionRequired;
        return new AedsError(status, Wire.EncodeError(status, "MFA_PROOF_REQUIRED", traceId: ctx.TraceIdentifier));
    }

    internal static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

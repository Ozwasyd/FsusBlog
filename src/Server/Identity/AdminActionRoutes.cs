using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

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
        RequireOrigin(ctx, authority);
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

    internal static void RequireOrigin(HttpContext ctx, string authority)
    {
        var origin = ctx.Request.Headers.Origin;
        if (origin.Count == 1 && string.Equals(origin[0], authority, StringComparison.OrdinalIgnoreCase)) return;
        var referer = ctx.Request.Headers.Referer;
        if (origin.Count == 0 && referer.Count == 1 && Uri.TryCreate(referer[0], UriKind.Absolute, out var uri) &&
            string.Equals(uri.GetLeftPart(UriPartial.Authority), authority, StringComparison.OrdinalIgnoreCase)) return;
        throw new BusinessException(Rejection.Forbidden, "A same-origin administrator request is required.");
    }

    internal static long PositiveCoordinate(HttpContext ctx, string key)
    {
        if (ctx.Request.Query[key] is { Count: 1 } values && values[0] is { Length: >= 1 and <= 19 } text &&
            long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var coordinate) && coordinate > 0 &&
            coordinate.ToString(CultureInfo.InvariantCulture) == text)
            return coordinate;
        throw InvalidCoordinate();
    }

    internal static BusinessException InvalidCoordinate() =>
        new(Rejection.Invalid, "Use an exact article ID and historical revision.");

    internal static string? Proof(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;

    internal static IResult ProofRequired(HttpContext ctx)
    {
        const int status = StatusCodes.Status428PreconditionRequired;
        return new AedsError(status, Wire.EncodeError(status, "MFA_PROOF_REQUIRED", traceId: ctx.TraceIdentifier));
    }

    internal static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminActionRoutes(WebApplication app, string authority, string session, string passkeyLimit,
    Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
{
    internal WebApplication App { get; } = app;
    internal string PasskeyLimit { get; } = passkeyLimit;
    internal string? Session(HttpContext ctx) => ctx.Request.Cookies[session];
    internal void RequireOrigin(HttpContext ctx) => RequireOrigin(ctx, authority);

    internal void Availability(string route, Func<string?, CancellationToken, Task> check) =>
        App.MapCommandGet(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            await check(Session(ctx), ct);
            return Results.NoContent();
        });

    internal Task<byte[]> Read(HttpContext ctx, int maximum, CancellationToken ct)
    {
        RequireOrigin(ctx);
        return readFrame(ctx, maximum, ct);
    }

    internal delegate T IntentDecoder<T>(ReadOnlySpan<byte> frame);

    internal async Task<T> ReadIntent<T>(HttpContext ctx, int maximum, IntentDecoder<T> decode,
        Func<T, Guid> idempotencyKey, bool required, CancellationToken ct)
    {
        var intent = decode(await Read(ctx, maximum, ct));
        ClientMutationHeader.Require(ctx, idempotencyKey(intent), required: required);
        return intent;
    }

    internal RouteHandlerBuilder Post(string route, int maximum,
        Func<string?, byte[], CancellationToken, Task<byte[]>> apply) =>
        App.MapPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await Read(ctx, maximum, ct);
            return Frame(await apply(Session(ctx), frame, ct));
        });

    internal void Begin<T>(string route, Func<HttpContext, CancellationToken, Task<T>> readIntent,
        Func<string?, T, CancellationToken, Task<byte[]>> begin) =>
        App.MapPost(route, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await begin(Session(ctx), await readIntent(ctx, ct), ct))).RequireRateLimiting(PasskeyLimit);

    internal void Complete(string route,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> apply) =>
        App.MapPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            var assertion = PasskeyWire.ReadLogin(await Read(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await apply(Session(ctx), assertion, ct));
        }).RequireRateLimiting(PasskeyLimit);

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

namespace FsusBlog.V2.Server.Administration;

internal abstract class ProofRequiredException : Exception;

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
            Frame(await apply(Session(ctx), await Read(ctx, maximum, ct), ct)));

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

    internal void Execute(string route, Func<HttpContext, CancellationToken, Task<IResult>> run, bool noStore = false) =>
        App.MapCommandPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            if (noStore) ctx.Response.Headers.CacheControl = "no-store";
            try { return await run(ctx, ct); }
            catch (ProofRequiredException) { return ProofRequired(ctx); }
        });

    internal void StepUpWithPermission<TIntent, TReceipt>(string begin, string complete, string execute, int maximum,
        IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey,
        Func<string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
        Func<string?, string?, TIntent, CancellationToken, Task<(TReceipt Receipt, string PermissionSession)>> apply,
        Func<TReceipt, byte[]> encode)
    {
        Task<TIntent> ReadCommand(HttpContext ctx, CancellationToken ct) =>
            ReadIntent(ctx, maximum, decode, idempotencyKey, required: true, ct);
        Begin(begin, ReadCommand, beginStepUp);
        Complete(complete, completeStepUp);
        Execute(execute, async (ctx, ct) =>
        {
            var result = await apply(Session(ctx), Proof(ctx), await ReadCommand(ctx, ct), ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Frame(encode(result.Receipt));
        }, noStore: true);
    }

    internal void StepUpPow<TIntent>(string begin, string complete, string powRoute, string execute,
        int maximum, IntentDecoder<TIntent> decode, PowScope scope,
        Func<HttpContext, string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
        Func<HttpContext, string?, TIntent, byte[], ScopedPow, CancellationToken, Task<byte[]>> issuePow,
        Func<HttpContext, string?, TIntent, byte[], string?, ScopedPow, CancellationToken, Task> apply)
    {
        App.MapPost(begin, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await beginStepUp(ctx, Session(ctx), decode(await Read(ctx, maximum, ct)), ct))).RequireRateLimiting(PasskeyLimit);
        Complete(complete, completeStepUp);
        App.MapCommandPost(powRoute, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await Read(ctx, maximum, ct);
                return await issuePow(ctx, Session(ctx), decode(frame), frame, pow, ct);
            }, scope));
        App.MapCommandPost(execute, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await Read(ctx, maximum, ct);
                await apply(ctx, Session(ctx), decode(frame), frame, Proof(ctx), pow, ct);
                return Wire.EncodeEmptySuccess();
            }, scope));
    }

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

    internal static IResult Frame(byte[] frame) => ServerHttp.Frame(frame);
}

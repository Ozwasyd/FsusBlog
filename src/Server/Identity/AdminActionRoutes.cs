namespace FsusBlog.V2.Server.Administration;

internal abstract class ProofRequiredException : Exception;

internal sealed class AdminActionRoutes(WebApplication app, string authority, string session, string passkeyLimit)
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

    internal void GetPermission<T>(string route,
        Func<HttpContext, string?, CancellationToken, Task<(T Value, string PermissionSession)>> load,
        Func<T, byte[]> encode, bool noStore = false, string? rateLimit = null, Action<HttpContext>? extraHeaders = null)
    {
        var builder = App.MapGet(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            if (noStore) ctx.Response.Headers.CacheControl = "no-store";
            var (value, permission) = await load(ctx, Session(ctx), ct);
            extraHeaders?.Invoke(ctx);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = permission;
            return Frame(encode(value));
        });
        builder.RequireRateLimiting(rateLimit ?? CommandEndpoints.Policy);
    }

    internal Task<byte[]> Read(HttpContext ctx, int maximum, CancellationToken ct)
    {
        RequireOrigin(ctx);
        return ServerHttp.ReadFrame(ctx, maximum, ct);
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
            Frame(await apply(Session(ctx), PasskeyWire.ReadLogin(await Read(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false), ct)))
            .RequireRateLimiting(PasskeyLimit);

    internal void Execute(string route, Func<HttpContext, CancellationToken, Task<IResult>> run, bool noStore = false) =>
        App.MapCommandPost(route, async (HttpContext ctx, CancellationToken ct) =>
        {
            if (noStore) ctx.Response.Headers.CacheControl = "no-store";
            try { return await run(ctx, ct); }
            catch (ProofRequiredException) { return ProofRequired(ctx); }
        });

    internal void ArticleAction<TIntent, TReceipt>(string available, string begin, string complete, string execute,
        int maximum, IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey, bool headerRequired,
        Func<string?, CancellationToken, Task> checkAvailability,
        Func<string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
        Func<HttpContext, string?, string?, TIntent, CancellationToken, Task<TReceipt>> apply,
        Func<TReceipt, byte[]> encode)
    {
        Task<TIntent> ReadCommand(HttpContext ctx, CancellationToken ct) =>
            ReadIntent(ctx, maximum, decode, idempotencyKey, headerRequired, ct);
        Availability(available, checkAvailability);
        Begin(begin, ReadCommand, beginStepUp);
        Complete(complete, completeStepUp);
        App.MapCommandPost(execute, async (HttpContext ctx, CancellationToken ct) =>
            Frame(encode(await apply(ctx, Session(ctx), Proof(ctx), await ReadCommand(ctx, ct), ct))));
    }

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
            var (receipt, permission) = await apply(Session(ctx), Proof(ctx), await ReadCommand(ctx, ct), ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = permission;
            return Frame(encode(receipt));
        }, noStore: true);
    }

    internal void StepUpPow<TIntent>(string begin, string complete, string powRoute, string execute,
        int maximum, IntentDecoder<TIntent> decode, PowScope scope,
        Func<HttpContext, string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
        Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
        Func<HttpContext, string?, TIntent, byte[], ScopedPow, CancellationToken, Task<byte[]>> issuePow,
        Func<HttpContext, string?, TIntent, byte[], string?, ScopedPow, CancellationToken, Task>? apply = null)
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
        if (apply is not null)
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

    internal static long PositiveCoordinate(HttpContext ctx, string key, Func<Exception>? onError = null) =>
        TryPositiveCoordinate(ctx.Request.Query, key, out var coordinate) ? coordinate : throw (onError ?? InvalidCoordinate)();

    internal static bool TryPositiveCoordinate(IQueryCollection query, string key, out long coordinate)
    {
        if (query[key] is { Count: 1 } values && values[0] is { Length: >= 1 and <= 19 } text &&
            long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out coordinate) && coordinate > 0 &&
            coordinate.ToString(CultureInfo.InvariantCulture) == text)
            return true;
        coordinate = 0;
        return false;
    }

    internal static int PositiveIntCoordinate(HttpContext ctx, string key, Func<Exception>? onError = null) =>
        PositiveCoordinate(ctx, key, onError) is var v && v <= int.MaxValue ? (int)v : throw (onError ?? InvalidCoordinate)();

    internal static BusinessException InvalidCoordinate() =>
        new(Rejection.Invalid, "Use an exact article ID and historical revision.");

    internal static string? Proof(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;

    internal static IResult ProofRequired(HttpContext ctx) =>
        ServerHttp.ErrorFrame(ctx, StatusCodes.Status428PreconditionRequired, "MFA_PROOF_REQUIRED");

    internal static IResult Frame(byte[] frame) => ServerHttp.Frame(frame);
}

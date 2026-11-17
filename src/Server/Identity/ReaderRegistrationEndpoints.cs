using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Passkeys;

internal static class ReaderRegistrationEndpoints
{
    private const string Base = "/api/v2/identity/reader-registration";
    private const string BrowserCookie = "fsus-v2-reader-registration";
    private const string Context = "reader-registration";

    internal static void Map(WebApplication app, PasskeyStore store,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        Action<HttpContext> requireHost, Action<HttpContext> requireOrigin, Func<string, CookieOptions> cookie)
    {
        var pow = app.Services.GetRequiredService<ScopedPow>();
        var acceptance = Wire.EncodeEmptySuccess();
        app.MapGet(Base + "/status.aeds", (HttpContext ctx) =>
        {
            NoStore(ctx);
            requireHost(ctx);
            return Results.Bytes(acceptance, Aeds.ContentType);
        }).RequireRateLimiting("query");
        app.MapPost(Base + "/pow.aeds", (HttpContext ctx, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                RequirePost(ctx);
                var frame = await Accepted(ctx, ct);
                var binding = PasskeyStore.NewReaderRegistrationBinding();
                var challenge = pow.Issue(PowScope.ReaderRegistration, Context, binding,
                    ScopedPow.Source(ctx), ScopedPow.ReadClientNonce(ctx), frame);
                var options = cookie(Base);
                options.MaxAge = TimeSpan.FromMinutes(5);
                ctx.Response.Cookies.Append(BrowserCookie, binding, options);
                return PowWire.EncodeChallenge(challenge);
            }, PowScope.ReaderRegistration)).RequireRateLimiting("reader-registration");
        app.MapPost(Base + "/begin.aeds", (HttpContext ctx, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                RequirePost(ctx);
                var frame = await Accepted(ctx, ct);
                var binding = Binding(ctx);
                var proof = ScopedPow.ReadProof(ctx);
                return await store.BeginReaderRegistration(binding, (db, tx) =>
                    pow.Consume(db, tx, PowScope.ReaderRegistration, Context, binding,
                        ScopedPow.Source(ctx), frame, proof, ct), ct);
            }, PowScope.ReaderRegistration)).RequireRateLimiting("reader-registration");
        app.MapPost(Base + "/complete.aeds", async (HttpContext ctx, CancellationToken ct) =>
        {
            RequirePost(ctx);
            var binding = Binding(ctx);
            var request = PasskeyWire.ReadProvision(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct));
            ctx.Response.Cookies.Delete(BrowserCookie, cookie(Base));
            await store.CompleteReaderRegistration(request, binding, ct);
            return Results.Bytes(acceptance, Aeds.ContentType);
        }).RequireRateLimiting("reader-registration");

        void RequirePost(HttpContext ctx) { NoStore(ctx); requireOrigin(ctx); }
        async Task<byte[]> Accepted(HttpContext ctx, CancellationToken ct)
        {
            var frame = await readFrame(ctx, acceptance.Length, ct);
            if (!frame.AsSpan().SequenceEqual(acceptance))
                throw new BusinessException(Rejection.Invalid, "Explicit reader registration acceptance is required.");
            return frame;
        }
        static string Binding(HttpContext ctx)
        {
            var binding = ctx.Request.Cookies[BrowserCookie];
            if (!PasskeyStore.ValidReaderRegistrationToken(binding))
                throw new BusinessException(Rejection.Unauthorized, "Reader registration browser binding is required.");
            return binding!;
        }
    }

    private static void NoStore(HttpContext ctx) => ctx.Response.Headers.CacheControl = "private, no-store";
}

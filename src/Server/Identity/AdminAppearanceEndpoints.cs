using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminAppearanceEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, AppearanceRegistry registry)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        app.MapGet(WireRoutes.AdminAppearanceState, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppearance(ctx.Request.Cookies[session], registry, ct))).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminAppearanceCatalog, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.AppearanceCatalog(ctx.Request.Cookies[session], registry, ct))).RequireRateLimiting("query");
        app.MapPost(WireRoutes.AdminAppearanceStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            var assertion = PasskeyWire.ReadLogin(frame, discoverable: false);
            return Frame(await store.CompleteAppearanceStepUp(ctx.Request.Cookies[session], assertion, ct));
        }).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminAppearanceStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (_, command) = await Decode(ctx, ct);
            return Frame(await store.BeginAppearanceStepUp(ctx.Request.Cookies[session], registry, command, ct));
        }).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminAppearancePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                return await store.IssueAppearancePow(ctx.Request.Cookies[session], registry, command, frame, pow, ctx, ct);
            }, PowScope.AdminAppearance)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminAppearanceApply, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
                await store.ApplyAppearance(ctx.Request.Cookies[session], registry, command, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminAppearance)).RequireRateLimiting("command");

        async Task<(byte[], AdminAppearanceCommand)> Decode(HttpContext ctx, CancellationToken ct)
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var body = await readFrame(ctx, WireLimits.AdminAppearanceCommandFrameBytes, ct);
            return (body, Wire.DecodeAdminAppearanceCommand(body));
        }
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

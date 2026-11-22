using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSiteConfigEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminSiteConfigStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, PublicSiteConfiguration config)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);

        app.MapGet(WireRoutes.AdminSiteConfig, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.ReadSiteConfig(ctx.Request.Cookies[session], config, ct)))
            .RequireRateLimiting("query");

        app.MapPost(WireRoutes.AdminSiteConfigStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
            var command = Wire.DecodeAdminSiteConfigCommand(frame);
            return AdminActionRoutes.Frame(await store.BeginSiteConfigStepUp(ctx.Request.Cookies[session], config, command, ct));
        }).RequireRateLimiting(passkeyLimit);

        actions.Complete(WireRoutes.AdminSiteConfigStepUpComplete, passkeyLimit, store.CompleteSiteConfigStepUp);

        app.MapPost(WireRoutes.AdminSiteConfigPow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
                var command = Wire.DecodeAdminSiteConfigCommand(frame);
                return await store.IssueSiteConfigPow(ctx.Request.Cookies[session], config, command, frame, pow, ctx, ct);
            }, PowScope.AdminSiteConfig)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminSiteConfigSave, (HttpContext ctx, Publications publications, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
                var command = Wire.DecodeAdminSiteConfigCommand(frame);
                var proof = AdminActionRoutes.Proof(ctx);
                await store.SaveSiteConfig(ctx.Request.Cookies[session], config, publications, command, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminSiteConfig)).RequireRateLimiting("command");
    }
}

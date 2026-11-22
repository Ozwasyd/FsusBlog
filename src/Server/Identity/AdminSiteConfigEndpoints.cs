using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSiteConfigEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminSiteConfigStore store, PublicSiteConfiguration config)
    {
        actions.App.MapQueryGet(WireRoutes.AdminSiteConfig, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.ReadSiteConfig(actions.Session(ctx), config, ct)));

        actions.App.MapPost(WireRoutes.AdminSiteConfigStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
            var command = Wire.DecodeAdminSiteConfigCommand(frame);
            return AdminActionRoutes.Frame(await store.BeginSiteConfigStepUp(actions.Session(ctx), config, command, ct));
        }).RequireRateLimiting(actions.PasskeyLimit);

        actions.Complete(WireRoutes.AdminSiteConfigStepUpComplete, store.CompleteSiteConfigStepUp);

        actions.App.MapCommandPost(WireRoutes.AdminSiteConfigPow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
                var command = Wire.DecodeAdminSiteConfigCommand(frame);
                return await store.IssueSiteConfigPow(actions.Session(ctx), config, command, frame, pow, ctx, ct);
            }, PowScope.AdminSiteConfig));

        actions.App.MapCommandPost(WireRoutes.AdminSiteConfigSave, (HttpContext ctx, Publications publications, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSiteConfigFrameBytes, ct);
                var command = Wire.DecodeAdminSiteConfigCommand(frame);
                var proof = AdminActionRoutes.Proof(ctx);
                await store.SaveSiteConfig(actions.Session(ctx), config, publications, command, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminSiteConfig));
    }
}

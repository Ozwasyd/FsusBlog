using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminTagMetadataEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_TAG_METADATA";

    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        app.MapGet(WireRoutes.AdminTagMetadataAvailability, async (HttpContext ctx, CancellationToken ct) =>
        {
            await store.TagMetadataAvailable(ctx.Request.Cookies[session], ct);
            return Results.NoContent();
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AdminTagMetadata, async (HttpContext ctx, int id, CancellationToken ct) =>
            Results.Bytes(Wire.EncodeAdminTagMetadata(await store.ReadTagMetadata(ctx.Request.Cookies[session], id, ct)), Aeds.ContentType))
            .RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminTagMetadataPow, (HttpContext ctx, int id, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (input, frame) = await Read(ctx, id, ct);
                return await store.ChangeTagMetadata(ctx.Request.Cookies[session], input, frame, ctx, pow, null, ct);
            }, PowScope.AdminTagMetadata)).RequireRateLimiting("command");

        app.MapPut(WireRoutes.AdminTagMetadata, (HttpContext ctx, int id, ScopedPow pow, Publications publications, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (input, frame) = await Read(ctx, id, ct);
                return await publications.AdministrativePublication(invalidate =>
                    store.ChangeTagMetadata(ctx.Request.Cookies[session], input, frame, ctx, pow, invalidate, ct), ct);
            }, PowScope.AdminTagMetadata)).RequireRateLimiting("command");

        async Task<(AdminTagMetadataCommand Input, byte[] Frame)> Read(HttpContext ctx, int id, CancellationToken ct)
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminTagMetadataFrameBytes, ct);
            var input = Wire.DecodeAdminTagMetadataCommand(frame);
            if (input.Id != id) throw new BusinessException(Rejection.Invalid, "Tag ID does not match the request route.");
            return (input, frame);
        }
    }
}

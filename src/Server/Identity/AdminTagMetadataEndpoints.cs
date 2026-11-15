using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminTagMetadataEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_TAG_METADATA";
    internal const string CategorySetting = "FSUSBLOG_ADMIN_CATEGORY_METADATA";

    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, bool category = false)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        var route = category ? WireRoutes.AdminCategoryMetadata : WireRoutes.AdminTagMetadata;
        var proof = category ? WireRoutes.AdminCategoryMetadataPow : WireRoutes.AdminTagMetadataPow;
        var scope = category ? PowScope.AdminCategoryMetadata : PowScope.AdminTagMetadata;
        actions.Availability(category ? WireRoutes.AdminCategoryMetadataAvailability : WireRoutes.AdminTagMetadataAvailability,
            store.TagMetadataAvailable);

        app.MapGet(route, async (HttpContext ctx, int id, CancellationToken ct) =>
        {
            var cookie = ctx.Request.Cookies[session];
            return AdminActionRoutes.Frame(category
                ? Wire.EncodeAdminCategoryMetadata(await store.ReadCategoryMetadata(cookie, id, ct))
                : Wire.EncodeAdminTagMetadata(await store.ReadTagMetadata(cookie, id, ct)));
        }).RequireRateLimiting("command");
        app.MapPost(proof, (HttpContext ctx, int id, ScopedPow pow, CancellationToken ct) =>
            Protect(ctx, id, pow, null, false, ct)).RequireRateLimiting("command");
        app.MapPut(route, (HttpContext ctx, int id, ScopedPow pow, Publications publications, CancellationToken ct) =>
            Protect(ctx, id, pow, publications, false, ct)).RequireRateLimiting("command");

        if (category)
        {
            app.MapPost(WireRoutes.AdminCategoryCreatePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Protect(ctx, 0, pow, null, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminCategoryCreate, (HttpContext ctx, ScopedPow pow, Publications publications, CancellationToken ct) =>
                Protect(ctx, 0, pow, publications, true, ct)).RequireRateLimiting("command");
        }

        Task<IResult> Protect(HttpContext ctx, int id, ScopedPow pow, Publications? publications, bool create, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminTagMetadataFrameBytes, ct);
                var input = category ? Wire.DecodeAdminCategoryMetadataCommand(frame) : Wire.DecodeAdminTagMetadataCommand(frame);
                if (input.Id != id || (!create && id <= 0))
                    throw new BusinessException(Rejection.Invalid, category ? "Category ID does not match the request route." : "Tag ID does not match the request route.");
                Task<byte[]> Apply(Action? invalidate) => category
                    ? store.ChangeCategoryMetadata(ctx.Request.Cookies[session], input, frame, ctx, pow, invalidate, ct)
                    : store.ChangeTagMetadata(ctx.Request.Cookies[session], input, frame, ctx, pow, invalidate, ct);
                return publications is null ? await Apply(null) : await publications.AdministrativePublication(Apply, ct);
            }, scope);
    }
}

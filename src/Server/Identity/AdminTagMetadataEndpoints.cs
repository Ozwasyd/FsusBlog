using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminTagMetadataEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_TAG_METADATA";
    internal const string CategorySetting = "FSUSBLOG_ADMIN_CATEGORY_METADATA";

    internal static void Map(AdminActionRoutes actions, AdminTagMetadataStore store, bool category = false)
    {
        var route = category ? WireRoutes.AdminCategoryMetadata : WireRoutes.AdminTagMetadata;
        var proof = category ? WireRoutes.AdminCategoryMetadataPow : WireRoutes.AdminTagMetadataPow;
        var scope = category ? PowScope.AdminCategoryMetadata : PowScope.AdminTagMetadata;
        actions.Availability(category ? WireRoutes.AdminCategoryMetadataAvailability : WireRoutes.AdminTagMetadataAvailability,
            store.TagMetadataAvailable);

        actions.App.MapCommandGet(route, async (HttpContext ctx, int id, CancellationToken ct) =>
        {
            var cookie = actions.Session(ctx);
            return AdminActionRoutes.Frame(category
                ? Wire.EncodeAdminCategoryMetadata(await store.ReadCategoryMetadata(cookie, id, ct))
                : Wire.EncodeAdminTagMetadata(await store.ReadTagMetadata(cookie, id, ct)));
        });
        actions.App.MapCommandPost(proof, (HttpContext ctx, int id, ScopedPow pow, CancellationToken ct) =>
            Protect(ctx, id, pow, null, false, ct));
        actions.App.MapCommandPut(route, (HttpContext ctx, int id, ScopedPow pow, Publications publications, CancellationToken ct) =>
            Protect(ctx, id, pow, publications, false, ct));

        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryCreatePow : WireRoutes.AdminTagCreatePow,
            (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Protect(ctx, 0, pow, null, true, ct));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryCreate : WireRoutes.AdminTagCreate,
            (HttpContext ctx, ScopedPow pow, Publications publications, CancellationToken ct) =>
                Protect(ctx, 0, pow, publications, true, ct));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryDelete : WireRoutes.AdminTagDelete,
            async (HttpContext ctx, int id, Publications publications, CancellationToken ct) =>
            {
                actions.RequireOrigin(ctx);
                if (id <= 0)
                    throw new BusinessException(Rejection.Invalid, category ? "Invalid category ID." : "Invalid tag ID.");
                return AdminActionRoutes.Frame(await publications.AdministrativePublication(
                    invalidate => store.DeleteTaxonomy(actions.Session(ctx), id, category, invalidate, ct), ct));
            });

        Task<IResult> Protect(HttpContext ctx, int id, ScopedPow pow, Publications? publications, bool create, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminTagMetadataFrameBytes, ct);
                var input = category ? Wire.DecodeAdminCategoryMetadataCommand(frame)
                    : create ? Wire.DecodeAdminTagCreateCommand(frame) : Wire.DecodeAdminTagMetadataCommand(frame);
                if (input.Id != id || (!create && id <= 0))
                    throw new BusinessException(Rejection.Invalid, category ? "Category ID does not match the request route." : "Tag ID does not match the request route.");
                Task<byte[]> Apply(Action? invalidate) => category
                    ? store.ChangeCategoryMetadata(actions.Session(ctx), input, frame, ctx, pow, invalidate, ct)
                    : store.ChangeTagMetadata(actions.Session(ctx), input, frame, ctx, pow, invalidate, ct);
                return publications is null ? await Apply(null) : await publications.AdministrativePublication(Apply, ct);
            }, scope);
    }
}

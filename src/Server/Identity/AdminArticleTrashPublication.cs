using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleTrashPublication
{
    internal static void Map(WebApplication app, Uri origin, AdminArticleTrashPublicationStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var routes = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        var media = app.Services.GetService<PublishedMediaStore>();
        routes.Availability(WireRoutes.AdminArticleTrashPublicationAvailability, store.CheckTrashPublicationAvailability);
        app.MapGet(WireRoutes.AdminArticleTrashPublicationPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = AdminActionRoutes.PositiveCoordinate(ctx, "articleId");
            var revision = AdminActionRoutes.PositiveCoordinate(ctx, "revision");
            if (article > int.MaxValue) throw new BusinessException(Rejection.Invalid, "Invalid article ID.");
            var preview = await store.PreviewTrashPublication(ctx.Request.Cookies[session], (int)article, revision, ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashPublicationPreview(preview));
        }).RequireRateLimiting("command");
        routes.Complete(WireRoutes.AdminArticleTrashPublicationComplete, limit, store.CompleteTrashPublicationStepUp);
        app.MapPost(WireRoutes.AdminArticleTrashPublicationBegin, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.BeginTrashPublicationStepUp(ctx.Request.Cookies[session], await Intent(ctx, ct), ct)))
            .RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleTrashPublicationExecute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            var intent = await Intent(ctx, ct);
            var result = await publications.AdministrativePublication(invalidate => store.RestoreTrashPublication(
                ctx.Request.Cookies[session], AdminActionRoutes.Proof(ctx), intent, media, invalidate, ct), ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashPublicationReceipt(result));
        }).RequireRateLimiting("command");

        Task<AdminArticleTrashPublicationIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            routes.ReadIntent(ctx, WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleTrashPublicationIntent,
                intent => intent.IdempotencyKey, required: true, ct);
    }
}

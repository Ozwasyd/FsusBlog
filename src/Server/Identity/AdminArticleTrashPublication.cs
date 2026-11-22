using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleTrashPublication
{
    internal static void Map(AdminActionRoutes actions, AdminArticleTrashPublicationStore store)
    {
        var media = actions.App.Services.GetService<PublishedMediaStore>();
        actions.Availability(WireRoutes.AdminArticleTrashPublicationAvailability, store.CheckTrashPublicationAvailability);
        actions.App.MapCommandGet(WireRoutes.AdminArticleTrashPublicationPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = AdminActionRoutes.PositiveCoordinate(ctx, "articleId");
            var revision = AdminActionRoutes.PositiveCoordinate(ctx, "revision");
            if (article > int.MaxValue) throw new BusinessException(Rejection.Invalid, "Invalid article ID.");
            var preview = await store.PreviewTrashPublication(actions.Session(ctx), (int)article, revision, ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashPublicationPreview(preview));
        });
        actions.Complete(WireRoutes.AdminArticleTrashPublicationComplete, store.CompleteTrashPublicationStepUp);
        actions.Begin(WireRoutes.AdminArticleTrashPublicationBegin, Intent, store.BeginTrashPublicationStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminArticleTrashPublicationExecute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            var intent = await Intent(ctx, ct);
            var result = await publications.AdministrativePublication(invalidate => store.RestoreTrashPublication(
                actions.Session(ctx), AdminActionRoutes.Proof(ctx), intent, media, invalidate, ct), ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashPublicationReceipt(result));
        });

        Task<AdminArticleTrashPublicationIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleTrashPublicationIntent,
                intent => intent.IdempotencyKey, required: true, ct);
    }
}

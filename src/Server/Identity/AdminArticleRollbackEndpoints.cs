using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Passkeys;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleRollbackEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_ARTICLE_ROLLBACK";

    internal static void Map(AdminActionRoutes actions, AdminArticleRollbackStore rollback, AdminArticleArchiveStore archive)
    {
        MapAction<AdminArticleRollbackIntent, AdminArticleRollbackReceipt>(
            WireRoutes.AdminArticleRollbackAvailability, WireRoutes.AdminArticleRollbackStepUpBegin,
            WireRoutes.AdminArticleRollbackStepUpComplete, WireRoutes.AdminArticleRollbackExecute,
            WireLimits.MaxAdminArticleRollbackFrameBytes, Wire.DecodeAdminArticleRollbackIntent, intent => intent.IdempotencyKey,
            rollback.CheckArticleRollbackAvailability, rollback.BeginArticleRollbackStepUp, rollback.CompleteArticleRollbackStepUp,
            rollback.ExecuteArticleRollback, Wire.EncodeAdminArticleRollbackReceipt);
        actions.App.MapQueryGet(WireRoutes.AdminArticleRollbackPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = PositiveCoordinate(ctx, "articleId");
            var source = PositiveCoordinate(ctx, "sourceRevision");
            if (article > int.MaxValue) throw InvalidCoordinate();
            var result = await rollback.PreviewArticleRollback(actions.Session(ctx), (int)article, source, ct);
            return Frame(Wire.EncodeAdminArticleRollbackPreview(result));
        });

        MapAction<AdminArticleDraftRollbackIntent, AdminArticleDraftRollbackReceipt>(
            WireRoutes.AdminArticleDraftRollbackAvailability, WireRoutes.AdminArticleDraftRollbackStepUpBegin,
            WireRoutes.AdminArticleDraftRollbackStepUpComplete, WireRoutes.AdminArticleDraftRollbackExecute,
            WireLimits.MaxAdminArticleDraftRollbackFrameBytes, Wire.DecodeAdminArticleDraftRollbackIntent, intent => intent.IdempotencyKey,
            rollback.CheckArticleDraftRollbackAvailability, rollback.BeginArticleDraftRollbackStepUp, rollback.CompleteArticleDraftRollbackStepUp,
            rollback.ExecuteArticleDraftRollback, Wire.EncodeAdminArticleDraftRollbackReceipt);

        MapAction<AdminArticleArchiveIntent, AdminArticleArchiveReceipt>(
            WireRoutes.AdminArticleArchiveAvailability, WireRoutes.AdminArticleArchiveStepUpBegin,
            WireRoutes.AdminArticleArchiveStepUpComplete, WireRoutes.AdminArticleArchiveExecute,
            WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleArchiveIntent, intent => intent.IdempotencyKey,
            archive.CheckArticleArchiveAvailability, archive.BeginArticleArchiveStepUp, archive.CompleteArticleArchiveStepUp,
            archive.ExecuteArticleArchive, Wire.EncodeAdminArticleArchiveReceipt);
        actions.App.MapQueryGet(WireRoutes.AdminArticleArchivePage, async (HttpContext ctx, CancellationToken ct) =>
        {
            var before = ctx.Request.Query.ContainsKey("before") ? PositiveCoordinate(ctx, "before") : 0;
            if (before > int.MaxValue) throw InvalidCoordinate();
            var page = await archive.ListArchivedArticles(actions.Session(ctx), (int)before, ct);
            return Frame(Wire.EncodeAdminArticleArchivePage(page));
        });
        actions.App.MapQueryGet(WireRoutes.AdminArticleArchivePreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = PositiveCoordinate(ctx, "articleId");
            var revision = PositiveCoordinate(ctx, "revision");
            var privateRelease = PositiveCoordinate(ctx, "privateReleaseId");
            if (article > int.MaxValue) throw InvalidCoordinate();
            return Frame(await archive.PreviewArchivedArticle(actions.Session(ctx), (int)article, revision, privateRelease, ct));
        });

        void MapAction<TIntent, TReceipt>(string available, string begin, string complete, string execute,
            int maximum, AdminActionRoutes.IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey,
            Func<string?, CancellationToken, Task> checkAvailability,
            Func<string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
            Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
            Func<string?, string?, TIntent, Action, CancellationToken, Task<TReceipt>> apply,
            Func<TReceipt, byte[]> encode)
        {
            actions.Availability(available, checkAvailability);
            actions.App.MapPost(begin, async (HttpContext ctx, CancellationToken ct) =>
            {
                var intent = await ReadIntent(ctx, ct);
                return Frame(await beginStepUp(actions.Session(ctx), intent, ct));
            }).RequireRateLimiting(actions.PasskeyLimit);
            actions.Complete(complete, completeStepUp);
            actions.App.MapCommandPost(execute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
            {
                var intent = await ReadIntent(ctx, ct);
                var proof = Proof(ctx);
                var receipt = await publications.AdministrativePublication(
                    invalidate => apply(actions.Session(ctx), proof, intent, invalidate, ct), ct);
                return Frame(encode(receipt));
            });

            Task<TIntent> ReadIntent(HttpContext ctx, CancellationToken ct) =>
                actions.ReadIntent(ctx, maximum, decode, idempotencyKey, required: false, ct);
        }
    }
}

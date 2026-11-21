using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Passkeys;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleRollbackEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_ARTICLE_ROLLBACK";

    internal static void Map(WebApplication app, Uri origin, AdminArticleRollbackStore rollback, AdminArticleArchiveStore archive,
        string session, string limit, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        MapAction<AdminArticleRollbackIntent, AdminArticleRollbackReceipt>(
            WireRoutes.AdminArticleRollbackAvailability, WireRoutes.AdminArticleRollbackStepUpBegin,
            WireRoutes.AdminArticleRollbackStepUpComplete, WireRoutes.AdminArticleRollbackExecute,
            WireLimits.MaxAdminArticleRollbackFrameBytes, Wire.DecodeAdminArticleRollbackIntent, intent => intent.IdempotencyKey,
            rollback.CheckArticleRollbackAvailability, rollback.BeginArticleRollbackStepUp, rollback.CompleteArticleRollbackStepUp,
            rollback.ExecuteArticleRollback, Wire.EncodeAdminArticleRollbackReceipt);
        app.MapGet(WireRoutes.AdminArticleRollbackPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = AdminActionRoutes.PositiveCoordinate(ctx, "articleId");
            var source = AdminActionRoutes.PositiveCoordinate(ctx, "sourceRevision");
            if (article > int.MaxValue) throw AdminActionRoutes.InvalidCoordinate();
            var result = await rollback.PreviewArticleRollback(ctx.Request.Cookies[session], (int)article, source, ct);
            return Frame(Wire.EncodeAdminArticleRollbackPreview(result));
        }).RequireRateLimiting("query");

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
        app.MapGet(WireRoutes.AdminArticleArchivePage, async (HttpContext ctx, CancellationToken ct) =>
        {
            var before = ctx.Request.Query.ContainsKey("before") ? AdminActionRoutes.PositiveCoordinate(ctx, "before") : 0;
            if (before > int.MaxValue) throw AdminActionRoutes.InvalidCoordinate();
            var page = await archive.ListArchivedArticles(ctx.Request.Cookies[session], (int)before, ct);
            return Frame(Wire.EncodeAdminArticleArchivePage(page));
        }).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminArticleArchivePreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = AdminActionRoutes.PositiveCoordinate(ctx, "articleId");
            var revision = AdminActionRoutes.PositiveCoordinate(ctx, "revision");
            var privateRelease = AdminActionRoutes.PositiveCoordinate(ctx, "privateReleaseId");
            if (article > int.MaxValue) throw AdminActionRoutes.InvalidCoordinate();
            return Frame(await archive.PreviewArchivedArticle(ctx.Request.Cookies[session], (int)article, revision, privateRelease, ct));
        }).RequireRateLimiting("query");

        void MapAction<TIntent, TReceipt>(string available, string begin, string complete, string execute,
            int maximum, AdminActionRoutes.IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey,
            Func<string?, CancellationToken, Task> checkAvailability,
            Func<string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
            Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
            Func<string?, string?, TIntent, Action, CancellationToken, Task<TReceipt>> apply,
            Func<TReceipt, byte[]> encode)
        {
            actions.Availability(available, checkAvailability);
            app.MapPost(begin, async (HttpContext ctx, CancellationToken ct) =>
            {
                var intent = await ReadIntent(ctx, ct);
                return Frame(await beginStepUp(ctx.Request.Cookies[session], intent, ct));
            }).RequireRateLimiting(limit);
            actions.Complete(complete, limit, completeStepUp);
            app.MapPost(execute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
            {
                var intent = await ReadIntent(ctx, ct);
                var proof = AdminActionRoutes.Proof(ctx);
                var receipt = await publications.AdministrativePublication(
                    invalidate => apply(ctx.Request.Cookies[session], proof, intent, invalidate, ct), ct);
                return Frame(encode(receipt));
            }).RequireRateLimiting("command");

            Task<TIntent> ReadIntent(HttpContext ctx, CancellationToken ct) =>
                actions.ReadIntent(ctx, maximum, decode, idempotencyKey, required: false, ct);
        }
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

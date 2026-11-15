using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Passkeys;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleRollbackEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_ARTICLE_ROLLBACK";

    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        MapAction<AdminArticleRollbackIntent, AdminArticleRollbackReceipt>(
            WireRoutes.AdminArticleRollbackAvailability, WireRoutes.AdminArticleRollbackStepUpBegin,
            WireRoutes.AdminArticleRollbackStepUpComplete, WireRoutes.AdminArticleRollbackExecute,
            WireLimits.MaxAdminArticleRollbackFrameBytes, Wire.DecodeAdminArticleRollbackIntent, intent => intent.IdempotencyKey,
            store.CheckArticleRollbackAvailability, store.BeginArticleRollbackStepUp, store.CompleteArticleRollbackStepUp,
            store.ExecuteArticleRollback, Wire.EncodeAdminArticleRollbackReceipt);
        app.MapGet(WireRoutes.AdminArticleRollbackPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = PositiveCoordinate(ctx, "articleId");
            var source = PositiveCoordinate(ctx, "sourceRevision");
            if (article > int.MaxValue) throw InvalidCoordinate();
            var result = await store.PreviewArticleRollback(ctx.Request.Cookies[session], (int)article, source, ct);
            return Frame(Wire.EncodeAdminArticleRollbackPreview(result));
        }).RequireRateLimiting("query");

        MapAction<AdminArticleDraftRollbackIntent, AdminArticleDraftRollbackReceipt>(
            WireRoutes.AdminArticleDraftRollbackAvailability, WireRoutes.AdminArticleDraftRollbackStepUpBegin,
            WireRoutes.AdminArticleDraftRollbackStepUpComplete, WireRoutes.AdminArticleDraftRollbackExecute,
            WireLimits.MaxAdminArticleDraftRollbackFrameBytes, Wire.DecodeAdminArticleDraftRollbackIntent, intent => intent.IdempotencyKey,
            store.CheckArticleDraftRollbackAvailability, store.BeginArticleDraftRollbackStepUp, store.CompleteArticleDraftRollbackStepUp,
            store.ExecuteArticleDraftRollback, Wire.EncodeAdminArticleDraftRollbackReceipt);

        MapAction<AdminArticleArchiveIntent, AdminArticleArchiveReceipt>(
            WireRoutes.AdminArticleArchiveAvailability, WireRoutes.AdminArticleArchiveStepUpBegin,
            WireRoutes.AdminArticleArchiveStepUpComplete, WireRoutes.AdminArticleArchiveExecute,
            WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleArchiveIntent, intent => intent.IdempotencyKey,
            store.CheckArticleArchiveAvailability, store.BeginArticleArchiveStepUp, store.CompleteArticleArchiveStepUp,
            store.ExecuteArticleArchive, Wire.EncodeAdminArticleArchiveReceipt);
        app.MapGet(WireRoutes.AdminArticleArchivePage, async (HttpContext ctx, CancellationToken ct) =>
        {
            var before = ctx.Request.Query.ContainsKey("before") ? PositiveCoordinate(ctx, "before") : 0;
            if (before > int.MaxValue) throw InvalidCoordinate();
            var page = await store.ListArchivedArticles(ctx.Request.Cookies[session], (int)before, ct);
            return Frame(Wire.EncodeAdminArticleArchivePage(page));
        }).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminArticleArchivePreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = PositiveCoordinate(ctx, "articleId");
            var revision = PositiveCoordinate(ctx, "revision");
            var privateRelease = PositiveCoordinate(ctx, "privateReleaseId");
            if (article > int.MaxValue) throw InvalidCoordinate();
            return Frame(await store.PreviewArchivedArticle(ctx.Request.Cookies[session], (int)article, revision, privateRelease, ct));
        }).RequireRateLimiting("query");

        void MapAction<TIntent, TReceipt>(string available, string begin, string complete, string execute,
            int maximum, IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey,
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

            async Task<TIntent> ReadIntent(HttpContext ctx, CancellationToken ct)
            {
                var intent = decode(await actions.Read(ctx, maximum, ct));
                RequireCommandHeader(ctx, idempotencyKey(intent));
                return intent;
            }
        }
    }

    private delegate T IntentDecoder<T>(ReadOnlySpan<byte> frame);

    private static void RequireCommandHeader(HttpContext ctx, Guid expected)
    {
        if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
            (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != expected))
            throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
    }

    private static long PositiveCoordinate(HttpContext ctx, string key)
    {
        if (ctx.Request.Query[key] is { Count: 1 } values && values[0] is { Length: >= 1 and <= 19 } text &&
            long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var coordinate) && coordinate > 0 &&
            coordinate.ToString(CultureInfo.InvariantCulture) == text)
            return coordinate;
        throw InvalidCoordinate();
    }

    private static BusinessException InvalidCoordinate() =>
        new(Rejection.Invalid, "Use an exact article ID and historical revision.");

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

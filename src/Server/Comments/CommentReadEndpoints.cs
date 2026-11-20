using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Comments;

internal readonly record struct InstalledCommentRoutes(bool RootSubmission, bool SignedInReply, bool RootPowPolicy);

internal static class CommentReadEndpoints
{
    internal static InstalledCommentRoutes Map(WebApplication app, Publications publications, string cookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, bool rootPowPolicy,
        FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        CommentReports.Map(app, cookie, readFrame);
        app.MapGet(WireRoutes.CommentRoots, (HttpContext ctx, CommentReadStore store, int articleId, CancellationToken ct) =>
            ReadWithWriteHeader(ctx, publications, articleId, Cursor(ctx),
                cursor => store.RootsWithWriteStatus(articleId, cursor, Limit(ctx, 10, 50), capabilities.PublicCommentSubmissions, ct),
                () => CommentReadWire.Roots([], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentChildren, (HttpContext ctx, CommentReadStore store, int articleId, long parentId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Children(articleId, parentId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Children(parentId, 0, [], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentContext, (HttpContext ctx, CommentReadStore store, int articleId, long commentId, int? window, CancellationToken ct) =>
            ReadWithWriteHeader(ctx, publications, articleId, null,
                _ => store.ContextWithWriteStatus(articleId, commentId, Math.Clamp(window ?? 6, 2, 20), capabilities.PublicCommentSubmissions, ct),
                () => CommentReadWire.Context(null, [], []))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentThread, (HttpContext ctx, CommentReadStore store, int articleId, long rootId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Thread(articleId, rootId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Thread(rootId, [], null))).RequireRateLimiting("query");

        if (capabilities.PublicCommentSubmissions)
        {
            var replies = capabilities.SignedInCommentReplies;
            CommentSubmissionEndpoints.Map(app, cookie, readFrame, replies, rootPowPolicy);
            app.MapGet(WireRoutes.PublicCommentEligibility, async (HttpContext ctx, int articleId, Store store, CancellationToken ct) =>
            {
                if (!long.TryParse(ctx.Request.Query["publication"].FirstOrDefault(), NumberStyles.None,
                    CultureInfo.InvariantCulture, out var publication) || publication <= 0)
                    throw new BusinessException(Rejection.Invalid, "A valid publication is required.");
                var result = await store.WithSession(ctx.Request.Cookies[cookie], false,
                    async (db, tx, actor) =>
                    {
                        var eligibility = await CommentWriteStore.Eligibility(db, tx, actor, articleId, publication, ct);
                        if (replies && await FsusBlogV2.Storage.CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
                            ctx.Response.Headers[WireHeaders.CommentReplyEnabled] = "1";
                        return eligibility;
                    }, ct);
                return Results.Bytes(Wire.EncodePublicCommentEligibility(result), Aeds.ContentType);
            }).RequireRateLimiting("command");
            return new(RootSubmission: true, SignedInReply: replies, RootPowPolicy: rootPowPolicy);
        }
        return new(RootSubmission: false, SignedInReply: false, RootPowPolicy: false);
    }

    private static async Task<IResult> Read(Publications publications, int article, long? cursor, Func<long?, Task<byte[]>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var bytes = snapshot.Article(article) is not null ? await fetch(cursor) : hidden();
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        return Results.Bytes(bytes, Aeds.ContentType);
    }

    private static async Task<IResult> ReadWithWriteHeader(HttpContext ctx, Publications publications, int article, long? cursor,
        Func<long?, Task<(byte[] Frame, bool WriteEnabled)>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var result = snapshot.Article(article) is not null ? await fetch(cursor) : (Frame: hidden(), WriteEnabled: false);
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (result.WriteEnabled) ctx.Response.Headers[WireHeaders.PublicCommentWriteEnabled] = "1";
        return Results.Bytes(result.Frame, Aeds.ContentType);
    }

    private static long? Cursor(HttpContext ctx)
    {
        if (!ctx.Request.Query.TryGetValue("cursor", out var values)) return null;
        if (values.Count == 1)
        {
            if (string.IsNullOrWhiteSpace(values[0])) return null;
            if (values[0] is { Length: <= 24 } value &&
                long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cursor) && cursor > 0)
                return cursor;
        }
        throw new BusinessException(Rejection.Invalid, "Invalid comment cursor.");
    }

    private static int Limit(HttpContext ctx, int fallback, int max) =>
        int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)
            ? Math.Clamp(count, 5, max)
            : fallback;
}

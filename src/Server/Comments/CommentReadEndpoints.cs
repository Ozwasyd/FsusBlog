using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentReadEndpoints
{
    internal static void Map(WebApplication app, Publications publications)
    {
        app.MapGet(WireRoutes.CommentRoots, (HttpContext ctx, CommentReadStore store, int articleId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Roots(articleId, cursor, Limit(ctx, 10, 50), ct),
                () => CommentReadWire.Roots([], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentChildren, (HttpContext ctx, CommentReadStore store, int articleId, long parentId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Children(articleId, parentId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Children(parentId, 0, [], null))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentContext, (HttpContext ctx, CommentReadStore store, int articleId, long commentId, int? window, CancellationToken ct) =>
            Read(publications, articleId, null, _ => store.Context(articleId, commentId, Math.Clamp(window ?? 6, 2, 20), ct),
                () => CommentReadWire.Context(null, [], []))).RequireRateLimiting("query");

        app.MapGet(WireRoutes.CommentThread, (HttpContext ctx, CommentReadStore store, int articleId, long rootId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Thread(articleId, rootId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Thread(rootId, [], null))).RequireRateLimiting("query");
    }

    private static async Task<IResult> Read(Publications publications, int article, long? cursor, Func<long?, Task<byte[]>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var bytes = snapshot.Article(article) is not null ? await fetch(cursor) : hidden();
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        return Results.Bytes(bytes, Aeds.ContentType);
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

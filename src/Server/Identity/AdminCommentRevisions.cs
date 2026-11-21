using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminCommentRevisions
{
    internal static void Map(WebApplication app, AdminCommentHistoryStore store, string session)
    {
        app.MapGet(WireRoutes.AdminCommentRevisions, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var result = await store.CommentRevisions(context.Request.Cookies[session], id, context.Request.Query, Position, ct);
            if (result.Next is long version)
            {
                var scope = result.Article == 0 ? "" : FormattableString.Invariant($"&articleId={result.Article}");
                context.Response.Headers.Link = FormattableString.Invariant($"</api/binary/author/comments/{id}/revisions?before={version}{scope}>; rel=\"next\"");
            }
            return Results.Bytes(result.Frame, Aeds.ContentType);
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminCommentTimeline, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Bytes(await store.CommentTimeline(context.Request.Cookies[session], id, context.Request.Query, ct),
                Aeds.ContentType);
        }).RequireRateLimiting("command");
    }

    internal static (long Before, int Article) Position(IQueryCollection query)
    {
        var hasBefore = query.TryGetValue("before", out var before);
        var hasArticle = query.TryGetValue("articleId", out var article);
        long version = long.MaxValue;
        int scope = 0;
        if (query.Count != (hasBefore ? 1 : 0) + (hasArticle ? 1 : 0) ||
            hasBefore && (before.Count != 1 || !long.TryParse(before[0], NumberStyles.None, CultureInfo.InvariantCulture, out version) || version <= 1) ||
            hasArticle && (article.Count != 1 || !int.TryParse(article[0], NumberStyles.None, CultureInfo.InvariantCulture, out scope) || scope <= 0))
            throw new BusinessException(Rejection.Invalid, "Invalid comment revision position.");
        return (version, scope);
    }
}

using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<AdminCommentQueue> CommentQueue(string? token, IQueryCollection query, CancellationToken ct) =>
        WithSession(token, CurrentSchema.CommentModeratePermission, async (db, tx, _) =>
        {
            var (afterComment, afterArticle) = QueueCursor(query);
            await using var select = Store.Sql(db, tx, """
                select c.article_id,c.id,c.created_at,c.display_name,c.body
                from public.comment c
                join public.comment_submit_command s on s.article_id=c.article_id and s.comment_id=c.id
                join public.article a on a.id=c.article_id and not a.deleted
                where c.moderation_status=0 and not c.deleted and (c.id,c.article_id)>($1,$2)
                order by c.id,c.article_id
                limit $3
                """, afterComment, afterArticle, WireLimits.AdminCommentQueueSize + 1);
            var page = new List<AdminPendingComment>();
            await using var rows = await select.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (page.Count == WireLimits.AdminCommentQueueSize) return new AdminCommentQueue(page, true);
                page.Add(new(rows.GetInt32(0), rows.GetInt64(1), rows.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds(),
                    rows.GetString(3), rows.GetString(4)));
            }
            return new AdminCommentQueue(page, false);
        }, ct);

    private static (long Comment, int Article) QueueCursor(IQueryCollection query)
    {
        if (query.Count == 0) return (0, 0);
        if (query.Count != 2 || query["afterComment"] is not { Count: 1 } comment || query["afterArticle"] is not { Count: 1 } article ||
            comment[0] is not { Length: > 0 and <= 19 } commentText || article[0] is not { Length: > 0 and <= 10 } articleText ||
            !long.TryParse(commentText, NumberStyles.None, CultureInfo.InvariantCulture, out long commentId) || commentId <= 0 ||
            !int.TryParse(articleText, NumberStyles.None, CultureInfo.InvariantCulture, out int articleId) || articleId <= 0)
            throw new BusinessException(Rejection.Invalid, "Invalid comment moderation cursor.");
        return (commentId, articleId);
    }
}

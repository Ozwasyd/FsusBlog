using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArchivedArticleAuthority
{
    internal const string Reason = "administrator-rollback-archived";

    // The surrounding statement supplies the article as a.id. Only the latest event governs access.
    internal const string Available = $"""
        (select h.kind='retract' and h.reason='{Reason}'
         from public.article_publication_history h
         where h.article_id=a.id order by h.event_no desc limit 1) is not true
        """;

    // Call these in a new statement after acquiring the article row lock. A snapshot taken
    // before the lock wait could see the new article revision with the old publication history.
    internal static async Task<bool> IsLockedArchived(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        CancellationToken ct)
    {
        return await SqlCommands.Scalar(db, tx, ct, $"select not ({Available}) from (values ($1::integer)) a(id)", article) is true;
    }

    internal static async Task<bool> AnyLockedArchived(NpgsqlConnection db, NpgsqlTransaction tx, int[] articles,
        CancellationToken ct)
    {
        return await SqlCommands.Scalar(db, tx, ct, $"""
            select exists(select from unnest($1::integer[]) a(id) where not ({Available}))
            """, articles) is true;
    }

    internal static async Task RequireLockedAvailability(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        CancellationToken ct)
    {
        if (await IsLockedArchived(db, tx, article, ct))
            throw new BusinessException(Rejection.NotFound, "Article not found.");
    }
}

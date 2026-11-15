using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleInventoryEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query)
    {
        app.MapGet(WireRoutes.AuthorArticles, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[cookie];
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, token, SiteSessions.Requested(ctx));
                var scope = query(ctx, "scope", 6) switch
                {
                    null or "active" => false, "trash" => true, _ => throw Invalid()
                };
                var state = query(ctx, "state", 9) switch
                {
                    null => (AuthorArticleState?)null,
                    "draft" when !scope => AuthorArticleState.Draft,
                    "scheduled" when !scope => AuthorArticleState.Scheduled,
                    "published" when !scope => AuthorArticleState.Published,
                    "retracted" when !scope => AuthorArticleState.Retracted,
                    _ => throw Invalid()
                };
                var keyword = query(ctx, "keyword", WireLimits.AuthorArticleKeywordChars)?.Trim() ?? "";
                if (keyword.Any(char.IsControl)) throw Invalid();
                var summary = query(ctx, "match", 13) switch
                {
                    null or "title" => false,
                    "title-summary" => true,
                    _ => throw Invalid()
                };
                var page = await Read(db, tx, actor, scope, state, keyword, summary, Number(ctx, "category"), Number(ctx, "tag"),
                    Number(ctx, "before"), Number(ctx, "article"), ct);
                return Results.Bytes(Wire.EncodeAuthorArticlePage(page), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        int Number(HttpContext context, string name)
        {
            if (query(context, name, 10) is not { } raw) return 0;
            if (int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0) return value;
            throw Invalid();
        }
    }

    // Same statement and identity snapshot for count, page, revision metadata, and scheduling. Fetch tags only for emitted rows.
    private static async Task<AuthorArticlePage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, bool trash,
        AuthorArticleState? state, string keyword, bool summary, int categoryId, int tagId, int beforeId, int articleId, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            with matched as materialized (
                select a.id,a.revision,a.title,a.updated_at,c.id as category_id,c.name as category,s.due_at,
                    case when a.deleted then 5 when s.due_at is not null then 2 when a.published_revision is not null then 3
                         when a.publication_count>0 then 4 else 1 end as state
                from public.article a
                left join public.article_schedule s on s.article_id=a.id and s.revision=a.revision
                    and s.actor_id=a.owner_id and s.generation=$2 and not a.deleted
                left join public.article_revision_category rc on rc.article_id=a.id and rc.revision=a.revision
                left join public.category c on c.id=rc.category_id
                where a.owner_id=$1 and a.deleted=$3 and ($10=0 or a.id=$10)
                    and ($4='' or strpos(lower(a.title), lower($4))>0
                         or ($11 and strpos(lower(left(a.body,200)),lower($4))>0))
                    and ($5=0 or rc.category_id=$5)
                    and ($6=0 or exists(select from public.article_revision_tag rt where rt.article_id=a.id and rt.revision=a.revision and rt.tag_id=$6))
            ), filtered as materialized (
                select * from matched where $7=0 or state=$7
            ), picked as (
                select * from filtered where $8=0 or id<$8 order by id desc limit $9
            )
            select count.total,p.id,p.revision,p.title,p.updated_at,p.category_id,p.category,p.due_at,p.state,t.ids,t.names
            from (select count(*)::integer as total from filtered) count
            left join picked p on true
            left join lateral (
                select array_agg(tag.id order by tag.id) as ids,array_agg(tag.name order by tag.id) as names
                from public.article_revision_tag link join public.tag tag on tag.id=link.tag_id
                where link.article_id=p.id and link.revision=p.revision
            ) t on true
            order by p.id desc
            """, actor.Id, actor.Generation, trash, keyword, categoryId, tagId, (int?)state ?? 0, beforeId,
                WireLimits.AuthorArticlePageSize + 1, articleId, summary);
        var list = new List<AuthorArticleRow>(WireLimits.AuthorArticlePageSize);
        var total = 0;
        var more = false;
        await using var rows = await cmd.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            total = rows.GetInt32(0);
            if (rows.IsDBNull(1)) break;
            if (list.Count == WireLimits.AuthorArticlePageSize)
            {
                more = true;
                break;
            }
            var category = rows.IsDBNull(5) ? null : new TaxonomyName(rows.GetInt32(5), rows.GetString(6));
            var tags = rows.IsDBNull(9) ? [] : rows.GetFieldValue<int[]>(9).Zip(rows.GetFieldValue<string[]>(10),
                (id, name) => new TaxonomyName(id, name)).ToArray();
            list.Add(new(rows.GetInt32(1), rows.GetInt64(2), rows.GetString(3), (AuthorArticleState)rows.GetInt32(8),
                rows.GetFieldValue<DateTimeOffset>(4).ToUnixTimeMilliseconds(),
                rows.IsDBNull(7) ? 0 : rows.GetFieldValue<DateTimeOffset>(7).ToUnixTimeMilliseconds(), category, tags));
        }
        return new(total, more ? list[^1].Id : 0, list);
    }

    private static BusinessException Invalid() => new(Rejection.Invalid, "Invalid article inventory filters.");
}

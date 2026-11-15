using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using Npgsql;
using NpgsqlTypes;

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
                return await ReadPage(ctx, query, db, tx, actor, ct);
            }, ct);
        }).RequireRateLimiting("command");
    }

    internal static async Task<IResult> ReadPage(HttpContext ctx, Func<HttpContext, string, int, string?> query,
        NpgsqlConnection db, NpgsqlTransaction tx, Identity? author, CancellationToken ct)
    {
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
        if (!Wire.IsCanonicalAuthorArticleKeyword(keyword)) throw Invalid();
        var summary = query(ctx, "match", 13) switch
        {
            null or "title" => false,
            "title-summary" => true,
            _ => throw Invalid()
        };
        var page = await Read(db, tx, author, scope, state, keyword, summary, Number("category"), Number("tag"),
            Number("before"), Number("article"), ct);
        return Results.Bytes(Wire.EncodeAuthorArticlePage(page), Aeds.ContentType);

        int Number(string name)
        {
            if (query(ctx, name, 10) is not { } raw) return 0;
            if (int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0) return value;
            throw Invalid();
        }
    }

    // Same statement and identity snapshot for count, page, revision metadata, and scheduling. Fetch tags only for emitted rows.
    private static async Task<AuthorArticlePage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity? author, bool trash,
        AuthorArticleState? state, string keyword, bool summary, int categoryId, int tagId, int beforeId, int articleId, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, $"""
            with matched as materialized (
                select a.id,a.revision,a.title,a.updated_at,c.id as category_id,c.name as category,s.due_at,
                    {CurrentState} as state
                from public.article a
                {CurrentSchedule(2, author is null)}
                left join public.article_revision_category rc on rc.article_id=a.id and rc.revision=a.revision
                left join public.category c on c.id=rc.category_id
                where ($1::uuid is null or a.owner_id=$1) and a.deleted=$3 and ($10=0 or a.id=$10)
                    and {ArchivedArticleAuthority.Available}
                    and {KeywordPredicate(4, 11)}
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
            """, new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = (object?)author?.Id ?? DBNull.Value },
                author?.Generation ?? 0L, trash, keyword, categoryId, tagId, (int?)state ?? 0, beforeId,
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

    internal const string CurrentState = """
        case when a.deleted then 5 when s.due_at is not null then 2 when a.published_revision is not null then 3
             when (select h.kind='retract' and h.reason='administrator-rollback-draft'
                   from public.article_publication_history h
                   where h.article_id=a.id order by h.event_no desc limit 1) then 1
             when a.publication_count>0 then 4 else 1 end
        """;

    internal static string CurrentSchedule(int generationParameter, bool crossAuthor = false)
    {
        var generation = "$" + generationParameter.ToString(CultureInfo.InvariantCulture);
        if (crossAuthor) generation = $"coalesce((select u.generation from public.blog_user u where u.id=a.owner_id and u.enabled and u.can_author),{generation})";
        return $"""
            left join public.article_schedule s on s.article_id=a.id and s.revision=a.revision
                and s.actor_id=a.owner_id and s.generation={generation} and not a.deleted
            """;
    }

    internal static string KeywordPredicate(int keywordParameter, int? includeSummaryParameter = null)
    {
        var keyword = "$" + keywordParameter.ToString(CultureInfo.InvariantCulture);
        var includeSummary = includeSummaryParameter is { } index ? "$" + index.ToString(CultureInfo.InvariantCulture) + " and " : "";
        return $"({keyword}='' or strpos(lower(a.title),lower({keyword}))>0 or " +
            $"({includeSummary}strpos(lower(coalesce((select r.author_summary from public.article_revision r " +
            $"where r.article_id=a.id and r.revision=a.revision),left(a.body,200))),lower({keyword}))>0))";
    }

    private static BusinessException Invalid() => new(Rejection.Invalid, "Invalid article inventory filters.");
}

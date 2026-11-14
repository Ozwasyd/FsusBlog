using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<AdminTaxonomyPage> Taxonomy(string? token, bool tags, IQueryCollection query, Publications publications,
        CancellationToken ct) => WithSession(token, CurrentSchema.ArticleWritePermission, async (db, tx, _) =>
        {
            var after = TaxonomyCursor(query);
            var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
            var (registry, links, key) = tags
                ? ("tag", "article_revision_tag", "tag_id")
                : ("category", "article_revision_category", "category_id");

            // The identifier choices above are fixed. Scope joins to the admitted page and use one PostgreSQL snapshot.
            await using var select = Store.Sql(db, tx, $"""
                with page as materialized (
                    select id,name from public.{registry} where id>$1 order by id limit $2
                ), watermark as (
                    select coalesce(max(id),0) as value from public.blog_outbox where kind in ('publish','retract','delete')
                )
                select w.value,p.id,p.name,counts.drafts,counts.scheduled,counts.retracted,counts.deleted,counts.retained
                from watermark w
                left join page p on true
                left join lateral (
                    select (count(*) filter (where current and not deleted and not scheduled and published_revision is null and publication_count=0))::int as drafts,
                           (count(*) filter (where current and not deleted and scheduled))::int as scheduled,
                           (count(*) filter (where current and not deleted and not scheduled and published_revision is null and publication_count>0))::int as retracted,
                           (count(*) filter (where current and deleted))::int as deleted,
                           count(*)::int as retained
                    from (
                        select a.deleted,a.published_revision,a.publication_count,
                               bool_or(l.revision=a.revision) as current,
                               exists(select from public.article_schedule s join public.blog_user u on u.id=s.actor_id
                                      where s.article_id=a.id and s.revision=a.revision and s.actor_id=a.owner_id
                                        and s.generation=u.generation and u.enabled and u.can_author) as scheduled
                        from public.{links} l join public.article a on a.id=l.article_id
                        where l.{key}=p.id group by a.id
                    ) members
                ) counts on p.id is not null
                order by p.id
                """, after, WireLimits.AdminTaxonomyPageSize + 1);
            var items = new List<AdminTaxonomyItem>(WireLimits.AdminTaxonomyPageSize);
            await using var rows = await select.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (rows.GetInt64(0) != snapshot.Watermark) throw new PublicUnavailableException();
                if (rows.IsDBNull(1)) break;
                if (items.Count == WireLimits.AdminTaxonomyPageSize) return new AdminTaxonomyPage(items[^1].Id, items);
                var id = rows.GetInt32(1);
                var published = snapshot.Taxonomy.ById(tags, id)?.ArticleCount ?? 0;
                items.Add(new(id, rows.GetString(2), published, rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5),
                    rows.GetInt32(6), rows.GetInt32(7)));
            }
            return new AdminTaxonomyPage(0, items);
        }, ct);

    private static int TaxonomyCursor(IQueryCollection query)
    {
        if (query.Count == 0) return 0;
        if (query.Count == 1 && query["after"] is { Count: 1 } after && after[0] is { Length: > 0 and <= 10 } raw &&
            int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0) return value;
        throw new BusinessException(Rejection.Invalid, "Invalid administrator taxonomy cursor.");
    }
}

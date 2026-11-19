using System.Globalization;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleInventorySql
{
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
        if (crossAuthor) generation = $"coalesce((select p.generation from public.admin_principal p where p.id=a.owner_id and p.enabled and exists (select from public.admin_permission g where g.principal_id=p.id and g.permission='article.write')),{generation})";
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
}

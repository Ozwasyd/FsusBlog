namespace FsusBlog.Server.Services.Background;

internal static class ScheduledPublishQuery
{
    internal const string ScheduledPredicateSql = """
        article.isdeleted = false
        AND article.status = @ScheduledStatus
        AND article.scheduled_publish_at <= @Now
        """;

    internal const string PendingPublicationPredicateSql = """
        article.isdeleted = false
        AND article.status = @PublishedStatus
        AND article.pending_publication_at <= @Now
        """;

    internal const string DueOrderSql = "due_at, id";

    internal static string LoadDueArticleIdsSql { get; } = BuildLoadDueArticleIdsSql();

    internal static string ClaimDueArticlesSql { get; } = BuildClaimDueArticlesSql();

    private static string BuildLoadDueArticleIdsSql()
        => $"""
            {BuildDueArticlesCte(candidateFilter: null)}
            SELECT id
            FROM due_articles
            ORDER BY {DueOrderSql}
            LIMIT @BatchSize;
            """;

    private static string BuildClaimDueArticlesSql()
        => $"""
            {BuildDueArticlesCte("article.id IN (@CandidateArticleIds)")}
            SELECT
                article.id,
                revision.id AS revision_id,
                revision.revision_no,
                rights.id AS rights_snapshot_id,
                responsibility.id AS responsibility_snapshot_id
            FROM due_articles due
            JOIN article article ON article.id = due.id
            JOIN article_revision revision ON revision.id = article.current_revision_id
            JOIN article_rights_snapshot rights
              ON rights.article_id = article.id
             AND rights.article_revision_id = revision.id
            LEFT JOIN article_responsibility_snapshot responsibility
              ON responsibility.article_revision_id = revision.id
            ORDER BY due.due_at, article.id
            LIMIT @BatchSize
            FOR UPDATE OF article SKIP LOCKED;
            """;

    private static string BuildDueArticlesCte(string? candidateFilter)
    {
        string candidateClause = candidateFilter is null
            ? string.Empty
            : $"{Environment.NewLine}          AND {candidateFilter}";
        return $"""
            WITH due_articles AS (
                SELECT article.id, article.scheduled_publish_at AS due_at
                FROM article article
                WHERE {ScheduledPredicateSql}{candidateClause}

                UNION ALL

                SELECT article.id, article.pending_publication_at AS due_at
                FROM article article
                WHERE {PendingPublicationPredicateSql}{candidateClause}
            )
            """;
    }
}

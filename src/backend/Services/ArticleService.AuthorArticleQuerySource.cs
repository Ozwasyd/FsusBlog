using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IAuthorArticleQuerySourceReader
{
    Task<AuthorArticleQuerySourceBatch> IAuthorArticleQuerySourceReader.ReadCoordinatesAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        CancellationToken cancellationToken)
        => ReadAuthorQueryCoordinatePageAsync(statuses, 0, cancellationToken);

    Task<AuthorArticleQuerySourceBatch> IAuthorArticleQuerySourceReader.ReadCoordinatesAfterAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        int afterArticleId,
        CancellationToken cancellationToken)
        => ReadAuthorQueryCoordinatePageAsync(statuses, afterArticleId, cancellationToken);

    private async Task<AuthorArticleQuerySourceBatch> ReadAuthorQueryCoordinatePageAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        int afterArticleId,
        CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(afterArticleId);
        statuses = statuses.ToImmutableArray();
        if (statuses.Count == 0)
        {
            return new([], false);
        }
        if (statuses.Any(static status => status is not (AuthorArticleQueryStatus.Draft
                or AuthorArticleQueryStatus.Scheduled or AuthorArticleQueryStatus.Published
                or AuthorArticleQueryStatus.Archived)))
        {
            throw new ArgumentException("author_article_query_source_status_invalid", nameof(statuses));
        }
        return await _dbConcurrencyGate.ExecuteAsync(
            "author-article-query-source-coordinates",
            async gateCt =>
            {
                var coordinates = new List<AuthorArticleQuerySourceCoordinate>();
                using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                    """
                    SELECT id, current_revision_id, xmin::text AS row_version, status
                    FROM article
                    WHERE id > @AfterArticleId AND isdeleted = false AND status = ANY(@Statuses)
                    ORDER BY id
                    LIMIT @Limit;
                    """,
                    new SugarParameter("@AfterArticleId", afterArticleId),
                    new SugarParameter("@Statuses", statuses.Select(static status => (int)status).ToArray()) { IsArray = true },
                    new SugarParameter("@Limit", AuthorArticleQuerySourceInspection.MaxBatchSize + 1)).ConfigureAwait(false);
                while (coordinates.Count <= AuthorArticleQuerySourceInspection.MaxBatchSize
                    && await reader.ReadAsync(gateCt).ConfigureAwait(false))
                {
                    coordinates.Add(new(
                        reader.GetInt32(0),
                        reader.IsDBNull(1) ? 0 : reader.GetInt64(1),
                        reader.GetString(2),
                        (AuthorArticleQueryStatus)reader.GetInt32(3)));
                }
                bool hasMore = coordinates.Count > AuthorArticleQuerySourceInspection.MaxBatchSize;
                return new AuthorArticleQuerySourceBatch(
                    coordinates.Take(AuthorArticleQuerySourceInspection.MaxBatchSize).ToArray(), hasMore);
            },
            _ => Task.FromException<AuthorArticleQuerySourceBatch>(
                new TimeoutException("db-gate-timeout:author-article-query-source-coordinates")),
            ResolveCancellationToken(cancellationToken)).ConfigureAwait(false);
    }

    async Task<AuthorArticleQuerySourceBatch> IAuthorArticleQuerySourceReader.ReadCoordinatesForIdsAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        statuses = statuses.ToImmutableArray();
        articleIds = articleIds.Take(AuthorArticleQuerySourceInspection.MaxBatchSize + 1).ToImmutableArray();
        if (articleIds.Count is < 1 or > AuthorArticleQuerySourceInspection.MaxBatchSize
            || articleIds.Any(static id => id <= 0) || articleIds.Distinct().Count() != articleIds.Count)
        {
            throw new ArgumentException("author_article_query_source_ids_invalid", nameof(articleIds));
        }
        if (statuses.Any(static status => status is not (AuthorArticleQueryStatus.Draft
                or AuthorArticleQueryStatus.Scheduled or AuthorArticleQueryStatus.Published
                or AuthorArticleQueryStatus.Archived)))
        {
            throw new ArgumentException("author_article_query_source_status_invalid", nameof(statuses));
        }
        if (statuses.Count == 0)
        {
            return new([], false);
        }
        return await _dbConcurrencyGate.ExecuteAsync(
            "author-article-query-source-history-coordinates",
            async gateCt =>
            {
                var coordinates = new List<AuthorArticleQuerySourceCoordinate>();
                using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                    """
                    SELECT id, current_revision_id, xmin::text AS row_version, status
                    FROM article
                    WHERE id = ANY(@ArticleIds) AND isdeleted = false AND status = ANY(@Statuses)
                    ORDER BY id
                    LIMIT @Limit;
                    """,
                    new SugarParameter("@ArticleIds", articleIds.ToArray()) { IsArray = true },
                    new SugarParameter("@Statuses", statuses.Select(static status => (int)status).ToArray()) { IsArray = true },
                    new SugarParameter("@Limit", AuthorArticleQuerySourceInspection.MaxBatchSize + 1)).ConfigureAwait(false);
                while (await reader.ReadAsync(gateCt).ConfigureAwait(false))
                {
                    coordinates.Add(new(reader.GetInt32(0), reader.IsDBNull(1) ? 0 : reader.GetInt64(1),
                        reader.GetString(2), (AuthorArticleQueryStatus)reader.GetInt32(3)));
                }
                bool hasMore = coordinates.Count > AuthorArticleQuerySourceInspection.MaxBatchSize;
                return new AuthorArticleQuerySourceBatch(
                    coordinates.Take(AuthorArticleQuerySourceInspection.MaxBatchSize).ToArray(), hasMore);
            },
            _ => Task.FromException<AuthorArticleQuerySourceBatch>(
                new TimeoutException("db-gate-timeout:author-article-query-source-history-coordinates")),
            ResolveCancellationToken(cancellationToken)).ConfigureAwait(false);
    }

    async Task<IReadOnlyList<AuthorArticleQuerySourceFields>> IAuthorArticleQuerySourceReader.ReadFieldsAsync(
        IReadOnlyList<int> admittedArticleIds,
        CancellationToken cancellationToken)
    {
        admittedArticleIds = admittedArticleIds.Take(AuthorArticleQuerySourceInspection.MaxBatchSize + 1).ToImmutableArray();
        if (admittedArticleIds.Count is < 1 or > AuthorArticleQuerySourceInspection.MaxBatchSize
            || admittedArticleIds.Any(static id => id <= 0)
            || admittedArticleIds.Distinct().Count() != admittedArticleIds.Count)
        {
            throw new ArgumentException("author_article_query_source_ids_invalid", nameof(admittedArticleIds));
        }
        return await _dbConcurrencyGate.ExecuteAsync<IReadOnlyList<AuthorArticleQuerySourceFields>>(
            "author-article-query-source-fields",
            async gateCt =>
            {
                var fields = new List<AuthorArticleQuerySourceFields>();
                using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                    """
                    SELECT a.id, a.current_revision_id, a.xmin::text AS row_version, a.status,
                           a.title, c.name AS category_name,
                           COALESCE(tags.names, ARRAY[]::text[]) AS tag_names
                    FROM article a
                    JOIN category c ON c.id = a.categoryid
                    LEFT JOIN LATERAL (
                        SELECT array_agg(t.name ORDER BY t.id) AS names
                        FROM article_tag at JOIN tag t ON t.id = at.tagid
                        WHERE at.articleid = a.id
                    ) tags ON TRUE
                    WHERE a.id = ANY(@ArticleIds) AND a.isdeleted = false
                      AND a.status = ANY(@Statuses)
                    ORDER BY a.id;
                    """,
                    new SugarParameter("@ArticleIds", admittedArticleIds.ToArray()) { IsArray = true },
                    new SugarParameter("@Statuses", new[]
                    {
                        (int)AuthorArticleQueryStatus.Draft, (int)AuthorArticleQueryStatus.Scheduled,
                        (int)AuthorArticleQueryStatus.Published, (int)AuthorArticleQueryStatus.Archived
                    })
                    {
                        IsArray = true
                    }).ConfigureAwait(false);
                while (await reader.ReadAsync(gateCt).ConfigureAwait(false))
                {
                    fields.Add(new(
                        new(reader.GetInt32(0), reader.IsDBNull(1) ? 0 : reader.GetInt64(1),
                            reader.GetString(2), (AuthorArticleQueryStatus)reader.GetInt32(3)),
                        reader.GetString(4), reader.GetString(5), reader.GetFieldValue<string[]>(6)));
                }
                return fields;
            },
            _ => Task.FromException<IReadOnlyList<AuthorArticleQuerySourceFields>>(
                new TimeoutException("db-gate-timeout:author-article-query-source-fields")),
            ResolveCancellationToken(cancellationToken)).ConfigureAwait(false);
    }
}

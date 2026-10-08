using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IAuthorArticleQuerySourceReader
{
    async Task<AuthorArticleQuerySourceBatch> IAuthorArticleQuerySourceReader.ReadCoordinatesAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        CancellationToken cancellationToken)
    {
        if (statuses.Count == 0)
        {
            return new([], false);
        }
        if (statuses.Any(static status => status is not (AuthorArticleQueryStatus.Draft
                or AuthorArticleQueryStatus.Scheduled or AuthorArticleQueryStatus.Published)))
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
                    WHERE isdeleted = false AND status = ANY(@Statuses)
                    ORDER BY id
                    LIMIT @Limit;
                    """,
                    new SugarParameter("@Statuses", statuses.Select(static status => (int)status).ToArray()) { IsArray = true },
                    new SugarParameter("@Limit", AuthorArticleQuerySourceInspection.MaxBatchSize + 1)).ConfigureAwait(false);
                while (await reader.ReadAsync(gateCt).ConfigureAwait(false))
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

    async Task<IReadOnlyList<AuthorArticleQuerySourceFields>> IAuthorArticleQuerySourceReader.ReadFieldsAsync(
        IReadOnlyList<int> admittedArticleIds,
        CancellationToken cancellationToken)
    {
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
                      AND a.status IN (0, 1, 2)
                    ORDER BY a.id;
                    """,
                    new SugarParameter("@ArticleIds", admittedArticleIds.ToArray()) { IsArray = true }).ConfigureAwait(false);
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

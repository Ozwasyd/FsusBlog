using System.Data.Common;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Production article/revision adapter for the private pin projection. Callers must pass only
/// article identities already admitted by the trusted permission provider.
/// </summary>
public sealed class SqlAuthorArticlePinArticleProjectionSource(ISqlSugarClient db)
    : IAuthorArticlePinArticleProjectionSource
{
    public async Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(articleIds);
        if (articleIds.Count > AuthorArticlePinContract.MaxPinsPerOwner
            || articleIds.Count != articleIds.Distinct().Count()
            || articleIds.Any(static articleId => articleId <= 0))
        {
            throw new AuthorArticlePinProjectionValidationException("article_pin_article_batch_invalid");
        }
        if (articleIds.Count == 0)
        {
            return [];
        }
        cancellationToken.ThrowIfCancellationRequested();

        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT a.id,
                   a.title,
                   a.status,
                   a.isdeleted,
                   a.current_revision_id,
                   revision.revision_no
            FROM article a
            LEFT JOIN article_revision revision
              ON revision.id = a.current_revision_id
             AND revision.article_id = a.id
            WHERE a.id = ANY(@ArticleIds);
            """,
            new SugarParameter("@ArticleIds", articleIds.ToArray())).ConfigureAwait(false);
        var found = new Dictionary<int, AuthorArticlePinArticleFact>(articleIds.Count);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int articleId = reader.GetInt32(reader.GetOrdinal("id"));
            bool hasRevision = !reader.IsDBNull(reader.GetOrdinal("current_revision_id"))
                && !reader.IsDBNull(reader.GetOrdinal("revision_no"));
            long revisionId = hasRevision
                ? reader.GetInt64(reader.GetOrdinal("current_revision_id"))
                : 0;
            int revisionNo = hasRevision
                ? reader.GetInt32(reader.GetOrdinal("revision_no"))
                : 0;
            string title = reader.GetString(reader.GetOrdinal("title"));
            var status = (Entities.ArticleStatus)reader.GetInt32(reader.GetOrdinal("status"));
            bool isDeleted = reader.GetBoolean(reader.GetOrdinal("isdeleted"));
            string articleReference = AuthorArticlePinProjectionContract.ComputeArticleVersionReference(
                articleId,
                title,
                status,
                isDeleted,
                revisionId,
                revisionNo);
            string revisionReference = hasRevision
                ? $"article:{articleId}:revision:{revisionId}:number:{revisionNo}"
                : string.Empty;
            var fact = new AuthorArticlePinArticleFact(
                articleId,
                title,
                status,
                revisionId,
                revisionNo,
                articleReference,
                revisionReference,
                Exists: true,
                isDeleted,
                string.Empty);
            found.Add(articleId, fact with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
            });
        }

        var facts = new List<AuthorArticlePinArticleFact>(articleIds.Count);
        foreach (int articleId in articleIds)
        {
            if (found.TryGetValue(articleId, out AuthorArticlePinArticleFact? fact))
            {
                facts.Add(fact);
                continue;
            }

            var missing = new AuthorArticlePinArticleFact(
                articleId,
                string.Empty,
                Entities.ArticleStatus.Deleted,
                0,
                0,
                string.Empty,
                string.Empty,
                Exists: false,
                IsDeleted: true,
                string.Empty);
            facts.Add(missing with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(missing)
            });
        }
        return facts;
    }
}

using System.Data.Common;

using Outbox = FsusBlog.Contracts.Articles.Outbox;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services;

public static class ArticleMutationOutboxProducer
{
    public const string FactoryId = Outbox.ArticleMutationOutboxValueFactory.FactoryId;

    public static async Task<ArticleMutationOutboxEvent> CreateForVersionAsync(
        ISqlSugarClient db,
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        DateTime occurredAt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision.categoryid,
                   revision.tag_ids,
                   article.status,
                   article.isdeleted,
                   article.current_revision_id,
                   article.public_updated_at
            FROM article_revision revision
            JOIN article article ON article.id = revision.article_id
            WHERE revision.article_id = @ArticleId
              AND revision.id = @RevisionId
              AND revision.revision_no = @RevisionNo;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RevisionId", version.RevisionId),
            new SugarParameter("@RevisionNo", version.RevisionNo));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article {articleId} revision coordinates do not resolve.");
        }

        string tagIds = reader.IsNull("tag_ids") ? string.Empty : reader.ReadString("tag_ids");
        int[] tags = ParseTagIds(tagIds);
        bool isCurrentRevision = reader.ReadInt64("current_revision_id") == version.RevisionId;
        string visibility = isCurrentRevision
            ? ArticleMutationVisibility.From(
                (ArticleStatus)reader.ReadInt32("status"),
                reader.ReadBoolean("isdeleted"))
            : "historical";
        var scope = new ArticleMutationScopeSnapshot(reader.ReadInt32("categoryid"), tags, visibility);
        DateTime publicUpdatedAt = reader.IsNull("public_updated_at")
            ? occurredAt
            : DateTime.SpecifyKind(reader.ReadDateTime("public_updated_at"), DateTimeKind.Utc);
        return Create(articleId, eventType, version, scope, scope, occurredAt, publicUpdatedAt);
    }

    public static async Task<ArticleMutationOutboxEvent> CreateCurrentAsync(
        ISqlSugarClient db,
        int articleId,
        string eventType,
        DateTime occurredAt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                revision.id AS revision_id,
                revision.revision_no,
                revision.categoryid,
                revision.tag_ids,
                COALESCE(publication.rights_snapshot_id, rights.id) AS rights_snapshot_id,
                COALESCE(publication.responsibility_snapshot_id, responsibility.id) AS responsibility_snapshot_id,
                responsibility.responsibility_version,
                publication.id AS publication_id,
                publication.publication_no,
                article.status,
                article.isdeleted,
                article.public_updated_at
            FROM article article
            JOIN article_revision revision ON revision.id = article.current_revision_id
            LEFT JOIN article_publication publication ON publication.id = article.current_publication_id
            LEFT JOIN LATERAL (
                SELECT snapshot.id
                FROM article_rights_snapshot snapshot
                WHERE snapshot.article_id = article.id
                  AND snapshot.article_revision_id = revision.id
                ORDER BY snapshot.revision_no DESC, snapshot.id DESC
                LIMIT 1
            ) rights ON TRUE
            LEFT JOIN LATERAL (
                SELECT snapshot.id, snapshot.responsibility_version
                FROM article_responsibility_snapshot snapshot
                WHERE snapshot.article_id = article.id
                  AND snapshot.article_revision_id = revision.id
                  AND (
                      publication.responsibility_snapshot_id IS NULL
                      OR snapshot.id = publication.responsibility_snapshot_id
                  )
                ORDER BY snapshot.responsibility_version DESC, snapshot.id DESC
                LIMIT 1
            ) responsibility ON TRUE
            WHERE article.id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", articleId));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article {articleId} has no immutable mutation coordinates.");
        }

        long revisionId = reader.ReadInt64("revision_id");
        int revisionNo = reader.ReadInt32("revision_no");
        long rightsSnapshotId = reader.ReadInt64("rights_snapshot_id");
        long? responsibilitySnapshotId = reader.IsNull("responsibility_snapshot_id")
            ? null
            : reader.ReadInt64("responsibility_snapshot_id");
        int? responsibilityVersion = reader.IsNull("responsibility_version")
            ? null
            : reader.ReadInt32("responsibility_version");
        long? publicationId = reader.IsNull("publication_id") ? null : reader.ReadInt64("publication_id");
        int? publicationNo = reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no");
        string tagIds = reader.IsNull("tag_ids") ? string.Empty : reader.ReadString("tag_ids");
        int[] tags = ParseTagIds(tagIds);
        var scope = new ArticleMutationScopeSnapshot(
            reader.ReadInt32("categoryid"),
            tags,
            ArticleMutationVisibility.From(
                (ArticleStatus)reader.ReadInt32("status"),
                reader.ReadBoolean("isdeleted")));
        var version = new ArticleVersionCoordinates(
            revisionId,
            revisionNo,
            rightsSnapshotId,
            responsibilitySnapshotId,
            publicationId,
            publicationNo,
            responsibilityVersion);
        DateTime publicUpdatedAt = reader.IsNull("public_updated_at")
            ? occurredAt
            : DateTime.SpecifyKind(reader.ReadDateTime("public_updated_at"), DateTimeKind.Utc);

        return Create(articleId, eventType, version, scope, scope, occurredAt, publicUpdatedAt);
    }

    public static ArticleMutationOutboxEvent Create(
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        ArticleMutationScopeSnapshot? before,
        ArticleMutationScopeSnapshot? after,
        DateTime occurredAt,
        DateTime? publicUpdatedAt = null)
    {
        var item = new ArticleMutationOutboxEvent();
        Outbox.ArticleMutationOutboxValue value = Outbox.ArticleMutationOutboxValueFactory.Create(
            item.EventId, articleId, eventType,
            ArticlePublicationTransitionWriter.ToOutboxValue(version),
            ArticlePublicationTransitionWriter.ToOutboxValue(before),
            ArticlePublicationTransitionWriter.ToOutboxValue(after), occurredAt, publicUpdatedAt);
        item.EventId = value.EventId;
        item.AggregateId = value.AggregateId;
        item.SchemaVersion = value.SchemaVersion;
        item.ArticleRevisionId = value.ArticleRevisionId;
        item.RevisionNo = value.RevisionNo;
        item.RightsSnapshotId = value.RightsSnapshotId;
        item.ResponsibilitySnapshotId = value.ResponsibilitySnapshotId;
        item.ResponsibilityVersion = value.ResponsibilityVersion;
        item.ArticlePublicationId = value.ArticlePublicationId;
        item.PublicationNo = value.PublicationNo;
        item.EventType = value.EventType;
        item.PayloadJson = value.PayloadJson;
        item.Status = "pending";
        item.RetryCount = 0;
        item.NextRetryAt = value.CreatedAt;
        item.CreatedAt = value.CreatedAt;
        return item;
    }

    private static int[] ParseTagIds(string tagIds)
        => tagIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(static value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))
            .Where(static value => value > 0)
            .Distinct()
            .Order()
            .ToArray();
}

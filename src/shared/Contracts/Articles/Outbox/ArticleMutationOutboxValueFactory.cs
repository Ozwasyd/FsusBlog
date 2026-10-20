using System.Text.Json;

namespace FsusBlog.Contracts.Articles.Outbox;

/// <summary>Pure original payload factory. The caller retains coordinate validation and event identity issuance.</summary>
public static class ArticleMutationOutboxValueFactory
{
    public const string FactoryId = "fsusblog.article-mutation-outbox-producer.v1";
    private static readonly JsonSerializerOptions s_outboxJsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Builds an event from verified current-owner coordinates and actual before/after scopes.</summary>
    /// <remarks>Pass the original authority's event ID once and retain the returned value for replay.</remarks>
    public static ArticleMutationOutboxValue Create(
        string eventId,
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        ArticleMutationScopeSnapshot? before,
        ArticleMutationScopeSnapshot? after,
        DateTime occurredAt,
        DateTime? publicUpdatedAt = null)
        => new(eventId, articleId, ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            version.RevisionId, version.RevisionNo, version.RightsSnapshotId,
            version.ResponsibilitySnapshotId, version.ResponsibilityVersion,
            version.PublicationId, version.PublicationNo, eventType,
            BuildOutboxPayload(articleId, eventType, version, before, after, occurredAt, publicUpdatedAt),
            occurredAt);

    public static string BuildOutboxPayload(
        int articleId,
        string eventType,
        ArticleVersionCoordinates version,
        ArticleMutationScopeSnapshot? before = null,
        ArticleMutationScopeSnapshot? after = null,
        DateTime? occurredAt = null,
        DateTime? publicUpdatedAt = null)
        => JsonSerializer.Serialize(new
        {
            schemaVersion = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            articleId,
            eventType,
            articleRevisionId = version.RevisionId,
            revisionNo = version.RevisionNo,
            rightsSnapshotId = version.RightsSnapshotId,
            responsibilitySnapshotId = version.ResponsibilitySnapshotId,
            responsibilityVersion = version.ResponsibilityVersion,
            releaseId = version.PublicationId,
            releaseNo = version.PublicationNo,
            publicUpdatedAt = publicUpdatedAt ?? occurredAt,
            occurredAt,
            before,
            after
        }, s_outboxJsonOptions);

}

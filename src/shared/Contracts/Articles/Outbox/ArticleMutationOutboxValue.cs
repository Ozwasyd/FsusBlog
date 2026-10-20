namespace FsusBlog.Contracts.Articles.Outbox;

/// <summary>Immutable coordinates supplied by the current owner; this value does not resolve storage.</summary>
public readonly record struct ArticleVersionCoordinates(
    long RevisionId,
    int RevisionNo,
    long RightsSnapshotId,
    long? ResponsibilitySnapshotId,
    long? PublicationId,
    int? PublicationNo,
    int? ResponsibilityVersion = null)
{
    public static ArticleVersionCoordinates Revision(
        long revisionId,
        int revisionNo,
        long rightsSnapshotId,
        long? responsibilitySnapshotId = null)
        => new(revisionId, revisionNo, rightsSnapshotId, responsibilitySnapshotId, null, null);
}

/// <summary>Actual taxonomy and visibility at one side of the original mutation.</summary>
public sealed record ArticleMutationScopeSnapshot(
    int? CategoryId,
    IReadOnlyList<int> TagIds,
    string? Visibility);

/// <summary>Original before/after scopes and their ordered invalidation union.</summary>
public sealed record ArticleMutationScopeChange(
    ArticleMutationScopeSnapshot? Before,
    ArticleMutationScopeSnapshot? After)
{
    public IReadOnlyList<int> CategoryIds => new[] { Before?.CategoryId, After?.CategoryId }
        .Where(static value => value is > 0)
        .Select(static value => value!.Value)
        .Distinct()
        .ToArray();

    public IReadOnlyList<int> TagIds => (Before?.TagIds ?? [])
        .Concat(After?.TagIds ?? [])
        .Where(static value => value > 0)
        .Distinct()
        .ToArray();
}

/// <summary>Decoded version references including legacy optional coordinates.</summary>
public readonly record struct ArticleMutationVersionReference(
    long? RevisionId,
    int? RevisionNo,
    long? PublicationId,
    int? PublicationNo,
    long? ResponsibilitySnapshotId = null,
    long? RightsSnapshotId = null,
    int? ResponsibilityVersion = null,
    DateTime? PublicUpdatedAt = null,
    DateTime? EventOccurredAt = null)
{
    // The authoring contract calls an immutable article publication a release.
    public long? ReleaseId => PublicationId;
}

/// <summary>Decoded original envelope without storage or delivery authority.</summary>
public sealed record ArticleMutationOutboxEnvelope(
    int SchemaVersion,
    string EventId,
    int ArticleId,
    string EventType,
    ArticleMutationVersionReference Version,
    ArticleMutationScopeChange Scope,
    DateTime OccurredAt)
{
    public bool IsLegacy => SchemaVersion < ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion;
}

/// <summary>Original outbox columns and payload; retaining this value preserves replay identity and bytes.</summary>
/// <remarks>This value carries no database authority or proof that coordinates resolve.</remarks>
public sealed record ArticleMutationOutboxValue(
    string EventId,
    int AggregateId,
    int SchemaVersion,
    long? ArticleRevisionId,
    int? RevisionNo,
    long? RightsSnapshotId,
    long? ResponsibilitySnapshotId,
    int? ResponsibilityVersion,
    long? ArticlePublicationId,
    int? PublicationNo,
    string EventType,
    string PayloadJson,
    DateTime CreatedAt);

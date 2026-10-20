using System.Globalization;

using FsusBlog.Server.Entities;

using SqlSugar;

using Outbox = FsusBlog.Contracts.Articles.Outbox;

namespace FsusBlog.Server.Services;

public sealed class ArticleMutationSupersededException(string reason) : Exception(reason)
{
    public string Reason { get; } = reason;
}

public sealed record ArticleMutationScopeSnapshot(
    int? CategoryId,
    IReadOnlyList<int> TagIds,
    string? Visibility);

public static class ArticleMutationVisibility
{
    public static string From(ArticleStatus status, bool isDeleted = false)
        => isDeleted || status == ArticleStatus.Deleted
            ? "deleted"
            : status switch
            {
                ArticleStatus.Published => "published",
                ArticleStatus.Scheduled => "scheduled",
                ArticleStatus.Archived => "archived",
                _ => "draft"
            };
}

public sealed record ArticleMutationScopeChange(
    ArticleMutationScopeSnapshot? Before,
    ArticleMutationScopeSnapshot? After)
{
    public IReadOnlyList<int> CategoryIds => ToValue().CategoryIds;

    public IReadOnlyList<int> TagIds => ToValue().TagIds;

    private Outbox.ArticleMutationScopeChange ToValue()
        => new(ArticlePublicationTransitionWriter.ToOutboxValue(Before),
            ArticlePublicationTransitionWriter.ToOutboxValue(After));
}

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

public static class ArticleMutationOutboxEnvelopeCodec
{
    public const string CurrentSchemaId = Outbox.ArticleMutationOutboxEnvelopeCodec.CurrentSchemaId;
    public const int CurrentSchemaVersion = Outbox.ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion;

    public static ArticleMutationOutboxEnvelope Read(ArticleMutationOutboxEvent item)
    {
        ArgumentNullException.ThrowIfNull(item);
        Outbox.ArticleMutationOutboxEnvelope envelope = Outbox.ArticleMutationOutboxEnvelopeCodec.Read(
            new Outbox.ArticleMutationOutboxValue(item.EventId, item.AggregateId, item.SchemaVersion,
                item.ArticleRevisionId, item.RevisionNo, item.RightsSnapshotId,
                item.ResponsibilitySnapshotId, item.ResponsibilityVersion,
                item.ArticlePublicationId, item.PublicationNo, item.EventType, item.PayloadJson, item.CreatedAt));
        Outbox.ArticleMutationVersionReference version = envelope.Version;
        return new ArticleMutationOutboxEnvelope(envelope.SchemaVersion, envelope.EventId,
            envelope.ArticleId, envelope.EventType,
            new ArticleMutationVersionReference(version.RevisionId, version.RevisionNo,
                version.PublicationId, version.PublicationNo, version.ResponsibilitySnapshotId,
                version.RightsSnapshotId, version.ResponsibilityVersion, version.PublicUpdatedAt,
                version.EventOccurredAt),
            new ArticleMutationScopeChange(FromValue(envelope.Scope.Before), FromValue(envelope.Scope.After)),
            envelope.OccurredAt);
    }

    private static ArticleMutationScopeSnapshot? FromValue(Outbox.ArticleMutationScopeSnapshot? scope)
        => scope is null ? null : new(scope.CategoryId, scope.TagIds, scope.Visibility);
}

public enum ArticleMutationVersionDispositionKind
{
    Process,
    Skip,
    Invalid
}

public sealed record ArticleMutationVersionDisposition(
    ArticleMutationVersionDispositionKind Kind,
    string? Reason)
{
    public static readonly ArticleMutationVersionDisposition Process = new(
        ArticleMutationVersionDispositionKind.Process,
        null);

    public static ArticleMutationVersionDisposition Skip(string reason)
        => new(ArticleMutationVersionDispositionKind.Skip, reason);

    public static ArticleMutationVersionDisposition Invalid(string reason)
        => new(ArticleMutationVersionDispositionKind.Invalid, reason);
}

public static class ArticleMutationOutboxVersionGuard
{
    public static async Task<ArticleMutationVersionDisposition> EvaluateAsync(
        ISqlSugarClient db,
        ArticleMutationOutboxEnvelope envelope,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(envelope);
        ArticleMutationVersionReference version = envelope.Version;

        ArticleMutationCurrentCoordinate? current = await db.Queryable<Article>()
            .ClearFilter()
            .Where(article => article.Id == envelope.ArticleId)
            .Select(article => new ArticleMutationCurrentCoordinate
            {
                CurrentRevisionId = article.CurrentRevisionId,
                CurrentPublicationId = article.CurrentPublicationId
            })
            .FirstAsync(cancellationToken);

        if (version.ReleaseId.HasValue)
        {
            ArticleMutationReleaseCoordinate? release = await db.Queryable<ArticlePublicationRecord>()
                .Where(record => record.Id == version.ReleaseId.Value && record.ArticleId == envelope.ArticleId)
                .Select(record => new ArticleMutationReleaseCoordinate
                {
                    PublicationNo = record.PublicationNo,
                    ArticleRevisionId = record.ArticleRevisionId,
                    RevisionNo = record.RevisionNo,
                    RightsSnapshotId = record.RightsSnapshotId,
                    ResponsibilitySnapshotId = record.ResponsibilitySnapshotId
                })
                .FirstAsync(cancellationToken);
            if (release is null
                || (version.PublicationNo.HasValue && release.PublicationNo != version.PublicationNo.Value)
                || (version.RevisionId.HasValue && release.ArticleRevisionId != version.RevisionId.Value)
                || (version.RevisionNo.HasValue && release.RevisionNo != version.RevisionNo.Value)
                || (version.RightsSnapshotId.HasValue && release.RightsSnapshotId != version.RightsSnapshotId.Value)
                || (version.ResponsibilitySnapshotId.HasValue
                    && release.ResponsibilitySnapshotId != version.ResponsibilitySnapshotId.Value))
            {
                return ArticleMutationVersionDisposition.Invalid(
                    $"invalid-release-coordinate:{version.ReleaseId.Value.ToString(CultureInfo.InvariantCulture)}");
            }

            if (current?.CurrentPublicationId is long currentReleaseId && currentReleaseId != version.ReleaseId.Value)
            {
                return ArticleMutationVersionDisposition.Skip(
                    $"superseded-by-release:{currentReleaseId.ToString(CultureInfo.InvariantCulture)}");
            }
        }
        else if (version.RevisionId.HasValue
            && current?.CurrentRevisionId is long currentRevisionId
            && currentRevisionId != version.RevisionId.Value)
        {
            return ArticleMutationVersionDisposition.Skip(
                $"superseded-by-revision:{currentRevisionId.ToString(CultureInfo.InvariantCulture)}");
        }

        if (version.RevisionId.HasValue)
        {
            bool revisionResolves = await db.Queryable<ArticleRevision>()
                .Where(revision => revision.Id == version.RevisionId.Value
                    && revision.ArticleId == envelope.ArticleId)
                .WhereIF(
                    version.RevisionNo.HasValue,
                    revision => revision.RevisionNo == version.RevisionNo.GetValueOrDefault())
                .AnyAsync(cancellationToken);
            if (!revisionResolves)
            {
                return ArticleMutationVersionDisposition.Invalid(
                    $"invalid-revision-coordinate:{version.RevisionId.Value.ToString(CultureInfo.InvariantCulture)}");
            }
        }

        if (version.RightsSnapshotId.HasValue)
        {
            bool rightsResolve = await db.Queryable<ArticleRightsSnapshot>()
                .Where(snapshot => snapshot.Id == version.RightsSnapshotId.Value
                    && snapshot.ArticleId == envelope.ArticleId)
                .WhereIF(
                    version.RevisionId.HasValue,
                    snapshot => snapshot.ArticleRevisionId == version.RevisionId.GetValueOrDefault())
                .AnyAsync(cancellationToken);
            if (!rightsResolve)
            {
                return ArticleMutationVersionDisposition.Invalid(
                    $"invalid-rights-coordinate:{version.RightsSnapshotId.Value.ToString(CultureInfo.InvariantCulture)}");
            }
        }

        if (version.ResponsibilitySnapshotId.HasValue)
        {
            bool responsibilityResolves = await db.Queryable<ArticleResponsibilitySnapshot>()
                .Where(snapshot => snapshot.Id == version.ResponsibilitySnapshotId.Value
                    && snapshot.ArticleId == envelope.ArticleId)
                .WhereIF(
                    version.RevisionId.HasValue,
                    snapshot => snapshot.ArticleRevisionId == version.RevisionId.GetValueOrDefault())
                .WhereIF(
                    version.ResponsibilityVersion.HasValue,
                    snapshot => snapshot.ResponsibilityVersion == version.ResponsibilityVersion.GetValueOrDefault())
                .AnyAsync(cancellationToken);
            if (!responsibilityResolves)
            {
                return ArticleMutationVersionDisposition.Invalid(
                    $"invalid-responsibility-coordinate:{version.ResponsibilitySnapshotId.Value.ToString(CultureInfo.InvariantCulture)}");
            }
        }

        return ArticleMutationVersionDisposition.Process;
    }

    private sealed class ArticleMutationCurrentCoordinate
    {
        public long? CurrentRevisionId
        {
            get; set;
        }

        public long? CurrentPublicationId
        {
            get; set;
        }
    }

    private sealed class ArticleMutationReleaseCoordinate
    {
        public int PublicationNo
        {
            get; set;
        }

        public long ArticleRevisionId
        {
            get; set;
        }

        public int RevisionNo
        {
            get; set;
        }

        public long RightsSnapshotId
        {
            get; set;
        }

        public long? ResponsibilitySnapshotId
        {
            get; set;
        }
    }
}

public static class ArticleMutationProjectionVersionPolicy
{
    public static bool PreserveCurrentWhenCoordinateDoesNotResolve(
        long? expectedReleaseId,
        bool coordinateResolved)
        => expectedReleaseId.HasValue && !coordinateResolved;
}

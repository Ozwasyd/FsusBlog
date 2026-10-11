using FsusBlog.Contracts.Articles;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Internal source coordinates; these contain no title, slug or taxonomy metadata.</summary>
public sealed record AuthorArticleQuerySourceCoordinate(
    int ArticleId,
    long ServerRevision,
    string RowVersion,
    AuthorArticleQueryStatus Status);

/// <summary>Actual management fields, read only after the existing permission authority admits the ID.</summary>
public sealed record AuthorArticleQuerySourceFields(
    AuthorArticleQuerySourceCoordinate Coordinate,
    string Title,
    string Category,
    IReadOnlyList<string> Tags);

/// <summary>A bounded source measurement, independent of ranked query pagination.</summary>
public sealed record AuthorArticleQuerySourceBatch(
    IReadOnlyList<AuthorArticleQuerySourceCoordinate> Coordinates,
    bool HasMore)
{
    /// <summary>Raw internal read position; this is not a query cursor or an authority receipt.</summary>
    public int? NextAfterArticleId => HasMore && Coordinates.Count > 0 ? Coordinates[^1].ArticleId : null;
}

/// <summary>Minimal projection on the canonical article owner; never a second article index.</summary>
public interface IAuthorArticleQuerySourceReader
{
    Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        CancellationToken cancellationToken);

    Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAfterAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        int afterArticleId,
        CancellationToken cancellationToken)
        => Task.FromException<AuthorArticleQuerySourceBatch>(
            new NotSupportedException("author_article_query_source_continuation_unavailable"));

    Task<AuthorArticleQuerySourceBatch> ReadCoordinatesForIdsAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
        => Task.FromException<AuthorArticleQuerySourceBatch>(
            new NotSupportedException("author_article_query_history_coordinate_source_unavailable"));

    Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
        IReadOnlyList<int> admittedArticleIds,
        CancellationToken cancellationToken);
}

/// <summary>Closed reasons that prevent this measurement becoming a successful full query.</summary>
public enum AuthorArticleQuerySourceUnavailableReason
{
    PermissionUnavailable = 0,
    PermissionChanged = 1,
    SourceChanged = 2,
    SlugUnavailable = 3,
    ArchivedReadGrantUnavailable = 4,
    VerifiedRecentSourceUnavailable = 5,
    QueryCursorUnavailable = 6,
    SourceWindowUnavailable = 7
}

/// <summary>A verified history ordinal joined by article identity to a live source coordinate.</summary>
/// <remarks>The history server revision is a recorded fact, not the live article version.</remarks>
public sealed record AuthorArticleQueryRecentSourceBinding(
    AuthorArticleQuerySourceCoordinate Coordinate,
    long HistoryServerRevision,
    int Ordinal);

/// <summary>
/// Internal observation only. Fields are not ranked candidates, a product response, a history
/// projection or an admission receipt; a missing slug remains unavailable even for zero articles.
/// </summary>
public sealed record AuthorArticleQuerySourceInspectionResult(
    AuthorArticleQuerySourceUnavailableReason UnavailableReason,
    IReadOnlyList<AuthorArticleQuerySourceFields> ObservedFields,
    bool HasMore)
{
    /// <summary>The identity returned by the original verified projection reader, if consulted.</summary>
    public AuthorArticleQueryHistoryIdentity? HistoryIdentity
    {
        get; init;
    }
    /// <summary>Only admitted live fields receive verified recent ordinals.</summary>
    public IReadOnlyList<AuthorArticleQueryRecentSourceBinding> RecentBindings { get; init; } = [];
    /// <summary>Internal corpus read position; it cannot be sent as an authenticated query cursor.</summary>
    public int? NextAfterArticleId
    {
        get; init;
    }
    internal AuthorRecentArticleHistoryPermissionSnapshot? ObservedPermission
    {
        get; init;
    }
}

/// <summary>
/// Reuses the real principal/site/session authority before source enumeration and each metadata
/// read. This cannot authorize Archived, synthesize a slug or issue successful query responses.
/// </summary>
public sealed class AuthorArticleQuerySourceInspection(
    IAuthorRecentArticleHistoryPermissionProjectionProvider permission,
    IAuthorArticleQuerySourceReader source,
    AuthorArticleQueryHistoryIdentityReader? history = null)
{
    /// <summary>The existing permission authority admits at most this many IDs per read.</summary>
    public const int MaxBatchSize = AuthorRecentArticleHistoryContract.MaxEntriesPerOwner;

    /// <summary>Measures available management fields while keeping the full query closed.</summary>
    public Task<AuthorArticleQuerySourceInspectionResult> InspectAsync(
        AuthorArticleQueryRequest request,
        CancellationToken cancellationToken = default)
        => InspectPageAsync(request, 0, cancellationToken);

    /// <summary>Measures one bounded corpus page while retaining the original permission and refusal gates.</summary>
    /// <remarks>The raw position does not bind a complete source/history identity or authorize a query cursor.</remarks>
    public async Task<AuthorArticleQuerySourceInspectionResult> InspectPageAsync(
        AuthorArticleQueryRequest request,
        int afterArticleId,
        CancellationToken cancellationToken = default)
    {
        AuthorArticleQueryContract.ValidateRequest(request);
        ArgumentOutOfRangeException.ThrowIfNegative(afterArticleId);
        cancellationToken.ThrowIfCancellationRequested();
        var owner = new AuthorRecentArticleHistoryOwner(request.Owner.AdminPrincipalId, request.Owner.SiteScope);
        AuthorRecentArticleHistoryPermissionSnapshot preflight = await permission.ResolveAsync(
            new(owner, request.RequestId, []), cancellationToken).ConfigureAwait(false);
        if (!ValidPermission(preflight, owner, []))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable);
        }
        if (request.Statuses.Contains(AuthorArticleQueryStatus.Archived)
            || request.Buckets.Contains(AuthorArticleQueryBucket.Archived))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable);
        }
        if (request.Cursor is not null)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable);
        }
        if (afterArticleId > 0 && request.Buckets.Contains(AuthorArticleQueryBucket.Recent))
        {
            // A corpus position cannot stand in for continuation of the complete Recent union.
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable);
        }

        AuthorArticleQueryHistoryIdentity? historyIdentity = null;
        if (request.Buckets.Contains(AuthorArticleQueryBucket.Recent))
        {
            if (history is null)
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
            }
            AuthorArticleQueryHistoryIdentityResult identity = await history.ReadAsync(request, cancellationToken)
                .ConfigureAwait(false);
            if (identity.Identity is null)
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
            }
            historyIdentity = identity.Identity;
            if (!SameHistoryAuthority(historyIdentity, preflight))
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionChanged);
            }
        }

        AuthorArticleQueryStatus[] statuses = request.Statuses.Where(status => request.Buckets.Contains(status switch
        {
            AuthorArticleQueryStatus.Draft => AuthorArticleQueryBucket.Draft,
            AuthorArticleQueryStatus.Published => AuthorArticleQueryBucket.Published,
            AuthorArticleQueryStatus.Scheduled => AuthorArticleQueryBucket.Scheduled,
            _ => throw new InvalidOperationException("author_article_query_source_status_unavailable")
        })).ToArray();
        AuthorArticleQuerySourceBatch batch;
        try
        {
            batch = statuses.Length == 0 ? new([], false)
                : afterArticleId == 0
                    ? await source.ReadCoordinatesAsync(statuses, cancellationToken).ConfigureAwait(false)
                    : await source.ReadCoordinatesAfterAsync(statuses, afterArticleId, cancellationToken).ConfigureAwait(false);
        }
        catch (NotSupportedException)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable);
        }
        if (!ValidCoordinates(batch.Coordinates, statuses)
            || batch.Coordinates.Any(coordinate => coordinate.ArticleId <= afterArticleId)
            || (batch.HasMore && batch.Coordinates.Count != MaxBatchSize))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
        }
        var coordinatesById = batch.Coordinates.ToDictionary(static coordinate => coordinate.ArticleId);
        if (historyIdentity is not null && historyIdentity.Ordinals.Count > 0)
        {
            int[] historyIds = historyIdentity.Ordinals.Select(static ordinal => ordinal.ArticleId).Order().ToArray();
            AuthorArticleQuerySourceBatch recent;
            try
            {
                recent = await source.ReadCoordinatesForIdsAsync(
                    request.Statuses, historyIds, cancellationToken).ConfigureAwait(false);
            }
            catch (NotSupportedException)
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
            }
            if (recent.HasMore || !ValidCoordinates(recent.Coordinates, request.Statuses)
                || recent.Coordinates.Any(coordinate => !historyIds.Contains(coordinate.ArticleId)))
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
            }
            foreach (AuthorArticleQuerySourceCoordinate coordinate in recent.Coordinates)
            {
                if (coordinatesById.TryGetValue(coordinate.ArticleId, out var existing) && existing != coordinate)
                {
                    return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
                }
                coordinatesById[coordinate.ArticleId] = coordinate;
            }
        }
        if (coordinatesById.Count > MaxBatchSize)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable);
        }
        AuthorArticleQuerySourceCoordinate[] coordinates = coordinatesById.Values.OrderBy(
            static coordinate => coordinate.ArticleId).ToArray();
        int[] ids = coordinates.Select(static coordinate => coordinate.ArticleId).ToArray();
        AuthorRecentArticleHistoryPermissionSnapshot admitted = await permission.ResolveAsync(
            new(owner, request.RequestId, ids), cancellationToken).ConfigureAwait(false);
        if (!ValidPermission(admitted, owner, ids) || !SameAuthority(preflight, admitted))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionChanged);
        }
        int[] admittedIds = admitted.Decisions.Where(static decision => decision.CanProject && decision.CanWrite)
            .Select(static decision => decision.ArticleId).Order().ToArray();
        IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedIds.Length == 0
            ? []
            : await source.ReadFieldsAsync(admittedIds, cancellationToken).ConfigureAwait(false);
        Dictionary<int, AuthorArticleQuerySourceCoordinate> expected = coordinates
            .Where(coordinate => admittedIds.Contains(coordinate.ArticleId))
            .ToDictionary(static coordinate => coordinate.ArticleId);
        if (fields.Count != admittedIds.Length
            || fields.Select(static field => field.Coordinate.ArticleId).Distinct().Count() != fields.Count
            || fields.Any(field => !expected.TryGetValue(field.Coordinate.ArticleId, out var coordinate)
                || field.Coordinate != coordinate))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
        }
        AuthorRecentArticleHistoryPermissionSnapshot after = await permission.ResolveAsync(
            new(owner, request.RequestId, ids), cancellationToken).ConfigureAwait(false);
        if (!ValidPermission(after, owner, ids) || after.ContentDigest != admitted.ContentDigest)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionChanged);
        }
        if (historyIdentity is not null && history is not null)
        {
            AuthorArticleQueryHistoryIdentityResult afterHistory = await history.ReadAsync(request, cancellationToken)
                .ConfigureAwait(false);
            if (afterHistory.Identity is null || !SameHistoryIdentity(historyIdentity, afterHistory.Identity))
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        Dictionary<int, AuthorArticleQueryHistoryOrdinal> ordinals = historyIdentity?.Ordinals.ToDictionary(
            static ordinal => ordinal.ArticleId) ?? [];
        return new(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, fields, batch.HasMore)
        {
            HistoryIdentity = historyIdentity,
            NextAfterArticleId = batch.NextAfterArticleId,
            ObservedPermission = after,
            RecentBindings = fields.Where(field => ordinals.ContainsKey(field.Coordinate.ArticleId))
                .Select(field => new AuthorArticleQueryRecentSourceBinding(field.Coordinate,
                    ordinals[field.Coordinate.ArticleId].HistoryServerRevision,
                    ordinals[field.Coordinate.ArticleId].Ordinal))
                .OrderBy(static binding => binding.Ordinal).ToArray()
        };
    }

    /// <summary>Rechecks bounded live coordinates and metadata through their original source owner.</summary>
    /// <remarks>This preserves missing query admission and does not establish a complete corpus snapshot.</remarks>
    public async Task<AuthorArticleQuerySourceInspectionResult> InspectStablePageAsync(
        AuthorArticleQueryRequest request,
        int afterArticleId,
        CancellationToken cancellationToken = default)
    {
        AuthorArticleQuerySourceInspectionResult first = await InspectPageAsync(request, afterArticleId, cancellationToken)
            .ConfigureAwait(false);
        if (first.UnavailableReason != AuthorArticleQuerySourceUnavailableReason.SlugUnavailable
            || first.ObservedFields.Count == 0)
        {
            return first;
        }
        AuthorRecentArticleHistoryPermissionSnapshot? anchor = first.ObservedPermission;
        if (anchor is null)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable);
        }
        AuthorArticleQuerySourceFields[] observed = first.ObservedFields
            .Select(static field => field with { Tags = field.Tags.ToArray() }).ToArray();
        int[] ownerIds = anchor.Decisions.Select(static decision => decision.ArticleId).Order().ToArray();
        int[] admittedIds = observed.Select(static field => field.Coordinate.ArticleId).Order().ToArray();
        AuthorRecentArticleHistoryPermissionSnapshot admitted = await permission.ResolveAsync(
            new(anchor.Owner, request.RequestId, ownerIds), cancellationToken).ConfigureAwait(false);
        if (!ValidPermission(admitted, anchor.Owner, ownerIds) || admitted.ContentDigest != anchor.ContentDigest)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionChanged);
        }
        AuthorArticleQuerySourceBatch current;
        try
        {
            current = await source.ReadCoordinatesForIdsAsync(request.Statuses, admittedIds, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (NotSupportedException)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable);
        }
        if (current.HasMore || !ValidCoordinates(current.Coordinates, request.Statuses)
            || !current.Coordinates.SequenceEqual(observed.Select(static field => field.Coordinate)
                .OrderBy(static coordinate => coordinate.ArticleId)))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
        }
        IReadOnlyList<AuthorArticleQuerySourceFields> rechecked = await source.ReadFieldsAsync(admittedIds, cancellationToken)
            .ConfigureAwait(false);
        if (!SameFields(observed, rechecked))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
        }
        AuthorRecentArticleHistoryPermissionSnapshot after = await permission.ResolveAsync(
            new(anchor.Owner, request.RequestId, ownerIds), cancellationToken).ConfigureAwait(false);
        if (!ValidPermission(after, anchor.Owner, ownerIds) || after.ContentDigest != admitted.ContentDigest)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.PermissionChanged);
        }
        if (first.HistoryIdentity is not null && history is not null)
        {
            AuthorArticleQueryHistoryIdentityResult afterHistory = await history.ReadAsync(request, cancellationToken)
                .ConfigureAwait(false);
            if (afterHistory.Identity is null || !SameHistoryIdentity(first.HistoryIdentity, afterHistory.Identity))
            {
                return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return first with
        {
            ObservedFields = observed,
            ObservedPermission = after
        };
    }

    private static bool SameFields(
        IReadOnlyList<AuthorArticleQuerySourceFields> left,
        IReadOnlyList<AuthorArticleQuerySourceFields> right)
    {
        if (left.Count != right.Count || right.Select(static field => field.Coordinate.ArticleId).Distinct().Count() != right.Count)
        {
            return false;
        }
        Dictionary<int, AuthorArticleQuerySourceFields> expected = left.ToDictionary(static field => field.Coordinate.ArticleId);
        return right.All(field => expected.TryGetValue(field.Coordinate.ArticleId, out var prior)
            && field.Coordinate == prior.Coordinate && field.Title == prior.Title && field.Category == prior.Category
            && field.Tags.SequenceEqual(prior.Tags, StringComparer.Ordinal));
    }

    private static bool ValidCoordinates(
        IReadOnlyList<AuthorArticleQuerySourceCoordinate> coordinates,
        IReadOnlyList<AuthorArticleQueryStatus> statuses)
        => coordinates.Count <= MaxBatchSize
            && coordinates.Select(static coordinate => coordinate.ArticleId)
                .SequenceEqual(coordinates.Select(static coordinate => coordinate.ArticleId).Distinct().Order())
            && coordinates.All(coordinate => coordinate.ArticleId > 0 && coordinate.ServerRevision > 0
                && !string.IsNullOrWhiteSpace(coordinate.RowVersion) && statuses.Contains(coordinate.Status));

    private static bool SameHistoryAuthority(
        AuthorArticleQueryHistoryIdentity identity,
        AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => identity.Owner == snapshot.Owner && identity.PermissionRevision == snapshot.PermissionRevision
            && identity.SiteRevision == snapshot.SiteRevision && identity.SessionRevision == snapshot.SessionRevision;

    private static bool SameHistoryIdentity(
        AuthorArticleQueryHistoryIdentity left,
        AuthorArticleQueryHistoryIdentity right)
        => left.Owner == right.Owner && left.CollectionRevision == right.CollectionRevision
            && left.ProjectionDigest == right.ProjectionDigest && left.PermissionDigest == right.PermissionDigest
            && left.PermissionRevision == right.PermissionRevision && left.SiteRevision == right.SiteRevision
            && left.SessionRevision == right.SessionRevision && left.Ordinals.SequenceEqual(right.Ordinals);

    private static bool SameAuthority(
        AuthorRecentArticleHistoryPermissionSnapshot left,
        AuthorRecentArticleHistoryPermissionSnapshot right)
        => left.PermissionRevision == right.PermissionRevision
            && left.SiteRevision == right.SiteRevision
            && left.SessionRevision == right.SessionRevision;

    private static bool ValidPermission(
        AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner,
        IReadOnlyList<int> articleIds)
    {
        try
        {
            return snapshot.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
                && snapshot.Owner == owner
                && snapshot.Decisions.Count == articleIds.Count
                && snapshot.Decisions.Select(static decision => decision.ArticleId).Order().SequenceEqual(articleIds.Order())
                && snapshot.Decisions.Select(static decision => decision.ArticleId).Distinct().Count() == articleIds.Count
                && snapshot.ContentDigest == AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot);
        }
        catch (AuthorRecentArticleHistoryValidationException)
        {
            return false;
        }
    }

    private static AuthorArticleQuerySourceInspectionResult Unavailable(AuthorArticleQuerySourceUnavailableReason reason)
        => new(reason, [], false);
}

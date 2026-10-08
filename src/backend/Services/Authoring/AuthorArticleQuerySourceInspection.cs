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
    bool HasMore);

/// <summary>Minimal projection on the canonical article owner; never a second article index.</summary>
public interface IAuthorArticleQuerySourceReader
{
    Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
        IReadOnlyList<AuthorArticleQueryStatus> statuses,
        CancellationToken cancellationToken);

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
    QueryCursorUnavailable = 6
}

/// <summary>
/// Internal observation only. Fields are not ranked candidates, a product response, a history
/// projection or an admission receipt; a missing slug remains unavailable even for zero articles.
/// </summary>
public sealed record AuthorArticleQuerySourceInspectionResult(
    AuthorArticleQuerySourceUnavailableReason UnavailableReason,
    IReadOnlyList<AuthorArticleQuerySourceFields> ObservedFields,
    bool HasMore);

/// <summary>
/// Reuses the real principal/site/session authority before source enumeration and each metadata
/// read. This cannot authorize Archived, synthesize a slug or issue successful query responses.
/// </summary>
public sealed class AuthorArticleQuerySourceInspection(
    IAuthorRecentArticleHistoryPermissionProjectionProvider permission,
    IAuthorArticleQuerySourceReader source)
{
    /// <summary>The existing permission authority admits at most this many IDs per read.</summary>
    public const int MaxBatchSize = AuthorRecentArticleHistoryContract.MaxEntriesPerOwner;

    /// <summary>Measures available management fields while keeping the full query closed.</summary>
    public async Task<AuthorArticleQuerySourceInspectionResult> InspectAsync(
        AuthorArticleQueryRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthorArticleQueryContract.ValidateRequest(request);
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
        if (request.Buckets.Contains(AuthorArticleQueryBucket.Recent))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable);
        }
        if (request.Cursor is not null)
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable);
        }

        AuthorArticleQueryStatus[] statuses = request.Statuses.Where(status => request.Buckets.Contains(status switch
        {
            AuthorArticleQueryStatus.Draft => AuthorArticleQueryBucket.Draft,
            AuthorArticleQueryStatus.Published => AuthorArticleQueryBucket.Published,
            AuthorArticleQueryStatus.Scheduled => AuthorArticleQueryBucket.Scheduled,
            _ => throw new InvalidOperationException("author_article_query_source_status_unavailable")
        })).ToArray();
        AuthorArticleQuerySourceBatch batch = await source.ReadCoordinatesAsync(statuses, cancellationToken)
            .ConfigureAwait(false);
        AuthorArticleQuerySourceCoordinate[] coordinates = [.. batch.Coordinates];
        int[] ids = coordinates.Select(static coordinate => coordinate.ArticleId).ToArray();
        if (coordinates.Length > MaxBatchSize
            || !ids.SequenceEqual(ids.Distinct().Order())
            || coordinates.Any(coordinate => coordinate.ArticleId <= 0
                || coordinate.ServerRevision <= 0
                || string.IsNullOrWhiteSpace(coordinate.RowVersion)
                || !statuses.Contains(coordinate.Status)))
        {
            return Unavailable(AuthorArticleQuerySourceUnavailableReason.SourceChanged);
        }
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
        cancellationToken.ThrowIfCancellationRequested();
        return new(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, fields, batch.HasMore);
    }

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

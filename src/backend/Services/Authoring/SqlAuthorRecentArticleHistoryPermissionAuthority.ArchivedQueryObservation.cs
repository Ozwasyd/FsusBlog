using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>A reading of the existing admin management permission, not an Archived query grant.</summary>
public sealed record AuthorArticleQueryArchivedManagementReadDecision(
    int ArticleId,
    bool CanReadManagementMetadata,
    AuthorArticleQuerySourceCoordinate? Coordinate);

/// <summary>Rechecked management facts; this is not an atomic query source snapshot or admission receipt.</summary>
public sealed record AuthorArticleQueryArchivedPermissionObservation(
    AuthorRecentArticleHistoryOwner Owner,
    Guid RequestId,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    ImmutableArray<AuthorArticleQueryArchivedManagementReadDecision> Decisions);

public sealed record AuthorArticleQueryArchivedPermissionObservationResult(
    AuthorArticleQueryArchivedPermissionObservation? Observation,
    string? UnavailableReason);

public interface IAuthorArticleQueryArchivedPermissionObservationReader
{
    Task<AuthorArticleQueryArchivedPermissionObservationResult> ObserveArchivedManagementPermissionAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default);
}

public sealed partial class SqlAuthorRecentArticleHistoryPermissionAuthority
    : IAuthorArticleQueryArchivedPermissionObservationReader
{
    /// <summary>Reuses live actor/site/session checks around actual Archived management coordinates.</summary>
    /// <remarks>
    /// The existing admin ArticleWrite route permits private management reads. This observation
    /// cannot replace history's Archived denial, issue a read grant or open the full query adapter.
    /// </remarks>
    public async Task<AuthorArticleQueryArchivedPermissionObservationResult> ObserveArchivedManagementPermissionAsync(
        AuthorRecentArticleHistoryPermissionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Owner);
        ArgumentNullException.ThrowIfNull(request.ArticleIds);
        AuthorRecentArticleHistoryContract.ValidateOwner(request.Owner);
        AuthorRecentArticleHistoryContract.ValidateRequestId(request.RequestId);
        ImmutableArray<int> ids = request.ArticleIds.Take(AuthorRecentArticleHistoryContract.MaxEntriesPerOwner + 1)
            .ToImmutableArray();
        if (ids.Length > AuthorRecentArticleHistoryContract.MaxEntriesPerOwner
            || ids.Any(static id => id <= 0) || ids.Distinct().Count() != ids.Length)
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_request_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        var authorityRequest = new AuthorRecentArticleHistoryPermissionRequest(request.Owner, request.RequestId, []);
        AuthorRecentArticleHistoryPermissionSnapshot before = await ResolveAsync(authorityRequest, cancellationToken)
            .ConfigureAwait(false);
        if (before.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current)
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_permission_unavailable");
        }
        Dictionary<int, ArchivedManagementState>? first = await ReadArchivedManagementStatesAsync(ids, cancellationToken)
            .ConfigureAwait(false);
        if (first is null)
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_source_changed");
        }
        AuthorRecentArticleHistoryPermissionSnapshot middle = await ResolveAsync(authorityRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!SameArchivedObservationAuthority(before, middle))
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_permission_changed");
        }
        Dictionary<int, ArchivedManagementState>? second = await ReadArchivedManagementStatesAsync(ids, cancellationToken)
            .ConfigureAwait(false);
        if (second is null || first.Count != second.Count
            || first.Any(pair => !second.TryGetValue(pair.Key, out var current) || current != pair.Value))
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_source_changed");
        }
        AuthorRecentArticleHistoryPermissionSnapshot after = await ResolveAsync(authorityRequest, cancellationToken)
            .ConfigureAwait(false);
        if (!SameArchivedObservationAuthority(before, after))
        {
            return ArchivedObservationUnavailable("author_article_query_archived_observation_permission_changed");
        }
        cancellationToken.ThrowIfCancellationRequested();
        ImmutableArray<AuthorArticleQueryArchivedManagementReadDecision> decisions = ids.Select(id =>
            first.TryGetValue(id, out var state) && state.Status == ArticleStatus.Archived && !state.IsDeleted
                && state.ServerRevision > 0 && !string.IsNullOrWhiteSpace(state.RowVersion)
                ? new AuthorArticleQueryArchivedManagementReadDecision(id, true,
                    new(id, state.ServerRevision, state.RowVersion, AuthorArticleQueryStatus.Archived))
                : new AuthorArticleQueryArchivedManagementReadDecision(id, false, null)).ToImmutableArray();
        return new(new(request.Owner, request.RequestId, before.PermissionRevision, before.SiteRevision,
            before.SessionRevision, decisions), null);
    }

    private async Task<Dictionary<int, ArchivedManagementState>?> ReadArchivedManagementStatesAsync(
        IReadOnlyList<int> ids,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = new Dictionary<int, ArchivedManagementState>();
        if (ids.Count == 0)
        {
            return result;
        }
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, status, isdeleted, current_revision_id, xmin::text AS row_version
            FROM article
            WHERE id = ANY(CAST(@ArticleIds AS integer[]))
            ORDER BY id
            LIMIT @Limit;
            """,
            new SugarParameter("@ArticleIds", FormatIntegerArray(ids)),
            new SugarParameter("@Limit", ids.Count + 1)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int id = reader.GetInt32(reader.GetOrdinal("id"));
            var state = new ArchivedManagementState(
                (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status")),
                reader.GetBoolean(reader.GetOrdinal("isdeleted")),
                reader.IsDBNull(reader.GetOrdinal("current_revision_id"))
                    ? 0 : reader.GetInt64(reader.GetOrdinal("current_revision_id")),
                reader.IsDBNull(reader.GetOrdinal("row_version"))
                    ? string.Empty : reader.GetString(reader.GetOrdinal("row_version")));
            if (!ids.Contains(id) || !result.TryAdd(id, state))
            {
                return null;
            }
        }
        return result;
    }

    private static bool SameArchivedObservationAuthority(
        AuthorRecentArticleHistoryPermissionSnapshot before,
        AuthorRecentArticleHistoryPermissionSnapshot current)
        => current.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            && before.Owner == current.Owner && before.ContentDigest == current.ContentDigest;

    private static AuthorArticleQueryArchivedPermissionObservationResult ArchivedObservationUnavailable(string reason)
        => new(null, reason);

    private sealed record ArchivedManagementState(ArticleStatus Status, bool IsDeleted, long ServerRevision, string RowVersion);
}

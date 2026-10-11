using FsusBlog.Contracts.Articles;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Fresh selected-ID observation; never a ranked query, open command or query receipt.</summary>
public sealed record AuthorArticleQuerySelectionRevalidationResult(
    bool Current,
    AuthorRecentArticleHistoryOwner Owner,
    int ArticleId,
    long ServerRevision,
    Guid RequestId,
    string? PermissionToken);

/// <summary>
/// Revalidates one selected ID through the original live permission and article owners.
/// No title, slug, ranking, history ordinal or numeric generation is manufactured here.
/// </summary>
public sealed class AuthorArticleQuerySelectionRevalidator(
    IAuthorRecentArticleHistoryPermissionProjectionProvider permission,
    IAuthorArticleQuerySourceReader source)
{
    public async Task<AuthorArticleQuerySelectionRevalidationResult> RevalidateAsync(
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        long serverRevision,
        string permissionToken,
        Guid requestId,
        CancellationToken cancellationToken = default)
    {
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        AuthorRecentArticleHistoryContract.ValidateArticleId(articleId);
        AuthorRecentArticleHistoryContract.ValidateServerRevision(serverRevision);
        AuthorRecentArticleHistoryContract.ValidateRequestId(requestId);
        AuthorRecentArticleHistoryContract.ValidateDigest(permissionToken);
        cancellationToken.ThrowIfCancellationRequested();
        var request = new AuthorRecentArticleHistoryPermissionRequest(owner, requestId, [articleId]);
        AuthorRecentArticleHistoryPermissionSnapshot before = await permission.ResolveAsync(request, cancellationToken)
            .ConfigureAwait(false);
        if (!Admitted(before, owner, articleId, permissionToken))
        {
            return Unavailable();
        }
        AuthorArticleQuerySourceCoordinate? first = await ReadCoordinateAsync().ConfigureAwait(false);
        if (first is null)
        {
            return Unavailable();
        }
        AuthorRecentArticleHistoryPermissionSnapshot middle = await permission.ResolveAsync(request, cancellationToken)
            .ConfigureAwait(false);
        if (!Admitted(middle, owner, articleId, permissionToken) || middle.ContentDigest != before.ContentDigest)
        {
            return Unavailable();
        }
        AuthorArticleQuerySourceCoordinate? last = await ReadCoordinateAsync().ConfigureAwait(false);
        if (last is null || last != first)
        {
            return Unavailable();
        }
        AuthorRecentArticleHistoryPermissionSnapshot after = await permission.ResolveAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return Admitted(after, owner, articleId, permissionToken) && after.ContentDigest == before.ContentDigest
            ? new(true, owner, articleId, serverRevision, requestId, permissionToken)
            : Unavailable();

        AuthorArticleQuerySelectionRevalidationResult Unavailable() => new(false, owner, articleId, serverRevision, requestId, null);

        async Task<AuthorArticleQuerySourceCoordinate?> ReadCoordinateAsync()
        {
            cancellationToken.ThrowIfCancellationRequested();
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = await source.ReadFieldsAsync([articleId], cancellationToken)
                .ConfigureAwait(false);
            if (fields.Count != 1)
            {
                return null;
            }
            AuthorArticleQuerySourceCoordinate coordinate = fields[0].Coordinate;
            return coordinate.ArticleId == articleId && coordinate.ServerRevision == serverRevision
                && !string.IsNullOrWhiteSpace(coordinate.RowVersion)
                && coordinate.Status is AuthorArticleQueryStatus.Draft or AuthorArticleQueryStatus.Published
                    or AuthorArticleQueryStatus.Scheduled or AuthorArticleQueryStatus.Inbox
                ? coordinate
                : null;
        }
    }

    private static bool Admitted(
        AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner,
        int articleId,
        string permissionToken)
    {
        try
        {
            return snapshot.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
                && snapshot.Owner == owner && snapshot.Decisions.Count == 1
                && snapshot.Decisions[0].ArticleId == articleId
                && snapshot.Decisions[0].CanProject && snapshot.Decisions[0].CanWrite
                && snapshot.Decisions[0].DecisionDigest == permissionToken
                && snapshot.ContentDigest == AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot);
        }
        catch (AuthorRecentArticleHistoryValidationException)
        {
            return false;
        }
    }
}

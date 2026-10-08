using FsusBlog.Contracts.Articles;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Ordinal from verified server history; the history revision is not a live article revision.</summary>
public sealed record AuthorArticleQueryHistoryOrdinal(int ArticleId, long HistoryServerRevision, int Ordinal);

/// <summary>Exact history and permission identity observed through the canonical projection service.</summary>
public sealed record AuthorArticleQueryHistoryIdentity(
    AuthorRecentArticleHistoryOwner Owner,
    long CollectionRevision,
    string ProjectionDigest,
    string PermissionDigest,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    IReadOnlyList<AuthorArticleQueryHistoryOrdinal> Ordinals);

/// <summary>History admission only; an available identity does not admit a full query response.</summary>
public sealed record AuthorArticleQueryHistoryIdentityResult(
    AuthorArticleQueryHistoryIdentity? Identity,
    string? UnavailableReason);

/// <summary>
/// Consumes the original verified, permission-filtered history projection. All pages must describe
/// the same owner, revision and authority; incomplete or changed projections produce no ordinals.
/// </summary>
public sealed class AuthorArticleQueryHistoryIdentityReader(IAuthorRecentArticleHistoryProjectionService history)
{
    /// <summary>Reads the bounded canonical history without browser history or synthetic receipts.</summary>
    public async Task<AuthorArticleQueryHistoryIdentityResult> ReadAsync(
        AuthorArticleQueryRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthorArticleQueryContract.ValidateRequest(request);
        cancellationToken.ThrowIfCancellationRequested();
        var owner = new AuthorRecentArticleHistoryOwner(request.Owner.AdminPrincipalId, request.Owner.SiteScope);
        var entries = new List<AuthorRecentArticleHistoryEntry>();
        var pages = new List<AuthorRecentArticleHistoryProjectionPage>();
        var cursors = new HashSet<string>(StringComparer.Ordinal);
        AuthorRecentArticleHistoryProjectionPage? first = null;
        string? cursor = null;
        do
        {
            AuthorRecentArticleHistoryProjectionPage page = await history.ReadAsync(
                new(owner, request.RequestId, AuthorRecentArticleHistoryContract.MaxPageSize, cursor,
                    first?.CollectionRevision, first?.PermissionRevision, first?.SiteRevision, first?.SessionRevision),
                cancellationToken).ConfigureAwait(false);
            if (page.Status != AuthorRecentArticleHistoryProjectionStatus.Current)
            {
                return Unavailable("author_article_query_history_unavailable");
            }
            if (page.Owner != owner
                || page.SchemaVersion != AuthorRecentArticleHistoryContract.SchemaVersion
                || page.Entries.Count > AuthorRecentArticleHistoryContract.MaxPageSize
                || page.HasMore != (page.NextCursor is not null)
                || (page.HasMore && page.Entries.Count == 0)
                || entries.Count + page.Entries.Count > AuthorRecentArticleHistoryContract.MaxEntriesPerOwner)
            {
                return Unavailable("author_article_query_history_invalid");
            }
            if (first is not null && !SameIdentity(first, page))
            {
                return Unavailable("author_article_query_history_changed");
            }
            first ??= page;
            entries.AddRange(page.Entries);
            pages.Add(page);
            cursor = page.NextCursor;
            if (cursor is not null && (!cursors.Add(cursor)
                || string.IsNullOrWhiteSpace(cursor)
                || cursor.Length > AuthorRecentArticleHistoryContract.MaxCursorLength
                || entries.Count >= AuthorRecentArticleHistoryContract.MaxEntriesPerOwner))
            {
                return Unavailable("author_article_query_history_invalid");
            }
        }
        while (cursor is not null);

        if (pages.Any(page => !AuthorRecentArticleHistoryContract.TryValidateProjectionPage(page, entries)))
        {
            return Unavailable("author_article_query_history_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        AuthorRecentArticleHistoryProjectionPage anchor = pages[0];
        return new(new(owner, anchor.CollectionRevision, anchor.ContentDigest, anchor.PermissionContentDigest,
            anchor.PermissionRevision, anchor.SiteRevision, anchor.SessionRevision,
            entries.Select(static (entry, index) =>
                new AuthorArticleQueryHistoryOrdinal(entry.ArticleId, entry.ServerRevision, index + 1)).ToArray()), null);
    }

    private static bool SameIdentity(
        AuthorRecentArticleHistoryProjectionPage first,
        AuthorRecentArticleHistoryProjectionPage page)
        => first.CollectionRevision == page.CollectionRevision
            && first.PermissionRevision == page.PermissionRevision
            && first.SiteRevision == page.SiteRevision
            && first.SessionRevision == page.SessionRevision
            && first.PermissionContentDigest == page.PermissionContentDigest
            && first.ContentDigest == page.ContentDigest
            && first.ProjectionReference == page.ProjectionReference
            && first.CacheReference == page.CacheReference;

    private static AuthorArticleQueryHistoryIdentityResult Unavailable(string reason) => new(null, reason);
}

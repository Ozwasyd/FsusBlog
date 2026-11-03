namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Server projection for history. Permission is resolved before any article is exposed, and the
/// result is ordered only by server-recorded history facts. A cache reference points at the same
/// durable server read model; there is no client-side or browser-history fallback.
/// </summary>
public interface IAuthorRecentArticleHistoryProjectionService
{
    Task<AuthorRecentArticleHistoryProjectionPage> ReadAsync(
        AuthorRecentArticleHistoryProjectionRequest request,
        CancellationToken cancellationToken = default);

    Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default);
}

public interface IAuthorRecentArticleHistoryProjectionCache
{
    Task<bool> PublishAsync(
        AuthorRecentArticleHistoryProjectionPage page,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Direct read-model publication. It deliberately stores no second history copy; publication
/// succeeds only when the page reference and digest describe the page being returned.
/// </summary>
public sealed class DirectAuthorRecentArticleHistoryProjectionCache
    : IAuthorRecentArticleHistoryProjectionCache
{
    public Task<bool> PublishAsync(
        AuthorRecentArticleHistoryProjectionPage page,
        IReadOnlyList<AuthorRecentArticleHistoryEntry> authoritativeEntries,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool valid = page.Status == AuthorRecentArticleHistoryProjectionStatus.Current
            && !string.IsNullOrWhiteSpace(page.CacheReference)
            && AuthorRecentArticleHistoryContract.TryValidateProjectionPage(
                page,
                authoritativeEntries);
        return Task.FromResult(valid);
    }
}

public sealed class AuthorRecentArticleHistoryProjectionService(
    IAuthorRecentArticleHistoryStore store,
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissionProvider,
    IAuthorRecentArticleHistoryCursorCodec cursorCodec,
    IAuthorRecentArticleHistoryProjectionCache cache)
    : IAuthorRecentArticleHistoryProjectionService
{
    public async Task<AuthorRecentArticleHistoryProjectionPage> ReadAsync(
        AuthorRecentArticleHistoryProjectionRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request);
        AuthorRecentArticleHistoryCollectionSnapshot snapshot;
        try
        {
            snapshot = await store.GetAuthoritySnapshotAsync(request.Owner, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_collection_unavailable");
        }
        if (!AuthorRecentArticleHistoryContract.TryValidateSnapshot(
                snapshot,
                out IReadOnlyList<string> snapshotReasons))
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                $"author_recent_history_collection_invalid:{string.Join(',', snapshotReasons)}");
        }
        if (snapshot.Owner != request.Owner)
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_collection_scope_mismatch");
        }

        AuthorRecentArticleHistoryVerificationResult verification;
        try
        {
            verification = await store.VerifyAsync(request.Owner, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_verifier_unavailable");
        }
        if (!MatchesVerifiedSnapshot(snapshot, verification))
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_durable_projection_invalid");
        }

        AuthorRecentArticleHistoryPermissionSnapshot permission;
        try
        {
            permission = await permissionProvider.ResolveAsync(
                new AuthorRecentArticleHistoryPermissionRequest(
                    request.Owner,
                    request.RequestId,
                    snapshot.Entries.Select(static entry => entry.ArticleId).ToArray()),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_permission_unavailable");
        }
        if (permission.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable)
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_permission_unavailable");
        }
        if (permission.Status == AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale)
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_permission_stale");
        }
        if (!ValidatePermissionSnapshot(request.Owner, snapshot, permission))
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_permission_invalid");
        }

        // A Current page authenticates whole-collection facts. Filtering entries cannot hide
        // their revision or permission digest; refuse before CAS/cursor comparisons or caching.
        if (permission.Decisions.Any(static decision => !decision.CanProject))
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_permission_unavailable");
        }

        if (request.ExpectedCollectionRevision is long expectedRevision
            && expectedRevision != snapshot.Revision)
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_collection_stale");
        }
        if (request.ExpectedPermissionRevision is not null
            && !string.Equals(request.ExpectedPermissionRevision, permission.PermissionRevision, StringComparison.Ordinal))
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_permission_stale");
        }
        if (request.ExpectedSiteRevision is not null
            && !string.Equals(request.ExpectedSiteRevision, permission.SiteRevision, StringComparison.Ordinal))
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_site_stale");
        }
        if (request.ExpectedSessionRevision is not null
            && !string.Equals(request.ExpectedSessionRevision, permission.SessionRevision, StringComparison.Ordinal))
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_session_stale");
        }

        AuthorRecentArticleHistoryEntry[] visibleEntries = snapshot.Entries
            .Where(entry => permission.Decisions.Any(
                decision => decision.ArticleId == entry.ArticleId && decision.CanProject))
            .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
            .ThenByDescending(static entry => entry.ArticleId)
            .ToArray();
        string projectionDigest = AuthorRecentArticleHistoryContract.ComputeProjectionDigest(
            request.Owner,
            snapshot.Revision,
            visibleEntries,
            permission);
        AuthorRecentArticleHistoryCursor? cursor = null;
        if (!cursorCodec.TryDecode(
                request.Cursor,
                out cursor,
                out string cursorReason))
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.InvalidCursor,
                cursorReason);
        }
        if (cursor is not null
            && (cursor.Owner != request.Owner
                || cursor.CollectionRevision != snapshot.Revision
                || !string.Equals(cursor.CollectionDigest, snapshot.ContentDigest, StringComparison.Ordinal)
                || !string.Equals(cursor.PermissionDigest, permission.ContentDigest, StringComparison.Ordinal)
                || !string.Equals(cursor.SiteRevision, permission.SiteRevision, StringComparison.Ordinal)
                || !string.Equals(cursor.SessionRevision, permission.SessionRevision, StringComparison.Ordinal)))
        {
            return BuildTerminalPage(
                request.Owner,
                snapshot,
                permission,
                AuthorRecentArticleHistoryProjectionStatus.Stale,
                "author_recent_history_cursor_stale");
        }

        int startIndex = 0;
        if (cursor is not null)
        {
            startIndex = Array.FindIndex(
                visibleEntries,
                entry => IsAfterCursor(entry, cursor));
            if (startIndex < 0)
            {
                startIndex = visibleEntries.Length;
            }
        }
        AuthorRecentArticleHistoryEntry[] pageEntries = visibleEntries
            .Skip(startIndex)
            .Take(request.Limit)
            .ToArray();
        bool hasMore = startIndex + pageEntries.Length < visibleEntries.Length;
        string? nextCursor = null;
        if (hasMore && pageEntries.Length > 0)
        {
            AuthorRecentArticleHistoryEntry last = pageEntries[^1];
            nextCursor = cursorCodec.Encode(
                new AuthorRecentArticleHistoryCursor(
                    request.Owner,
                    snapshot.Revision,
                    snapshot.ContentDigest,
                    permission.ContentDigest,
                    permission.SiteRevision,
                    permission.SessionRevision,
                    RecentArticleHistoryOrdering.LatestFactAtUtc(last),
                    last.ArticleId));
        }
        string projectionReference = $"author-recent-history:{request.Owner.AdminPrincipalId}:{request.Owner.SiteScope}:r{snapshot.Revision}";
        string cacheReference = $"server-read-model:{request.Owner.AdminPrincipalId}:{request.Owner.SiteScope}:{projectionDigest}";
        var page = new AuthorRecentArticleHistoryProjectionPage(
            AuthorRecentArticleHistoryProjectionStatus.Current,
            request.Owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            snapshot.Revision,
            pageEntries,
            nextCursor,
            hasMore,
            permission.PermissionRevision,
            permission.SiteRevision,
            permission.SessionRevision,
            permission.ContentDigest,
            projectionReference,
            cacheReference,
            projectionDigest,
            null);
        try
        {
            if (!await cache.PublishAsync(
                    page,
                    visibleEntries,
                    cancellationToken).ConfigureAwait(false))
            {
                return AuthorRecentArticleHistoryProjectionPage.Empty(
                    request.Owner,
                    AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                    "author_recent_history_projection_cache_unavailable");
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(
                request.Owner,
                AuthorRecentArticleHistoryProjectionStatus.Unavailable,
                "author_recent_history_projection_cache_unavailable");
        }
        return page;
    }

    public async Task<AuthorRecentArticleHistoryVerificationResult> VerifyAsync(
        AuthorRecentArticleHistoryOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        try
        {
            AuthorRecentArticleHistoryCollectionSnapshot snapshot =
                await store.GetAuthoritySnapshotAsync(owner, cancellationToken).ConfigureAwait(false);
            // Authority diagnostics and receipt facts require a current server permission snapshot.
            AuthorRecentArticleHistoryPermissionSnapshot permission =
                await permissionProvider.ResolveAsync(
                    new AuthorRecentArticleHistoryPermissionRequest(
                        owner,
                        Guid.CreateVersion7(),
                        snapshot.Entries.Select(static entry => entry.ArticleId).ToArray()),
                    cancellationToken).ConfigureAwait(false);
            if (permission.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
                || !ValidatePermissionSnapshot(owner, snapshot, permission)
                || permission.Decisions.Any(static decision => !decision.CanProject))
            {
                return new(
                    false,
                    ["author_recent_history_permission_verification_failed"],
                    0,
                    0,
                    string.Empty);
            }

            AuthorRecentArticleHistoryVerificationResult authority =
                await store.VerifyAsync(owner, cancellationToken).ConfigureAwait(false);
            if (!MatchesVerifiedSnapshot(snapshot, authority))
            {
                return new(
                    false,
                    ["author_recent_history_authority_verification_mismatch"],
                    0,
                    0,
                    string.Empty);
            }

            AuthorRecentArticleHistoryEntry[] visible = snapshot.Entries
                .Where(entry => permission.Decisions.Any(
                    decision => decision.ArticleId == entry.ArticleId && decision.CanProject))
                .OrderByDescending(RecentArticleHistoryOrdering.LatestFactAtUtc)
                .ThenByDescending(static entry => entry.ArticleId)
                .ToArray();
            string projectionDigest = AuthorRecentArticleHistoryContract.ComputeProjectionDigest(
                owner,
                snapshot.Revision,
                visible,
                permission);
            return new(
                true,
                [],
                snapshot.Revision,
                snapshot.ItemCount,
                projectionDigest,
                visible.Length,
                snapshot.ContentDigest,
                permission.ContentDigest);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return new(
                false,
                ["author_recent_history_independent_verifier_unavailable"],
                0,
                0,
                string.Empty);
        }
    }

    private static bool MatchesVerifiedSnapshot(
        AuthorRecentArticleHistoryCollectionSnapshot snapshot,
        AuthorRecentArticleHistoryVerificationResult verification)
        => verification.Valid
            && verification.Revision == snapshot.Revision
            && verification.ItemCount == snapshot.ItemCount
            && string.Equals(
                verification.ContentDigest,
                snapshot.ContentDigest,
                StringComparison.Ordinal);

    private static void ValidateRequest(AuthorRecentArticleHistoryProjectionRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        AuthorRecentArticleHistoryContract.ValidateOwner(request.Owner);
        AuthorRecentArticleHistoryContract.ValidateRequestId(request.RequestId);
        AuthorRecentArticleHistoryContract.ValidatePageSize(request.Limit);
        if (request.ExpectedCollectionRevision is < 0)
        {
            throw new AuthorRecentArticleHistoryValidationException(
                "author_recent_history_expected_revision_invalid");
        }
        ValidateOptionalDigest(request.ExpectedPermissionRevision);
        ValidateOptionalDigest(request.ExpectedSiteRevision);
        ValidateOptionalDigest(request.ExpectedSessionRevision);
    }

    private static void ValidateOptionalDigest(string? digest)
    {
        if (digest is not null)
        {
            AuthorRecentArticleHistoryContract.ValidateDigest(digest);
        }
    }

    private static bool ValidatePermissionSnapshot(
        AuthorRecentArticleHistoryOwner owner,
        AuthorRecentArticleHistoryCollectionSnapshot collection,
        AuthorRecentArticleHistoryPermissionSnapshot permission)
    {
        try
        {
            AuthorRecentArticleHistoryContract.ValidateOwner(permission.Owner);
            if (permission.Owner != owner
                || string.IsNullOrWhiteSpace(permission.PermissionRevision)
                || string.IsNullOrWhiteSpace(permission.SiteRevision)
                || string.IsNullOrWhiteSpace(permission.SessionRevision))
            {
                return false;
            }
            AuthorRecentArticleHistoryContract.ValidateDigest(permission.PermissionRevision);
            AuthorRecentArticleHistoryContract.ValidateDigest(permission.SiteRevision);
            AuthorRecentArticleHistoryContract.ValidateDigest(permission.SessionRevision);
            AuthorRecentArticleHistoryContract.ValidateDigest(permission.ContentDigest);
            int[] expectedIds = collection.Entries.Select(static entry => entry.ArticleId).Order().ToArray();
            int[] actualIds = permission.Decisions.Select(static decision => decision.ArticleId).Order().ToArray();
            if (!expectedIds.SequenceEqual(actualIds)
                || permission.Decisions.Select(static decision => decision.ArticleId).Distinct().Count()
                    != permission.Decisions.Count)
            {
                return false;
            }
            return string.Equals(
                AuthorRecentArticleHistoryContract.ComputePermissionDigest(permission with
                {
                    ContentDigest = string.Empty
                }),
                permission.ContentDigest,
                StringComparison.Ordinal);
        }
        catch (AuthorRecentArticleHistoryValidationException)
        {
            return false;
        }
    }

    private static bool IsAfterCursor(
        AuthorRecentArticleHistoryEntry entry,
        AuthorRecentArticleHistoryCursor cursor)
    {
        DateTime current = RecentArticleHistoryOrdering.LatestFactAtUtc(entry);
        return current < cursor.LastFactAtUtc
            || (current == cursor.LastFactAtUtc && entry.ArticleId < cursor.LastArticleId);
    }

    private static AuthorRecentArticleHistoryProjectionPage BuildTerminalPage(
        AuthorRecentArticleHistoryOwner owner,
        AuthorRecentArticleHistoryCollectionSnapshot snapshot,
        AuthorRecentArticleHistoryPermissionSnapshot permission,
        AuthorRecentArticleHistoryProjectionStatus status,
        string reason)
    {
        if (permission.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || !ValidatePermissionSnapshot(owner, snapshot, permission)
            || permission.Decisions.Any(static decision => !decision.CanProject))
        {
            return AuthorRecentArticleHistoryProjectionPage.Empty(owner, status, reason);
        }
        return new(
            status,
            owner,
            AuthorRecentArticleHistoryContract.SchemaVersion,
            snapshot.Revision,
            [],
            null,
            false,
            permission.PermissionRevision,
            permission.SiteRevision,
            permission.SessionRevision,
            permission.ContentDigest,
            $"author-recent-history:{owner.AdminPrincipalId}:{owner.SiteScope}:r{snapshot.Revision}",
            string.Empty,
            snapshot.ContentDigest,
            reason);
    }
}

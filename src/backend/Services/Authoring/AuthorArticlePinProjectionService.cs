namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The sole server-side reader for private article pins. It resolves authorization before article
/// metadata, keeps ordering server-owned, and returns content-addressed revision evidence.
/// </summary>
public sealed class AuthorArticlePinProjectionService(
    IAuthorArticlePinStore pinStore,
    IAuthorArticlePinPermissionProjectionProvider permissionProvider,
    IAuthorArticlePinArticleProjectionSource articleSource,
    IAuthorArticlePinProjectionCache cache,
    IAuthorArticlePinReconciliationSink reconciliationSink,
    TimeProvider timeProvider) : IAuthorArticlePinProjectionService
{
    public async Task<AuthorArticlePinProjectionPage> ReadAsync(
        AuthorArticlePinProjectionRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthorArticlePinProjectionContract.ValidateRequest(request);
        AuthorArticlePinCollectionSnapshot snapshot;
        try
        {
            snapshot = await pinStore.GetAuthoritySnapshotAsync(request.Owner, cancellationToken)
                .ConfigureAwait(false);
            snapshot = snapshot with
            {
                Pins = [.. snapshot.Pins]
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_collection_unavailable");
        }
        if (!ValidateCollectionSnapshot(request.Owner, snapshot))
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_collection_invalid");
        }

        int[] pinnedArticleIds = snapshot.Pins
            .OrderBy(static pin => pin.OrderKey)
            .ThenBy(static pin => pin.PinId)
            .Select(static pin => pin.ArticleId)
            .ToArray();
        AuthorArticlePinPermissionSnapshot permission;
        try
        {
            permission = await permissionProvider.ResolveAsync(
                new AuthorArticlePinPermissionBatchRequest(request.Owner, request.RequestId, pinnedArticleIds),
                cancellationToken).ConfigureAwait(false);
            permission = permission with
            {
                Decisions = [.. permission.Decisions]
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_permission_authority_unavailable");
        }
        if (permission.Status == AuthorArticlePinPermissionSnapshotStatus.Unavailable)
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_permission_authority_unavailable");
        }
        if (permission.Status == AuthorArticlePinPermissionSnapshotStatus.Stale)
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Stale,
                "permission_projection_stale");
        }
        if (!ValidatePermissionSnapshot(request.Owner, pinnedArticleIds, permission))
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_permission_projection_invalid");
        }

        int[] visibleArticleIds = permission.Decisions
            .Where(static decision => decision.CanProject)
            .Select(static decision => decision.ArticleId)
            .ToArray();
        IReadOnlyList<AuthorArticlePinArticleFact> articleFacts;
        try
        {
            articleFacts = [.. (await articleSource.ReadCurrentBatchAsync(visibleArticleIds, cancellationToken)
                .ConfigureAwait(false))];
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_article_projection_unavailable");
        }
        if (!ValidateArticleFacts(visibleArticleIds, articleFacts))
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_article_projection_invalid");
        }

        string articleProjectionDigest = AuthorArticlePinProjectionContract.ComputeArticleProjectionDigest(articleFacts);
        ProjectionMaterial material = BuildProjectionMaterial(snapshot, permission, articleFacts);
        try
        {
            if (!await reconciliationSink.RecordClosedRemovalsAsync(material.Removals, cancellationToken)
                .ConfigureAwait(false))
            {
                return AuthorArticlePinProjectionPage.Empty(
                    AuthorArticlePinProjectionStatus.Unavailable,
                    "article_pin_reconciliation_unavailable");
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_reconciliation_unavailable");
        }

        CursorResolution cursor = ResolveCursor(
            request,
            snapshot,
            permission,
            articleProjectionDigest,
            material.Items);
        if (cursor.Status == AuthorArticlePinProjectionStatus.InvalidCursor)
        {
            return BuildTerminalPage(
                request,
                snapshot,
                permission,
                articleProjectionDigest,
                AuthorArticlePinProjectionStatus.InvalidCursor,
                [],
                filteredCount: 0,
                nextCursor: null,
                hasMore: false,
                cursor.Reasons,
                cacheReference: string.Empty);
        }
        if (cursor.Status == AuthorArticlePinProjectionStatus.Stale)
        {
            return BuildTerminalPage(
                request,
                snapshot,
                permission,
                articleProjectionDigest,
                AuthorArticlePinProjectionStatus.Stale,
                [],
                filteredCount: 0,
                nextCursor: null,
                hasMore: false,
                cursor.Reasons,
                cacheReference: string.Empty);
        }

        string identity = AuthorArticlePinProjectionContract.ComputeCacheIdentity(
            request.Owner,
            snapshot.Revision,
            snapshot.ContentDigest,
            articleProjectionDigest,
            permission,
            request.Cursor,
            request.Limit);
        string cacheReference;
        AuthorArticlePinProjectionCacheReadResult cached;
        try
        {
            cacheReference = cache.GetReference(identity);
            cached = await cache.TryReadAsync(identity, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return AuthorArticlePinProjectionPage.Empty(
                AuthorArticlePinProjectionStatus.Unavailable,
                "article_pin_projection_cache_unavailable");
        }

        AuthorArticlePinProjectionPage freshPage = BuildCurrentPage(
            snapshot,
            permission,
            articleProjectionDigest,
            material.Items,
            cursor.StartIndex,
            request.Limit,
            cacheReference);
        AuthorArticlePinProjectionPage currentPage;
        switch (cached.Status)
        {
            case AuthorArticlePinProjectionCacheReadStatus.Hit:
                if (cached.Page is null
                    || !string.Equals(cached.CacheReference, cacheReference, StringComparison.Ordinal)
                    || !string.Equals(cached.Page.CacheReference, cacheReference, StringComparison.Ordinal)
                    || !AuthorArticlePinProjectionVerifier.Verify(
                        new AuthorArticlePinProjectionVerificationInput(
                            snapshot,
                            permission,
                            articleFacts,
                            request with
                            {
                                ExpectedCollectionRevision = null,
                                ExpectedArticleProjectionDigest = null,
                                ExpectedPermissionRevision = null,
                                ExpectedSiteRevision = null,
                                ExpectedSessionRevision = null
                            },
                            cached.Page,
                            RequireReceipt: false,
                            ClosedRemovals: material.Removals)).Valid)
                {
                    return AuthorArticlePinProjectionPage.Empty(
                        AuthorArticlePinProjectionStatus.Unavailable,
                        "article_pin_projection_cache_tampered");
                }
                currentPage = cached.Page;
                break;
            case AuthorArticlePinProjectionCacheReadStatus.Miss:
                try
                {
                    if (!await cache.WriteAsync(identity, freshPage, cancellationToken).ConfigureAwait(false))
                    {
                        return AuthorArticlePinProjectionPage.Empty(
                            AuthorArticlePinProjectionStatus.Unavailable,
                            "article_pin_projection_cache_unavailable");
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    return AuthorArticlePinProjectionPage.Empty(
                        AuthorArticlePinProjectionStatus.Unavailable,
                        "article_pin_projection_cache_unavailable");
                }
                currentPage = freshPage;
                break;
            default:
                return AuthorArticlePinProjectionPage.Empty(
                    AuthorArticlePinProjectionStatus.Unavailable,
                    "article_pin_projection_cache_unavailable");
        }

        IReadOnlyList<string> staleReasons = GetExpectedRevisionMismatches(
            request,
            snapshot,
            permission,
            articleProjectionDigest);
        AuthorArticlePinProjectionStatus status = staleReasons.Count == 0
            ? AuthorArticlePinProjectionStatus.Current
            : AuthorArticlePinProjectionStatus.Stale;
        return BuildTerminalPage(
            request,
            snapshot,
            permission,
            articleProjectionDigest,
            status,
            currentPage.Items,
            currentPage.FilteredCount,
            currentPage.NextCursor,
            currentPage.HasMore,
            staleReasons,
            currentPage.CacheReference);
    }

    public async Task<AuthorArticlePinOpenValidationResult> RevalidateOpenAsync(
        AuthorArticlePinOpenValidationRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthorArticlePinProjectionContract.ValidateOpenRequest(request);
        AuthorArticlePinCollectionSnapshot snapshot;
        try
        {
            snapshot = await pinStore.GetAuthoritySnapshotAsync(request.Owner, cancellationToken)
                .ConfigureAwait(false);
            snapshot = snapshot with
            {
                Pins = [.. snapshot.Pins]
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_collection_unavailable");
        }
        if (!ValidateCollectionSnapshot(request.Owner, snapshot))
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_collection_invalid");
        }
        if (snapshot.Revision != request.CollectionRevision
            || !snapshot.Pins.Any(pin => pin.ArticleId == request.ArticleId))
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Stale, "article_pin_open_collection_stale");
        }

        AuthorArticlePinPermissionSnapshot permission;
        try
        {
            permission = await permissionProvider.ResolveAsync(
                new AuthorArticlePinPermissionBatchRequest(request.Owner, request.RequestId, [request.ArticleId]),
                cancellationToken).ConfigureAwait(false);
            permission = permission with
            {
                Decisions = [.. permission.Decisions]
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_permission_authority_unavailable");
        }
        if (permission.Status == AuthorArticlePinPermissionSnapshotStatus.Stale)
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Stale, "article_pin_permission_projection_stale");
        }
        if (permission.Status != AuthorArticlePinPermissionSnapshotStatus.Current
            || !ValidatePermissionSnapshot(request.Owner, [request.ArticleId], permission))
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_permission_authority_unavailable");
        }
        AuthorArticlePinPermissionDecision decision = permission.Decisions[0];
        if (!decision.CanProject || !decision.CanOpen)
        {
            return new AuthorArticlePinOpenValidationResult(
                AuthorArticlePinOpenValidationStatus.Denied,
                string.Empty,
                string.Empty,
                permission.PermissionRevision,
                permission.SiteRevision,
                permission.SessionRevision,
                "article_pin_open_denied");
        }

        IReadOnlyList<AuthorArticlePinArticleFact> facts;
        try
        {
            facts = [.. (await articleSource.ReadCurrentBatchAsync([request.ArticleId], cancellationToken)
                .ConfigureAwait(false))];
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_article_projection_unavailable");
        }
        if (!ValidateArticleFacts([request.ArticleId], facts))
        {
            return OpenResult(AuthorArticlePinOpenValidationStatus.Unavailable, "article_pin_article_projection_invalid");
        }
        AuthorArticlePinArticleFact fact = facts[0];
        if (!fact.Exists || fact.IsDeleted || fact.Status == Entities.ArticleStatus.Deleted)
        {
            return new AuthorArticlePinOpenValidationResult(
                AuthorArticlePinOpenValidationStatus.Denied,
                string.Empty,
                string.Empty,
                permission.PermissionRevision,
                permission.SiteRevision,
                permission.SessionRevision,
                "article_pin_open_denied");
        }

        bool stale = !string.Equals(request.ArticleVersionReference, fact.ArticleVersionReference, StringComparison.Ordinal)
            || !string.Equals(request.RevisionVersionReference, fact.RevisionVersionReference, StringComparison.Ordinal)
            || !string.Equals(request.PermissionRevision, permission.PermissionRevision, StringComparison.Ordinal)
            || !string.Equals(request.PermissionReference, decision.PermissionReference, StringComparison.Ordinal)
            || !string.Equals(request.SiteRevision, permission.SiteRevision, StringComparison.Ordinal)
            || !string.Equals(request.SessionRevision, permission.SessionRevision, StringComparison.Ordinal);
        return new AuthorArticlePinOpenValidationResult(
            stale ? AuthorArticlePinOpenValidationStatus.Stale : AuthorArticlePinOpenValidationStatus.Current,
            fact.ArticleVersionReference,
            fact.RevisionVersionReference,
            permission.PermissionRevision,
            permission.SiteRevision,
            permission.SessionRevision,
            stale ? "article_pin_open_projection_stale" : "current");
    }

    private static bool ValidateCollectionSnapshot(
        AuthorArticlePinOwner owner,
        AuthorArticlePinCollectionSnapshot snapshot)
    {
        try
        {
            if (snapshot.Owner != owner
                || snapshot.SchemaVersion != AuthorArticlePinContract.SchemaVersion
                || snapshot.ItemCount != snapshot.Pins.Count
                || snapshot.Pins.Count > AuthorArticlePinContract.MaxPinsPerOwner
                || snapshot.Pins.Select(static pin => pin.PinId).Distinct().Count() != snapshot.Pins.Count
                || snapshot.Pins.Select(static pin => pin.ArticleId).Distinct().Count() != snapshot.Pins.Count
                || snapshot.Pins.Select(static pin => pin.OrderKey).Distinct().Count() != snapshot.Pins.Count)
            {
                return false;
            }
            foreach (AuthorArticlePin pin in snapshot.Pins)
            {
                if (!string.Equals(
                        pin.ContentDigest,
                        AuthorArticlePinContract.ComputePinDigest(
                            owner,
                            pin.PinId,
                            pin.ArticleId,
                            pin.OrderKey,
                            pin.CreatedRevision,
                            pin.UpdatedRevision),
                        StringComparison.Ordinal))
                {
                    return false;
                }
            }
            return string.Equals(
                snapshot.ContentDigest,
                AuthorArticlePinContract.ComputeCollectionDigest(owner, snapshot.Revision, snapshot.Pins),
                StringComparison.Ordinal);
        }
        catch (AuthorArticlePinValidationException)
        {
            return false;
        }
    }

    private static bool ValidatePermissionSnapshot(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> requestedArticleIds,
        AuthorArticlePinPermissionSnapshot permission)
    {
        if (permission.Owner != owner
            || permission.Status != AuthorArticlePinPermissionSnapshotStatus.Current
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(permission.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(permission.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(permission.SessionRevision)
            || permission.Decisions.Count != requestedArticleIds.Count
            || permission.Decisions.Select(static decision => decision.ArticleId).Distinct().Count() != permission.Decisions.Count
            || !permission.Decisions.Select(static decision => decision.ArticleId).Order().SequenceEqual(requestedArticleIds.Order())
            || permission.Decisions.Any(static decision => decision.ArticleId <= 0
                || (decision.CanOpen && !decision.CanProject)
                || (decision.CanProject
                    && !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))))
        {
            return false;
        }
        return string.Equals(
            permission.ContentDigest,
            AuthorArticlePinProjectionContract.ComputePermissionDigest(permission),
            StringComparison.Ordinal);
    }

    private static bool ValidateArticleFacts(
        IReadOnlyList<int> requestedArticleIds,
        IReadOnlyList<AuthorArticlePinArticleFact> facts)
    {
        if (facts.Count != requestedArticleIds.Count
            || facts.Select(static fact => fact.ArticleId).Distinct().Count() != facts.Count
            || !facts.Select(static fact => fact.ArticleId).Order().SequenceEqual(requestedArticleIds.Order()))
        {
            return false;
        }
        foreach (AuthorArticlePinArticleFact fact in facts)
        {
            if (!Enum.IsDefined(fact.Status)
                || !string.Equals(
                    fact.ContentDigest,
                    AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact),
                    StringComparison.Ordinal))
            {
                return false;
            }
            if (!fact.Exists)
            {
                if (!fact.IsDeleted
                    || fact.CurrentRevisionId != 0
                    || fact.RevisionNo != 0
                    || fact.Title.Length != 0
                    || fact.ArticleVersionReference.Length != 0
                    || fact.RevisionVersionReference.Length != 0)
                {
                    return false;
                }
                continue;
            }
            if (!fact.IsDeleted && fact.Status != Entities.ArticleStatus.Deleted
                && (fact.CurrentRevisionId <= 0
                    || fact.RevisionNo <= 0
                    || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.ArticleVersionReference)
                    || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.RevisionVersionReference)))
            {
                return false;
            }
        }
        return true;
    }

    private static ProjectionMaterial BuildProjectionMaterial(
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        IReadOnlyList<AuthorArticlePinArticleFact> articleFacts)
    {
        Dictionary<int, AuthorArticlePinPermissionDecision> permissions = permission.Decisions
            .ToDictionary(static decision => decision.ArticleId);
        Dictionary<int, AuthorArticlePinArticleFact> facts = articleFacts
            .ToDictionary(static fact => fact.ArticleId);
        var items = new List<AuthorArticlePinProjectionItem>();
        var removals = new List<AuthorArticlePinClosedRemovalObligation>();
        foreach (AuthorArticlePin pin in snapshot.Pins
            .OrderBy(static pin => pin.OrderKey)
            .ThenBy(static pin => pin.PinId))
        {
            if (!permissions[pin.ArticleId].CanProject)
            {
                continue;
            }
            AuthorArticlePinArticleFact fact = facts[pin.ArticleId];
            if (!fact.Exists || fact.IsDeleted || fact.Status == Entities.ArticleStatus.Deleted)
            {
                string reason = fact.Exists ? "article-deleted" : "article-missing";
                removals.Add(new AuthorArticlePinClosedRemovalObligation(
                    snapshot.Owner,
                    snapshot.Revision,
                    pin.PinId,
                    pin.ArticleId,
                    reason,
                    AuthorArticlePinProjectionContract.ComputeClosedRemovalDigest(
                        snapshot.Owner,
                        snapshot.Revision,
                        pin.PinId,
                        pin.ArticleId,
                        reason)));
                continue;
            }
            AuthorArticlePinPermissionDecision decision = permissions[pin.ArticleId];
            var item = new AuthorArticlePinProjectionItem(
                pin.PinId,
                pin.ArticleId,
                AuthorArticlePinProjectionContract.ComputeOrderReference(snapshot.Owner, pin),
                fact.Title,
                fact.Status,
                fact.CurrentRevisionId,
                fact.RevisionNo,
                fact.ArticleVersionReference,
                fact.RevisionVersionReference,
                decision.PermissionReference,
                decision.CanOpen,
                string.Empty);
            items.Add(item with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputeItemDigest(item)
            });
        }
        return new ProjectionMaterial(items, removals);
    }

    private static CursorResolution ResolveCursor(
        AuthorArticlePinProjectionRequest request,
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        IReadOnlyList<AuthorArticlePinProjectionItem> items)
    {
        if (request.Cursor is null)
        {
            return new CursorResolution(AuthorArticlePinProjectionStatus.Current, 0, []);
        }
        if (!AuthorArticlePinProjectionCursorCodec.TryDecode(request.Cursor, out AuthorArticlePinProjectionCursor? cursor)
            || cursor is null
            || cursor.SchemaVersion != AuthorArticlePinProjectionContract.SchemaVersion
            || !string.Equals(cursor.OwnerDigest, OwnerDigest(request.Owner), StringComparison.Ordinal)
            || !string.Equals(
                cursor.ContentDigest,
                AuthorArticlePinProjectionCursorCodec.ComputeContentDigest(cursor),
                StringComparison.Ordinal))
        {
            return new CursorResolution(
                AuthorArticlePinProjectionStatus.InvalidCursor,
                0,
                ["article_pin_projection_cursor_invalid"]);
        }

        var staleReasons = new List<string>();
        AddMismatch(staleReasons, cursor.CollectionRevision == snapshot.Revision, "cursor_collection_revision_stale");
        AddMismatch(staleReasons, string.Equals(cursor.CollectionDigest, snapshot.ContentDigest, StringComparison.Ordinal), "cursor_collection_digest_stale");
        AddMismatch(staleReasons, string.Equals(cursor.ArticleProjectionDigest, articleProjectionDigest, StringComparison.Ordinal), "cursor_article_projection_stale");
        AddMismatch(staleReasons, string.Equals(cursor.PermissionRevision, permission.PermissionRevision, StringComparison.Ordinal), "cursor_permission_revision_stale");
        AddMismatch(staleReasons, string.Equals(cursor.PermissionDigest, permission.ContentDigest, StringComparison.Ordinal), "cursor_permission_digest_stale");
        AddMismatch(staleReasons, string.Equals(cursor.SiteRevision, permission.SiteRevision, StringComparison.Ordinal), "cursor_site_revision_stale");
        AddMismatch(staleReasons, string.Equals(cursor.SessionRevision, permission.SessionRevision, StringComparison.Ordinal), "cursor_session_revision_stale");
        if (staleReasons.Count != 0)
        {
            return new CursorResolution(AuthorArticlePinProjectionStatus.Stale, 0, staleReasons);
        }

        int anchor = items.ToList().FindIndex(item => item.PinId == cursor.LastPinId);
        return anchor < 0
            ? new CursorResolution(
                AuthorArticlePinProjectionStatus.Stale,
                0,
                ["cursor_anchor_stale"])
            : new CursorResolution(AuthorArticlePinProjectionStatus.Current, anchor + 1, []);
    }

    private static AuthorArticlePinProjectionPage BuildCurrentPage(
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        IReadOnlyList<AuthorArticlePinProjectionItem> allItems,
        int startIndex,
        int limit,
        string cacheReference)
    {
        AuthorArticlePinProjectionItem[] items = [.. allItems.Skip(startIndex).Take(limit)];
        bool hasMore = startIndex + items.Length < allItems.Count;
        string? nextCursor = hasMore && items.Length != 0
            ? CreateCursor(snapshot, permission, articleProjectionDigest, items[^1].PinId)
            : null;
        var page = new AuthorArticlePinProjectionPage(
            AuthorArticlePinProjectionStatus.Current,
            AuthorArticlePinProjectionContract.SchemaVersion,
            snapshot.Revision,
            snapshot.ContentDigest,
            articleProjectionDigest,
            permission.PermissionRevision,
            permission.SiteRevision,
            permission.SessionRevision,
            allItems.Count,
            items,
            nextCursor,
            hasMore,
            [],
            cacheReference,
            string.Empty,
            null);
        return page with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePageDigest(page)
        };
    }

    private AuthorArticlePinProjectionPage BuildTerminalPage(
        AuthorArticlePinProjectionRequest request,
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        AuthorArticlePinProjectionStatus status,
        IReadOnlyList<AuthorArticlePinProjectionItem> items,
        int filteredCount,
        string? nextCursor,
        bool hasMore,
        IReadOnlyList<string> staleReasons,
        string cacheReference)
    {
        var page = new AuthorArticlePinProjectionPage(
            status,
            AuthorArticlePinProjectionContract.SchemaVersion,
            snapshot.Revision,
            snapshot.ContentDigest,
            articleProjectionDigest,
            permission.PermissionRevision,
            permission.SiteRevision,
            permission.SessionRevision,
            filteredCount,
            items,
            nextCursor,
            hasMore,
            staleReasons,
            cacheReference,
            string.Empty,
            null);
        page = page with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePageDigest(page)
        };
        AuthorArticlePinProjectionReceipt receipt = CreateReceipt(request, page);
        return page with
        {
            Receipt = receipt
        };
    }

    private AuthorArticlePinProjectionReceipt CreateReceipt(
        AuthorArticlePinProjectionRequest request,
        AuthorArticlePinProjectionPage page)
    {
        var receipt = new AuthorArticlePinProjectionReceipt(
            AuthorArticlePinProjectionContract.CreateReceiptId(request.RequestId, page.ContentDigest),
            request.RequestId,
            request.Owner,
            page.CollectionRevision,
            page.CollectionDigest,
            page.ArticleProjectionDigest,
            page.PermissionRevision,
            page.SiteRevision,
            page.SessionRevision,
            page.Status,
            page.FilteredCount,
            page.Items.Count,
            [.. page.Items.Select(static item => item.ArticleId)],
            [.. page.Items.Select(static item => item.OrderReference)],
            [.. page.Items.Select(static item => item.ArticleVersionReference)],
            [.. page.Items.Select(static item => item.PermissionReference)],
            [.. page.Items.Select(static item => item.Status)],
            [.. page.Items.Select(static item => item.ContentDigest)],
            AuthorArticlePinProjectionContract.HashText(request.Cursor ?? string.Empty),
            AuthorArticlePinProjectionContract.HashText(page.NextCursor ?? string.Empty),
            page.CacheReference,
            page.ContentDigest,
            timeProvider.GetUtcNow().UtcDateTime,
            string.Empty);
        return receipt with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputeReceiptDigest(receipt)
        };
    }

    private static IReadOnlyList<string> GetExpectedRevisionMismatches(
        AuthorArticlePinProjectionRequest request,
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest)
    {
        var reasons = new List<string>();
        AddMismatch(reasons, !request.ExpectedCollectionRevision.HasValue
            || request.ExpectedCollectionRevision.Value == snapshot.Revision, "collection_revision_stale");
        AddMismatch(reasons, request.ExpectedArticleProjectionDigest is null
            || string.Equals(request.ExpectedArticleProjectionDigest, articleProjectionDigest, StringComparison.Ordinal), "article_projection_stale");
        AddMismatch(reasons, request.ExpectedPermissionRevision is null
            || string.Equals(request.ExpectedPermissionRevision, permission.PermissionRevision, StringComparison.Ordinal), "permission_revision_stale");
        AddMismatch(reasons, request.ExpectedSiteRevision is null
            || string.Equals(request.ExpectedSiteRevision, permission.SiteRevision, StringComparison.Ordinal), "site_revision_stale");
        AddMismatch(reasons, request.ExpectedSessionRevision is null
            || string.Equals(request.ExpectedSessionRevision, permission.SessionRevision, StringComparison.Ordinal), "session_revision_stale");
        return reasons;
    }

    private static void AddMismatch(List<string> reasons, bool matches, string reason)
    {
        if (!matches)
        {
            reasons.Add(reason);
        }
    }

    private static string CreateCursor(
        AuthorArticlePinCollectionSnapshot snapshot,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        Guid lastPinId)
    {
        var cursor = new AuthorArticlePinProjectionCursor(
            AuthorArticlePinProjectionContract.SchemaVersion,
            OwnerDigest(snapshot.Owner),
            snapshot.Revision,
            snapshot.ContentDigest,
            articleProjectionDigest,
            permission.PermissionRevision,
            permission.ContentDigest,
            permission.SiteRevision,
            permission.SessionRevision,
            lastPinId,
            string.Empty);
        return AuthorArticlePinProjectionCursorCodec.Encode(cursor with
        {
            ContentDigest = AuthorArticlePinProjectionCursorCodec.ComputeContentDigest(cursor)
        });
    }

    private static string OwnerDigest(AuthorArticlePinOwner owner)
        => AuthorArticlePinProjectionContract.HashText($"{owner.AdminPrincipalId}:{owner.SiteScope}");

    private static AuthorArticlePinOpenValidationResult OpenResult(
        AuthorArticlePinOpenValidationStatus status,
        string reason)
        => new(status, string.Empty, string.Empty, string.Empty, string.Empty, string.Empty, reason);

    private sealed record ProjectionMaterial(
        IReadOnlyList<AuthorArticlePinProjectionItem> Items,
        IReadOnlyList<AuthorArticlePinClosedRemovalObligation> Removals);

    private sealed record CursorResolution(
        AuthorArticlePinProjectionStatus Status,
        int StartIndex,
        IReadOnlyList<string> Reasons);
}

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthorArticlePinProjectionVerificationInput(
    AuthorArticlePinCollectionSnapshot Collection,
    AuthorArticlePinPermissionSnapshot Permission,
    IReadOnlyList<AuthorArticlePinArticleFact> ArticleFacts,
    AuthorArticlePinProjectionRequest Request,
    AuthorArticlePinProjectionPage Page,
    bool RequireReceipt = true,
    IReadOnlyList<AuthorArticlePinClosedRemovalObligation>? ClosedRemovals = null);

/// <summary>
/// Independent, read-only reconstruction of filter, order, lifecycle, pagination and receipts.
/// It does not consume cached service intermediates.
/// </summary>
public static class AuthorArticlePinProjectionVerifier
{
    public static AuthorArticlePinProjectionVerificationResult Verify(
        AuthorArticlePinProjectionVerificationInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var reasons = new List<string>();
        try
        {
            AuthorArticlePinProjectionContract.ValidateRequest(input.Request);
        }
        catch (AuthorArticlePinProjectionValidationException)
        {
            reasons.Add("projection_request_invalid");
            return Result(reasons);
        }
        string articleProjectionDigest = AuthorArticlePinProjectionContract.ComputeArticleProjectionDigest(
            input.ArticleFacts);
        if (input.Collection.Owner != input.Request.Owner
            || input.Permission.Owner != input.Request.Owner)
        {
            reasons.Add("projection_owner_mismatch");
        }
        if (input.Collection.SchemaVersion != AuthorArticlePinContract.SchemaVersion
            || input.Collection.ItemCount != input.Collection.Pins.Count
            || input.Collection.Pins.Count > AuthorArticlePinContract.MaxPinsPerOwner
            || input.Collection.Pins.Select(static pin => pin.PinId).Distinct().Count() != input.Collection.Pins.Count
            || input.Collection.Pins.Select(static pin => pin.ArticleId).Distinct().Count() != input.Collection.Pins.Count
            || input.Collection.Pins.Select(static pin => pin.OrderKey).Distinct().Count() != input.Collection.Pins.Count)
        {
            reasons.Add("projection_collection_shape_invalid");
        }
        foreach (AuthorArticlePin pin in input.Collection.Pins)
        {
            try
            {
                if (!string.Equals(
                    pin.ContentDigest,
                    AuthorArticlePinContract.ComputePinDigest(
                        input.Collection.Owner,
                        pin.PinId,
                        pin.ArticleId,
                        pin.OrderKey,
                        pin.CreatedRevision,
                        pin.UpdatedRevision),
                    StringComparison.Ordinal))
                {
                    reasons.Add($"projection_pin_digest_mismatch:{pin.PinId:D}");
                }
            }
            catch (AuthorArticlePinValidationException)
            {
                reasons.Add($"projection_pin_shape_invalid:{pin.PinId:D}");
            }
        }
        string? expectedCollectionDigest = null;
        try
        {
            expectedCollectionDigest = AuthorArticlePinContract.ComputeCollectionDigest(
                input.Collection.Owner,
                input.Collection.Revision,
                input.Collection.Pins);
        }
        catch (AuthorArticlePinValidationException)
        {
            reasons.Add("projection_collection_shape_invalid");
        }
        if (expectedCollectionDigest is not null
            && !string.Equals(
                input.Collection.ContentDigest,
                expectedCollectionDigest,
                StringComparison.Ordinal))
        {
            reasons.Add("projection_collection_digest_mismatch");
        }
        if (!string.Equals(
                input.Permission.ContentDigest,
                AuthorArticlePinProjectionContract.ComputePermissionDigest(input.Permission),
                StringComparison.Ordinal))
        {
            reasons.Add("projection_permission_digest_mismatch");
        }
        if (input.Permission.Status != AuthorArticlePinPermissionSnapshotStatus.Current
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(input.Permission.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(input.Permission.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(input.Permission.SessionRevision)
            || input.Permission.Decisions.Count != input.Collection.Pins.Count
            || !input.Permission.Decisions.Select(static decision => decision.ArticleId).Order()
                .SequenceEqual(input.Collection.Pins.Select(static pin => pin.ArticleId).Order())
            || input.Permission.Decisions.Any(static decision => decision.ArticleId <= 0
                || (decision.CanOpen && !decision.CanProject)
                || (decision.CanProject
                    && !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))))
        {
            reasons.Add("projection_permission_scope_mismatch");
        }
        foreach (AuthorArticlePinArticleFact fact in input.ArticleFacts)
        {
            if (!Enum.IsDefined(fact.Status)
                || !ArticleFactShapeValid(fact))
            {
                reasons.Add($"projection_article_shape_invalid:{fact.ArticleId}");
            }
            if (!string.Equals(
                    fact.ContentDigest,
                    AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact),
                    StringComparison.Ordinal))
            {
                reasons.Add($"projection_article_digest_mismatch:{fact.ArticleId}");
            }
        }

        Dictionary<int, AuthorArticlePinPermissionDecision> permissions;
        Dictionary<int, AuthorArticlePinArticleFact> facts;
        try
        {
            permissions = input.Permission.Decisions.ToDictionary(static decision => decision.ArticleId);
            facts = input.ArticleFacts.ToDictionary(static fact => fact.ArticleId);
        }
        catch (ArgumentException)
        {
            reasons.Add("projection_duplicate_identity");
            return Result(reasons);
        }
        int[] permittedIds = permissions.Values
            .Where(static decision => decision.CanProject)
            .Select(static decision => decision.ArticleId)
            .Order()
            .ToArray();
        if (!facts.Keys.Order().SequenceEqual(permittedIds))
        {
            reasons.Add("projection_article_batch_scope_mismatch");
        }

        var allItems = new List<AuthorArticlePinProjectionItem>();
        var removals = new List<AuthorArticlePinClosedRemovalObligation>();
        foreach (AuthorArticlePin pin in input.Collection.Pins
            .OrderBy(static pin => pin.OrderKey)
            .ThenBy(static pin => pin.PinId))
        {
            if (!permissions.TryGetValue(pin.ArticleId, out AuthorArticlePinPermissionDecision? permission)
                || !permission.CanProject)
            {
                continue;
            }
            if (!facts.TryGetValue(pin.ArticleId, out AuthorArticlePinArticleFact? fact))
            {
                continue;
            }
            if (!fact.Exists || fact.IsDeleted || fact.Status == Entities.ArticleStatus.Deleted)
            {
                string reason = fact.Exists ? "article-deleted" : "article-missing";
                removals.Add(new AuthorArticlePinClosedRemovalObligation(
                    input.Collection.Owner,
                    input.Collection.Revision,
                    pin.PinId,
                    pin.ArticleId,
                    reason,
                    AuthorArticlePinProjectionContract.ComputeClosedRemovalDigest(
                        input.Collection.Owner,
                        input.Collection.Revision,
                        pin.PinId,
                        pin.ArticleId,
                        reason)));
                continue;
            }
            var item = new AuthorArticlePinProjectionItem(
                pin.PinId,
                pin.ArticleId,
                AuthorArticlePinProjectionContract.ComputeOrderReference(input.Collection.Owner, pin),
                fact.Title,
                fact.Status,
                fact.CurrentRevisionId,
                fact.RevisionNo,
                fact.ArticleVersionReference,
                fact.RevisionVersionReference,
                permission.PermissionReference,
                permission.CanOpen,
                string.Empty);
            allItems.Add(item with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputeItemDigest(item)
            });
        }
        if (input.ClosedRemovals is not null
            && !input.ClosedRemovals.SequenceEqual(removals))
        {
            reasons.Add("projection_reconciliation_mismatch");
        }

        ExpectedWindow window = ResolveWindow(input, articleProjectionDigest, allItems);
        AuthorArticlePinProjectionItem[] expectedItems = window.EmitItems
            ? [.. allItems.Skip(window.StartIndex).Take(input.Request.Limit)]
            : [];
        bool expectedHasMore = window.EmitItems
            && window.StartIndex + expectedItems.Length < allItems.Count;
        string? expectedNextCursor = expectedHasMore && expectedItems.Length != 0
            ? CreateCursor(input.Collection, input.Permission, articleProjectionDigest, expectedItems[^1].PinId)
            : null;
        int expectedFilteredCount = window.EmitItems ? allItems.Count : 0;

        ComparePageShape(
            input.Page,
            window.Status,
            input.Collection,
            input.Permission,
            articleProjectionDigest,
            expectedFilteredCount,
            expectedItems,
            expectedNextCursor,
            expectedHasMore,
            window.Reasons,
            reasons);
        if (!string.Equals(
                input.Page.ContentDigest,
                AuthorArticlePinProjectionContract.ComputePageDigest(input.Page),
                StringComparison.Ordinal))
        {
            reasons.Add("projection_page_digest_mismatch");
        }

        if (input.RequireReceipt)
        {
            VerifyReceipt(input.Request, input.Page, reasons);
        }
        else if (input.Page.Receipt is not null)
        {
            reasons.Add("projection_cached_receipt_present");
        }
        return Result(reasons);
    }

    private static ExpectedWindow ResolveWindow(
        AuthorArticlePinProjectionVerificationInput input,
        string articleProjectionDigest,
        IReadOnlyList<AuthorArticlePinProjectionItem> allItems)
    {
        if (input.Request.Cursor is not null)
        {
            if (!AuthorArticlePinProjectionCursorCodec.TryDecode(
                    input.Request.Cursor,
                    out AuthorArticlePinProjectionCursor? cursor)
                || cursor is null
                || cursor.SchemaVersion != AuthorArticlePinProjectionContract.SchemaVersion
                || !string.Equals(cursor.OwnerDigest, OwnerDigest(input.Request.Owner), StringComparison.Ordinal)
                || !string.Equals(
                    cursor.ContentDigest,
                    AuthorArticlePinProjectionCursorCodec.ComputeContentDigest(cursor),
                    StringComparison.Ordinal))
            {
                return new ExpectedWindow(
                    AuthorArticlePinProjectionStatus.InvalidCursor,
                    0,
                    EmitItems: false,
                    ["article_pin_projection_cursor_invalid"]);
            }
            var cursorStale = new List<string>();
            AddMismatch(cursorStale, cursor.CollectionRevision == input.Collection.Revision, "cursor_collection_revision_stale");
            AddMismatch(cursorStale, string.Equals(cursor.CollectionDigest, input.Collection.ContentDigest, StringComparison.Ordinal), "cursor_collection_digest_stale");
            AddMismatch(cursorStale, string.Equals(cursor.ArticleProjectionDigest, articleProjectionDigest, StringComparison.Ordinal), "cursor_article_projection_stale");
            AddMismatch(cursorStale, string.Equals(cursor.PermissionRevision, input.Permission.PermissionRevision, StringComparison.Ordinal), "cursor_permission_revision_stale");
            AddMismatch(cursorStale, string.Equals(cursor.PermissionDigest, input.Permission.ContentDigest, StringComparison.Ordinal), "cursor_permission_digest_stale");
            AddMismatch(cursorStale, string.Equals(cursor.SiteRevision, input.Permission.SiteRevision, StringComparison.Ordinal), "cursor_site_revision_stale");
            AddMismatch(cursorStale, string.Equals(cursor.SessionRevision, input.Permission.SessionRevision, StringComparison.Ordinal), "cursor_session_revision_stale");
            if (cursorStale.Count != 0)
            {
                return new ExpectedWindow(AuthorArticlePinProjectionStatus.Stale, 0, EmitItems: false, cursorStale);
            }
            int anchor = allItems.ToList().FindIndex(item => item.PinId == cursor.LastPinId);
            if (anchor < 0)
            {
                return new ExpectedWindow(
                    AuthorArticlePinProjectionStatus.Stale,
                    0,
                    EmitItems: false,
                    ["cursor_anchor_stale"]);
            }
            return WithExpectedRevisions(input, articleProjectionDigest, anchor + 1);
        }
        return WithExpectedRevisions(input, articleProjectionDigest, 0);
    }

    private static ExpectedWindow WithExpectedRevisions(
        AuthorArticlePinProjectionVerificationInput input,
        string articleProjectionDigest,
        int startIndex)
    {
        var stale = new List<string>();
        AddMismatch(stale, !input.Request.ExpectedCollectionRevision.HasValue
            || input.Request.ExpectedCollectionRevision.Value == input.Collection.Revision, "collection_revision_stale");
        AddMismatch(stale, input.Request.ExpectedArticleProjectionDigest is null
            || string.Equals(input.Request.ExpectedArticleProjectionDigest, articleProjectionDigest, StringComparison.Ordinal), "article_projection_stale");
        AddMismatch(stale, input.Request.ExpectedPermissionRevision is null
            || string.Equals(input.Request.ExpectedPermissionRevision, input.Permission.PermissionRevision, StringComparison.Ordinal), "permission_revision_stale");
        AddMismatch(stale, input.Request.ExpectedSiteRevision is null
            || string.Equals(input.Request.ExpectedSiteRevision, input.Permission.SiteRevision, StringComparison.Ordinal), "site_revision_stale");
        AddMismatch(stale, input.Request.ExpectedSessionRevision is null
            || string.Equals(input.Request.ExpectedSessionRevision, input.Permission.SessionRevision, StringComparison.Ordinal), "session_revision_stale");
        return new ExpectedWindow(
            stale.Count == 0 ? AuthorArticlePinProjectionStatus.Current : AuthorArticlePinProjectionStatus.Stale,
            startIndex,
            EmitItems: true,
            stale);
    }

    private static void ComparePageShape(
        AuthorArticlePinProjectionPage page,
        AuthorArticlePinProjectionStatus status,
        AuthorArticlePinCollectionSnapshot collection,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        int filteredCount,
        IReadOnlyList<AuthorArticlePinProjectionItem> items,
        string? nextCursor,
        bool hasMore,
        IReadOnlyList<string> staleReasons,
        List<string> reasons)
    {
        if (page.Status != status
            || page.SchemaVersion != AuthorArticlePinProjectionContract.SchemaVersion
            || page.CollectionRevision != collection.Revision
            || !string.Equals(page.CollectionDigest, collection.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(page.ArticleProjectionDigest, articleProjectionDigest, StringComparison.Ordinal)
            || !string.Equals(page.PermissionRevision, permission.PermissionRevision, StringComparison.Ordinal)
            || !string.Equals(page.SiteRevision, permission.SiteRevision, StringComparison.Ordinal)
            || !string.Equals(page.SessionRevision, permission.SessionRevision, StringComparison.Ordinal)
            || page.FilteredCount != filteredCount
            || page.HasMore != hasMore
            || !string.Equals(page.NextCursor, nextCursor, StringComparison.Ordinal)
            || !page.StaleReasons.SequenceEqual(staleReasons))
        {
            reasons.Add("projection_page_shape_mismatch");
        }
        if (page.Items.Count != items.Count)
        {
            reasons.Add("projection_page_count_mismatch");
            return;
        }
        for (int index = 0; index < items.Count; index++)
        {
            if (page.Items[index] != items[index])
            {
                reasons.Add($"projection_item_mismatch:{index}");
            }
            if (!string.Equals(
                    page.Items[index].ContentDigest,
                    AuthorArticlePinProjectionContract.ComputeItemDigest(page.Items[index]),
                    StringComparison.Ordinal))
            {
                reasons.Add($"projection_item_digest_mismatch:{index}");
            }
        }
    }

    private static void VerifyReceipt(
        AuthorArticlePinProjectionRequest request,
        AuthorArticlePinProjectionPage page,
        List<string> reasons)
    {
        AuthorArticlePinProjectionReceipt? receipt = page.Receipt;
        if (receipt is null)
        {
            reasons.Add("projection_receipt_missing");
            return;
        }
        if (receipt.ReceiptId != AuthorArticlePinProjectionContract.CreateReceiptId(request.RequestId, page.ContentDigest)
            || receipt.RequestId != request.RequestId
            || receipt.Owner != request.Owner
            || receipt.CollectionRevision != page.CollectionRevision
            || !string.Equals(receipt.CollectionDigest, page.CollectionDigest, StringComparison.Ordinal)
            || !string.Equals(receipt.ArticleProjectionDigest, page.ArticleProjectionDigest, StringComparison.Ordinal)
            || !string.Equals(receipt.PermissionRevision, page.PermissionRevision, StringComparison.Ordinal)
            || !string.Equals(receipt.SiteRevision, page.SiteRevision, StringComparison.Ordinal)
            || !string.Equals(receipt.SessionRevision, page.SessionRevision, StringComparison.Ordinal)
            || receipt.Status != page.Status
            || receipt.ResultCount != page.FilteredCount
            || receipt.PageCount != page.Items.Count
            || !receipt.ResultArticleIds.SequenceEqual(page.Items.Select(static item => item.ArticleId))
            || !receipt.ResultOrderReferences.SequenceEqual(page.Items.Select(static item => item.OrderReference))
            || !receipt.ResultArticleVersionReferences.SequenceEqual(page.Items.Select(static item => item.ArticleVersionReference))
            || !receipt.ResultPermissionReferences.SequenceEqual(page.Items.Select(static item => item.PermissionReference))
            || !receipt.ResultStatuses.SequenceEqual(page.Items.Select(static item => item.Status))
            || !receipt.ResultItemDigests.SequenceEqual(page.Items.Select(static item => item.ContentDigest))
            || receipt.CreatedAtUtc.Kind != DateTimeKind.Utc
            || !string.Equals(receipt.InputCursorDigest, AuthorArticlePinProjectionContract.HashText(request.Cursor ?? string.Empty), StringComparison.Ordinal)
            || !string.Equals(receipt.NextCursorDigest, AuthorArticlePinProjectionContract.HashText(page.NextCursor ?? string.Empty), StringComparison.Ordinal)
            || !string.Equals(receipt.CacheReference, page.CacheReference, StringComparison.Ordinal)
            || !string.Equals(receipt.ResultContentDigest, page.ContentDigest, StringComparison.Ordinal))
        {
            reasons.Add("projection_receipt_shape_mismatch");
        }
        if (!string.Equals(
                receipt.ContentDigest,
                AuthorArticlePinProjectionContract.ComputeReceiptDigest(receipt),
                StringComparison.Ordinal))
        {
            reasons.Add("projection_receipt_digest_mismatch");
        }
    }

    private static string CreateCursor(
        AuthorArticlePinCollectionSnapshot collection,
        AuthorArticlePinPermissionSnapshot permission,
        string articleProjectionDigest,
        Guid lastPinId)
    {
        var cursor = new AuthorArticlePinProjectionCursor(
            AuthorArticlePinProjectionContract.SchemaVersion,
            OwnerDigest(collection.Owner),
            collection.Revision,
            collection.ContentDigest,
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

    private static bool ArticleFactShapeValid(AuthorArticlePinArticleFact fact)
    {
        if (!fact.Exists)
        {
            return fact.IsDeleted
                && fact.CurrentRevisionId == 0
                && fact.RevisionNo == 0
                && fact.Title.Length == 0
                && fact.ArticleVersionReference.Length == 0
                && fact.RevisionVersionReference.Length == 0;
        }
        return fact.IsDeleted
            || fact.Status == Entities.ArticleStatus.Deleted
            || (fact.CurrentRevisionId > 0
                && fact.RevisionNo > 0
                && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.ArticleVersionReference)
                && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.RevisionVersionReference));
    }

    private static void AddMismatch(List<string> reasons, bool matches, string reason)
    {
        if (!matches)
        {
            reasons.Add(reason);
        }
    }

    private static AuthorArticlePinProjectionVerificationResult Result(IReadOnlyList<string> reasons)
        => new(
            reasons.Count == 0,
            reasons,
            AuthorArticlePinProjectionContract.HashText(string.Join('|', reasons)));

    private sealed record ExpectedWindow(
        AuthorArticlePinProjectionStatus Status,
        int StartIndex,
        bool EmitItems,
        IReadOnlyList<string> Reasons);
}

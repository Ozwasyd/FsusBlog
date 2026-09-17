namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independently verifies a canvas reference resolution against fresh authority facts.
/// It does not call the resolver or consume its projection cache.
/// </summary>
public sealed class AuthoringCanvasReferenceVerifier(
    IAuthoringCanvasDocumentStore canvasStore,
    IAuthoringCanvasReferenceFactSource factSource)
{
    public async Task<AuthoringCanvasReferenceVerificationResult> VerifyAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceResolutionBatch candidate,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasReferenceContract.ValidateRequest(request);
        ArgumentNullException.ThrowIfNull(candidate);
        cancellationToken.ThrowIfCancellationRequested();

        await EnsureCurrentCanvasCoordinateAsync(request, cancellationToken).ConfigureAwait(false);

        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await factSource.ReadAuthorityCoordinateAsync(
            request.Owner,
            request.Permission,
            cancellationToken).ConfigureAwait(false);
        AuthoringCanvasReferenceContract.ValidateAuthorityCoordinate(coordinate);
        AuthoringCanvasReferenceTarget[] targets = request.Nodes.Select(ToTarget).ToArray();
        IReadOnlyList<AuthoringCanvasReferenceFact> loaded = targets.Length == 0
            ? []
            : await factSource.ReadBatchAsync(
                new AuthoringCanvasReferenceFactQuery(
                    request.CanvasId,
                    request.CanvasRevision,
                    request.CanvasContentDigest,
                    request.Owner,
                    request.Permission,
                    coordinate,
                    targets),
                cancellationToken).ConfigureAwait(false);
        Dictionary<Guid, AuthoringCanvasReferenceFact> facts = ExactFacts(targets, loaded);
        await EnsureCurrentCanvasCoordinateAsync(request, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringCanvasReferenceProjection[] expected = targets
            .Select(target => Project(target, facts[target.NodeId], request.TargetWorkspaceGroupId))
            .ToArray();
        string expectedBatchDigest = AuthoringCanvasReferenceContract.ComputeBatchDigest(
            request,
            coordinate,
            expected);

        var reasons = new List<string>();
        ValidateBatchCoordinate(request, candidate, reasons);
        if (candidate.AuthorityCoordinate != coordinate)
        {
            reasons.Add("authority_coordinate_mismatch");
        }
        ValidateProjections(candidate.Projections, expected, reasons);
        if (!string.Equals(candidate.ContentDigest, expectedBatchDigest, StringComparison.Ordinal)
            || !string.Equals(
                candidate.ContentDigest,
                AuthoringCanvasReferenceContract.ComputeBatchDigest(
                    request,
                    candidate.AuthorityCoordinate,
                    candidate.Projections),
                StringComparison.Ordinal))
        {
            reasons.Add("batch_digest_mismatch");
        }
        ValidateReceipt(request, coordinate, candidate, expected, reasons);

        return new AuthoringCanvasReferenceVerificationResult(
            request.CanvasId,
            request.CanvasRevision,
            expected.Length,
            expectedBatchDigest,
            reasons.Count == 0,
            reasons);
    }

    private static Dictionary<Guid, AuthoringCanvasReferenceFact> ExactFacts(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        IReadOnlyList<AuthoringCanvasReferenceFact> loaded)
    {
        var requested = targets.ToDictionary(static target => target.NodeId);
        var facts = new Dictionary<Guid, AuthoringCanvasReferenceFact>(targets.Count);
        foreach (AuthoringCanvasReferenceFact fact in loaded)
        {
            if (!requested.TryGetValue(fact.NodeId, out AuthoringCanvasReferenceTarget? target)
                || !facts.TryAdd(fact.NodeId, fact))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_fact_set_invalid");
            }
            AuthoringCanvasReferenceContract.ValidateFact(target, fact);
        }
        if (facts.Count != targets.Count)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_fact_set_invalid");
        }
        return facts;
    }

    private static void ValidateBatchCoordinate(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceResolutionBatch candidate,
        List<string> reasons)
    {
        if (candidate.CanvasId != request.CanvasId
            || candidate.CanvasRevision != request.CanvasRevision
            || !string.Equals(candidate.CanvasContentDigest, request.CanvasContentDigest, StringComparison.Ordinal))
        {
            reasons.Add("resolution_coordinate_mismatch");
        }
    }

    private static void ValidateProjections(
        IReadOnlyList<AuthoringCanvasReferenceProjection> candidate,
        IReadOnlyList<AuthoringCanvasReferenceProjection> expected,
        List<string> reasons)
    {
        if (candidate.Count != expected.Count)
        {
            reasons.Add("projection_count_mismatch");
        }
        var expectedByNode = expected.ToDictionary(static projection => projection.NodeId);
        var candidateNodes = new HashSet<Guid>();
        foreach (AuthoringCanvasReferenceProjection projection in candidate)
        {
            if (!candidateNodes.Add(projection.NodeId))
            {
                reasons.Add($"projection_duplicate:{projection.NodeId:D}");
            }
            if (!string.Equals(
                projection.ContentDigest,
                AuthoringCanvasReferenceContract.ComputeProjectionDigest(projection),
                StringComparison.Ordinal))
            {
                reasons.Add($"projection_digest_mismatch:{projection.NodeId:D}");
            }
            if (!expectedByNode.TryGetValue(projection.NodeId, out AuthoringCanvasReferenceProjection? expectedProjection)
                || projection != expectedProjection)
            {
                reasons.Add($"projection_fact_mismatch:{projection.NodeId:D}");
            }
        }
        if (candidate.Count == expected.Count
            && !candidate.Select(static projection => projection.NodeId)
                .SequenceEqual(expected.Select(static projection => projection.NodeId)))
        {
            reasons.Add("projection_order_mismatch");
        }
    }

    private static void ValidateReceipt(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        AuthoringCanvasReferenceResolutionBatch candidate,
        IReadOnlyList<AuthoringCanvasReferenceProjection> expected,
        List<string> reasons)
    {
        AuthoringCanvasReferenceResolutionReceipt receipt = candidate.Receipt;
        AuthoringCanvasReferenceResolutionReceiptItem[] expectedItems = expected.Select(ToReceiptItem).ToArray();
        bool itemsMatch = receipt.Items.Count == expectedItems.Length
            && receipt.Items.SequenceEqual(expectedItems);
        bool fieldsValid = receipt.RequestId == request.RequestId
            && receipt.CanvasId == request.CanvasId
            && receipt.CanvasRevision == request.CanvasRevision
            && string.Equals(receipt.CanvasContentDigest, request.CanvasContentDigest, StringComparison.Ordinal)
            && receipt.Permission == request.Permission
            && string.Equals(receipt.PermissionFingerprint, coordinate.PermissionFingerprint, StringComparison.Ordinal)
            && receipt.AuthorityGeneration == coordinate.Generation
            && string.Equals(receipt.AuthorityContentDigest, coordinate.ContentDigest, StringComparison.Ordinal)
            && receipt.TargetCount == expected.Count
            && receipt.CacheHitCount >= 0
            && receipt.CacheHitCount <= receipt.TargetCount
            && receipt.ElapsedMilliseconds >= 0
            && itemsMatch;
        string digest = AuthoringCanvasReferenceContract.ComputeReceiptDigest(
            request,
            candidate.AuthorityCoordinate,
            receipt.Items,
            candidate.ContentDigest,
            receipt.TargetCount,
            receipt.CacheHitCount,
            receipt.ElapsedMilliseconds);
        if (!fieldsValid || !string.Equals(receipt.ContentDigest, digest, StringComparison.Ordinal))
        {
            reasons.Add("receipt_invalid");
        }
    }

    private static AuthoringCanvasReferenceResolutionReceiptItem ToReceiptItem(
        AuthoringCanvasReferenceProjection projection)
        => new(
            projection.NodeId,
            projection.TargetArticleId,
            projection.TargetHeadingIdentity,
            projection.TargetBlockIdentity,
            projection.TargetRevision,
            projection.Status,
            projection.Title,
            projection.ContextSnippet,
            projection.OpenIntent,
            projection.ContentDigest);

    private static AuthoringCanvasReferenceTarget ToTarget(AuthoringCanvasNode node)
        => new(
            node.Id,
            node.Type,
            node.TargetArticleId!.Value,
            node.TargetHeadingIdentity,
            node.TargetBlockIdentity,
            node.PinnedTargetRevision,
            node.DisplayProjectionReference);

    private static AuthoringCanvasReferenceProjection Project(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasReferenceFact fact,
        string? targetWorkspaceGroupId)
    {
        AuthoringCanvasReferenceProjectionStatus status = Status(target, fact);
        bool contentVisible = status is AuthoringCanvasReferenceProjectionStatus.Current
            or AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
            or AuthoringCanvasReferenceProjectionStatus.PinnedStale
            or AuthoringCanvasReferenceProjectionStatus.TargetUpdated
            or AuthoringCanvasReferenceProjectionStatus.SourceStale;
        bool openEligible = contentVisible && fact.StableRoute is not null && fact.ResolvedRevision > 0;
        var projection = new AuthoringCanvasReferenceProjection(
            target.NodeId,
            target.NodeType,
            target.TargetArticleId,
            target.TargetHeadingIdentity,
            target.TargetBlockIdentity,
            status,
            contentVisible ? fact.Title : null,
            contentVisible ? fact.ContextSnippet : null,
            fact.ResolvedRevision > 0 ? fact.ResolvedRevision : null,
            fact.CurrentRevision > 0 ? fact.CurrentRevision : null,
            openEligible
                ? new AuthoringCanvasOpenIntent(
                    target.TargetArticleId,
                    fact.ResolvedRevision,
                    target.TargetHeadingIdentity,
                    target.TargetBlockIdentity,
                    fact.StableRoute!,
                    TargetGroupId: targetWorkspaceGroupId)
                : null,
            status is AuthoringCanvasReferenceProjectionStatus.PinnedStale
                or AuthoringCanvasReferenceProjectionStatus.TargetUpdated,
            string.Empty);
        projection = projection with
        {
            DisplayProjectionReference = contentVisible ? fact.DisplayProjectionReference : null
        };
        return projection with
        {
            ContentDigest = AuthoringCanvasReferenceContract.ComputeProjectionDigest(projection)
        };
    }

    private static AuthoringCanvasReferenceProjectionStatus Status(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasReferenceFact fact)
    {
        AuthoringCanvasReferenceProjectionStatus? articleStatus = fact.ArticleState switch
        {
            AuthoringCanvasArticleState.Current => null,
            AuthoringCanvasArticleState.Missing => AuthoringCanvasReferenceProjectionStatus.Missing,
            AuthoringCanvasArticleState.Deleted => AuthoringCanvasReferenceProjectionStatus.Deleted,
            AuthoringCanvasArticleState.Archived => AuthoringCanvasReferenceProjectionStatus.Archived,
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown =>
                AuthoringCanvasReferenceProjectionStatus.PermissionDeniedOrUnknown,
            _ => throw new AuthoringCanvasValidationException("canvas_reference_article_state_invalid")
        };
        if (articleStatus is not null)
        {
            return articleStatus.Value;
        }
        AuthoringCanvasReferenceProjectionStatus? coordinateStatus = fact.CoordinateState switch
        {
            AuthoringCanvasReferenceCoordinateState.Current => null,
            AuthoringCanvasReferenceCoordinateState.SourceStale =>
                AuthoringCanvasReferenceProjectionStatus.SourceStale,
            AuthoringCanvasReferenceCoordinateState.Missing => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingMissing,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockMissing,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            AuthoringCanvasReferenceCoordinateState.Duplicate => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingDuplicate,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockDuplicate,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            AuthoringCanvasReferenceCoordinateState.Invalid => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingInvalid,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockInvalid,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            _ => throw new AuthoringCanvasValidationException("canvas_reference_coordinate_state_invalid")
        };
        if (coordinateStatus is not null)
        {
            return coordinateStatus.Value;
        }
        if (target.PinnedTargetRevision is not null)
        {
            return fact.CurrentRevision == target.PinnedTargetRevision.Value
                ? AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
                : AuthoringCanvasReferenceProjectionStatus.PinnedStale;
        }
        return fact.TargetChangedSinceProjection
            ? AuthoringCanvasReferenceProjectionStatus.TargetUpdated
            : AuthoringCanvasReferenceProjectionStatus.Current;
    }

    private async Task EnsureCurrentCanvasCoordinateAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringCanvasDocumentHeader header = await canvasStore.GetAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        if (header.Revision != request.CanvasRevision)
        {
            throw new AuthoringCanvasRevisionConflictException(request.CanvasRevision, header.Revision);
        }
        if (!string.Equals(header.ContentDigest, request.CanvasContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_content_digest_stale");
        }
    }
}

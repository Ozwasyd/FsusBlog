namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds create/pin/unpin operations to a fresh #2483 permission-filtered resolution. Coordinates which
/// cannot be proven by the current upstream authority are rejected instead of trusting caller state.
/// </summary>
public sealed class AuthoringCanvasOperationReferenceValidator(
    AuthoringCanvasReferenceResolver resolver,
    AuthoringCanvasRequestLifetime? requestLifetime = null) : IAuthoringCanvasOperationReferenceValidator
{
    private readonly AuthoringCanvasRequestLifetime _requestLifetime = requestLifetime ?? new();

    public async Task<string> ValidateAsync(
        AuthoringCanvasOperationReferenceValidationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        using AuthoringCanvasRequestLifetime.Borrow authorityScope = _requestLifetime.Acquire(request.Owner, cancellationToken);
        cancellationToken = authorityScope.Token;
        if (request.References.Count == 0)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_reference_validation_empty");
        }

        AuthoringCanvasReferenceResolutionBatch batch = await resolver.ResolveAsync(
            new AuthoringCanvasReferenceResolutionRequest(
                request.RequestId,
                request.CanvasId,
                request.CanvasRevision,
                request.CanvasContentDigest,
                request.Owner,
                AuthoringCanvasReferencePermission.ArticleRead,
                request.References),
            cancellationToken).ConfigureAwait(false);
        if (batch.Projections.Count != request.References.Count
            || batch.Projections.Any(static projection => projection.Status is not (
                AuthoringCanvasReferenceProjectionStatus.Current
                or AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
                or AuthoringCanvasReferenceProjectionStatus.PinnedStale)))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_reference_unavailable");
        }

        Dictionary<Guid, AuthoringCanvasReferenceProjection> projections = batch.Projections
            .ToDictionary(static projection => projection.NodeId);
        foreach (AuthoringCanvasNode reference in request.References)
        {
            if (!projections.TryGetValue(reference.Id, out AuthoringCanvasReferenceProjection? projection)
                || projection.NodeType != reference.Type
                || projection.TargetArticleId != reference.TargetArticleId
                || !string.Equals(
                    projection.TargetHeadingIdentity,
                    reference.TargetHeadingIdentity,
                    StringComparison.Ordinal)
                || !string.Equals(
                    projection.TargetBlockIdentity,
                    reference.TargetBlockIdentity,
                    StringComparison.Ordinal)
                || projection.TargetRevision != (reference.PinnedTargetRevision
                    ?? projection.CurrentTargetRevision)
                || reference.ReferenceState != ExpectedReferenceState(projection.Status)
                || string.IsNullOrEmpty(projection.DisplayProjectionReference)
                || !string.Equals(
                    reference.DisplayProjectionReference,
                    projection.DisplayProjectionReference,
                    StringComparison.Ordinal))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_reference_validation_mismatch");
            }
        }

        return await _requestLifetime.PublishAsync(authorityScope, _ =>
        {
            return Task.FromResult(AuthoringCanvasContract.ComputeCommandDigest(
            "canvas-operation-reference-validation",
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            batch.AuthorityCoordinate.Generation,
            batch.AuthorityCoordinate.ContentDigest,
            batch.AuthorityCoordinate.PermissionFingerprint,
            batch.ContentDigest,
            batch.Receipt.ContentDigest,
            string.Join(',', request.References.Select(AuthoringCanvasContract.ComputeNodeDigest))));
        }).ConfigureAwait(false);
    }

    private static AuthoringCanvasReferenceState ExpectedReferenceState(
        AuthoringCanvasReferenceProjectionStatus status)
        => status switch
        {
            AuthoringCanvasReferenceProjectionStatus.Current => AuthoringCanvasReferenceState.Current,
            AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
                or AuthoringCanvasReferenceProjectionStatus.PinnedStale => AuthoringCanvasReferenceState.Pinned,
            _ => throw new AuthoringCanvasValidationException("canvas_operation_reference_unavailable")
        };
}

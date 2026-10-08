using FsusBlog.Server.Services.Fixtures;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record DataScalePublishedArticleBinding(
    string SemanticArticleId,
    string PlanDigest,
    string NativeBindingsDigest,
    CanonicalArticlePublicationRequest CurrentInvocation,
    CanonicalArticlePublicationResult ActualPublication);

/// <summary>
/// Joins an actual canonical publication result to its exact native factory role and request.
/// The existing publication authority creates receipts; this adapter only verifies and forwards.
/// Offline bulk execution never calls the publication port or derives receipts from audit coordinates.
/// </summary>
internal static class DataScalePublicationRequestBinding
{
    internal static async Task<DataScalePublishedArticleBinding> BindAsync(
        ISqlSugarClient db, CanonicalArticleProjectionVerifier reader,
        ArticleScalePlan plan, ArticleScaleArticleGraph graph,
        ArticleScaleGraphIdentityBindings nativeIdentities,
        CanonicalArticlePublicationRequest currentInvocation,
        CanonicalArticlePublicationResult actualPublication,
        CancellationToken cancellationToken)
    {
        CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        nativeIdentities.ValidateFor(plan, graph.SemanticArticleId);
        ArticleScaleRowPlan[] physicalRoles = graph.Rows.Where(row => row.Kind is not (
            ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleTaxonomyReference
            or ArticleScaleRowKind.ArticleAuditCoordinate)).ToArray();
        if (!physicalRoles.Select(row => row.SemanticId).ToHashSet(StringComparer.Ordinal).SetEquals(nativeIdentities.Ids.Keys)
            || physicalRoles.Any(row => !row.Fields.TryGetValue("Id", out object? id)
                || id is not (int or long) || Convert.ToInt64(id) != nativeIdentities.Resolve(row.SemanticId)))
        {
            throw new InvalidOperationException("publication_factory_native_role_binding_mismatch");
        }
        currentInvocation.Binding.Validate();
        CanonicalArticlePublicationReceipt receipt = actualPublication.Receipt;
        ArticleScaleRowPlan article = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        ArticleScaleRowPlan body = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticleBody);
        ArticleScaleRowPlan publication = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticlePublication
            && row.Fields["Id"] is long id && id == receipt.PublicationId);
        ArticleScaleRowPlan rights = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticleRightsSnapshot
            && row.Fields["Id"] is long id && id == receipt.RightsSnapshotId);
        ArticleScaleRowPlan responsibility = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticleResponsibilitySnapshot
            && row.Fields["Id"] is long id && id == receipt.ResponsibilitySnapshotId);
        ArticleScaleRowPlan outbox = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope
            && (string)row.Fields["EventId"]! == receipt.OutboxEventId);
        if (currentInvocation.Binding.Namespace != plan.Namespace
            || currentInvocation.Plan.SemanticRole != graph.SemanticArticleId
            || receipt.SemanticRole != graph.SemanticArticleId
            || receipt.ArticleId != nativeIdentities.Resolve(graph.SemanticArticleId)
            || article.Fields["CurrentRevisionId"] is not long revisionId || receipt.RevisionId != revisionId
            || article.Fields["CurrentPublicationId"] is not long publicationId || receipt.PublicationId != publicationId
            || Convert.ToInt32(publication.Fields["RevisionNo"]) != receipt.RevisionNo
            || Convert.ToInt32(publication.Fields["PublicationNo"]) != receipt.PublicationNo
            || (string)rights.Fields["ContentCanonicalHash"]! != receipt.ContentCanonicalHash
            || (string)rights.Fields["PolicyHash"]! != receipt.PolicyHash
            || Convert.ToInt32(responsibility.Fields["ResponsibilityVersion"]) != receipt.ResponsibilityVersion
            || CanonicalArticlePublicationFixturePort.ComputeOutboxPayloadDigest((string)outbox.Fields["PayloadJson"]!) != receipt.OutboxPayloadDigest
            || currentInvocation.Plan.Title != (string)article.Fields["Title"]!
            || currentInvocation.Plan.Content != (string)body.Fields["MarkdownContent"]!
            || receipt.ContentDigest != CanonicalArticlePublicationFixturePort.ComputeContentDigest(currentInvocation.Plan.Content))
        {
            throw new InvalidOperationException("publication_factory_request_or_native_coordinate_mismatch");
        }
        string requestHash = CanonicalArticlePublicationFixturePort.ComputeRequestHash(currentInvocation.Plan);
        CanonicalArticlePublicationVerificationResult verified = await CanonicalArticlePublicationVerifier.VerifyAsync(
            db, receipt, cancellationToken).ConfigureAwait(false);
        if (!verified.IsValid)
        {
            throw new InvalidOperationException("publication_actual_writer_receipt_not_verified");
        }
        // The actual reader verifies command/request hash, immutable publication and signed audit refs.
        await reader.VerifyPublicationInvocationAsync(receipt, currentInvocation, cancellationToken).ConfigureAwait(false);
        if (requestHash != CanonicalArticlePublicationFixturePort.ComputeRequestHash(currentInvocation.Plan))
        {
            throw new InvalidOperationException("publication_request_changed_during_binding");
        }
        return new(graph.SemanticArticleId, ArticleScalePlanDigest.Compute(plan), nativeIdentities.Digest,
            currentInvocation, actualPublication);
    }
}

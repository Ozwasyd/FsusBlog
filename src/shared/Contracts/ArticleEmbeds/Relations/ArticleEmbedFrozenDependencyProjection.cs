using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>
/// Projects the existing frozen dependency receipts for publication, AOT, HotRead,
/// package and export consumers. The expected digest comes from the caller's
/// authorized persisted publication or frozen export task, never target current
/// state. This data boundary does not establish access or publication acceptance.
/// </summary>
public static class ArticleEmbedFrozenDependencyProjection
{
    /// <summary>
    /// Requires complete ordered parity with the canonical publication plan and
    /// relation derivation. Failure returns no partial dependencies. Successful
    /// output owns its immutable collection and retains the original coordinates
    /// and digests without looking up targets, expanding content or minting a schema.
    /// </summary>
    public static ArticleEmbedValidationResult Project(
        string? expectedPlanDigest,
        ArticleEmbedPublicationPlan? plan,
        ArticleEmbedRelationDerivation? derivation,
        out ImmutableArray<ArticleEmbedDependencyReceipt> dependencies)
    {
        dependencies = [];
        if (!ArticleEmbedContractDigest.IsSha256(expectedPlanDigest)
            || plan is null
            || plan.PlanDigest != expectedPlanDigest)
        {
            return Invalid("article_embed_frozen_plan_binding_mismatch");
        }
        if (plan.Edges is null
            || plan.Edges.Count > ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound
            || plan.Receipt is null
            || plan.Receipt.Items is null
            || plan.Receipt.Items.Count > ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound)
        {
            return Invalid("article_embed_frozen_dependencies_unbounded");
        }
        ArticleEmbedValidationResult planCheck = ArticleEmbedPublicationContractValidator.Validate(plan);
        if (!planCheck.IsValid)
        {
            return planCheck;
        }
        if (plan.Status != ArticleEmbedPublicationPlanStatus.Sealed
            || plan.Receipt.BlockedEdgeCount != 0
            || plan.Receipt.FrozenEdgeCount != plan.Edges.Count)
        {
            return Invalid("article_embed_frozen_plan_blocked");
        }
        if (derivation is not { Accepted: true, RejectedReasonCode: null, EdgeSet: not null }
            || derivation.DependencyReceipts is null)
        {
            return Invalid("article_embed_frozen_derivation_missing");
        }
        ArticleEmbedRelationEdgeSet set = derivation.EdgeSet;
        ArticleEmbedValidationResult setCheck = ArticleEmbedRelationContractValidator.Validate(set);
        if (!setCheck.IsValid)
        {
            return setCheck;
        }
        if (set.Scope != ArticleEmbedEdgeScope.FrozenPublication
            || set.SourceArtifactDigest != expectedPlanDigest
            || set.HostPortableArticleIdentity != plan.Receipt.HostPortableArticleIdentity
            || set.HostDocument != plan.Receipt.HostDocument
            || set.HostSourceRevision != plan.Receipt.HostCurrentRevision
            || set.AuthorityGeneration != plan.Receipt.AuthorityGeneration
            || set.Actor != plan.Receipt.Actor
            || set.Runtime != plan.Receipt.Runtime
            || set.MaterialLocale != plan.Receipt.MaterialLocale
            || set.MaterialTheme != plan.Receipt.MaterialTheme
            || set.Edges.Count != plan.Edges.Count
            || derivation.DependencyReceipts.Count != plan.Edges.Count)
        {
            return Invalid("article_embed_frozen_derivation_binding_mismatch");
        }
        var owned = ImmutableArray.CreateBuilder<ArticleEmbedDependencyReceipt>(plan.Edges.Count);
        for (int index = 0; index < plan.Edges.Count; index++)
        {
            ArticleEmbedPublicationEdge publication = plan.Edges[index];
            ArticleEmbedRelationEdge relation = set.Edges[index];
            ArticleEmbedDependencyReceipt receipt = derivation.DependencyReceipts[index];
            ArticleEmbedValidationResult receiptCheck = ArticleEmbedRelationContractValidator.Validate(receipt);
            if (!receiptCheck.IsValid)
            {
                return receiptCheck;
            }
            if (publication.Status != ArticleEmbedPublicationEdgeStatus.Frozen
                || publication.Coordinate is null
                || relation.Status != ArticleEmbedEdgeStatus.Frozen
                || relation.Visibility != ArticleEmbedVisibilityStatus.Public
                || relation.Lifecycle != ArticleEmbedLifecycleStatus.Published
                || relation.Permission != ArticleEmbedPermissionStatus.Allowed
                || relation.OwnerPortableArticleIdentity != publication.OwnerPortableArticleIdentity
                || relation.OwnerRevision != publication.OwnerRevision
                || relation.Directive != publication.Directive
                || relation.Target != publication.Target
                || relation.ResolvedRevision != publication.Coordinate.ResolvedRevision
                || relation.DependencyDigest != publication.Coordinate.DependencyDigest
                || receipt.EdgeIdentity != relation.EdgeIdentity
                || receipt.PlanDigest != expectedPlanDigest
                || receipt.PublicationEdgeDigest != publication.EdgeDigest
                || receipt.Coordinate != publication.Coordinate)
            {
                return Invalid("article_embed_frozen_dependency_parity_mismatch");
            }
            owned.Add(receipt);
        }
        dependencies = owned.MoveToImmutable();
        return ArticleEmbedValidationResult.Valid();
    }

    private static ArticleEmbedValidationResult Invalid(string reasonCode)
        => ArticleEmbedValidationResult.Invalid(reasonCode);
}

using System.Globalization;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Trusted authenticated document context supplied by server composition, not a wire grant.</summary>
public sealed record ArticleVaultConflictReviewContext(
    long AdminPrincipalId,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    int ArticleId,
    string PortableArticleIdentity);

/// <summary>Names an immutable proposal and, optionally, an exact canonical operation checkpoint.</summary>
public sealed record ArticleVaultConflictReviewReference(
    string ResolutionOperationIdentity,
    string ProposalSha256,
    ArticleVaultConflictReviewCheckpointReference? Checkpoint);

/// <summary>Retains the exact canonical operation identity, sequence and checkpoint digest requested.</summary>
public sealed record ArticleVaultConflictReviewCheckpointReference(
    ArticleVaultOperationIdentity Operation,
    long Sequence,
    string ContentSha256);

/// <summary>
/// In-process review data only. Operation checkpoints are not recovery-journal descriptors. Permission
/// and current validation do not create execution, native materialization or base-commit admission.
/// No private accepted-source package is projected into this snapshot.
/// </summary>
public sealed record ArticleVaultConflictReviewSnapshot(
    ArticleVaultResolutionPlan Proposal,
    ArticleVaultConflictEvidence? CurrentEvidence,
    ArticleVaultValidationResult CurrentValidation,
    ArticleVaultValidationResult ExecutionAdmission,
    ArticleVaultRecoveryCheckpointSnapshot? Checkpoint,
    string PermissionSnapshotSha256);

/// <summary>
/// Composes the canonical exact proposal/checkpoint readers with the existing live-session permission
/// authority. It owns no persistence, source parser, endpoint, current-fact acquisition or command.
/// The caller must acquire actual current inputs and pass the authenticated current document context.
/// Server composition must bind its configured permission site to trustedVaultSiteIdentity before
/// registering this reader; these are distinct canonical scope namespaces, not interchangeable IDs.
/// </summary>
public sealed class ArticleVaultConflictReviewReader(
    IArticleVaultResolutionProposalStore proposals,
    IArticleVaultExecutionStore executions,
    ArticleVaultRecoveryCheckpointReader checkpoints,
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissions,
    IConfiguration configuration,
    string trustedVaultSiteIdentity)
{
    /// <summary>Reads one named proposal and optional checkpoint under current live document permission.</summary>
    public async Task<ArticleVaultConflictReviewSnapshot> ReadAsync(
        ArticleVaultConflictReviewReference reference,
        ArticleVaultConflictReviewContext context,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(current);
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(trustedVaultSiteIdentity)
            || context.AdminPrincipalId <= 0 || context.ArticleId <= 0
            || context.SiteIdentity != trustedVaultSiteIdentity
            || current.Metadata.Plan.SiteIdentity != context.SiteIdentity
            || current.Metadata.Plan.VaultIdentity != context.VaultIdentity
            || current.Metadata.Plan.DeviceIdentity != context.DeviceIdentity)
        {
            throw Rejected("article_vault_conflict_review_context_mismatch");
        }

        string permissionSite = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        var owner = new AuthorRecentArticleHistoryOwner(context.AdminPrincipalId, permissionSite);
        var permissionRequest = new AuthorRecentArticleHistoryPermissionRequest(owner, Guid.CreateVersion7(), [context.ArticleId]);
        AuthorRecentArticleHistoryPermissionSnapshot before = await permissions.ResolveAsync(permissionRequest, cancellationToken)
            .ConfigureAwait(false);
        RequirePermission(before, owner, context.ArticleId);
        cancellationToken.ThrowIfCancellationRequested();

        ArticleVaultResolutionPlan proposal = await proposals.ReadExactAsync(
            reference.ResolutionOperationIdentity, reference.ProposalSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_conflict_review_proposal_missing");
        ArticleVaultOperationVerifier.Require(ArticleVaultResolutionPlanner.ValidateStructure(proposal));
        if (proposal.ResolutionOperationIdentity != reference.ResolutionOperationIdentity
            || proposal.ContentSha256 != reference.ProposalSha256
            || proposal.Binding.SiteIdentity != context.SiteIdentity
            || proposal.Binding.VaultIdentity != context.VaultIdentity
            || proposal.Binding.DeviceIdentity != context.DeviceIdentity
            || proposal.Binding.PortableArticleIdentity != context.PortableArticleIdentity
            || proposal.Binding.ServerArticleIdentity != context.ArticleId.ToString(CultureInfo.InvariantCulture))
        {
            throw Rejected("article_vault_conflict_review_document_mismatch");
        }

        ArticleVaultSealedExecutionBundle bundle = await executions.LoadSealedAsync(
            proposal.Binding.PlanCandidateIdentity, proposal.Binding.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_conflict_review_original_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (bundle.AdminPrincipalId != context.AdminPrincipalId
            || bundle.PlanReference != proposal.Binding.PlanCandidateIdentity || bundle.PlanSha256 != proposal.Binding.PlanSha256)
        {
            throw Rejected("article_vault_conflict_review_actor_mismatch");
        }

        ArticleVaultRecoveryCheckpointSnapshot? checkpoint = null;
        if (reference.Checkpoint is { } requested)
        {
            checkpoint = await checkpoints.ReadAsync(proposal, requested.Operation,
                requested.Sequence, requested.ContentSha256, cancellationToken).ConfigureAwait(false);
        }

        // Historical data can be reviewed when stale; the canonical result must remain rejected.
        ArticleVaultValidationResult validation = ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current);
        ArticleVaultValidationResult execution = ArticleVaultResolutionPlanner.RequireExecutionAdmission(proposal, current);
        AuthorRecentArticleHistoryPermissionSnapshot after = await permissions.ResolveAsync(permissionRequest, cancellationToken)
            .ConfigureAwait(false);
        RequirePermission(after, owner, context.ArticleId);
        cancellationToken.ThrowIfCancellationRequested();
        if (before.ContentDigest != after.ContentDigest
            || permissionSite != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration))
        {
            throw Rejected("article_vault_conflict_review_permission_changed");
        }

        return new(proposal, validation.IsValid ? current.Evidence : null, validation, execution, checkpoint, after.ContentDigest);
    }

    private static void RequirePermission(
        AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner,
        int articleId)
    {
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || snapshot.Owner != owner || snapshot.Decisions.Count != 1
            || snapshot.Decisions[0].ArticleId != articleId
            || !snapshot.Decisions[0].CanProject || !snapshot.Decisions[0].CanWrite
            || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
        {
            throw Rejected("article_vault_conflict_review_permission_denied");
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason) => new(reason);
}

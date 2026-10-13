using System.Globalization;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Private historical projection; neither current resolution nor native execution admission.</summary>
public sealed record ArticleVaultRecoveryHistoryResponse(
    ArticleVaultResolutionPlan Proposal,
    ArticleVaultRecoveryCheckpointSnapshot Snapshot,
    string PermissionSnapshotSha256)
{
    public bool IsHistorical => true;
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Binds existing exact stored readers to the authenticated endpoint principal and live article
/// permission projection. The host supplies a trusted Vault site independently of request fields.
/// No local fact, private accepted-source package, new store, key or current-resolution grant exists here.
/// </summary>
public sealed class ArticleVaultRecoveryHistoryReader(
    IArticleVaultResolutionProposalStore proposals,
    IArticleVaultExecutionStore executions,
    ArticleVaultRecoveryStoredProposalReader historical,
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissions,
    IConfiguration configuration,
    string trustedVaultSiteIdentity)
{
    public async Task<ArticleVaultRecoveryHistoryResponse> ReadAsync(
        ArticleVaultRecoveryHistoryRequest request,
        EndpointUserContext authenticated,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        if (!authenticated.IsAuthenticated || !authenticated.IsAdminPrincipal
            || authenticated.AdminPrincipalId <= 0 || string.IsNullOrWhiteSpace(authenticated.SessionId))
        {
            throw Rejected("authentication_required");
        }
        if (!ArticleVaultRecoveryHistoryRequestCodec.Verify(request)
            || string.IsNullOrWhiteSpace(trustedVaultSiteIdentity))
        {
            throw Rejected("reference_invalid");
        }

        // Pin the permission namespace; do not infer the opaque Vault site from the public URL.
        string permissionSite = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        var owner = new AuthorRecentArticleHistoryOwner(authenticated.AdminPrincipalId, permissionSite);
        var permissionRequest = new AuthorRecentArticleHistoryPermissionRequest(owner, Guid.CreateVersion7(), [request.ArticleId]);
        AuthorRecentArticleHistoryPermissionSnapshot before = await permissions.ResolveAsync(permissionRequest, cancellationToken)
            .ConfigureAwait(false);
        RequirePermission(before, owner, request.ArticleId);
        cancellationToken.ThrowIfCancellationRequested();

        ArticleVaultResolutionPlan proposal = await proposals.ReadExactAsync(request.ResolutionOperationIdentity,
            request.ProposalSha256, cancellationToken).ConfigureAwait(false) ?? throw Rejected("proposal_missing");
        ArticleVaultOperationVerifier.Require(ArticleVaultResolutionPlanner.ValidateStructure(proposal));
        if (proposal.ResolutionOperationIdentity != request.ResolutionOperationIdentity
            || proposal.ContentSha256 != request.ProposalSha256
            || proposal.Binding.ServerArticleIdentity != request.ArticleId.ToString(CultureInfo.InvariantCulture)
            || proposal.Binding.SiteIdentity != trustedVaultSiteIdentity
            || request.Operation.SiteIdentity != proposal.Binding.SiteIdentity
            || request.Operation.VaultIdentity != proposal.Binding.VaultIdentity
            || request.Operation.DeviceIdentity != proposal.Binding.DeviceIdentity
            || request.Operation.PlanReference != proposal.Binding.PlanCandidateIdentity
            || request.Operation.PlanSha256 != proposal.Binding.PlanSha256)
        {
            throw Rejected("document_scope_mismatch");
        }

        ArticleVaultSealedExecutionBundle bundle = await executions.LoadSealedAsync(
            proposal.Binding.PlanCandidateIdentity, proposal.Binding.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("original_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (bundle.AdminPrincipalId != authenticated.AdminPrincipalId
            || bundle.PlanReference != proposal.Binding.PlanCandidateIdentity
            || bundle.PlanSha256 != proposal.Binding.PlanSha256
            || bundle.Plan.SiteIdentity != trustedVaultSiteIdentity
            || bundle.Plan.VaultIdentity != proposal.Binding.VaultIdentity
            || bundle.Plan.DeviceIdentity != proposal.Binding.DeviceIdentity)
        {
            throw Rejected("principal_scope_mismatch");
        }
        string originalBundleSha256 = bundle.ContentSha256;

        ArticleVaultRecoveryCheckpointSnapshot snapshot = await historical.ReadAsync(request.ResolutionOperationIdentity,
            request.ProposalSha256, request.Operation, request.Sequence, request.CheckpointSha256, cancellationToken)
            .ConfigureAwait(false);
        // The canonical reader performs an independent exact read. Refuse a changing producer.
        ArticleVaultResolutionPlan afterProposal = await proposals.ReadExactAsync(request.ResolutionOperationIdentity,
            request.ProposalSha256, cancellationToken).ConfigureAwait(false) ?? throw Rejected("proposal_changed");
        if (!ArticleVaultResolutionPlanner.Serialize(proposal).AsSpan()
            .SequenceEqual(ArticleVaultResolutionPlanner.Serialize(afterProposal)))
        {
            throw Rejected("proposal_changed");
        }
        ArticleVaultSealedExecutionBundle afterBundle = await executions.LoadSealedAsync(
            proposal.Binding.PlanCandidateIdentity, proposal.Binding.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("original_plan_changed");
        ArticleVaultExecutionIntegrity.ValidateBundle(afterBundle);
        if (afterBundle.ContentSha256 != originalBundleSha256 || afterBundle.AdminPrincipalId != authenticated.AdminPrincipalId)
        {
            throw Rejected("original_plan_changed");
        }
        AuthorRecentArticleHistoryPermissionSnapshot after = await permissions.ResolveAsync(permissionRequest, cancellationToken)
            .ConfigureAwait(false);
        RequirePermission(after, owner, request.ArticleId);
        cancellationToken.ThrowIfCancellationRequested();
        if (before.ContentDigest != after.ContentDigest
            || permissionSite != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration))
        {
            throw Rejected("permission_changed");
        }

        // The HTTP projection contains no local path/instruction or accepted source bytes.
        return new(proposal, snapshot with
        {
            MaterializationPreflight = null
        }, after.ContentDigest);
    }

    private static void RequirePermission(AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner, int articleId)
    {
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || snapshot.Owner != owner || snapshot.Decisions.Count != 1
            || snapshot.Decisions[0].ArticleId != articleId || !snapshot.Decisions[0].CanProject
            || !snapshot.Decisions[0].CanWrite
            || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
        {
            throw Rejected("permission_denied");
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_recovery_history_" + reason);
}

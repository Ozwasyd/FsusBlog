using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Reads a named immutable proposal from the canonical store and replays its current byte/Git
/// provenance. Scalar proposal support does not resolve dependency candidates or admit a writer.
/// The original sealed plan remains unchanged, including a blocked status.
/// </summary>
public sealed class ArticleVaultDependencyResolutionStage(
    IArticleVaultResolutionProposalStore proposalStore,
    TimeProvider timeProvider)
{
    public async Task<ArticleVaultDependencyResolutionRead> ReadExactAsync(
        ArticleVaultSealedExecutionBundle bundle,
        string resolutionOperationIdentity,
        string proposalSha256,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArgumentNullException.ThrowIfNull(current);
        if (current.Metadata?.Plan?.ContentSha256 != bundle.PlanSha256
            || current.Metadata?.Root?.ContentSha256 != bundle.RootManifest.ContentSha256)
        {
            throw Rejected("article_vault_dependency_resolution_original_plan_mismatch");
        }
        ArticleVaultResolutionPlan proposal = await proposalStore.ReadExactAsync(
            resolutionOperationIdentity, proposalSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_dependency_resolution_proposal_missing");
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultValidationResult verification = ArticleVaultResolutionPlanner.VerifyCurrent(proposal, current);
        if (!verification.IsValid)
        {
            throw Rejected(verification.ReasonCode!);
        }
        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (proposal.ResolutionOperationIdentity != resolutionOperationIdentity || proposal.ContentSha256 != proposalSha256
            || proposal.Binding.PlanCandidateIdentity != bundle.PlanReference
            || proposal.Binding.PlanSha256 != bundle.PlanSha256
            || proposal.Binding.SiteIdentity != bundle.Plan.SiteIdentity
            || proposal.Binding.VaultIdentity != bundle.Plan.VaultIdentity
            || proposal.Binding.DeviceIdentity != bundle.Plan.DeviceIdentity
            || now < proposal.Confirmation.ConfirmedAtUnixMs || now > proposal.ExpiresAtUnixMs)
        {
            throw Rejected("article_vault_dependency_resolution_exact_binding_invalid");
        }
        return new(proposal);
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason) => new(reason);
}

/// <summary>Current proposal read only; canonical mutation admission and dependency mapping are absent.</summary>
public sealed record ArticleVaultDependencyResolutionRead(ArticleVaultResolutionPlan Proposal)
{
    public bool CanExecuteCanonicalWriter => false;
    public bool CanCommitBase => false;
    public string MissingCapability => "article_vault_dependency_resolution_execution_bridge_missing";
}

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Persists immutable resolution proposals under their original canonical sealed plan. A stored
/// proposal is neither execution admission nor an operation, backup or materialization receipt.
/// Authorization and current/native fact acquisition remain the calling server boundary's owners.
/// </summary>
public interface IArticleVaultResolutionProposalStore
{
    Task SealAsync(
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default);

    /// <summary>Reads only the named immutable proposal; historical reads grant no current status.</summary>
    Task<ArticleVaultResolutionPlan?> ReadExactAsync(
        string resolutionOperationIdentity,
        string proposalSha256,
        CancellationToken cancellationToken = default);
}

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Composes exact persisted proposals with the existing canonical historical readers. These reads
/// describe the original plan only; they neither associate a new executable plan nor admit resume.
/// Trusted authorization, store/data-source and accepted-source adapter composition remain required.
/// </summary>
public sealed class ArticleVaultRecoveryStoredProposalReader(
    IArticleVaultResolutionProposalStore proposalStore,
    ArticleVaultRecoveryCheckpointReader checkpointReader)
{
    public async Task<ArticleVaultRecoveryCheckpointSnapshot> ReadAsync(
        string resolutionOperationIdentity,
        string proposalSha256,
        ArticleVaultOperationIdentity operation,
        long exactSequence,
        string exactCheckpointSha256,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultResolutionPlan proposal = await ReadProposalAsync(
            resolutionOperationIdentity, proposalSha256, cancellationToken).ConfigureAwait(false);
        return await checkpointReader.ReadAsync(proposal, operation, exactSequence,
            exactCheckpointSha256, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Reads the original operation's historical accepted source through the canonical adapter.
    /// It cannot claim that the proposed decision was executed; CanCommitBase remains false.
    /// </summary>
    public async Task<ArticleVaultRecoveryAcceptedSourceSnapshot> ReadAcceptedSourceAsync(
        string resolutionOperationIdentity,
        string proposalSha256,
        ArticleVaultOperationIdentity operation,
        long exactSequence,
        string exactCheckpointSha256,
        ArticleVaultAcceptedSourceAdapter acceptedSourceAdapter,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultResolutionPlan proposal = await ReadProposalAsync(
            resolutionOperationIdentity, proposalSha256, cancellationToken).ConfigureAwait(false);
        return await checkpointReader.ReadAcceptedSourceAsync(proposal, operation, exactSequence,
            exactCheckpointSha256, acceptedSourceAdapter, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ArticleVaultResolutionPlan> ReadProposalAsync(
        string resolutionOperationIdentity,
        string proposalSha256,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultResolutionPlan proposal = await proposalStore.ReadExactAsync(
            resolutionOperationIdentity, proposalSha256, cancellationToken).ConfigureAwait(false)
            ?? throw new ArticleVaultExecutionRejectedException("article_vault_recovery_stored_proposal_missing");
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultValidationResult validation = ArticleVaultResolutionPlanner.ValidateStructure(proposal);
        if (!validation.IsValid)
        {
            throw new ArticleVaultExecutionRejectedException(validation.ReasonCode
                ?? "article_vault_recovery_stored_proposal_invalid");
        }
        if (proposal.ResolutionOperationIdentity != resolutionOperationIdentity
            || proposal.ContentSha256 != proposalSha256)
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_recovery_stored_proposal_binding_drift");
        }

        return proposal;
    }
}

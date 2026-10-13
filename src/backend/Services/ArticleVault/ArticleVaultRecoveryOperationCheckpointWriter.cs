using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Adds exact recovery journal facts through the sole checkpoint writer. The journal store is a
/// trusted server-composition port, never request data or backup protection/decision authority.
/// Successful bookkeeping grants no server execution, native recovery or synchronized base.
/// </summary>
public interface IArticleVaultRecoveryOperationCheckpointWriter
{
    Task AppendAsync(
        ArticleVaultResolutionOperationPlan operationPlan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint,
        ArticleVaultRecoveryJournalAssociation association,
        IArticleVaultTransactionalRecoveryJournalStore journalStore,
        CancellationToken cancellationToken = default);
}

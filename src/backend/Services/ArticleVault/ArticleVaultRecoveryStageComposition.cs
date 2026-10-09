using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Composes the existing checkpoint writer and canonical recovery storage with the actual
/// read-only recovery-key authenticator. All dependencies come from trusted server composition;
/// callers cannot replace the journal stage or protection authority through request data.
/// Persistence and authenticated bytes grant no decision, custody, native or synchronized base admission.
/// </summary>
public sealed class ArticleVaultRecoveryStageComposition
{
    private readonly PostgresArticleVaultOperationCheckpointStore _checkpointWriter;

    /// <summary>
    /// Retains the supplied sole checkpoint writer. The key store must already own the exact
    /// independent-domain key, and the clock must be the same trusted clock used by that writer.
    /// This composition never instantiates a key store, creates a key or registers runtime services.
    /// </summary>
    public ArticleVaultRecoveryStageComposition(
        PostgresArticleVaultOperationCheckpointStore checkpointWriter,
        NpgsqlDataSource dataSource,
        IArticleVaultResolutionProposalStore proposalStore,
        IAuditRetentionEpochKeyStore keyStore,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(checkpointWriter);
        ArgumentNullException.ThrowIfNull(dataSource);
        ArgumentNullException.ThrowIfNull(proposalStore);
        ArgumentNullException.ThrowIfNull(keyStore);
        ArgumentNullException.ThrowIfNull(timeProvider);

        _checkpointWriter = checkpointWriter;
        Storage = new PostgresArticleVaultRecoveryStorage(dataSource, proposalStore, checkpointWriter,
            new ArticleVaultRecoveryBackupProtectionAuthority(keyStore, timeProvider), timeProvider);
    }

    /// <summary>
    /// Exposes canonical encrypted-backup storage and exact journal reads for trusted composition.
    /// The caller still supplies current authorization; this property does not grant transport admission.
    /// </summary>
    public PostgresArticleVaultRecoveryStorage Storage
    {
        get;
    }

    /// <summary>
    /// Appends through the supplied sole writer, using the canonical protected storage for both
    /// initial stage and its precommit revalidation in the writer's existing checkpoint transaction.
    /// </summary>
    public Task AppendAsync(
        ArticleVaultResolutionOperationPlan operationPlan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint,
        ArticleVaultRecoveryJournalAssociation association,
        CancellationToken cancellationToken = default)
        => _checkpointWriter.AppendAsync(operationPlan, proposal, current, journal, checkpoint,
            association, Storage, cancellationToken);
}

using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Requires the real dedicated Vault recovery key owner to authenticate encrypted bytes, plaintext
/// identity and the complete scope. Trusted composition must supply the actual provider and existing
/// independent-domain key; a missing authority/key prevents backup storage and recovery admission.
/// </summary>
public interface IArticleVaultRecoveryBackupProtectionAuthority
{
    Task VerifyAsync(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlyMemory<byte> ciphertext,
        CancellationToken cancellationToken = default);
}

/// <summary>Holds encrypted private bytes in-process; it is not a native capture or recovery grant.</summary>
public sealed record ArticleVaultRecoveryEncryptedBackup(
    ArticleVaultRecoveryBackupReceipt Receipt,
    ReadOnlyMemory<byte> Ciphertext);

/// <summary>Returns only immutable journal associations; private backup bytes are read separately.</summary>
public sealed record ArticleVaultRecoveryStoredJournal(
    ArticleVaultRecoveryJournal Journal,
    ArticleVaultRecoveryJournalAssociation Association);

/// <summary>
/// Stages owned journal facts inside the canonical operation writer's transaction. Implementations
/// must not append operation checkpoints or create a second operation lifecycle/store.
/// </summary>
public interface IArticleVaultTransactionalRecoveryJournalStore
{
    Task StageAsync(NpgsqlTransaction transaction,
        ArticleVaultResolutionOperationPlan operationPlan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint,
        ArticleVaultOperationCheckpoint? previousCheckpoint,
        ArticleVaultRecoveryJournalAssociation association,
        CancellationToken cancellationToken = default);
}

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Freezes backup scope without paths, bodies, credentials or an asserted native grant.</summary>
public sealed record VaultRecoveryBackupBinding(
    VaultRecoveryReference Proposal,
    VaultRecoveryReference OriginalSyncPlan,
    VaultRecoveryReference ResolutionOperationPlan,
    VaultRecoveryReference Operation,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string RootManifestSha256,
    string BeforeBaseSha256,
    VaultRecoveryReference NativeSnapshot);

/// <summary>
/// References encrypted backup bytes and their dedicated external protection authority. Structural
/// validity does not establish encryption, native capture, availability or permission to recover.
/// </summary>
public sealed record ArticleVaultRecoveryBackupReceipt(
    string Schema,
    int SchemaVersion,
    string BackupIdentity,
    VaultRecoveryBackupBinding Binding,
    VaultRecoveryBackupPolicy Policy,
    long CreatedAtUnixMs,
    long PlaintextBytes,
    string PlaintextSha256,
    long CiphertextBytes,
    string CiphertextSha256,
    string ProtectionDomainIdentity,
    VaultRecoveryReference ProtectionKey,
    string ContentSha256);

/// <summary>Associates one journal fact with the exact canonical checkpoint in its writer transaction.</summary>
public sealed record ArticleVaultRecoveryJournalAssociation(
    string Schema,
    int SchemaVersion,
    VaultRecoveryReference ResolutionOperationPlan,
    VaultRecoveryReference Operation,
    long OperationSequence,
    string OperationCheckpointSha256,
    VaultRecoveryReference Journal,
    VaultRecoveryReference Backup,
    string ContentSha256);

/// <summary>Checks closed storage bindings only; actual crypto/native/operation owners supply admission.</summary>
public static class ArticleVaultRecoveryStorageVerifier
{
    public const string BackupSchema = "fsusblog.article-vault.recovery-backup.v1";
    public const string AssociationSchema = "fsusblog.article-vault.recovery-association.v1";
    public const long MaxCiphertextBytes = ArticleVaultRecoveryJournalVerifier.MaxBackupBytes + 65_536;

    public static ArticleVaultValidationResult ValidateBackup(ArticleVaultRecoveryBackupReceipt? receipt)
    {
        if (receipt is null || receipt.Schema != BackupSchema || receipt.SchemaVersion != 1
            || !ArticleVaultManifestValidator.IsIdentity(receipt.BackupIdentity) || receipt.Binding is null
            || receipt.Policy is null || !ReferenceValid(receipt.Binding.Proposal)
            || !ReferenceValid(receipt.Binding.OriginalSyncPlan) || !ReferenceValid(receipt.Binding.ResolutionOperationPlan)
            || !ReferenceValid(receipt.Binding.Operation) || !ReferenceValid(receipt.Binding.NativeSnapshot)
            || !ReferenceValid(receipt.ProtectionKey)
            || !new[] { receipt.Binding.SiteIdentity, receipt.Binding.VaultIdentity, receipt.Binding.DeviceIdentity,
                receipt.Binding.PortableArticleIdentity }.All(ArticleVaultManifestValidator.IsIdentity)
            || !new[] { receipt.Binding.RootManifestSha256, receipt.Binding.BeforeBaseSha256,
                receipt.PlaintextSha256, receipt.CiphertextSha256 }.All(ArticleVaultManifestValidator.IsSha256)
            || receipt.CreatedAtUnixMs <= 0 || receipt.PlaintextBytes <= 0
            || receipt.PlaintextBytes > receipt.Policy.MaxBytes
            || receipt.Policy.MaxBytes is <= 0 or > ArticleVaultRecoveryJournalVerifier.MaxBackupBytes
            || receipt.CiphertextBytes is <= 0 or > MaxCiphertextBytes || !receipt.Policy.EncryptionRequired
            || receipt.Policy.PrivacyClass != "private-source" || receipt.Policy.CleanupPolicyIdentity != "owned-encrypted-backup-expiry-v1"
            || receipt.Policy.DeleteAfterUnixMs <= receipt.CreatedAtUnixMs
            || receipt.Policy.DeleteAfterUnixMs - receipt.CreatedAtUnixMs > ArticleVaultRecoveryJournalVerifier.MaxBackupRetentionMs
            || receipt.ProtectionDomainIdentity != "article-vault-recovery"
            || receipt.ContentSha256 != ComputeContentSha256(receipt))
        {
            return Invalid("backup_structure_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult VerifyAssociation(
        ArticleVaultRecoveryJournalAssociation association,
        ArticleVaultResolutionOperationPlan operationPlan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint,
        ArticleVaultOperationCheckpoint? previousCheckpoint,
        ArticleVaultRecoveryBackupReceipt backup)
    {
        ArticleVaultValidationResult[] validations =
        [ArticleVaultResolutionOperationPlanner.ValidateStructure(operationPlan),
            ArticleVaultResolutionPlanner.ValidateStructure(proposal),
            ArticleVaultRecoveryJournalVerifier.ValidateStructure(journal), ValidateBackup(backup)];
        foreach (ArticleVaultValidationResult validation in validations)
        {
            if (!validation.IsValid)
            {
                return validation;
            }
        }

        ArticleVaultValidationResult append = ArticleVaultOperationVerifier.ValidateAppend(
            operationPlan.Operation, operationPlan.SyncPlan, previousCheckpoint, checkpoint);
        if (!append.IsValid)
        {
            return append;
        }

        VaultRecoveryBackupBinding binding = backup.Binding;
        if (association is null || association.Schema != AssociationSchema || association.SchemaVersion != 1
            || association.ResolutionOperationPlan != new VaultRecoveryReference(operationPlan.Operation.OperationIdentity, operationPlan.ContentSha256)
            || association.Operation != new VaultRecoveryReference(operationPlan.Operation.OperationIdentity, operationPlan.Operation.ContentSha256)
            || association.OperationSequence != checkpoint.Sequence || association.OperationCheckpointSha256 != checkpoint.ContentSha256
            || association.Journal != new VaultRecoveryReference(proposal.ResolutionOperationIdentity + "-checkpoint-" + journal.Sequence, journal.ContentSha256)
            || association.Backup != new VaultRecoveryReference(backup.BackupIdentity, backup.ContentSha256)
            || binding.Proposal != operationPlan.Proposal || binding.OriginalSyncPlan != operationPlan.OriginalSyncPlan
            || binding.ResolutionOperationPlan != association.ResolutionOperationPlan || binding.Operation != association.Operation
            || binding.SiteIdentity != proposal.Binding.SiteIdentity || binding.VaultIdentity != proposal.Binding.VaultIdentity
            || binding.DeviceIdentity != proposal.Binding.DeviceIdentity || binding.PortableArticleIdentity != proposal.Binding.PortableArticleIdentity
            || binding.RootManifestSha256 != proposal.RootManifestSha256 || binding.BeforeBaseSha256 != proposal.Binding.Coordinates.Base.ContentSha256
            || operationPlan.Proposal != new VaultRecoveryReference(proposal.ResolutionOperationIdentity, proposal.ContentSha256)
            || journal.ResolutionOperationIdentity != proposal.ResolutionOperationIdentity || journal.PlanSha256 != proposal.ContentSha256
            || journal.SiteIdentity != binding.SiteIdentity || journal.VaultIdentity != binding.VaultIdentity
            || journal.DeviceIdentity != binding.DeviceIdentity || journal.BeforeBaseSha256 != binding.BeforeBaseSha256
            || journal.Backup != association.Backup || journal.BackupPolicy != backup.Policy
            || journal.ServerResult?.Identity != checkpoint.ServerResult?.Reference
            || journal.ServerResult?.ContentSha256 != checkpoint.ServerResult?.ContentSha256
            || journal.LocalMaterialization?.Identity != checkpoint.MaterializationReceipt?.Reference
            || journal.LocalMaterialization?.ContentSha256 != checkpoint.MaterializationReceipt?.ContentSha256
            || !StateMatches(journal.State, checkpoint.State)
            || association.ContentSha256 != ComputeContentSha256(association))
        {
            return Invalid("association_binding_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static string ComputeContentSha256(ArticleVaultRecoveryBackupReceipt receipt)
        => Digest(receipt with
        {
            ContentSha256 = string.Empty
        });

    public static string ComputeContentSha256(ArticleVaultRecoveryJournalAssociation association)
        => Digest(association with
        {
            ContentSha256 = string.Empty
        });

    private static bool StateMatches(VaultRecoveryState journal, VaultOperationState checkpoint)
        => (journal, checkpoint) is (VaultRecoveryState.Prepared, VaultOperationState.Planned or VaultOperationState.Validating)
            or (VaultRecoveryState.ServerCommitting, VaultOperationState.ExecutingServer)
            or (VaultRecoveryState.ServerCommitted or VaultRecoveryState.LocalMaterializing, VaultOperationState.MaterializingLocal)
            or (VaultRecoveryState.RecoveryRequired, VaultOperationState.RecoveryRequired)
            or (VaultRecoveryState.Cancelled, VaultOperationState.Cancelled)
            or (VaultRecoveryState.Failed, VaultOperationState.Failed)
            or (VaultRecoveryState.Complete or VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward, VaultOperationState.Synced);

    private static bool ReferenceValid(VaultRecoveryReference? reference)
        => reference is not null && ArticleVaultManifestValidator.IsIdentity(reference.Identity)
            && ArticleVaultManifestValidator.IsSha256(reference.ContentSha256);

    private static string Digest<T>(T value)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(value));

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid("article_vault_recovery_storage_" + reason);
}

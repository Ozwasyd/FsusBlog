using System.Collections.Immutable;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Names recovery checkpoints; server acceptance alone never means complete.</summary>
public enum VaultRecoveryState
{
    Prepared = 1,
    ServerCommitting,
    ServerCommitted,
    LocalMaterializing,
    RecoveryRequired,
    Recovered,
    RolledForward,
    Cancelled,
    Failed,
    Complete
}

/// <summary>Identifies one exact artifact; no latest lookup, URL, path or plaintext is accepted.</summary>
public sealed record VaultRecoveryReference(string Identity, string ContentSha256);

/// <summary>
/// Declares requirements for the canonical backup owner, not proof that encryption or cleanup ran.
/// Body-bearing backups require scoped encrypted storage and a bounded TTL; receipts contain no body.
/// </summary>
public sealed record VaultRecoveryBackupPolicy(
    long MaxBytes,
    long DeleteAfterUnixMs,
    bool EncryptionRequired,
    string PrivacyClass,
    string CleanupPolicyIdentity);

/// <summary>
/// Seals one immutable recovery checkpoint. These references cannot grant server/local/base write
/// authority. The canonical #2107 operation owner must persist and bind the checkpoint atomically.
/// </summary>
public sealed record ArticleVaultRecoveryJournal(
    string Schema,
    int SchemaVersion,
    string ResolutionOperationIdentity,
    string PlanSha256,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    long Sequence,
    string? PreviousCheckpointSha256,
    VaultRecoveryState State,
    VaultRecoveryReference Backup,
    VaultRecoveryBackupPolicy BackupPolicy,
    VaultRecoveryReference? ServerResult,
    VaultRecoveryReference? LocalMaterialization,
    VaultRecoveryReference? BaseCommit,
    string BeforeBaseSha256,
    string? AfterBaseSha256,
    long CreatedAtUnixMs,
    string ContentSha256);

/// <summary>
/// Checks journal structure, legal history and exact references only. It never claims an artifact is
/// present or verified from a caller-supplied flag; execution/recovery still needs actual authorities.
/// There is no filesystem, database, writer, fallback or secondary operation lifecycle here.
/// </summary>
public static class ArticleVaultRecoveryJournalVerifier
{
    public const string Schema = "fsusblog.article-vault.recovery-journal.v1";
    public const long MaxBackupBytes = 16_777_216;
    public const long MaxBackupRetentionMs = 86_400_000;

    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultRecoveryJournal? journal)
    {
        if (journal is null || journal.Schema != Schema || journal.SchemaVersion != 1 || !Enum.IsDefined(journal.State)
            || !ArticleVaultManifestValidator.IsIdentity(journal.ResolutionOperationIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(journal.SiteIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(journal.VaultIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(journal.DeviceIdentity)
            || !ArticleVaultManifestValidator.IsSha256(journal.PlanSha256)
            || !ArticleVaultManifestValidator.IsSha256(journal.BeforeBaseSha256)
            || journal.AfterBaseSha256 is not null && !ArticleVaultManifestValidator.IsSha256(journal.AfterBaseSha256)
            || journal.Sequence < 0 || journal.CreatedAtUnixMs <= 0 || journal.BackupPolicy is null
            || journal.Sequence == 0 && (journal.PreviousCheckpointSha256 is not null || journal.State != VaultRecoveryState.Prepared)
            || journal.Sequence != 0 && !ArticleVaultManifestValidator.IsSha256(journal.PreviousCheckpointSha256)
            || !ReferenceValid(journal.Backup) || journal.ServerResult is not null && !ReferenceValid(journal.ServerResult)
            || journal.LocalMaterialization is not null && !ReferenceValid(journal.LocalMaterialization)
            || journal.BaseCommit is not null && !ReferenceValid(journal.BaseCommit))
        {
            return Invalid("structure_invalid");
        }

        VaultRecoveryBackupPolicy policy = journal.BackupPolicy;
        if (policy.MaxBytes is <= 0 or > MaxBackupBytes || !policy.EncryptionRequired || policy.DeleteAfterUnixMs <= 0
            || policy.PrivacyClass != "private-source" || policy.CleanupPolicyIdentity != "owned-encrypted-backup-expiry-v1"
            // An expired backup must block use, not erase a late failure/recovery obligation.
            // These three states retain metadata only; active/completed materialization still
            // requires the original live backup window and actual independent admission.
            || policy.DeleteAfterUnixMs <= journal.CreatedAtUnixMs
                && journal.State is not (VaultRecoveryState.RecoveryRequired or VaultRecoveryState.Cancelled or VaultRecoveryState.Failed)
            || policy.DeleteAfterUnixMs - journal.CreatedAtUnixMs > MaxBackupRetentionMs)
        {
            return Invalid("backup_policy_invalid");
        }

        bool committed = journal.State is VaultRecoveryState.ServerCommitted or VaultRecoveryState.LocalMaterializing
            or VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward or VaultRecoveryState.Complete;
        bool materialized = journal.State is VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward or VaultRecoveryState.Complete;
        if (committed && journal.ServerResult is null
            || materialized && (journal.LocalMaterialization is null || journal.BaseCommit is null || journal.AfterBaseSha256 is null)
            || !materialized && (journal.BaseCommit is not null || journal.AfterBaseSha256 is not null)
            || journal.ServerResult is null && journal.LocalMaterialization is not null
            || journal.State is VaultRecoveryState.Prepared or VaultRecoveryState.ServerCommitting
                && (journal.ServerResult is not null || journal.LocalMaterialization is not null)
            || journal.State is VaultRecoveryState.Cancelled or VaultRecoveryState.Failed && journal.ServerResult is not null
            || journal.ContentSha256 != ComputeContentSha256(journal))
        {
            return Invalid("receipt_state_or_digest_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>Verifies all checkpoints and the selected exact tip; no history overwrite is possible.</summary>
    public static ArticleVaultValidationResult VerifyHistory(
        ArticleVaultResolutionPlan plan,
        ImmutableArray<ArticleVaultRecoveryJournal> history,
        VaultRecoveryReference exactCheckpoint)
    {
        ArticleVaultValidationResult resolution = ArticleVaultResolutionPlanner.ValidateStructure(plan);
        if (!resolution.IsValid)
        {
            return resolution;
        }

        if (plan.State != VaultResolutionPlanState.Prepared || history.IsDefaultOrEmpty || history.Length > 10_000
            || !ReferenceValid(exactCheckpoint))
        {
            return Invalid("history_missing_or_cancelled");
        }

        ArticleVaultRecoveryJournal? previous = null;
        foreach (ArticleVaultRecoveryJournal journal in history)
        {
            ArticleVaultValidationResult structure = ValidateStructure(journal);
            if (!structure.IsValid)
            {
                return structure;
            }

            if (journal.ResolutionOperationIdentity != plan.ResolutionOperationIdentity || journal.PlanSha256 != plan.ContentSha256
                || journal.SiteIdentity != plan.Binding.SiteIdentity || journal.VaultIdentity != plan.Binding.VaultIdentity
                || journal.DeviceIdentity != plan.Binding.DeviceIdentity
                || journal.BeforeBaseSha256 != plan.Binding.Coordinates.Base.ContentSha256)
            {
                return Invalid("plan_binding_drift");
            }

            if (previous is null)
            {
                if (journal.Sequence != 0 || journal.State != VaultRecoveryState.Prepared)
                {
                    return Invalid("prepared_checkpoint_missing");
                }
            }
            else if (journal.Sequence != previous.Sequence + 1 || journal.PreviousCheckpointSha256 != previous.ContentSha256
                || journal.CreatedAtUnixMs < previous.CreatedAtUnixMs || journal.Backup != previous.Backup
                || journal.BackupPolicy != previous.BackupPolicy || !CanFollow(previous.State, journal.State)
                || previous.ServerResult is not null && journal.ServerResult != previous.ServerResult
                || previous.LocalMaterialization is not null && journal.LocalMaterialization != previous.LocalMaterialization
                || previous.BaseCommit is not null && journal.BaseCommit != previous.BaseCommit
                || previous.AfterBaseSha256 is not null && journal.AfterBaseSha256 != previous.AfterBaseSha256)
            {
                return Invalid("checkpoint_transition_invalid");
            }

            previous = journal;
        }

        return exactCheckpoint.Identity == plan.ResolutionOperationIdentity + "-checkpoint-" + previous!.Sequence
            && exactCheckpoint.ContentSha256 == previous.ContentSha256
                ? ArticleVaultValidationResult.Valid() : Invalid("exact_checkpoint_drift");
    }

    /// <summary>
    /// Checks current coordinates and exact history before refusing the absent canonical resume bridge.
    /// Sealed references alone cannot prove backups, server receipts, files, base or cleanup exist.
    /// </summary>
    public static ArticleVaultValidationResult RequireRecoveryAdmission(
        ArticleVaultResolutionPlan plan,
        ArticleVaultResolutionPlanInput current,
        ImmutableArray<ArticleVaultRecoveryJournal> history,
        VaultRecoveryReference checkpoint)
    {
        ArticleVaultValidationResult validity = ArticleVaultResolutionPlanner.VerifyCurrent(plan, current);
        if (!validity.IsValid)
        {
            return validity;
        }

        validity = VerifyHistory(plan, history, checkpoint);
        if (!validity.IsValid)
        {
            return validity;
        }
        return history[^1].BackupPolicy.DeleteAfterUnixMs <= current.Metadata.Context.NowUnixMs
            ? Invalid("backup_expired") : Invalid("canonical_materializer_and_operation_admission_missing");
    }

    public static byte[] Serialize(ArticleVaultRecoveryJournal journal)
    {
        ArticleVaultValidationResult result = ValidateStructure(journal);
        return result.IsValid ? ArticleVaultManifestCodec.SerializeCanonical(journal) : throw new InvalidDataException(result.ReasonCode);
    }

    public static ArticleVaultRecoveryJournal Deserialize(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > ArticleVaultGitFactDecoder.MaxOutputBytes)
        {
            throw new InvalidDataException("article_vault_recovery_size_limit");
        }

        try
        {
            ArticleVaultRecoveryJournal? journal = ArticleVaultManifestCodec.DeserializeCanonical<ArticleVaultRecoveryJournal>(bytes);
            ArticleVaultValidationResult validity = ValidateStructure(journal);
            return validity.IsValid ? journal! : throw new InvalidDataException(validity.ReasonCode);
        }
        catch (JsonException)
        {
            throw new InvalidDataException("article_vault_recovery_schema_invalid");
        }
    }

    public static string ComputeContentSha256(ArticleVaultRecoveryJournal journal)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(journal with
        {
            ContentSha256 = string.Empty
        }));

    private static bool ReferenceValid(VaultRecoveryReference? reference)
        => reference is not null && ArticleVaultManifestValidator.IsIdentity(reference.Identity)
            && ArticleVaultManifestValidator.IsSha256(reference.ContentSha256);

    private static bool CanFollow(VaultRecoveryState previous, VaultRecoveryState next)
        => previous switch
        {
            VaultRecoveryState.Prepared => next is VaultRecoveryState.ServerCommitting or VaultRecoveryState.Cancelled or VaultRecoveryState.Failed,
            VaultRecoveryState.ServerCommitting => next is VaultRecoveryState.ServerCommitted or VaultRecoveryState.RecoveryRequired or VaultRecoveryState.Failed,
            VaultRecoveryState.ServerCommitted => next is VaultRecoveryState.LocalMaterializing or VaultRecoveryState.RecoveryRequired,
            VaultRecoveryState.LocalMaterializing => next is VaultRecoveryState.Complete or VaultRecoveryState.RecoveryRequired,
            VaultRecoveryState.RecoveryRequired => next is VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward,
            VaultRecoveryState.Recovered or VaultRecoveryState.RolledForward => next == VaultRecoveryState.Complete,
            _ => false
        };

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_recovery_{reason}");
}

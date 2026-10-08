using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Presents exact persisted checkpoints and canonical server receipts. This is not a recovery
/// execution receipt: backup journal persistence and verified native/base commit are still absent.
/// </summary>
public sealed record ArticleVaultRecoveryCheckpointSnapshot(
    string ResolutionPlanSha256,
    ArticleVaultOperationIdentity Operation,
    IReadOnlyList<ArticleVaultOperationCheckpoint> Checkpoints,
    ArticleVaultExecutionResult? ServerResult,
    ArticleVaultMaterializationPreflight? MaterializationPreflight,
    IReadOnlyList<string> MissingCapabilities);

/// <summary>
/// Reads only explicit canonical plan/checkpoint/result references. It preserves historical server
/// facts even when a current resolution would be stale. Authorization belongs to the calling server
/// boundary; this reader supplies no endpoint, write, resume, undo or new identity authority.
/// </summary>
public sealed class ArticleVaultRecoveryCheckpointReader(
    IArticleVaultExecutionStore executionStore,
    IArticleVaultOperationCheckpointStore checkpointStore)
{
    public async Task<ArticleVaultRecoveryCheckpointSnapshot> ReadAsync(
        ArticleVaultResolutionPlan resolution,
        ArticleVaultOperationIdentity operation,
        long exactSequence,
        string exactCheckpointSha256,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultOperationVerifier.Require(ArticleVaultResolutionPlanner.ValidateStructure(resolution));
        if (exactSequence < 0 || exactCheckpointSha256 is not { Length: 64 }
            || !exactCheckpointSha256.All(static value => value is >= '0' and <= '9' or >= 'a' and <= 'f'))
        {
            throw new InvalidDataException("article_vault_recovery_checkpoint_reference_invalid");
        }

        ArticleVaultSealedExecutionBundle bundle = await executionStore.LoadSealedAsync(
            operation.PlanReference, operation.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("article_vault_recovery_sealed_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan));
        if (bundle.PlanReference != operation.PlanReference || bundle.PlanSha256 != operation.PlanSha256
            || resolution.Binding.PlanSha256 != bundle.PlanSha256
            || resolution.Binding.SiteIdentity != operation.SiteIdentity
            || resolution.Binding.VaultIdentity != operation.VaultIdentity
            || resolution.Binding.DeviceIdentity != operation.DeviceIdentity)
        {
            throw new InvalidDataException("article_vault_recovery_original_plan_binding_drift");
        }

        VaultSyncPlanItem[] items = bundle.Plan.Groups.Where(group => group.GroupIdentity == resolution.Binding.GroupIdentity)
            .SelectMany(static group => group.Items).Where(item => item.OperationIdentity == resolution.Binding.OperationIdentity).ToArray();
        if (items.Length != 1 || items[0].PortableArticleIdentity != resolution.Binding.PortableArticleIdentity
            || items[0].ServerArticleIdentity != resolution.Binding.ServerArticleIdentity
            || items[0].Preconditions.ArticleManifestSha256 != resolution.Binding.ArticleManifestSha256
            || items[0].Preconditions.ServerObservationSha256 != resolution.Binding.ServerObservationSha256
            || items[0].Base.ContentSha256 != resolution.Binding.Coordinates.Base.ContentSha256
            || items[0].Local.ContentSha256 != resolution.Binding.Coordinates.Local.ContentSha256
            || items[0].Server.ContentSha256 != resolution.Binding.Coordinates.Server.ContentSha256)
        {
            throw new InvalidDataException("article_vault_recovery_article_binding_drift");
        }

        IReadOnlyList<ArticleVaultOperationCheckpoint> history = await checkpointStore.ReadThroughAsync(
            operation, bundle.Plan, exactSequence, exactCheckpointSha256, cancellationToken).ConfigureAwait(false);
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.VerifyHistory(
            operation, bundle.Plan, history, exactSequence, exactCheckpointSha256));
        ArticleVaultOperationCheckpoint checkpoint = history[^1];
        ArticleVaultExecutionResult? result = null;
        ArticleVaultMaterializationPreflight? preflight = null;
        if (checkpoint.ServerResult is not null)
        {
            result = await executionStore.LoadResultAsync(checkpoint.ServerResult.Reference, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidDataException("article_vault_recovery_exact_server_result_missing");
            ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
            if (result.ResultReference != checkpoint.ServerResult.Reference
                || result.ContentSha256 != checkpoint.ServerResult.ContentSha256)
            {
                throw new InvalidDataException("article_vault_recovery_server_result_binding_drift");
            }

            if (checkpoint.ServerCommit == VaultServerCommitDisposition.Accepted)
            {
                preflight = ArticleVaultMaterializationPreflightVerifier.Prepare(bundle, result, operation);
            }
        }

        return new(resolution.ContentSha256, operation, history, result, preflight,
        [
            "canonical_conflict_resolution_execution_admission",
            "encrypted_recovery_backup_and_journal_persistence",
            "native_conditional_write_and_readback",
            "atomic_verified_manifest_base_receipt_commit"
        ]);
    }
}

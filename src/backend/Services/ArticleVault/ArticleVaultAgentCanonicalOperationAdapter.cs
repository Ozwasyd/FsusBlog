using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Composes the original server stores and executor. Cancellation uses the canonical checkpoint
/// writer; no second store, article writer or automatic DI registration is added.
/// </summary>
public sealed class ArticleVaultAgentCanonicalOperationAdapter(
    IArticleVaultExecutionStore executions,
    IArticleVaultOperationCheckpointStore checkpoints,
    IArticleVaultSyncPlanExecutor executor,
    ArticleVaultAgentBinding binding,
    string rootManifestSha256,
    long trustedAdminPrincipalId,
    TimeProvider timeProvider) : IArticleVaultAgentCanonicalOperations
{
    public async Task<ArticleVaultAgentOperationSnapshot> ReadAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken)
    {
        ArticleVaultSealedExecutionBundle bundle = await LoadAsync(reference, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ArticleVaultOperationCheckpoint> history = await checkpoints.ReadThroughAsync(
            reference.Identity, bundle.Plan, reference.CheckpointSequence, reference.CheckpointSha256,
            cancellationToken).ConfigureAwait(false);
        var snapshot = new ArticleVaultAgentOperationSnapshot(bundle.Plan, history);
        ArticleVaultAgentOperationInventory.RequireCurrentBinding(binding, rootManifestSha256, reference, snapshot);
        return snapshot;
    }

    public async Task<ArticleVaultAgentCanonicalResult> ExecuteAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken)
    {
        ArticleVaultAgentOperationSnapshot snapshot = await ReadAsync(reference, cancellationToken).ConfigureAwait(false);
        ArticleVaultOperationCheckpoint tip = snapshot.History[^1];
        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (tip.State != VaultOperationState.ExecutingServer || tip.CancellationRequested
            || now < tip.RecordedAtUnixMs || now >= reference.Identity.DeadlineUnixMs
            || tip.ServerCommit != VaultServerCommitDisposition.Unknown)
        {
            // The existing operation owner must durably admit its uncertain server stage first.
            throw new InvalidDataException("agent_operation_execution_checkpoint_required");
        }

        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultExecutionResult? existing = await executions.LoadResultAsync(snapshot.Plan.ResultCandidateIdentity,
            cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            // ReadThrough is a historical prefix, not a compare-and-admit of the current tip.
            // Do not bypass a later canonical cancellation/recovery transition with an old pointer.
            throw new InvalidDataException("agent_current_operation_execution_admission_missing");
        }

        ArticleVaultSealedExecutionBundle original = await LoadAsync(reference, cancellationToken).ConfigureAwait(false);
        ArticleVaultExecutionIntegrity.VerifyResult(original, existing);
        // The original executor's immutable-result replay path supplies the canonical result.
        ArticleVaultExecutionResult result = await executor.ExecuteAsync(reference.Identity.PlanReference,
            reference.Identity.PlanSha256, cancellationToken).ConfigureAwait(false);
        ArticleVaultSealedExecutionBundle bundle = await LoadAsync(reference, CancellationToken.None).ConfigureAwait(false);
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
        ArticleVaultExecutionResult persisted = await executions.LoadResultAsync(result.ResultReference,
            CancellationToken.None).ConfigureAwait(false)
            ?? throw new InvalidDataException("agent_execution_result_receipt_missing");
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, persisted);
        if (persisted.ContentSha256 != result.ContentSha256 || existing.ContentSha256 != result.ContentSha256)
        {
            throw new InvalidDataException("agent_execution_result_receipt_mismatch");
        }

        return new(reference.Identity.OperationIdentity, reference.Identity.ContentSha256,
            reference.Identity.PlanSha256, result.ResultReference, result.ContentSha256, result.Outcome switch
            {
                ArticleVaultExecutionOutcome.Completed => ArticleVaultAgentCanonicalOutcome.Completed,
                ArticleVaultExecutionOutcome.NoOp => ArticleVaultAgentCanonicalOutcome.NoOp,
                ArticleVaultExecutionOutcome.Cancelled => ArticleVaultAgentCanonicalOutcome.Cancelled,
                _ => ArticleVaultAgentCanonicalOutcome.Failed
            });
    }

    public async Task<ArticleVaultAgentOperationSnapshot> CancelAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken)
    {
        ArticleVaultAgentOperationSnapshot snapshot = await ReadAsync(reference, cancellationToken).ConfigureAwait(false);
        ArticleVaultOperationCheckpoint tip = snapshot.History[^1];
        if (tip.State == VaultOperationState.Cancelled
            || tip.State == VaultOperationState.RecoveryRequired && tip.CancellationRequested)
        {
            return snapshot;
        }

        if (ArticleVaultOperationVerifier.IsTerminal(tip.State))
        {
            throw new InvalidDataException("agent_operation_cancellation_terminal");
        }

        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (now < tip.RecordedAtUnixMs)
        {
            throw new InvalidDataException("agent_operation_cancellation_clock_invalid");
        }

        bool recovery = tip.ServerCommit is VaultServerCommitDisposition.Unknown or VaultServerCommitDisposition.Accepted;
        ArticleVaultOperationCheckpoint next = tip with
        {
            Sequence = checked(tip.Sequence + 1),
            PreviousCheckpointSha256 = tip.ContentSha256,
            RecordedAtUnixMs = now,
            State = recovery ? VaultOperationState.RecoveryRequired : VaultOperationState.Cancelled,
            CancellationRequested = true,
            ReasonCode = recovery ? "agent_canonical_recovery_required" : "agent_cancel_requested",
            ContentSha256 = string.Empty
        };
        next = next with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(next)
        };
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateAppend(
            reference.Identity, snapshot.Plan, tip, next));
        cancellationToken.ThrowIfCancellationRequested();
        // This is the existing sole writer's expected-predecessor append, not first-execution admission.
        // A competing transition refuses this candidate rather than overwriting canonical history.
        await checkpoints.AppendAsync(reference.Identity, snapshot.Plan, next, cancellationToken).ConfigureAwait(false);
        // Once the append returns, obtain the durable exact receipt even if the peer has disconnected.
        return await ReadAsync(new(reference.Identity, next.Sequence, next.ContentSha256), CancellationToken.None)
            .ConfigureAwait(false);
    }

    private async Task<ArticleVaultSealedExecutionBundle> LoadAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken)
    {
        if (!ArticleVaultAgentOperationInventory.IsReference(reference))
        {
            throw new InvalidDataException("agent_operation_reference_invalid");
        }

        ArticleVaultSealedExecutionBundle bundle = await executions.LoadSealedAsync(
            reference.Identity.PlanReference, reference.Identity.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("agent_operation_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (trustedAdminPrincipalId <= 0 || bundle.AdminPrincipalId != trustedAdminPrincipalId)
        {
            throw new InvalidDataException("agent_operation_principal_binding_mismatch");
        }

        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(reference.Identity, bundle.Plan));
        if (bundle.Plan.RootManifestSha256 != rootManifestSha256 || reference.Identity.SiteIdentity != binding.SiteIdentity
            || reference.Identity.VaultIdentity != binding.VaultIdentity || reference.Identity.DeviceIdentity != binding.DeviceIdentity
            || reference.Identity.AgentIdentity != binding.AgentInstanceIdentity)
        {
            throw new InvalidDataException("agent_operation_scope_mismatch");
        }
        return bundle;
    }
}

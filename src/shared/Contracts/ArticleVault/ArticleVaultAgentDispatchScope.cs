namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Routes admitted references to the original planner and canonical operation port. Registration is
/// host-owned, bounded and session-local; canonical cancellation persistence remains in its owner.
/// The native control owner must admit the peer/grant and supply its own current lifecycle receipt.
/// </summary>
public sealed class ArticleVaultAgentDispatchScope : IDisposable
{
    private readonly object _gate = new();
    private readonly ArticleVaultAgentBinding _binding;
    private readonly string _rootManifestSha256;
    private readonly IArticleVaultAgentCanonicalOperations _operations;
    private readonly TimeProvider _time;
    private readonly Dictionary<string, OperationEntry> _registered = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ArticleVaultPlanRequest> _plannerInputs = new(StringComparer.Ordinal);
    private readonly HashSet<string> _requests = new(StringComparer.Ordinal);
    private bool _revoked;

    public ArticleVaultAgentDispatchScope(
        ArticleVaultAgentBinding binding,
        string rootManifestSha256,
        IArticleVaultAgentCanonicalOperations operations,
        TimeProvider timeProvider)
    {
        if (!ArticleVaultAgentProtocol.IsBinding(binding) || !ArticleVaultAgentProtocol.IsDigest(rootManifestSha256))
        {
            throw new InvalidDataException("agent_dispatch_binding_invalid");
        }

        _binding = binding;
        _rootManifestSha256 = rootManifestSha256;
        _operations = operations ?? throw new ArgumentNullException(nameof(operations));
        _time = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
    }

    public async Task RegisterOperationAsync(
        ArticleVaultAgentOperationReference reference,
        string executeRequestIdentity,
        string cancellationIdentity,
        CancellationToken cancellationToken)
    {
        if (!ArticleVaultAgentProtocol.IsIdentity(executeRequestIdentity)
            || !ArticleVaultAgentProtocol.IsIdentity(cancellationIdentity)
            || !ArticleVaultAgentOperationInventory.IsReference(reference))
        {
            throw new InvalidDataException("agent_dispatch_registration_invalid");
        }

        // Snapshot the pointer before the asynchronous owner read.
        reference = ArticleVaultOperationCodec.Deserialize<ArticleVaultAgentOperationReference>(
            ArticleVaultOperationCodec.Serialize(reference));
        ArticleVaultAgentOperationSnapshot snapshot = await _operations.ReadAsync(reference, cancellationToken).ConfigureAwait(false);
        ArticleVaultAgentOperationInventory.RequireCurrentBinding(_binding, _rootManifestSha256, reference, snapshot);
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_revoked, this);
            if (_registered.Values.Any(item => item.ExecuteRequestIdentity == executeRequestIdentity
                && item.Reference.Identity.OperationIdentity != reference.Identity.OperationIdentity))
            {
                throw new InvalidDataException("agent_dispatch_request_identity_duplicate");
            }

            if (_registered.TryGetValue(reference.Identity.OperationIdentity, out OperationEntry? old))
            {
                if (old.Active is not null || old.ExecuteRequestIdentity != executeRequestIdentity
                    || old.CancellationIdentity != cancellationIdentity || old.Reference.Identity != reference.Identity
                    || reference.CheckpointSequence < old.Reference.CheckpointSequence
                    || reference.CheckpointSequence == old.Reference.CheckpointSequence
                        && reference.CheckpointSha256 != old.Reference.CheckpointSha256)
                {
                    throw new InvalidDataException("agent_dispatch_operation_refresh_invalid");
                }

                old.Reference = reference;
            }
            else if (_registered.Count >= ArticleVaultAgentLifecycleInventory.MaximumOperations)
            {
                throw new InvalidDataException("agent_dispatch_operation_duplicate_or_budget");
            }
            else
            {
                _registered.Add(reference.Identity.OperationIdentity, new(reference, executeRequestIdentity, cancellationIdentity));
            }
        }
    }

    public ArticleVaultAgentReference RegisterPlannerInput(ArticleVaultPlanRequest input)
    {
        ArgumentNullException.ThrowIfNull(input);
        input = ArticleVaultManifestCodec.DeserializeCanonical<ArticleVaultPlanRequest>(
            ArticleVaultManifestCodec.SerializeCanonical(input))!;
        if (input.RootManifest.SiteIdentity != _binding.SiteIdentity
            || input.RootManifest.VaultIdentity != _binding.VaultIdentity
            || input.RootManifest.DeviceIdentity != _binding.DeviceIdentity
            || input.RootManifest.ContentSha256 != _rootManifestSha256)
        {
            throw new InvalidDataException("agent_dispatch_planner_scope_mismatch");
        }

        string digest = ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(input));
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_revoked, this);
            if (_plannerInputs.Count >= 64 || !_plannerInputs.TryAdd(digest, input))
            {
                throw new InvalidDataException("agent_dispatch_planner_duplicate_or_budget");
            }
        }

        return new(ArticleVaultAgentReferenceKind.PlannerInput, digest, digest);
    }

    public async Task<ArticleVaultAgentCommandReceipt> DispatchAsync(
        ArticleVaultAgentRequest request,
        int frameByteLength,
        ArticleVaultAgentLifecycleReceipt lifecycle,
        CancellationToken cancellationToken)
    {
        if (!ArticleVaultAgentRequestCodec.Verify(request) || request.Binding != _binding
            || !ArticleVaultAgentLifecycle.Verify(lifecycle) || lifecycle.Binding != _binding)
        {
            throw new InvalidDataException("agent_dispatch_request_scope_invalid");
        }

        lock (_gate)
        {
            if (_revoked || _requests.Count >= 4096 || !_requests.Add(request.RequestIdentity))
            {
                return Blocked("agent_dispatch_revoked_duplicate_or_budget");
            }
        }

        long now = _time.GetUtcNow().ToUnixTimeMilliseconds();
        if (now < lifecycle.ObservedUnixMilliseconds || now >= request.DeadlineUnixMilliseconds)
        {
            return Blocked("agent_dispatch_deadline_invalid");
        }

        if (request.Command == ArticleVaultAgentCommand.InspectStatus)
        {
            return Receipt(ArticleVaultAgentCommandStatus.Completed, null, lifecycle.ContentSha256);
        }

        if (request.Command == ArticleVaultAgentCommand.Revoke)
        {
            Dispose();
            return Receipt(ArticleVaultAgentCommandStatus.Admitted, "agent_revoke_requested");
        }

        if (request.Command == ArticleVaultAgentCommand.Cancel)
        {
            OperationEntry? entry = FindOperation(request, cancellation: true);
            if (entry is null)
            {
                return Blocked("agent_cancel_operation_binding_missing");
            }

            // Signal only the bound local request, then require the canonical writer's durable fact.
            CancellationTokenSource? activeCancellation;
            lock (_gate)
            {
                entry.CancelRequested = true;
                activeCancellation = entry.Active;
            }

            try
            {
                try
                {
                    activeCancellation?.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // The target completed while the cancellation request was being admitted.
                }

                ArticleVaultOperationCheckpoint tip = await CancelEntryAsync(entry, cancellationToken).ConfigureAwait(false);
                lock (_gate)
                {
                    if (_revoked)
                    {
                        return Blocked("agent_execution_recovery_required", tip.ContentSha256);
                    }
                }

                return tip.State == VaultOperationState.Cancelled
                    ? Receipt(ArticleVaultAgentCommandStatus.Cancelled, "agent_canonical_cancelled", tip.ContentSha256)
                    : Receipt(ArticleVaultAgentCommandStatus.Blocked, "agent_canonical_recovery_required", tip.ContentSha256);
            }
            catch (Exception)
            {
                return Blocked("agent_cancel_canonical_receipt_unavailable");
            }
        }

        if (lifecycle.NewState != ArticleVaultAgentLifecycleState.Running || lifecycle.RescanRequired
            || lifecycle.LeaseGeneration != request.LeaseGeneration
            || lifecycle.LeaseReceiptSha256 != request.LeaseReceiptSha256)
        {
            return Blocked("agent_dispatch_lifecycle_not_running");
        }

        if (request.Command == ArticleVaultAgentCommand.RequestPlanner)
        {
            ArticleVaultPlanRequest? input;
            lock (_gate)
            {
                _plannerInputs.TryGetValue(request.Reference!.Identity, out input);
            }

            if (input is null || request.Reference!.ContentSha256 != request.Reference.Identity
                || now < input.CreatedAtUnixMs || now >= input.ExpiresAtUnixMs || cancellationToken.IsCancellationRequested)
            {
                return Blocked("agent_planner_input_unavailable_or_expired");
            }

            ArticleVaultPlanBuildResult planned = ArticleVaultSyncPlanner.Build(input);
            return planned.Plan is { } plan && planned.IsSuccess
                ? Receipt(ArticleVaultAgentCommandStatus.Completed, "agent_plan_only", plan.ContentSha256)
                : Blocked("agent_canonical_planner_rejected");
        }

        if (request.Command != ArticleVaultAgentCommand.ExecuteVerifiedPlan)
        {
            return Blocked(request.Command == ArticleVaultAgentCommand.MaterializeVerifiedInstruction
                ? "agent_native_conditional_materializer_missing" : "agent_native_observation_admission_missing");
        }

        OperationEntry? operation = FindOperation(request, cancellation: false);
        if (operation is null || request.DeadlineUnixMilliseconds > operation.Reference.Identity.DeadlineUnixMs)
        {
            return Blocked("agent_execution_operation_binding_missing");
        }

        using var deadline = new CancellationTokenSource(
            TimeSpan.FromMilliseconds(request.DeadlineUnixMilliseconds - now), _time);
        using var active = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        lock (_gate)
        {
            if (_revoked || operation.CancelRequested || operation.Active is not null)
            {
                return Blocked("agent_execution_cancelled_or_active");
            }

            operation.Active = active;
        }

        try
        {
            ArticleVaultAgentCanonicalResult result = await _operations.ExecuteAsync(operation.Reference, active.Token)
                .ConfigureAwait(false);
            ArticleVaultOperationIdentity identity = operation.Reference.Identity;
            if (result.OperationIdentity != identity.OperationIdentity || result.IdentitySha256 != identity.ContentSha256
                || result.PlanSha256 != identity.PlanSha256 || !ArticleVaultAgentProtocol.IsDigest(result.ResultSha256)
                || !ArticleVaultManifestValidator.IsIdentity(result.ResultReference) || !Enum.IsDefined(result.Outcome))
            {
                return Blocked("agent_execution_result_binding_invalid");
            }

            lock (_gate)
            {
                if (_revoked || operation.CancelRequested || active.IsCancellationRequested
                    || _time.GetUtcNow().ToUnixTimeMilliseconds() >= request.DeadlineUnixMilliseconds)
                {
                    return Blocked("agent_execution_recovery_required", result.ResultSha256);
                }
            }

            return result.Outcome switch
            {
                ArticleVaultAgentCanonicalOutcome.Completed or ArticleVaultAgentCanonicalOutcome.NoOp
                    => Receipt(ArticleVaultAgentCommandStatus.Completed, "agent_server_result_only", result.ResultSha256),
                ArticleVaultAgentCanonicalOutcome.Cancelled
                    => Receipt(ArticleVaultAgentCommandStatus.Cancelled, "agent_canonical_cancelled", result.ResultSha256),
                _ => Blocked("agent_canonical_execution_failed", result.ResultSha256)
            };
        }
        catch (InvalidDataException exception) when (
            exception.Message is "agent_current_operation_execution_admission_missing" or "agent_operation_execution_checkpoint_required")
        {
            return Blocked(exception.Message);
        }
        catch (Exception)
        {
            // No invented cancellation or success when the canonical result is uncertain.
            return Blocked("agent_execution_canonical_receipt_unavailable");
        }
        finally
        {
            lock (_gate)
            {
                operation.Active = null;
            }
        }

        ArticleVaultAgentCommandReceipt Receipt(
            ArticleVaultAgentCommandStatus status, string? reason, string? result = null)
            => ArticleVaultAgentCommandReceipts.Create(request, frameByteLength, status, reason, result);

        ArticleVaultAgentCommandReceipt Blocked(string reason, string? result = null)
            => Receipt(ArticleVaultAgentCommandStatus.Blocked, reason, result);
    }

    public void Dispose()
    {
        CancellationTokenSource[] active;
        lock (_gate)
        {
            _revoked = true;
            foreach (OperationEntry entry in _registered.Values)
            {
                entry.CancelRequested = true;
            }

            active = _registered.Values.Where(static entry => entry.Active is not null)
                .Select(static entry => entry.Active!).ToArray();
        }

        bool failed = false;
        foreach (CancellationTokenSource cancellation in active)
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // The operation's finally block already disposed this linked source.
            }
            catch (Exception)
            {
                failed = true;
            }
        }

        if (failed)
        {
            throw new InvalidDataException("agent_dispatch_cancellation_drain_failed");
        }
    }

    /// <summary>Returns closed canonical pointers for the lifecycle owner's durable inventory.</summary>
    public IReadOnlyList<ArticleVaultAgentOperationReference> InspectOperationReferences()
    {
        lock (_gate)
        {
            return _registered.Values.Select(static entry =>
                ArticleVaultOperationCodec.Deserialize<ArticleVaultAgentOperationReference>(
                    ArticleVaultOperationCodec.Serialize(entry.Reference))).ToArray();
        }
    }

    /// <summary>
    /// Persists cancellations for this session's registered operations after local authority is
    /// revoked. Historical pointers retained from another session are not adopted or executed.
    /// </summary>
    public async Task CancelRegisteredOperationsAsync(CancellationToken cancellationToken)
    {
        OperationEntry[] entries;
        lock (_gate)
        {
            if (!_revoked)
            {
                throw new InvalidDataException("agent_shutdown_cancellation_requires_revocation");
            }

            entries = _registered.Values.ToArray();
        }

        bool failed = false;
        foreach (OperationEntry entry in entries)
        {
            try
            {
                ArticleVaultAgentOperationReference reference = entry.Reference;
                ArticleVaultAgentOperationSnapshot snapshot = await _operations.ReadAsync(reference, cancellationToken)
                    .ConfigureAwait(false);
                ArticleVaultAgentOperationInventory.RequireCurrentBinding(_binding, _rootManifestSha256, reference, snapshot);
                if (!ArticleVaultOperationVerifier.IsTerminal(snapshot.History[^1].State))
                {
                    await CancelEntryAsync(entry, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception)
            {
                // Continue cancelling the other owned operations; preserve their durable pointers.
                failed = true;
            }
        }

        if (failed)
        {
            throw new InvalidDataException("agent_shutdown_canonical_cancellation_unavailable");
        }
    }

    private async Task<ArticleVaultOperationCheckpoint> CancelEntryAsync(
        OperationEntry entry, CancellationToken cancellationToken)
    {
        ArticleVaultAgentOperationReference previous = entry.Reference;
        ArticleVaultAgentOperationSnapshot snapshot = await _operations.CancelAsync(previous, cancellationToken)
            .ConfigureAwait(false);
        ArticleVaultOperationCheckpoint tip = snapshot.History[^1];
        ArticleVaultAgentOperationReference durable = new(previous.Identity, tip.Sequence, tip.ContentSha256);
        ArticleVaultAgentOperationInventory.RequireCurrentBinding(_binding, _rootManifestSha256, durable, snapshot);
        if (tip.Sequence < previous.CheckpointSequence
            || snapshot.History[(int)previous.CheckpointSequence].ContentSha256 != previous.CheckpointSha256
            || tip.State != VaultOperationState.Cancelled
                && !(tip.State == VaultOperationState.RecoveryRequired && tip.CancellationRequested))
        {
            throw new InvalidDataException("agent_cancel_canonical_receipt_unavailable");
        }

        lock (_gate)
        {
            entry.Reference = durable;
        }

        return tip;
    }

    private OperationEntry? FindOperation(ArticleVaultAgentRequest request, bool cancellation)
    {
        lock (_gate)
        {
            if (request.Reference is not { } reference)
            {
                return null;
            }

            OperationEntry? entry = cancellation
                ? _registered.GetValueOrDefault(reference.Identity)
                : _registered.Values.SingleOrDefault(item => item.ExecuteRequestIdentity == request.RequestIdentity);
            if (entry is null || !cancellation && reference.Identity != entry.Reference.Identity.PlanReference
                || request.CancellationIdentity != entry.CancellationIdentity
                || reference.ContentSha256 != (cancellation ? entry.Reference.Identity.ContentSha256 : entry.Reference.Identity.PlanSha256)
                || !cancellation && request.RequestIdentity != entry.ExecuteRequestIdentity)
            {
                return null;
            }

            return entry;
        }
    }

    private sealed class OperationEntry(
        ArticleVaultAgentOperationReference reference,
        string executeRequestIdentity,
        string cancellationIdentity)
    {
        public ArticleVaultAgentOperationReference Reference
        {
            get; set;
        } = reference;
        public string ExecuteRequestIdentity { get; } = executeRequestIdentity;
        public string CancellationIdentity { get; } = cancellationIdentity;
        public bool CancelRequested
        {
            get; set;
        }
        public CancellationTokenSource? Active
        {
            get; set;
        }
    }
}

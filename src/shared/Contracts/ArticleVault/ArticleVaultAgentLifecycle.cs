namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Defines local authority shutdown intents without generic operations or destructive deletion.</summary>
public enum ArticleVaultAgentShutdownIntent
{
    Stop,
    Logout,
    SiteSwitch,
    Unlink
}

/// <summary>Enumerates all lifecycle states, including retained audit/control state.</summary>
public enum ArticleVaultAgentLifecycleState
{
    Installed,
    Starting,
    Running,
    Stopping,
    Stopped,
    Updating,
    RollbackRequired,
    Crashed,
    Reconnecting,
    Unlinking,
    Removed,
    RetainedControlState
}

/// <summary>Describes closed lifecycle facts; producer receipts remain separately required.</summary>
public enum ArticleVaultAgentLifecycleFact
{
    RequestStart,
    HealthyStart,
    RequestStop,
    OwnedResourcesStopped,
    RequestUpdate,
    HealthyUpdate,
    FailedUpdate,
    RollbackCompleted,
    Crash,
    RequestReconnect,
    RecoveryCompleted,
    RequestUnlink,
    ControlStateRemoved,
    ControlStateRetained,
    ObservationDuringTransition,
    ProtocolMismatch
}

/// <summary>Describes the platform claimed by a lifecycle receipt, not platform qualification.</summary>
public enum ArticleVaultAgentPlatform
{
    Linux,
    Windows,
    MacOS
}

/// <summary>Lists exact durable inputs required for recovery; an in-memory watermark is insufficient.</summary>
public sealed record ArticleVaultAgentRecoveryReferences(
    string RootManifestSha256,
    string SourceTreeSha256,
    string WatcherWatermarkSha256,
    string RescanReceiptSha256,
    string OperationReceiptsSha256);

/// <summary>Records content-addressed lifecycle state, without source, tokens or arbitrary cleanup paths.</summary>
public sealed record ArticleVaultAgentLifecycleReceipt(
    string Schema,
    ArticleVaultAgentBinding Binding,
    ArticleVaultAgentPlatform Platform,
    ArticleVaultAgentLifecycleState PreviousState,
    ArticleVaultAgentLifecycleState NewState,
    long Sequence,
    long ObservedUnixMilliseconds,
    bool RescanRequired,
    long? LeaseGeneration,
    string? LeaseReceiptSha256,
    string? IpcReceiptSha256,
    string? RetainedBinarySha256,
    string? CandidateBinarySha256,
    ArticleVaultAgentRecoveryReferences? Recovery,
    string? ProducerReceiptSha256,
    string? ReasonCode,
    string? PreviousReceiptSha256,
    string ContentSha256);

/// <summary>
/// Reduces closed lifecycle facts and verifies the resulting receipt chain. This is a contract
/// reducer, not a signature/trust verifier, process owner, updater or rescan producer. Its serialized
/// receipts and digest references cannot construct native runtime admission capabilities.
/// </summary>
public static class ArticleVaultAgentLifecycle
{
    public static ArticleVaultAgentLifecycleReceipt Initial(
        ArticleVaultAgentBinding binding,
        ArticleVaultAgentPlatform platform,
        long nowUnixMilliseconds)
    {
        if (!ArticleVaultAgentProtocol.IsBinding(binding) || !Enum.IsDefined(platform) || nowUnixMilliseconds < 0)
        {
            throw new InvalidDataException("agent_lifecycle_binding_invalid");
        }

        // Initial is a stopped control receipt, never evidence that a binary was installed/trusted.
        return Seal(new(ArticleVaultAgentProtocol.LifecycleSchema, binding, platform,
            ArticleVaultAgentLifecycleState.Stopped, ArticleVaultAgentLifecycleState.Stopped,
            1, nowUnixMilliseconds, true, null, null, null, null, null, null,
            null, "runtime_admission_required", null, string.Empty));
    }

    public static bool Verify(ArticleVaultAgentLifecycleReceipt? receipt)
    {
        if (receipt is null || receipt.Schema != ArticleVaultAgentProtocol.LifecycleSchema
            || !ArticleVaultAgentProtocol.IsBinding(receipt.Binding) || !Enum.IsDefined(receipt.Platform)
            || !Enum.IsDefined(receipt.PreviousState) || !Enum.IsDefined(receipt.NewState)
            || receipt.Sequence < 1 || receipt.ObservedUnixMilliseconds < 0
            || !OptionalDigest(receipt.LeaseReceiptSha256) || !OptionalDigest(receipt.IpcReceiptSha256)
            || !OptionalDigest(receipt.RetainedBinarySha256) || !OptionalDigest(receipt.CandidateBinarySha256)
            || !OptionalDigest(receipt.ProducerReceiptSha256) || !OptionalDigest(receipt.PreviousReceiptSha256)
            || (receipt.ReasonCode is not null && !IsReason(receipt.ReasonCode))
            || (receipt.Recovery is not null && !ValidRecovery(receipt.Recovery))
            || (receipt.Sequence == 1 ? receipt.PreviousReceiptSha256 is not null : receipt.PreviousReceiptSha256 is null)
            || (receipt.LeaseGeneration is null ? receipt.LeaseReceiptSha256 is not null
                : receipt.LeaseGeneration < 1 || receipt.LeaseReceiptSha256 is null))
        {
            return false;
        }

        if (receipt.NewState == ArticleVaultAgentLifecycleState.Running
            && (receipt.RescanRequired || receipt.Recovery is null || receipt.LeaseGeneration is null
                || receipt.IpcReceiptSha256 is null || receipt.ProducerReceiptSha256 is null
                || receipt.CandidateBinarySha256 is not null))
        {
            return false;
        }

        return receipt.ContentSha256 == ArticleVaultAgentProtocol.Digest(receipt with
        {
            ContentSha256 = string.Empty
        });
    }

    public static ArticleVaultAgentLifecycleReceipt Reduce(
        ArticleVaultAgentLifecycleReceipt previous,
        ArticleVaultAgentLifecycleFact fact,
        string expectedPreviousReceiptSha256,
        long nowUnixMilliseconds,
        string? producerReceiptSha256 = null,
        string? candidateBinarySha256 = null,
        ArticleVaultAgentRecoveryReferences? recovery = null,
        ArticleVaultWriterLeaseReceipt? lease = null,
        string? ipcReceiptSha256 = null)
    {
        if (!Verify(previous) || !Enum.IsDefined(fact) || previous.Sequence == long.MaxValue
            || expectedPreviousReceiptSha256 != previous.ContentSha256
            || nowUnixMilliseconds < previous.ObservedUnixMilliseconds
            || !OptionalDigest(producerReceiptSha256) || !OptionalDigest(candidateBinarySha256)
            || !OptionalDigest(ipcReceiptSha256) || (recovery is not null && !ValidRecovery(recovery)))
        {
            throw new InvalidDataException("agent_lifecycle_input_or_chain_invalid");
        }

        ArticleVaultAgentLifecycleState state = Next(previous.NewState, fact);
        bool healthy = fact is ArticleVaultAgentLifecycleFact.HealthyStart
            or ArticleVaultAgentLifecycleFact.HealthyUpdate or ArticleVaultAgentLifecycleFact.RecoveryCompleted;
        if (healthy && (producerReceiptSha256 is null || recovery is null || ipcReceiptSha256 is null
            || lease is null || !ArticleVaultWriterLease.Verify(lease) || lease.Binding != previous.Binding
            || lease.State != ArticleVaultWriterLeaseState.Active || nowUnixMilliseconds >= lease.DeadlineUnixMilliseconds
            || nowUnixMilliseconds < lease.ObservedUnixMilliseconds))
        {
            throw new InvalidDataException("agent_lifecycle_current_recovery_lease_ipc_required");
        }

        if (fact == ArticleVaultAgentLifecycleFact.RequestUpdate && candidateBinarySha256 is null)
        {
            throw new InvalidDataException("agent_lifecycle_candidate_missing");
        }

        if (fact is ArticleVaultAgentLifecycleFact.OwnedResourcesStopped
            or ArticleVaultAgentLifecycleFact.RollbackCompleted
            or ArticleVaultAgentLifecycleFact.ControlStateRemoved
            or ArticleVaultAgentLifecycleFact.ControlStateRetained
            && producerReceiptSha256 is null)
        {
            throw new InvalidDataException("agent_lifecycle_terminal_producer_missing");
        }

        ArticleVaultAgentBinding binding = previous.Binding;
        string? retained = previous.RetainedBinarySha256;
        string? candidate = previous.CandidateBinarySha256;
        if (fact == ArticleVaultAgentLifecycleFact.RequestUpdate)
        {
            retained = binding.BinarySha256;
            candidate = candidateBinarySha256;
        }
        else if (fact == ArticleVaultAgentLifecycleFact.HealthyUpdate)
        {
            if (candidate is null || retained is null)
            {
                throw new InvalidDataException("agent_lifecycle_update_stage_missing");
            }

            // Binary/version handoff requires a new independently admitted runtime binding.
            // The contract does not invent that binding from a staged digest.
            state = ArticleVaultAgentLifecycleState.Reconnecting;
        }
        else if (fact == ArticleVaultAgentLifecycleFact.RollbackCompleted)
        {
            if (retained != binding.BinarySha256)
            {
                throw new InvalidDataException("agent_lifecycle_rollback_identity_drift");
            }

            candidate = null;
        }

        bool rescan = !healthy || state != ArticleVaultAgentLifecycleState.Running;
        if (fact == ArticleVaultAgentLifecycleFact.ObservationDuringTransition)
        {
            rescan = true;
        }

        bool holdsLease = state == ArticleVaultAgentLifecycleState.Running;
        string? reason = fact switch
        {
            ArticleVaultAgentLifecycleFact.ProtocolMismatch => "protocol_mismatch_blocked",
            ArticleVaultAgentLifecycleFact.FailedUpdate => "update_failed_rollback_required",
            ArticleVaultAgentLifecycleFact.Crash => "crash_rebuild_required",
            ArticleVaultAgentLifecycleFact.ObservationDuringTransition => "events_blocked_rescan_required",
            ArticleVaultAgentLifecycleFact.HealthyUpdate => "new_binary_runtime_binding_required",
            _ => rescan ? "rescan_required" : null
        };
        var receipt = new ArticleVaultAgentLifecycleReceipt(ArticleVaultAgentProtocol.LifecycleSchema,
            binding, previous.Platform, previous.NewState, state, previous.Sequence + 1, nowUnixMilliseconds,
            rescan, holdsLease ? lease!.Generation : null, holdsLease ? lease!.ContentSha256 : null,
            holdsLease ? ipcReceiptSha256 : null, retained, candidate,
            healthy ? recovery : null, producerReceiptSha256, reason, previous.ContentSha256, string.Empty);
        receipt = Seal(receipt);
        if (!Verify(receipt))
        {
            throw new InvalidDataException("agent_lifecycle_result_invalid");
        }

        return receipt;
    }

    private static ArticleVaultAgentLifecycleState Next(
        ArticleVaultAgentLifecycleState state,
        ArticleVaultAgentLifecycleFact fact)
        => (state, fact) switch
        {
            (ArticleVaultAgentLifecycleState.Installed or ArticleVaultAgentLifecycleState.Stopped, ArticleVaultAgentLifecycleFact.RequestStart) => ArticleVaultAgentLifecycleState.Starting,
            (ArticleVaultAgentLifecycleState.Starting, ArticleVaultAgentLifecycleFact.HealthyStart) => ArticleVaultAgentLifecycleState.Running,
            (ArticleVaultAgentLifecycleState.Running or ArticleVaultAgentLifecycleState.Starting or ArticleVaultAgentLifecycleState.Reconnecting, ArticleVaultAgentLifecycleFact.RequestStop) => ArticleVaultAgentLifecycleState.Stopping,
            (ArticleVaultAgentLifecycleState.Stopping, ArticleVaultAgentLifecycleFact.OwnedResourcesStopped) => ArticleVaultAgentLifecycleState.Stopped,
            (ArticleVaultAgentLifecycleState.Running or ArticleVaultAgentLifecycleState.Stopped, ArticleVaultAgentLifecycleFact.RequestUpdate) => ArticleVaultAgentLifecycleState.Updating,
            (ArticleVaultAgentLifecycleState.Updating, ArticleVaultAgentLifecycleFact.HealthyUpdate) => ArticleVaultAgentLifecycleState.Reconnecting,
            (ArticleVaultAgentLifecycleState.Updating, ArticleVaultAgentLifecycleFact.FailedUpdate) => ArticleVaultAgentLifecycleState.RollbackRequired,
            (ArticleVaultAgentLifecycleState.RollbackRequired, ArticleVaultAgentLifecycleFact.RollbackCompleted) => ArticleVaultAgentLifecycleState.Stopped,
            (ArticleVaultAgentLifecycleState.Starting or ArticleVaultAgentLifecycleState.Running or ArticleVaultAgentLifecycleState.Stopping or ArticleVaultAgentLifecycleState.Updating or ArticleVaultAgentLifecycleState.Reconnecting, ArticleVaultAgentLifecycleFact.Crash) => ArticleVaultAgentLifecycleState.Crashed,
            (ArticleVaultAgentLifecycleState.Crashed or ArticleVaultAgentLifecycleState.Stopped, ArticleVaultAgentLifecycleFact.RequestReconnect) => ArticleVaultAgentLifecycleState.Reconnecting,
            (ArticleVaultAgentLifecycleState.Reconnecting, ArticleVaultAgentLifecycleFact.RecoveryCompleted) => ArticleVaultAgentLifecycleState.Running,
            (ArticleVaultAgentLifecycleState.Running or ArticleVaultAgentLifecycleState.Stopped or ArticleVaultAgentLifecycleState.Crashed or ArticleVaultAgentLifecycleState.RollbackRequired, ArticleVaultAgentLifecycleFact.RequestUnlink) => ArticleVaultAgentLifecycleState.Unlinking,
            (ArticleVaultAgentLifecycleState.Unlinking, ArticleVaultAgentLifecycleFact.ControlStateRemoved) => ArticleVaultAgentLifecycleState.Removed,
            (ArticleVaultAgentLifecycleState.Unlinking, ArticleVaultAgentLifecycleFact.ControlStateRetained) => ArticleVaultAgentLifecycleState.RetainedControlState,
            (ArticleVaultAgentLifecycleState.Starting or ArticleVaultAgentLifecycleState.Running or ArticleVaultAgentLifecycleState.Reconnecting or ArticleVaultAgentLifecycleState.Updating, ArticleVaultAgentLifecycleFact.ProtocolMismatch) => ArticleVaultAgentLifecycleState.Stopping,
            (ArticleVaultAgentLifecycleState.Starting or ArticleVaultAgentLifecycleState.Stopping or ArticleVaultAgentLifecycleState.Updating or ArticleVaultAgentLifecycleState.RollbackRequired or ArticleVaultAgentLifecycleState.Crashed or ArticleVaultAgentLifecycleState.Reconnecting or ArticleVaultAgentLifecycleState.Unlinking, ArticleVaultAgentLifecycleFact.ObservationDuringTransition) => state,
            _ => throw new InvalidDataException("agent_lifecycle_transition_invalid")
        };

    private static bool OptionalDigest(string? value) => value is null || ArticleVaultAgentProtocol.IsDigest(value);

    private static bool ValidRecovery(ArticleVaultAgentRecoveryReferences references)
        => ArticleVaultAgentProtocol.IsDigest(references.RootManifestSha256)
            && ArticleVaultAgentProtocol.IsDigest(references.SourceTreeSha256)
            && ArticleVaultAgentProtocol.IsDigest(references.WatcherWatermarkSha256)
            && ArticleVaultAgentProtocol.IsDigest(references.RescanReceiptSha256)
            && ArticleVaultAgentProtocol.IsDigest(references.OperationReceiptsSha256);

    private static bool IsReason(string value)
        => value is { Length: >= 1 and <= 64 }
            && value.All(static character => char.IsAsciiLetterOrDigit(character) || character == '_');

    private static ArticleVaultAgentLifecycleReceipt Seal(ArticleVaultAgentLifecycleReceipt receipt)
        => receipt with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(receipt with
            {
                ContentSha256 = string.Empty
            })
        };
}

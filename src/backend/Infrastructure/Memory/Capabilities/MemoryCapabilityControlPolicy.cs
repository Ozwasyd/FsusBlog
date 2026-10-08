using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Host;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Infrastructure.Memory.Capabilities;

public enum MemoryCapabilityControlReason
{
    Ready, UnmetBaseline, UnmetGovernor, ReleaseUnqualified, Disabled, Draining,
    DependencyUnavailable, Unknown, Absent, Unsupported, PermissionDenied, RuntimeUnqualified,
    BudgetRejected, ProbeFault, ProbeCancelled, ProbeTimedOut, StaleCompletion, RetryDeferred, CircuitOpen,
    InvalidIdentity, DrainFault
}

// CONFIGURATION: These are explicit frozen owner inputs, never production defaults.
public sealed record MemoryCapabilityControlPolicy(ulong Revision, ulong GovernorPolicyRevision,
    MemoryGovernorBaselineBinding Baseline, int MaximumConcurrentProbes, int MaximumAttemptsPerWindow,
    TimeSpan MaximumProbeDuration, TimeSpan MaximumGovernorAge, TimeSpan RetryCooldown, TimeSpan CircuitCooldown);

public sealed record MemoryCapabilityRuntimeIdentity(string IdentityDigest, DeviceEpoch Epoch);
public sealed record MemoryCapabilityReleaseBinding(string CandidateCommit, string IdentityDigest,
    MemoryQualification Qualification, DateTimeOffset ValidUntil);
public sealed record MemoryCapabilityProbeContext(string CapabilityId, ulong PolicyRevision,
    ulong Generation, MemoryCapabilityRuntimeIdentity Identity);
public sealed record MemoryCapabilityProbeOutcome(MemoryDetection Detection, MemoryQualification RuntimeQualification,
    MemoryCapabilityControlReason Reason, MemoryCapabilityOwner? Owner);
public sealed record MemoryCapabilityBackendBinding(string CapabilityId, string EffectivePath,
    IReadOnlyList<MemoryResourceCharge> ProbeCharges,
    Func<MemoryCapabilityProbeContext, CancellationToken, ValueTask<MemoryCapabilityProbeOutcome>> Probe);
public sealed record MemoryCapabilityControlResult(MemoryCapabilityStatus Status,
    MemoryCapabilityControlReason Reason, bool RequiredSatisfied, bool ProbeStarted);
public sealed record MemoryCapabilitySelection(string CapabilityId, ulong PolicyRevision, ulong Generation);

/// <summary>
/// Bridges existing managed/native retirement and their actual final-drain task.
/// No disk/GPU completion is inferred from IDisposable or an empty logical target.
/// </summary>
public sealed class MemoryCapabilityOwner
{
    private readonly Action _retire;
    private int _retired;

    private MemoryCapabilityOwner(Action retire, Task drained)
    {
        _retire = retire;
        Drained = drained;
    }

    public Task Drained
    {
        get;
    }

    public static MemoryCapabilityOwner FromManaged(ManagedMemoryBacking owner)
    {
        ArgumentNullException.ThrowIfNull(owner);
        return new(owner.Dispose, owner.Drained);
    }

    public static MemoryCapabilityOwner FromNative(NativeMemoryArena owner)
    {
        ArgumentNullException.ThrowIfNull(owner);
        return new(owner.Dispose, owner.Drained);
    }

    internal void BeginRetirement()
    {
        if (Interlocked.Exchange(ref _retired, 1) == 0)
        {
            _retire();
        }
    }
}

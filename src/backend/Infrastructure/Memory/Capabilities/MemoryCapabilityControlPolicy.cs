using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Disk;
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
/// Bridges existing owner retirement and actual final-drain tasks. Disk root ownership
/// is explicitly transferred by the caller with its complete, bounded borrower roster.
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

    public static MemoryCapabilityOwner FromGpu(GpuMemoryDevice owner)
    {
        ArgumentNullException.ThrowIfNull(owner);
        return new(owner.Dispose, owner.Drained);
    }

    /// <summary>
    /// The caller transfers its exclusively owned root and freezes the complete borrower
    /// roster before this call. No new borrower may be created after transfer. Store drain
    /// covers store resources only; the caller's root closes after every borrower drains.
    /// The finite roster limit is supplied by the existing frozen ownership policy.
    /// </summary>
    public static MemoryCapabilityOwner FromDisk(OwnedSpillRoot ownedRoot,
        IReadOnlyList<DiskSegmentStore> borrowers, int maximumBorrowers)
    {
        ArgumentNullException.ThrowIfNull(ownedRoot);
        ArgumentNullException.ThrowIfNull(borrowers);
        if (maximumBorrowers <= 0 || borrowers.Count <= 0 || borrowers.Count > maximumBorrowers)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBorrowers));
        }
        var stores = new DiskSegmentStore[borrowers.Count];
        for (int index = 0; index < stores.Length; index++)
        {
            stores[index] = borrowers[index] ?? throw new ArgumentException("Missing disk borrower.", nameof(borrowers));
            for (int prior = 0; prior < index; prior++)
            {
                if (ReferenceEquals(stores[prior], stores[index]))
                {
                    throw new ArgumentException("Duplicate disk borrower.", nameof(borrowers));
                }
            }
        }
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        return new(() => RetireDiskRoot(ownedRoot, stores, completed), completed.Task);
    }

    private static void RetireDiskRoot(OwnedSpillRoot ownedRoot, DiskSegmentStore[] stores, TaskCompletionSource completed)
    {
        var failures = new List<Exception>();
        foreach (DiskSegmentStore store in stores)
        {
            try
            {
                store.Disable();
            }
            catch (Exception exception)
            {
                failures.Add(exception);
            }
        }
        _ = CloseDiskRootAfterDrainAsync(ownedRoot, stores, failures, completed);
    }

    private static async Task CloseDiskRootAfterDrainAsync(OwnedSpillRoot ownedRoot, DiskSegmentStore[] stores,
        IReadOnlyList<Exception> retirementFailures, TaskCompletionSource completed)
    {
        try
        {
            if (retirementFailures.Count != 0)
            {
                completed.TrySetException(new AggregateException(retirementFailures));
            }
            await Task.WhenAll(stores.Select(store => ObserveDiskBorrowerAsync(store, completed))).ConfigureAwait(false);
            if (completed.Task.IsCompleted)
            {
                return;
            }
            ownedRoot.Dispose();
            completed.TrySetResult();
        }
        catch (Exception exception)
        {
            // Failed/uncertain store custody keeps the caller's root open and retained.
            completed.TrySetException(exception);
        }
    }

    private static async Task ObserveDiskBorrowerAsync(DiskSegmentStore store, TaskCompletionSource completed)
    {
        try
        {
            await store.Drained.ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            completed.TrySetException(exception);
        }
    }

    internal void BeginRetirement()
    {
        if (Interlocked.Exchange(ref _retired, 1) == 0)
        {
            _retire();
        }
    }
}

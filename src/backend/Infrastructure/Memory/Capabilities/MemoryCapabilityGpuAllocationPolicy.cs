using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Capabilities;

public sealed record MemoryCapabilityGpuAllocationBound(string CapabilityId, ulong PolicyRevision,
    ulong AccountingRevision, MemoryCapabilityRuntimeIdentity Identity, GpuMemoryDomains Domains,
    GpuMemoryLimits Limits, DateTimeOffset ValidUntil);

/// <summary>
/// Retains explicit owner-declared physical bounds for one identity and policy revision.
/// Missing bounds cannot be inferred from a request or observation. This control-plane
/// contract neither qualifies a device nor reserves capacity; actual allocation still
/// enters the canonical coordinator after these inputs are checked.
/// </summary>
public sealed class MemoryCapabilityGpuAllocationPolicy
{
    private readonly MemoryCapabilityGpuAllocationBound? _bound;
    private readonly TimeProvider _clock;
    private readonly long _createdTimestamp;
    private readonly TimeSpan _validDuration;

    public MemoryCapabilityGpuAllocationPolicy(MemoryCapabilityGpuAllocationBound? bound, TimeProvider? clock = null)
    {
        _clock = clock ?? TimeProvider.System;
        if (_clock.TimestampFrequency <= 0)
        {
            throw new ArgumentException("A monotonic clock requires a positive timestamp frequency.", nameof(clock));
        }
        _createdTimestamp = _clock.GetTimestamp();
        if (bound is not null)
        {
            ArgumentNullException.ThrowIfNull(bound.Identity);
            ArgumentNullException.ThrowIfNull(bound.Domains);
            ArgumentNullException.ThrowIfNull(bound.Limits);
            GpuMemoryLimits limits = bound.Limits;
            if (string.IsNullOrWhiteSpace(bound.CapabilityId) || bound.CapabilityId.Length > 128
                || bound.PolicyRevision == 0 || bound.AccountingRevision == 0
                || !MemoryGovernorPolicy.ValidDigest(bound.Identity.IdentityDigest, 64) || bound.Identity.Epoch.Value == 0
                || bound.ValidUntil == DateTimeOffset.MaxValue || limits.MaximumAllocationBytes <= 0
                || limits.MaximumAllocations <= 0 || limits.MaximumStagingBuffers <= 0 || limits.MaximumOperations <= 0
                || limits.StagingAlignmentBytes <= 0 || (limits.StagingAlignmentBytes & (limits.StagingAlignmentBytes - 1)) != 0
                || limits.MaximumObservedDeviceCapacityBytes < limits.MaximumAllocationBytes
                || limits.MaximumObservedStagingCapacityBytes < limits.MaximumAllocationBytes)
            {
                throw new ArgumentException("GPU bounds require explicit valid identity, revisions, finite expiry and limits.", nameof(bound));
            }
            _bound = bound with
            {
                Limits = limits with
                {
                }
            };
            _validDuration = bound.ValidUntil - _clock.GetUtcNow();
        }
    }

    public MemoryOperationResult<GpuMemoryLimits> TryGetLimits(MemoryCapabilityProbeContext context,
        MemoryReservationCoordinator ledger)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(ledger);
        if (_bound is null || _bound.Limits.MaximumObservedDeviceCapacityBytes is null
            || _bound.Limits.MaximumObservedStagingCapacityBytes is null
            || _bound.ValidUntil <= _clock.GetUtcNow())
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.TierUnavailable);
        }
        TimeSpan elapsed = _clock.GetElapsedTime(_createdTimestamp, _clock.GetTimestamp());
        if (elapsed < TimeSpan.Zero || elapsed >= _validDuration)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.TierUnavailable);
        }
        MemoryAccountingSnapshot accounting = ledger.Snapshot();
        if (context.Generation == 0 || context.CapabilityId != _bound.CapabilityId
            || context.PolicyRevision != _bound.PolicyRevision || context.Identity != _bound.Identity
            || accounting.PolicyRevision != _bound.AccountingRevision)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.StaleLocation);
        }
        if (accounting.Faulted)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.OwnershipViolation);
        }
        var required = new Dictionary<string, long>(StringComparer.Ordinal);
        try
        {
            AddBound(ledger.Topology, required, _bound.Domains.Device, MemoryResourceUnit.Bytes,
                _bound.Limits.MaximumObservedDeviceCapacityBytes.Value);
            AddBound(ledger.Topology, required, _bound.Domains.RegisteredHost, MemoryResourceUnit.Bytes,
                _bound.Limits.MaximumObservedStagingCapacityBytes.Value);
            AddBound(ledger.Topology, required, _bound.Domains.TransferSlots, MemoryResourceUnit.OperationSlots, 1);
        }
        catch (KeyNotFoundException)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.BoundsViolation);
        }
        catch (ArgumentException)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.BoundsViolation);
        }
        catch (OverflowException)
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.BoundsViolation);
        }
        if (required.Keys.Any(key => !accounting.EnforcedHardCaps.ContainsKey(key)))
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.TierUnavailable);
        }
        if (required.Any(item => item.Value > accounting.EnforcedHardCaps[item.Key]))
        {
            return MemoryOperationResult<GpuMemoryLimits>.Reject(MemoryFailure.BudgetRejected);
        }
        return MemoryOperationResult<GpuMemoryLimits>.Success(_bound.Limits);
    }

    private static void AddBound(MemoryResourceTopology topology, Dictionary<string, long> required,
        ResourceDomainId domain, MemoryResourceUnit unit, long amount)
    {
        var capacities = new HashSet<string>(StringComparer.Ordinal);
        foreach (MemoryResourceDomain constraint in topology.ConstraintChain(domain))
        {
            if (constraint.Unit != unit)
            {
                throw new ArgumentException("GPU domain has an incompatible unit.", nameof(domain));
            }
            if (capacities.Add(constraint.CapacityIdentity))
            {
                required[constraint.CapacityIdentity] = checked(required.GetValueOrDefault(constraint.CapacityIdentity) + amount);
            }
        }
    }
}

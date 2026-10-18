using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

namespace FsusBlog.Server.Infrastructure.Memory.Accounting;

/// <summary>
/// Retains an owner-supplied physical upper bound without deriving one from sampled blocks.
/// A missing bound rejects use. This contract does not establish filesystem qualification.
/// </summary>
public sealed class FrozenDiskPhysicalAllocationPolicy : IDiskPhysicalAllocationPolicy
{
    private readonly DiskPhysicalAllocationBound? _bound;
    private readonly TimeProvider _timeProvider;

    public FrozenDiskPhysicalAllocationPolicy(DiskPhysicalAllocationBound? bound, TimeProvider? timeProvider = null)
    {
        if (bound is not null && (string.IsNullOrWhiteSpace(bound.CapacityIdentity) || bound.RootInode == 0
            || bound.MaximumLogicalBytes <= 0 || bound.MaximumChargeBytes < bound.MaximumLogicalBytes
            || bound.PolicyRevision == 0 || bound.ValidUntil == DateTimeOffset.MaxValue))
        {
            throw new ArgumentException("A physical bound requires finite bytes, root identity, revision and expiry.", nameof(bound));
        }
        _bound = bound;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public MemoryOperationResult<DiskPhysicalAllocationBound> TryGetBound(DiskFileFootprint root, long logicalBytes)
    {
        ArgumentNullException.ThrowIfNull(root);
        if (logicalBytes <= 0)
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.BoundsViolation);
        }
        DateTimeOffset now = _timeProvider.GetUtcNow();
        if (_bound is null || _bound.ValidUntil <= now || !root.IsDirectory
            || root.CapacityIdentity != _bound.CapacityIdentity || root.Inode != _bound.RootInode
            || root.SampledAt > now || root.LogicalBytes < 0 || root.AllocatedFileBytes < 0)
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.TierUnavailable);
        }
        if (logicalBytes > _bound.MaximumLogicalBytes)
        {
            return MemoryOperationResult<DiskPhysicalAllocationBound>.Reject(MemoryFailure.BoundsViolation);
        }
        return MemoryOperationResult<DiskPhysicalAllocationBound>.Success(_bound);
    }
}

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryDiskPolicyTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
    private static DiskFileFootprint Root => new("volume", 23, 4096, 4096, true, s_now, new(0, 0, 0, 0));
    private static DiskPhysicalAllocationBound Bound => new("volume", 23, 1024, 8192, 3, s_now.AddMinutes(1));

    [Fact]
    public void UpperBoundIsRetainedRatherThanInferredFromLogicalOrObservedBytes()
    {
        var policy = new FrozenDiskPhysicalAllocationPolicy(Bound, new Clock());
        Assert.Equal(Bound, policy.TryGetBound(Root, 1).Value);
        Assert.Equal(Bound, policy.TryGetBound(Root with
        {
            AllocatedFileBytes = 0
        }, 1024).Value);
        Assert.Equal(MemoryFailure.BoundsViolation, policy.TryGetBound(Root, 1025).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, policy.TryGetBound(Root, long.MaxValue).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, policy.TryGetBound(Root, 0).Failure);
    }

    [Fact]
    public void MissingExpiredOrWrongRootBoundsCannotAdmitPhysicalCapacity()
    {
        Assert.Equal(MemoryFailure.TierUnavailable,
            new FrozenDiskPhysicalAllocationPolicy(null, new Clock()).TryGetBound(Root, 1).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable,
            new FrozenDiskPhysicalAllocationPolicy(Bound with
            {
                ValidUntil = s_now
            }, new Clock()).TryGetBound(Root, 1).Failure);
        var policy = new FrozenDiskPhysicalAllocationPolicy(Bound, new Clock());
        foreach (DiskFileFootprint wrong in new[] { Root with { Inode = 24 }, Root with { CapacityIdentity = "other" },
            Root with { IsDirectory = false }, Root with { SampledAt = s_now.AddTicks(1) }, Root with { AllocatedFileBytes = -1 } })
        {
            Assert.Equal(MemoryFailure.TierUnavailable, policy.TryGetBound(wrong, 1).Failure);
        }
        Assert.Throws<ArgumentException>(() => new FrozenDiskPhysicalAllocationPolicy(Bound with { MaximumChargeBytes = 1 }));
        Assert.Throws<ArgumentException>(() => new FrozenDiskPhysicalAllocationPolicy(Bound with { PolicyRevision = 0 }));
        Assert.Throws<ArgumentException>(() => new FrozenDiskPhysicalAllocationPolicy(Bound with { ValidUntil = DateTimeOffset.MaxValue }));
    }

    [Fact]
    public void InodeExhaustionRejectsWholeVectorIndependentlyOfOperationSlots()
    {
        ResourceDomainId bytes = new(Guid.NewGuid());
        ResourceDomainId slots = new(Guid.NewGuid());
        ResourceDomainId inodes = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology(new MemoryResourceDomain[]
        {
            new(bytes, "disk-bytes", MemoryResourceUnit.Bytes, null),
            new(slots, "operations", MemoryResourceUnit.OperationSlots, null),
            new(inodes, "volume-inodes", MemoryResourceUnit.Inodes, null)
        });
        var ledger = new MemoryReservationCoordinator(topology, new MemoryResourceLimit[]
        {
            new(bytes, MemoryResourceUnit.Bytes, 100), new(slots, MemoryResourceUnit.OperationSlots, 4),
            new(inodes, MemoryResourceUnit.Inodes, 1)
        }, 1, 8, 16);
        using MemoryReservation held = ledger.TryReserve(new MemoryResourceCharge[]
        {
            new(bytes, MemoryResourceUnit.Bytes, 1), new(slots, MemoryResourceUnit.OperationSlots, 1),
            new(inodes, MemoryResourceUnit.Inodes, 1)
        }).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve(new MemoryResourceCharge[]
        {
            new(bytes, MemoryResourceUnit.Bytes, 1), new(slots, MemoryResourceUnit.OperationSlots, 1),
            new(inodes, MemoryResourceUnit.Inodes, 1)
        }).Failure);
        Assert.Equal(1, ledger.Snapshot().Reservations);
        Assert.All(ledger.Snapshot().Used.Values, used => Assert.Equal(1, used));
        using MemoryReservation operation = ledger.TryReserve(new[] { new MemoryResourceCharge(slots, MemoryResourceUnit.OperationSlots, 3) }).Value!;
        Assert.Equal(4, ledger.Snapshot().Used["operations"]);
        operation.Dispose();
        held.Dispose();
        Assert.All(ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
        Assert.Throws<ArgumentException>(() => new MemoryResourceTopology(new MemoryResourceDomain[]
        {
            new(inodes, "same", MemoryResourceUnit.Inodes, null),
            new(slots, "same", MemoryResourceUnit.OperationSlots, null)
        }));
    }

    private sealed class Clock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_now;
    }
}

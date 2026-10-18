using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryExistingAllocationTests
{
    [Fact]
    public void DefaultCoordinatorCannotUseExistingRegistrationAsFreshAllocationCredit()
    {
        Fixture fixture = Create(false);
        using MemoryReservation reservation = fixture.Ledger.TryReserve([Bytes(fixture.Host, 1)]).Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, reservation.CommitObservedExisting(Descriptor(fixture.Disk, 5),
            [Bytes(fixture.Disk, 5)], [], 1).Failure);
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["disk"]);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void ExistingOverCapBytesAndInodesStayVisibleWhileOnlyNewIndexUsesAdmission()
    {
        Fixture fixture = Create();
        using MemoryReservation reservation = fixture.Ledger.TryReserve([Bytes(fixture.Host, 4), Slots(fixture.Slots, 1)]).Value!;
        using IMemoryAllocationCharge owner = reservation.CommitObservedExisting(Descriptor(fixture.Disk, 5),
            [Bytes(fixture.Disk, 5), new(fixture.Inodes, MemoryResourceUnit.Inodes, 1)], [Bytes(fixture.Host, 2)], 1).Value!;
        MemoryAccountingSnapshot snapshot = fixture.Ledger.Snapshot();
        Assert.True(snapshot.OverTarget);
        Assert.Equal(5, snapshot.Used["disk"]);
        Assert.Equal(1, snapshot.Used["inodes"]);
        Assert.Equal(2, snapshot.Used["host"]);
        Assert.Equal(0, snapshot.Used["slots"]);
        Assert.Equal(0, snapshot.Reservations);
        Assert.Equal(1, snapshot.Allocations);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Ledger.TryReserve([Bytes(fixture.Disk, 1)]).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Ledger.TryReserve([new(fixture.Inodes, MemoryResourceUnit.Inodes, 1)]).Failure);
        AssertReplay(fixture.Ledger);
        // Failed/blocked deletion leaves this owner untouched; an attempted growth is no release.
        Assert.Equal(5, fixture.Ledger.Snapshot().Used["disk"]);
        owner.Dispose();
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
        AssertReplay(fixture.Ledger);
    }

    [Fact]
    public void NewResourceExcessAndUnknownPersistentRoleLeaveTheScratchReservationIntact()
    {
        Fixture fixture = Create();
        using MemoryReservation reservation = fixture.Ledger.TryReserve([Bytes(fixture.Host, 2)]).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, reservation.CommitObservedExisting(Descriptor(fixture.Disk, 5),
            [Bytes(fixture.Disk, 5)], [Bytes(fixture.Host, 3)], 1).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, reservation.CommitObservedExisting(Descriptor(fixture.Host, 2),
            [Bytes(fixture.Host, 2)], [], 1).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, reservation.CommitObservedExisting(Descriptor(fixture.Disk, 5),
            [Bytes(fixture.Disk, 5)], [Bytes(fixture.Disk, 1)], 1).Failure);
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(1, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(2, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["disk"]);
        reservation.Dispose();
        AssertReplay(fixture.Ledger);
    }

    [Fact]
    public void StalePolicyDescriptorMismatchAndDuplicateIdentityCannotAdopt()
    {
        Fixture fixture = Create();
        using MemoryReservation reservation = fixture.Ledger.TryReserve([Bytes(fixture.Host, 2)]).Value!;
        MemoryAllocationDescriptor descriptor = Descriptor(fixture.Disk, 5);
        Assert.Equal(MemoryFailure.OwnershipViolation, reservation.CommitObservedExisting(descriptor,
            [Bytes(fixture.Disk, 5)], [Bytes(fixture.Host, 2)], 2).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, reservation.CommitObservedExisting(descriptor,
            [Bytes(fixture.Disk, 4)], [Bytes(fixture.Host, 2)], 1).Failure);
        using IMemoryAllocationCharge owner = reservation.CommitObservedExisting(descriptor,
            [Bytes(fixture.Disk, 5)], [Bytes(fixture.Host, 2)], 1).Value!;
        using MemoryReservation second = fixture.Ledger.TryReserve([Bytes(fixture.Host, 2)]).Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, second.CommitObservedExisting(descriptor,
            [Bytes(fixture.Disk, 5)], [Bytes(fixture.Host, 2)], 1).Failure);
        Assert.True(fixture.Ledger.Snapshot().Faulted);
        Assert.Single(fixture.Ledger.Allocations());
        second.Dispose();
        owner.Dispose();
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
        AssertReplay(fixture.Ledger);
    }

    [Fact]
    public void ExistingRegistrationOverflowIsAtomicAndDoesNotHideLiveOccupancy()
    {
        Fixture fixture = Create();
        using MemoryReservation reservation = fixture.Ledger.TryReserve([Bytes(fixture.Host, 1)]).Value!;
        using IMemoryAllocationCharge owner = reservation.CommitObservedExisting(Descriptor(fixture.Disk, long.MaxValue),
            [Bytes(fixture.Disk, long.MaxValue)], [], 1).Value!;
        using MemoryReservation second = fixture.Ledger.TryReserve([Bytes(fixture.Host, 1)]).Value!;
        Assert.Equal(MemoryFailure.BoundsViolation, second.CommitObservedExisting(Descriptor(fixture.Disk, 1),
            [Bytes(fixture.Disk, 1)], [], 1).Failure);
        Assert.Equal(long.MaxValue, fixture.Ledger.Snapshot().Used["disk"]);
        Assert.Single(fixture.Ledger.Allocations());
        second.Dispose();
        owner.Dispose();
        AssertReplay(fixture.Ledger);
    }

    private static Fixture Create(bool registerPersistentDomains = true)
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId disk = new(Guid.NewGuid());
        ResourceDomainId inodes = new(Guid.NewGuid());
        ResourceDomainId slots = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology(new MemoryResourceDomain[]
        {
            new(host, "host", MemoryResourceUnit.Bytes, null), new(disk, "disk", MemoryResourceUnit.Bytes, null),
            new(inodes, "inodes", MemoryResourceUnit.Inodes, null), new(slots, "slots", MemoryResourceUnit.OperationSlots, null)
        });
        var ledger = new MemoryReservationCoordinator(topology, new MemoryResourceLimit[]
        {
            new(host, MemoryResourceUnit.Bytes, 8), new(disk, MemoryResourceUnit.Bytes, 2),
            new(inodes, MemoryResourceUnit.Inodes, 0), new(slots, MemoryResourceUnit.OperationSlots, 2)
        }, 1, 8, 64, registerPersistentDomains ? new[] { disk, inodes } : null);
        return new(ledger, host, disk, inodes, slots);
    }

    private static MemoryAllocationDescriptor Descriptor(ResourceDomainId domain, long capacity)
        => new(new(Guid.NewGuid()), domain, MemoryAllocationLayout.TryCreate(0, capacity, 1).Value!);
    private static MemoryResourceCharge Bytes(ResourceDomainId domain, long amount) => new(domain, MemoryResourceUnit.Bytes, amount);
    private static MemoryResourceCharge Slots(ResourceDomainId domain, long amount) => new(domain, MemoryResourceUnit.OperationSlots, amount);

    private static void AssertReplay(MemoryReservationCoordinator ledger)
    {
        var replay = new Dictionary<string, long>();
        MemoryAccountingEventWindow window = ledger.EventWindow();
        Assert.True(window.CompleteFromStart);
        foreach (MemoryAccountingEvent item in window.Events)
        {
            foreach ((string key, long delta) in item.Delta)
            {
                replay[key] = checked(replay.GetValueOrDefault(key) + delta);
                Assert.True(replay[key] >= 0);
            }
        }
        Assert.All(ledger.Snapshot().Used, item => Assert.Equal(item.Value, replay.GetValueOrDefault(item.Key)));
    }

    private sealed record Fixture(MemoryReservationCoordinator Ledger, ResourceDomainId Host,
        ResourceDomainId Disk, ResourceDomainId Inodes, ResourceDomainId Slots);
}

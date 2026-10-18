using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryReservationCoordinatorTests
{
    [Fact]
    public void PhysicalDescriptorMustMatchActualDomainAndCapacityBeforeConversion()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId other = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64), (other, "other", 64)]);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 64)]).Value!;
        AllocationId identity = new(Guid.NewGuid());
        MemoryAllocationLayout layout = MemoryAllocationLayout.TryCreate(3, 64, 1).Value!;
        Assert.Equal(MemoryFailure.BoundsViolation,
            reservation.CommitPhysical(new MemoryAllocationDescriptor(identity, other, layout), [Bytes(host, 64)]).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation,
            reservation.CommitPhysical(new MemoryAllocationDescriptor(identity, host, layout), [Bytes(host, 32)]).Failure);
        Assert.Equal(1, ledger.Snapshot().Reservations);
        Assert.Empty(ledger.Allocations());
        var descriptor = new MemoryAllocationDescriptor(identity, host, layout);
        using IMemoryAllocationCharge charge = reservation.CommitPhysical(descriptor, [Bytes(host, 64)]).Value!;
        MemoryAllocationObservation observed = Assert.Single(ledger.Allocations());
        Assert.Same(descriptor, observed.Descriptor);
        Assert.Same(descriptor, charge.Descriptor);
        Assert.Equal(3, observed.Descriptor.Layout.LogicalBytes);
        Assert.Equal(64, Assert.Single(observed.ActualCharges).Amount);
        charge.Dispose();
        Assert.Empty(ledger.Allocations());
        Assert.Equal(64, Assert.Single(observed.ActualCharges).Amount);
        AssertReplay(ledger);
    }

    [Fact]
    public void DescriptorConversionRacesCannotReopenTheReservedCapacity()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 64)]).Value!;
        var descriptor = new MemoryAllocationDescriptor(new(Guid.NewGuid()), host,
            MemoryAllocationLayout.TryCreate(3, 64, 1).Value!);
        var committed = new ConcurrentBag<IMemoryAllocationCharge>();
        Parallel.For(0, 256, index =>
        {
            if (index % 2 == 0)
            {
                MemoryOperationResult<IMemoryAllocationCharge> result = reservation.CommitPhysical(descriptor, [Bytes(host, 64)]);
                if (result.Succeeded)
                {
                    committed.Add(result.Value!);
                }
                else
                {
                    Assert.Equal(MemoryFailure.OwnershipViolation, result.Failure);
                }
            }
            else
            {
                Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, 1)]).Failure);
            }
            Assert.Equal(64, ledger.Snapshot().Used["host"]);
        });
        using IMemoryAllocationCharge charge = Assert.Single(committed);
        Assert.False(ledger.Snapshot().Faulted);
        Assert.Same(descriptor, Assert.Single(ledger.Allocations()).Descriptor);
        AssertReplay(ledger);
    }

    [Fact]
    public void ConcurrentLastCapacityIsAtomicAndIndependentEventsReplayEveryCharge()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        var accepted = new ConcurrentBag<MemoryReservation>();
        Parallel.For(0, 256, _ =>
        {
            MemoryOperationResult<MemoryReservation> result = ledger.TryReserve([Bytes(host, 1)]);
            if (result.Succeeded)
            {
                accepted.Add(result.Value!);
            }
            else
            {
                Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
            }
        });
        Assert.Equal(64, accepted.Count);
        Assert.Equal(64, ledger.Snapshot().Used["host"]);
        AssertReplay(ledger);
        foreach (MemoryReservation reservation in accepted)
        {
            reservation.Dispose();
            reservation.Dispose();
        }
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        AssertReplay(ledger);
    }

    [Fact]
    public void ResourceFailureLeavesNoPartialGrantAndAliasesSpendOneCapacity()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId alias = new(Guid.NewGuid());
        ResourceDomainId device = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64), (alias, "host", 64), (device, "gpu", 1)]);
        Assert.Equal(MemoryFailure.BudgetRejected,
            ledger.TryReserve([Bytes(host, 32), Bytes(device, 2)]).Failure);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Equal(0, ledger.Snapshot().Used["gpu"]);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 32), Bytes(alias, 32)]).Value!;
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        AssertReplay(ledger);
    }

    [Fact]
    public void ConversionHasNoUnchargedWindowAndExcessIsRejectedBeforeAllocation()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 64)]).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected,
            reservation.Commit(new(Guid.NewGuid()), [Bytes(host, 65)]).Failure);
        Assert.Equal(64, ledger.Snapshot().Used["host"]);
        MemoryOperationResult<IMemoryAllocationCharge> committed = reservation.Commit(new(Guid.NewGuid()), [Bytes(host, 64)]);
        using IMemoryAllocationCharge allocation = committed.Value!;
        Assert.Null(Assert.Single(ledger.Allocations()).Descriptor);
        reservation.Dispose();
        Assert.Equal(64, ledger.Snapshot().Used["host"]);
        Assert.Equal(0, ledger.Snapshot().Reservations);
        Assert.Equal(1, ledger.Snapshot().Allocations);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, 1)]).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation,
            reservation.Commit(new(Guid.NewGuid()), [Bytes(host, 64)]).Failure);
        AssertReplay(ledger);
        allocation.Dispose();
        allocation.Dispose();
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void ShrinkRetainsOldChargesAndRejectsGrowthUntilActualRelease()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 64)]).Value!;
        ledger.ReviseLimits(2, [new(host, MemoryResourceUnit.Bytes, 16)]);
        Assert.True(ledger.Snapshot().OverTarget);
        Assert.Equal(64, ledger.Snapshot().Used["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, 1)]).Failure);
        using IMemoryAllocationCharge allocation = reservation.Commit(new(Guid.NewGuid()), [Bytes(host, 64)]).Value!;
        Assert.Equal(64, ledger.Snapshot().Used["host"]);
        Assert.Throws<ArgumentOutOfRangeException>(() => ledger.ReviseLimits(2, [new(host, MemoryResourceUnit.Bytes, 64)]));
        Assert.Equal(16, ledger.Snapshot().HardCaps["host"]);
        allocation.Dispose();
        Assert.False(ledger.Snapshot().OverTarget);
        AssertReplay(ledger);
    }

    [Fact]
    public void DuplicateLiveIdentityFaultsAccountingWithoutDiscardingEarlierCharges()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        using MemoryReservation first = ledger.TryReserve([Bytes(host, 16)]).Value!;
        using MemoryReservation second = ledger.TryReserve([Bytes(host, 16)]).Value!;
        AllocationId id = new(Guid.NewGuid());
        using IMemoryAllocationCharge allocation = first.Commit(id, [Bytes(host, 16)]).Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, second.Commit(id, [Bytes(host, 16)]).Failure);
        Assert.True(ledger.Snapshot().Faulted);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        Assert.Equal(MemoryFailure.OwnershipViolation, ledger.TryReserve([Bytes(host, 1)]).Failure);
        second.Dispose();
        Assert.Equal(16, ledger.Snapshot().Used["host"]);
        AssertReplay(ledger);
    }

    [Fact]
    public void InvalidSizesAndRetiredReservationsCannotCreateACharge()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var ledger = Create([(host, "host", 64)]);
        foreach (long amount in new[] { 0L, -1L, long.MinValue })
        {
            Assert.Equal(MemoryFailure.BoundsViolation, ledger.TryReserve([Bytes(host, amount)]).Failure);
        }
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, long.MaxValue)]).Failure);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        MemoryReservation reservation = ledger.TryReserve([Bytes(host, 1)]).Value!;
        reservation.Dispose();
        Assert.Equal(MemoryFailure.OwnershipViolation, reservation.Commit(new(Guid.NewGuid()), [Bytes(host, 1)]).Failure);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void SubsetOnlyRequestStillConsumesHostAndMissingDomainRemainsUnavailable()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId locked = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([
            new(host, "host", MemoryResourceUnit.Bytes, null),
            new(locked, "locked", MemoryResourceUnit.Bytes, host)
        ]);
        var ledger = new MemoryReservationCoordinator(topology, [
            new(host, MemoryResourceUnit.Bytes, 32), new(locked, MemoryResourceUnit.Bytes, 64)
        ], 1, 16, 16);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(locked, 64)]).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, ledger.TryReserve([Bytes(new(Guid.NewGuid()), 1)]).Failure);
        using MemoryReservation reservation = ledger.TryReserve([Bytes(locked, 16)]).Value!;
        Assert.Equal(16, ledger.Snapshot().Used["host"]);
        Assert.Equal(16, ledger.Snapshot().Used["locked"]);
        AssertReplay(ledger);
    }

    [Fact]
    public void BoundedEventWindowNeverClaimsCompleteHistoryAfterRotation()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(host, MemoryResourceUnit.Bytes, 32)], 1, 16, 2);
        for (int index = 0; index < 4; index++)
        {
            using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 1)]).Value!;
        }
        MemoryAccountingEventWindow window = ledger.EventWindow();
        Assert.False(window.CompleteFromStart);
        Assert.Equal(2, window.Events.Count);
        Assert.Equal(7UL, window.Events[0].Sequence);
        Assert.Equal(8UL, window.Events[1].Sequence);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    private static MemoryResourceCharge Bytes(ResourceDomainId domain, long amount)
        => new(domain, MemoryResourceUnit.Bytes, amount);

    private static MemoryReservationCoordinator Create((ResourceDomainId Id, string Capacity, long Cap)[] domains)
    {
        var topology = new MemoryResourceTopology(domains.Select(value =>
            new MemoryResourceDomain(value.Id, value.Capacity, MemoryResourceUnit.Bytes, null)));
        return new(topology, domains.Select(value => new MemoryResourceLimit(value.Id, MemoryResourceUnit.Bytes, value.Cap)),
            policyRevision: 1, entryLimit: 512, eventCapacity: 1024);
    }

    private static void AssertReplay(MemoryReservationCoordinator ledger)
    {
        MemoryAccountingEventWindow window = ledger.EventWindow();
        Assert.True(window.CompleteFromStart);
        var observed = new Dictionary<string, long>(StringComparer.Ordinal);
        var reservations = new HashSet<Guid>();
        var allocations = new HashSet<AllocationId>();
        ulong expectedSequence = 1;
        foreach (MemoryAccountingEvent entry in window.Events)
        {
            Assert.Equal(expectedSequence++, entry.Sequence);
            switch (entry.Kind)
            {
                case "reserved":
                    Assert.True(reservations.Add(entry.Reservation));
                    Assert.Null(entry.Allocation);
                    break;
                case "committed":
                    Assert.True(reservations.Remove(entry.Reservation));
                    Assert.True(allocations.Add(entry.Allocation!.Value));
                    break;
                case "reservation-released":
                    Assert.True(reservations.Remove(entry.Reservation));
                    break;
                case "allocation-released":
                    Assert.True(allocations.Remove(entry.Allocation!.Value));
                    break;
                default:
                    Assert.Fail("Unknown accounting event.");
                    break;
            }
            foreach ((string key, long delta) in entry.Delta)
            {
                observed[key] = checked(observed.GetValueOrDefault(key) + delta);
                Assert.True(observed[key] >= 0);
            }
        }
        foreach ((string key, long value) in ledger.Snapshot().Used)
        {
            Assert.Equal(value, observed.GetValueOrDefault(key));
        }
    }
}

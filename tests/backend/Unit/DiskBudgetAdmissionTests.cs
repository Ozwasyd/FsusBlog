using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Disk;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DiskBudgetAdmissionTests
{
    [Fact]
    public void AliasesAndConcurrentStagingSpendOneSharedVolume()
    {
        var fixture = new Fixture();
        DiskBudgetAdmission alias = fixture.Create(fixture.Alias);
        var successes = new List<MemoryReservation>();
        Parallel.For(0, 16, index =>
        {
            var result = (index % 2 == 0 ? fixture.Admission : alias).TryReserve(new(20, 2, 1));
            if (result.Succeeded)
            {
                lock (successes)
                {
                    successes.Add(result.Value!);
                }
            }
            else
            {
                Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
            }
        });
        Assert.Equal(4, successes.Count);
        Assert.Equal(80, fixture.Coordinator.Snapshot().Used["application"]);
        Assert.Equal(80, fixture.Coordinator.Snapshot().Used["volume"]);
        foreach (MemoryReservation token in successes)
        {
            token.Dispose();
        }
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void PolicyReductionRetainsLiveStorageAndStopsGrowth()
    {
        var fixture = new Fixture();
        using MemoryReservation staging = fixture.Admission.TryReserve(new(70, 2, 1)).Value!;
        using IMemoryAllocationCharge live = staging.Commit(new(Guid.NewGuid()),
            [new(fixture.Disk, MemoryResourceUnit.Bytes, 70)]).Value!;
        fixture.Coordinator.ReviseLimits(2, fixture.Limits(30));
        fixture.Sample = fixture.Sample with
        {
            PolicyRevision = 2
        };
        Assert.True(fixture.Coordinator.Snapshot().OverTarget);
        Assert.Equal(70, fixture.Coordinator.Snapshot().Used["volume"]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 2, 1)).Failure);
        live.Dispose();
        Assert.False(fixture.Coordinator.Snapshot().OverTarget);
    }

    [Fact]
    public void ApplicationCapAndSafetyReserveAreIndependent()
    {
        var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(81, 1, 1)).Failure);
        fixture.Sample = fixture.Sample with
        {
            AvailableBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Bytes, 99)
        };
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
    }

    [Fact]
    public void InsufficientHostCapacityRejectsTheCompleteVector()
    {
        var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(20, 101, 1)).Failure);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void MemoryBackedOrStaleOrUnknownObservationsFailClosed()
    {
        var fixture = new Fixture();
        DiskCapacityObservation valid = fixture.Sample;
        fixture.Sample = valid with
        {
            Backing = DiskBackingKind.MemoryBacked
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            Backing = DiskBackingKind.Unknown
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            ValidUntil = DateTimeOffset.MinValue
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            QuotaBytes = new(fixture.Volume, MemoryResourceUnit.Bytes, MemoryObservationState.Unknown,
                null, "fixture:quota-unavailable", valid.QuotaBytes.SampledAt)
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            AvailableInodes = new(fixture.Slot, MemoryResourceUnit.OperationSlots, MemoryObservationState.Unknown,
                null, "fixture:inode-unavailable", valid.AvailableInodes.SampledAt)
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
    }

    [Fact]
    public void LostSpaceOrChangedRevisionRequiresCommonOwnerRecapping()
    {
        var fixture = new Fixture();
        fixture.Sample = fixture.Sample with
        {
            AvailableBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Bytes, 20)
        };
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        fixture.Sample = fixture.Sample with
        {
            PolicyRevision = 99
        };
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
    }

    private sealed class Fixture
    {
        internal ResourceDomainId Volume { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Disk { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Alias { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Host { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Slot { get; } = new(Guid.NewGuid());
        internal MemoryReservationCoordinator Coordinator
        {
            get;
        }
        internal DiskCapacityObservation Sample
        {
            get; set;
        }
        internal DiskBudgetAdmission Admission
        {
            get;
        }

        internal Fixture()
        {
            var topology = new MemoryResourceTopology([
                new(Volume, "volume", MemoryResourceUnit.Bytes, null),
                new(Disk, "application", MemoryResourceUnit.Bytes, Volume),
                new(Alias, "application", MemoryResourceUnit.Bytes, Volume),
                new(Host, "host", MemoryResourceUnit.Bytes, null),
                new(Slot, "slots", MemoryResourceUnit.OperationSlots, null)
            ]);
            Coordinator = new(topology, Limits(80), 1, 64, 128);
            Sample = new("volume", Observation(Volume, MemoryResourceUnit.Bytes, 100),
                Observation(Volume, MemoryResourceUnit.Bytes, 100),
                Observation(Slot, MemoryResourceUnit.OperationSlots, 16), DiskBackingKind.Independent,
                DateTimeOffset.UtcNow.AddMinutes(1), 1);
            Admission = Create(Disk);
        }

        internal DiskBudgetAdmission Create(ResourceDomainId disk)
            => new(Coordinator, disk, Volume, Host, Slot, 80, 20, () => Sample);

        internal MemoryResourceLimit[] Limits(long diskCap)
            => [new(Volume, MemoryResourceUnit.Bytes, diskCap), new(Disk, MemoryResourceUnit.Bytes, diskCap),
                new(Host, MemoryResourceUnit.Bytes, 100), new(Slot, MemoryResourceUnit.OperationSlots, 16)];

        internal MemoryResourceObservation Observation(ResourceDomainId domain, MemoryResourceUnit unit, long value)
            => new(domain, unit, MemoryObservationState.Available, value, "fixture:scoped", DateTimeOffset.UtcNow);
    }
}

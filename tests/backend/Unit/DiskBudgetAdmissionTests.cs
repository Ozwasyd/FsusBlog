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
            var result = (index % 2 == 0 ? fixture.Admission : alias).TryReserve(new(20, 2, 1, 1));
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
        using MemoryReservation staging = fixture.Admission.TryReserve(new(70, 2, 1, 1)).Value!;
        using IMemoryAllocationCharge live = staging.Commit(new(Guid.NewGuid()),
            [new(fixture.Disk, MemoryResourceUnit.Bytes, 70), new(fixture.Inode, MemoryResourceUnit.Inodes, 1)]).Value!;
        fixture.Coordinator.ReviseLimits(2, fixture.Limits(30));
        fixture.Sample = fixture.Sample with
        {
            PolicyRevision = 2
        };
        Assert.True(fixture.Coordinator.Snapshot().OverTarget);
        Assert.Equal(70, fixture.Coordinator.Snapshot().Used["volume"]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 2, 1, 1)).Failure);
        live.Dispose();
        Assert.False(fixture.Coordinator.Snapshot().OverTarget);
    }

    [Fact]
    public void ApplicationCapAndSafetyReserveAreIndependent()
    {
        var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(81, 1, 1, 1)).Failure);
        fixture.Sample = fixture.Sample with
        {
            AvailableBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Bytes, 99)
        };
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
    }

    [Fact]
    public void InsufficientHostCapacityRejectsTheCompleteVector()
    {
        var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(20, 101, 1, 1)).Failure);
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
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            Backing = DiskBackingKind.Unknown
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            ValidUntil = DateTimeOffset.MinValue
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            QuotaBytes = new(fixture.Volume, MemoryResourceUnit.Bytes, MemoryObservationState.Unknown,
                null, "fixture:quota-unavailable", valid.QuotaBytes.SampledAt)
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        fixture.Sample = valid with
        {
            AvailableInodes = new(fixture.InodeCapacity, MemoryResourceUnit.Inodes, MemoryObservationState.Unknown,
                null, "fixture:inode-unavailable", valid.AvailableInodes.SampledAt)
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
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
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        fixture.Sample = fixture.Sample with
        {
            PolicyRevision = 99
        };
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
    }

    [Fact]
    public void AliasAdmissionsCompeteForOnePersistentInodeCapacityIndependentOfSlots()
    {
        var fixture = new Fixture(inodeCap: 2);
        DiskBudgetAdmission alias = fixture.Create(fixture.Alias, fixture.InodeAlias);
        var owners = new List<MemoryReservation>();
        Parallel.For(0, 16, index =>
        {
            var result = (index % 2 == 0 ? fixture.Admission : alias).TryReserve(new(1, 1, 1, 1));
            if (result.Succeeded)
            {
                lock (owners)
                {
                    owners.Add(result.Value!);
                }
            }
            else
            {
                Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
            }
        });
        Assert.Equal(2, owners.Count);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Used["application-inodes"]);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Used["slots"]);
        Assert.Equal(2, fixture.Coordinator.Snapshot().Used["volume"]);
        foreach (MemoryReservation owner in owners)
        {
            owner.Dispose();
        }
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReducedInodeCapRetainsLiveFileButAllowsHostAndSlotOnlyReads()
    {
        var fixture = new Fixture(inodeCap: 1);
        using MemoryReservation staging = fixture.Admission.TryReserve(new(40, 2, 1, 1)).Value!;
        using IMemoryAllocationCharge live = staging.Commit(new(Guid.NewGuid()),
            [new(fixture.Disk, MemoryResourceUnit.Bytes, 40), new(fixture.Inode, MemoryResourceUnit.Inodes, 1)]).Value!;
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Used["slots"]);
        fixture.Coordinator.ReviseLimits(2, fixture.Limits(80, inodeCap: 0));
        fixture.Sample = fixture.Sample with
        {
            PolicyRevision = 2,
            AvailableInodes = fixture.Observation(fixture.InodeCapacity, MemoryResourceUnit.Inodes, 0)
        };
        Assert.True(fixture.Coordinator.Snapshot().OverTarget);
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        var read = fixture.Admission.TryReserve(new(0, 2, 3));
        Assert.True(read.Succeeded);
        using (read.Value!)
        {
            Assert.Equal(1, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
            Assert.Equal(3, fixture.Coordinator.Snapshot().Used["slots"]);
            Assert.Equal(2, fixture.Coordinator.Snapshot().Used["host"]);
        }
        Assert.Equal(1, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
        live.Dispose();
        Assert.False(fixture.Coordinator.Snapshot().OverTarget);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ZeroInodesDoNotBecomeZeroIoSlotsOrBlockReadOnlyAdmission()
    {
        var fixture = new Fixture(inodeCap: 0);
        var read = fixture.Admission.TryReserve(new(0, 1, 16));
        Assert.True(read.Succeeded);
        using (read.Value!)
        {
            Assert.Equal(16, fixture.Coordinator.Snapshot().Used["slots"]);
            Assert.Equal(0, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
            Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(0, 1, 1)).Failure);
        }
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData("unit")]
    [InlineData("domain")]
    [InlineData("unknown")]
    public void InodeObservationMustHaveExplicitCorrectUnitDomainAndAvailabilityForGrowth(string change)
    {
        var fixture = new Fixture();
        fixture.Sample = fixture.Sample with
        {
            AvailableInodes = change switch
            {
                "unit" => fixture.Observation(fixture.InodeCapacity, MemoryResourceUnit.OperationSlots, 16),
                "domain" => fixture.Observation(fixture.Slot, MemoryResourceUnit.Inodes, 16),
                "unknown" => new(fixture.InodeCapacity, MemoryResourceUnit.Inodes, MemoryObservationState.Unknown,
                    null, "fixture:no-inode-signal", DateTimeOffset.UtcNow),
                _ => throw new ArgumentOutOfRangeException(nameof(change))
            }
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        if (change == "unknown")
        {
            var read = fixture.Admission.TryReserve(new(0, 1, 1));
            Assert.True(read.Succeeded);
            read.Value!.Dispose();
        }
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void PositiveDiskGrowthRequiresAnExplicitPersistentInodeReservation()
    {
        var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.Admission.TryReserve(new(1, 1, 1)).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.Admission.TryReserve(new(1, 1, 1, -1)).Failure);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReadOnlyAdmissionIgnoresZeroFreeBytesBelowSafetyReserveWithoutRewritingGrowthCaps()
    {
        var fixture = new Fixture();
        fixture.Sample = fixture.Sample with
        {
            AvailableBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Bytes, 0),
            QuotaBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Bytes, 0)
        };
        Assert.Equal(80, fixture.Coordinator.Snapshot().HardCaps["volume"]);
        var read = fixture.Admission.TryReserve(new(0, 2, 3));
        Assert.True(read.Succeeded);
        using (read.Value!)
        {
            Assert.Equal(2, fixture.Coordinator.Snapshot().Used["host"]);
            Assert.Equal(3, fixture.Coordinator.Snapshot().Used["slots"]);
            Assert.Equal(0, fixture.Coordinator.Snapshot().Used["volume"]);
            Assert.Equal(0, fixture.Coordinator.Snapshot().Used["volume-inodes"]);
            Assert.Equal(80, fixture.Coordinator.Snapshot().HardCaps["volume"]);
            Assert.Equal(MemoryFailure.BudgetRejected, fixture.Admission.TryReserve(new(1, 1, 1, 1)).Failure);
        }
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData("stale")]
    [InlineData("byte-domain")]
    [InlineData("quota-domain")]
    [InlineData("byte-unit")]
    [InlineData("quota-unknown")]
    public void ReadOnlyAdmissionStillRequiresFreshScopedExplicitByteAndQuotaObservations(string change)
    {
        var fixture = new Fixture();
        fixture.Sample = change switch
        {
            "stale" => fixture.Sample with { ValidUntil = DateTimeOffset.MinValue },
            "byte-domain" => fixture.Sample with
            {
                AvailableBytes = fixture.Observation(fixture.Host, MemoryResourceUnit.Bytes, 100)
            },
            "quota-domain" => fixture.Sample with
            {
                QuotaBytes = fixture.Observation(fixture.Host, MemoryResourceUnit.Bytes, 100)
            },
            "byte-unit" => fixture.Sample with
            {
                AvailableBytes = fixture.Observation(fixture.Volume, MemoryResourceUnit.Inodes, 100)
            },
            "quota-unknown" => fixture.Sample with
            {
                QuotaBytes = new(fixture.Volume, MemoryResourceUnit.Bytes, MemoryObservationState.Unknown,
                    null, "fixture:missing-quota", DateTimeOffset.UtcNow)
            },
            _ => throw new ArgumentOutOfRangeException(nameof(change))
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Admission.TryReserve(new(0, 1, 1)).Failure);
        Assert.Equal(0, fixture.Coordinator.Snapshot().Reservations);
        Assert.All(fixture.Coordinator.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    private sealed class Fixture
    {
        internal ResourceDomainId Volume { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Disk { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Alias { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Host { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Slot { get; } = new(Guid.NewGuid());
        internal ResourceDomainId InodeCapacity { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Inode { get; } = new(Guid.NewGuid());
        internal ResourceDomainId InodeAlias { get; } = new(Guid.NewGuid());
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

        internal Fixture(long inodeCap = 16)
        {
            var topology = new MemoryResourceTopology([
                new(Volume, "volume", MemoryResourceUnit.Bytes, null),
                new(Disk, "application", MemoryResourceUnit.Bytes, Volume),
                new(Alias, "application", MemoryResourceUnit.Bytes, Volume),
                new(Host, "host", MemoryResourceUnit.Bytes, null),
                new(Slot, "slots", MemoryResourceUnit.OperationSlots, null),
                new(InodeCapacity, "volume-inodes", MemoryResourceUnit.Inodes, null),
                new(Inode, "application-inodes", MemoryResourceUnit.Inodes, InodeCapacity),
                new(InodeAlias, "application-inodes", MemoryResourceUnit.Inodes, InodeCapacity)
            ]);
            Coordinator = new(topology, Limits(80, inodeCap), 1, 64, 128);
            Sample = new("volume", Observation(Volume, MemoryResourceUnit.Bytes, 100),
                Observation(Volume, MemoryResourceUnit.Bytes, 100),
                Observation(InodeCapacity, MemoryResourceUnit.Inodes, inodeCap), DiskBackingKind.Independent,
                DateTimeOffset.UtcNow.AddMinutes(1), 1);
            Admission = Create(Disk);
        }

        internal DiskBudgetAdmission Create(ResourceDomainId disk, ResourceDomainId? inode = null)
            => new(Coordinator, disk, Volume, Host, Slot, inode ?? Inode, InodeCapacity, 80, 20, () => Sample);

        internal MemoryResourceLimit[] Limits(long diskCap, long inodeCap = 16)
            => [new(Volume, MemoryResourceUnit.Bytes, diskCap), new(Disk, MemoryResourceUnit.Bytes, diskCap),
                new(Host, MemoryResourceUnit.Bytes, 100), new(Slot, MemoryResourceUnit.OperationSlots, 16),
                new(InodeCapacity, MemoryResourceUnit.Inodes, inodeCap), new(Inode, MemoryResourceUnit.Inodes, inodeCap)];

        internal MemoryResourceObservation Observation(ResourceDomainId domain, MemoryResourceUnit unit, long value)
            => new(domain, unit, MemoryObservationState.Available, value, "fixture:scoped", DateTimeOffset.UtcNow);
    }
}

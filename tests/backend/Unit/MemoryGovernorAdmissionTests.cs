using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryGovernorAdmissionTests
{
    [Fact]
    public void SnapshotsDistinguishConfiguredAndActuallyEnforcedBoundsAcrossRevisions()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(host, MemoryResourceUnit.Bytes, 100)], 1, 8, 16);
        Assert.Null(ledger.ApplyGovernedBounds(1, 1, new Dictionary<string, long> { ["host"] = 20 }));
        MemoryAccountingSnapshot frozen = ledger.Snapshot();
        Assert.Equal(100, frozen.HardCaps["host"]);
        Assert.Equal(20, frozen.EnforcedHardCaps["host"]);
        ledger.ReviseLimits(2, [new(host, MemoryResourceUnit.Bytes, 200)]);
        Assert.Equal(20, ledger.Snapshot().EnforcedHardCaps["host"]);
        Assert.Null(ledger.ApplyGovernedBounds(1, 2, new Dictionary<string, long> { ["host"] = 40 }));
        Assert.Equal(40, ledger.Snapshot().EnforcedHardCaps["host"]);
        Assert.Equal(20, frozen.EnforcedHardCaps["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 41)]).Failure);
    }

    [Fact]
    public void PublishedScopeAlsoGatesExistingRawAllocatorsAndSurvivesFailureOrDisable()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(host, MemoryResourceUnit.Bytes, 1000)], 1, 8, 16);
        using MemoryReservation existing = ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 80)]).Value!;
        Assert.Null(ledger.ApplyGovernedBounds(1, 1, new Dictionary<string, long> { ["host"] = 20 }));
        Assert.True(ledger.Snapshot().OverTarget);
        Assert.Equal(80, ledger.Snapshot().Used["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 1)]).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, ledger.ApplyGovernedBounds(2, 1, new Dictionary<string, long>()));
        Assert.Equal(MemoryFailure.StaleLocation, ledger.ApplyGovernedBounds(1, 1, new Dictionary<string, long> { ["host"] = 1000 }));
        existing.Dispose();
        Assert.Null(ledger.ApplyGovernedBounds(2, 1, new Dictionary<string, long> { ["host"] = 30 }));
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 31)]).Failure);
        using MemoryReservation admitted = ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 30)]).Value!;
        Assert.Equal(30, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public async Task ConcurrentFinalScopedBudgetAdmitsOneWholeVectorWithoutPartialSlotGrants()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId slots = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null),
            new(slots, "slots", MemoryResourceUnit.OperationSlots, null)]);
        var ledger = new MemoryReservationCoordinator(topology,
            [new(host, MemoryResourceUnit.Bytes, 1000), new(slots, MemoryResourceUnit.OperationSlots, 32)], 1, 64, 128);
        IReadOnlyDictionary<string, long> scoped = new Dictionary<string, long> { ["host"] = 10, ["slots"] = 32 };
        MemoryOperationResult<MemoryReservation>[] results = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ => Task.Run(() =>
            ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 6), new(slots, MemoryResourceUnit.OperationSlots, 1)], scoped, 1))));
        try
        {
            Assert.Single(results, result => result.Succeeded);
            Assert.Equal(31, results.Count(result => result.Failure == MemoryFailure.BudgetRejected));
            Assert.Equal(6, ledger.Snapshot().Used["host"]);
            Assert.Equal(1, ledger.Snapshot().Used["slots"]);
        }
        finally
        {
            foreach (MemoryOperationResult<MemoryReservation> result in results)
            {
                result.Value?.Dispose();
            }
        }
        Assert.All(ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public void ScopedLimitsCannotRaiseConfiguredCapsOrSpendMissingOrStaleDomains()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology, [new(host, MemoryResourceUnit.Bytes, 10)], 1, 8, 16);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 11)],
            new Dictionary<string, long> { ["host"] = 1000 }, 1).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 1)],
            new Dictionary<string, long>(), 1).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 1)],
            new Dictionary<string, long> { ["host"] = -1 }, 1).Failure);
        using MemoryReservation held = ledger.TryReserve([new(host, MemoryResourceUnit.Bytes, 8)]).Value!;
        ledger.ReviseLimits(2, [new(host, MemoryResourceUnit.Bytes, 6)]);
        Assert.Equal(MemoryFailure.StaleLocation, ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 1)],
            new Dictionary<string, long> { ["host"] = 6 }, 1).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserveUnderBounds([new(host, MemoryResourceUnit.Bytes, 1)],
            new Dictionary<string, long> { ["host"] = 6 }, 2).Failure);
        Assert.Equal(8, ledger.Snapshot().Used["host"]);
        Assert.True(ledger.Snapshot().OverTarget);
    }

    [Fact]
    public void ChildAndAliasChargesMustMeetEveryContainingScopedBudget()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId native = new(Guid.NewGuid());
        ResourceDomainId umaAlias = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null),
            new(native, "native", MemoryResourceUnit.Bytes, host), new(umaAlias, "host", MemoryResourceUnit.Bytes, null)]);
        var ledger = new MemoryReservationCoordinator(topology,
            [new(host, MemoryResourceUnit.Bytes, 100), new(native, MemoryResourceUnit.Bytes, 100)], 1, 8, 16);
        Assert.Equal(MemoryFailure.TierUnavailable, ledger.TryReserveUnderBounds([new(native, MemoryResourceUnit.Bytes, 4)],
            new Dictionary<string, long> { ["native"] = 100 }, 1).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserveUnderBounds([new(native, MemoryResourceUnit.Bytes, 4)],
            new Dictionary<string, long> { ["native"] = 100, ["host"] = 3 }, 1).Failure);
        using MemoryReservation held = ledger.TryReserveUnderBounds([new(native, MemoryResourceUnit.Bytes, 3),
            new(umaAlias, MemoryResourceUnit.Bytes, 3)], new Dictionary<string, long> { ["native"] = 100, ["host"] = 3 }, 1).Value!;
        Assert.Equal(3, ledger.Snapshot().Used["host"]);
        Assert.Equal(3, ledger.Snapshot().Used["native"]);
    }
}

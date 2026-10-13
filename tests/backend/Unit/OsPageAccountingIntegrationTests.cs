using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OsPageAccountingIntegrationTests
{
    [Fact]
    public void GuardedLockUsesOnePhysicalChargeAndRetainsSubsetUntilFinalRelease()
    {
        (MemoryReservationCoordinator ledger, ResourceDomainId host, ResourceDomainId locked) = Ledger(16384, 4096);
        using var native = new FixturePageApi();
        using MemoryReservation reservation = ledger.TryReserve([
            Bytes(host, 12288), Bytes(locked, 4096)
        ]).Value!;
        MemoryAllocationDescriptor descriptor = Descriptor(host, 12288);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, true, locked).Value!;
        Assert.Same(descriptor, Assert.Single(ledger.Allocations()).Descriptor);
        Assert.Equal(0, ledger.Snapshot().Reservations);
        Assert.Equal(1, ledger.Snapshot().Allocations);
        Assert.Equal(12288, ledger.Snapshot().Used["test-host"]);
        Assert.Equal(4096, ledger.Snapshot().Used["test-locked"]);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, 4097)]).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected,
            ledger.TryReserve([Bytes(host, 1), Bytes(locked, 1)]).Failure);
        Assert.False(region.Decommit());
        Assert.True(region.Unlock());
        Assert.True(region.Decommit());
        Assert.Equal(4096, ledger.Snapshot().Used["test-locked"]);
        region.Dispose();
        region.Dispose();
        Assert.Equal(1, native.SuccessfulReleases);
        AssertEmpty(ledger);
    }

    [Fact]
    public void NativeReserveRejectionLeavesTheExistingReservationWithItsCaller()
    {
        var (ledger, host, _) = Ledger(4096, 0);
        using var native = new FixturePageApi { FailReserve = true };
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 4096)]).Value!;
        MemoryOperationResult<OsPageRegion> result = OsPageRegion.TryReserve(native,
            Descriptor(host, 4096), reservation, false, out int? error);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Equal(12, error);
        Assert.Null(result.Value);
        Assert.Equal(1, ledger.Snapshot().Reservations);
        Assert.Equal(0, ledger.Snapshot().Allocations);
        Assert.Equal(4096, ledger.Snapshot().Used["test-host"]);
        Assert.Equal(0, native.ReleaseAttempts);
        reservation.Dispose();
        AssertEmpty(ledger);
    }

    [Fact]
    public void FailedNativeReleaseKeepsTheActualChargeUntilSuccessfulRetry()
    {
        var (ledger, host, _) = Ledger(4096, 0);
        using var native = new FixturePageApi { FailRelease = true };
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 4096)]).Value!;
        OsPageRegion region = OsPageRegion.TryReserve(native, Descriptor(host, 4096), reservation, false).Value!;
        OsPageRegionCleanupException error = Assert.Throws<OsPageRegionCleanupException>(region.Dispose);
        Assert.Same(region, error.Region);
        Assert.Equal(4096, ledger.Snapshot().Used["test-host"]);
        Assert.Single(ledger.Allocations());
        Assert.Equal(0, native.SuccessfulReleases);
        native.FailRelease = false;
        error.Region.Dispose();
        error.Region.Dispose();
        Assert.Equal(2, native.ReleaseAttempts);
        Assert.Equal(1, native.SuccessfulReleases);
        AssertEmpty(ledger);
    }

    [Fact]
    public void LockRejectionReleasesTheMappingAndTheActualAllocationVector()
    {
        (MemoryReservationCoordinator ledger, ResourceDomainId host, ResourceDomainId locked) = Ledger(4096, 4096);
        using var native = new FixturePageApi { FailLock = true };
        using MemoryReservation reservation = ledger.TryReserve([
            Bytes(host, 4096), Bytes(locked, 4096)
        ]).Value!;
        MemoryOperationResult<OsPageRegion> result = OsPageRegion.TryReserve(native,
            Descriptor(host, 4096), reservation, false, out int? error, locked);
        Assert.Equal(MemoryFailure.TierUnavailable, result.Failure);
        Assert.Equal(13, error);
        Assert.Equal(1, native.SuccessfulReleases);
        reservation.Dispose();
        AssertEmpty(ledger);
    }

    [Fact]
    public void ReducedBudgetDoesNotEraseAnExistingPhysicalCharge()
    {
        (MemoryReservationCoordinator ledger, ResourceDomainId host, ResourceDomainId locked) = Ledger(4096, 0);
        using var native = new FixturePageApi();
        using MemoryReservation reservation = ledger.TryReserve([Bytes(host, 4096)]).Value!;
        using OsPageRegion region = OsPageRegion.TryReserve(native, Descriptor(host, 4096), reservation, false).Value!;
        ledger.ReviseLimits(2, [
            new MemoryResourceLimit(host, MemoryResourceUnit.Bytes, 4095),
            new MemoryResourceLimit(locked, MemoryResourceUnit.Bytes, 0)
        ]);
        Assert.True(ledger.Snapshot().OverTarget);
        Assert.Equal(4096, ledger.Snapshot().Used["test-host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, ledger.TryReserve([Bytes(host, 1)]).Failure);
        region.Dispose();
        AssertEmpty(ledger);
        Assert.False(ledger.Snapshot().OverTarget);
    }

    private static (MemoryReservationCoordinator Ledger, ResourceDomainId Host, ResourceDomainId Locked)
        Ledger(long hostCap, long lockedCap)
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId locked = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([
            new MemoryResourceDomain(host, "test-host", MemoryResourceUnit.Bytes, null),
            new MemoryResourceDomain(locked, "test-locked", MemoryResourceUnit.Bytes, host)
        ]);
        var ledger = new MemoryReservationCoordinator(topology, [
            new MemoryResourceLimit(host, MemoryResourceUnit.Bytes, hostCap),
            new MemoryResourceLimit(locked, MemoryResourceUnit.Bytes, lockedCap)
        ], 1, 8, 64);
        return (ledger, host, locked);
    }

    private static MemoryResourceCharge Bytes(ResourceDomainId domain, long bytes)
        => new(domain, MemoryResourceUnit.Bytes, bytes);

    private static MemoryAllocationDescriptor Descriptor(ResourceDomainId host, long capacity)
        => new(new AllocationId(Guid.NewGuid()), host, MemoryAllocationLayout.TryCreate(4096, capacity, 4096).Value!);

    private static void AssertEmpty(MemoryReservationCoordinator ledger)
    {
        MemoryAccountingSnapshot snapshot = ledger.Snapshot();
        Assert.Equal(0, snapshot.Reservations);
        Assert.Equal(0, snapshot.Allocations);
        Assert.All(snapshot.Used.Values, value => Assert.Equal(0, value));
        Assert.False(snapshot.Faulted);
    }

    // Contract fixture calls allocate task-owned aligned memory, without OS page
    // protection, locking, NUMA or huge-page syscalls. Accounting uses the real ledger.
    private sealed class FixturePageApi : IOsPageNativeApi, IDisposable
    {
        private nint _address;
        public int PageBytes => 4096;
        public string Backend => "accounting-contract-fixture";
        public bool UsesExplicitLargePages => false;
        public bool FailReserve
        {
            get; init;
        }
        public bool FailLock
        {
            get; init;
        }
        public bool FailRelease
        {
            get; set;
        }
        public int ReleaseAttempts
        {
            get; private set;
        }
        public int SuccessfulReleases
        {
            get; private set;
        }

        public unsafe nint Reserve(nuint bytes, out int error)
        {
            if (FailReserve)
            {
                error = 12;
                return 0;
            }
            _address = (nint)NativeMemory.AlignedAlloc(bytes, 4096);
            error = _address == 0 ? 12 : 0;
            return _address;
        }
        public OsPageCall Commit(nint address, nuint bytes) => new(true, 0);
        public OsPageCall Protect(nint address, nuint bytes, bool writable) => new(true, 0);
        public OsPageCall Decommit(nint address, nuint bytes) => new(true, 0);
        public OsPageCall Lock(nint address, nuint bytes) => new(!FailLock, FailLock ? 13 : 0);
        public OsPageCall Unlock(nint address, nuint bytes) => new(true, 0);
        public OsPageCall HintTransparentLargePages(nint address, nuint bytes) => new(false, 95);
        public unsafe OsPageCall Release(nint address, nuint bytes)
        {
            ReleaseAttempts++;
            if (FailRelease)
            {
                return new(false, 22);
            }
            Assert.Equal(_address, address);
            NativeMemory.AlignedFree((void*)_address);
            _address = 0;
            SuccessfulReleases++;
            return new(true, 0);
        }
        public unsafe void Dispose()
        {
            if (_address != 0)
            {
                NativeMemory.AlignedFree((void*)_address);
                _address = 0;
            }
        }
    }
}

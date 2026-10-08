using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OsPageRegionTests
{
    [Fact]
    public void DisabledNeverConstructsAnOsAdapterAndOmissionUsesAutoDiscovery()
    {
        Assert.Equal(MemoryCapabilityMode.Auto, MemoryCapabilityPolicy.Parse(null));
        Assert.Null(OsPageNativeApi.Detect(mode: MemoryCapabilityMode.Disabled));
        IOsPageNativeApi? detected = OsPageNativeApi.Detect();
        Assert.Equal(OperatingSystem.IsLinux() || OperatingSystem.IsWindows(), detected is not null);
        Assert.Equal(detected?.Backend, OsPageNativeApi.Detect(mode: MemoryCapabilityMode.Required)?.Backend);
    }

    [Fact]
    public void CompleteMappingIsAdmittedBeforeReserveAndChargedOnce()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 12288);
        var reservation = new TestReservation(descriptor);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, true).Value!;
        Assert.Equal(1, native.Reserves);
        Assert.Same(descriptor, reservation.Charge!.Descriptor);
        Assert.Equal(12288, region.Observe().ReservedBytes);
        Assert.Equal(12288, region.Observe().ChargedBytes);
        Assert.Equal(0, region.Observe().CommittedBytes);
        Assert.True(region.Commit());
        Assert.Equal(native.Address + 4096, native.LastAddress);
        Assert.Equal((nuint)4096, native.LastBytes);
        Assert.Equal(4096, region.Observe().CommittedBytes);
        region.Dispose();
        region.Dispose();
        Assert.Equal(1, native.Releases);
        Assert.Equal(1, reservation.Charge.Releases);
        Assert.Equal(0, region.Observe().ReservedBytes);
    }

    [Fact]
    public void InvalidOrUnadmittedLayoutsNeverReachNativeAllocation()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 8192);
        var reservation = new TestReservation(descriptor);
        Assert.Equal(MemoryFailure.BoundsViolation,
            OsPageRegion.TryReserve(native, descriptor, reservation, true).Failure);
        reservation.Reserved = Array.Empty<MemoryResourceCharge>();
        Assert.Equal(MemoryFailure.BoundsViolation,
            OsPageRegion.TryReserve(native, descriptor, reservation, false).Failure);
        Assert.Equal(0, native.Reserves);
    }

    [Fact]
    public void SealFailureRetainsBuildingAndNeverReportsOsReadOnly()
    {
        using var native = new TestNativeApi { FailProtection = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, new TestReservation(descriptor), false).Value!;
        Assert.True(region.Commit());
        Assert.False(region.Seal());
        Assert.False(region.Observe().OsReadOnly);
        Assert.Equal(13, region.Observe().LastNativeError);
        native.FailProtection = false;
        Assert.True(region.Seal());
        Assert.True(region.Observe().OsReadOnly);
        Assert.Throws<InvalidOperationException>(() => region.Write(0, new byte[] { 1 }));
    }

    [Fact]
    public void HintSuccessLeavesPhysicalPromotionUnknown()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, new TestReservation(descriptor), false).Value!;
        Assert.True(region.Commit());
        Assert.True(region.HintTransparentLargePages());
        Assert.True(region.Observe().LargePageHintAccepted);
        Assert.Null(region.Observe().ObservedPhysicalPageBytes);
    }

    [Fact]
    public void FaultedDiscardDeniesAccessAndRetainsChargeUntilRelease()
    {
        using var native = new TestNativeApi { FailDecommit = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var reservation = new TestReservation(descriptor);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, false).Value!;
        Assert.True(region.Commit());
        Assert.False(region.Decommit());
        Assert.Equal(OsPageRegionState.Faulted, region.Observe().State);
        Assert.Null(region.Observe().CommittedBytes);
        Assert.Throws<InvalidOperationException>(() => region.Read(0, new byte[1]));
        Assert.False(region.Commit());
        Assert.Equal(0, reservation.Charge!.Releases);
    }

    [Fact]
    public void FailedReleaseRetainsRetryableOwnerAndCharge()
    {
        using var native = new TestNativeApi { FailRelease = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var reservation = new TestReservation(descriptor);
        OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, false).Value!;
        OsPageRegionCleanupException error = Assert.Throws<OsPageRegionCleanupException>(region.Dispose);
        Assert.Same(region, error.Region);
        Assert.Equal(4096, region.Observe().ChargedBytes);
        Assert.Equal(0, reservation.Charge!.Releases);
        native.FailRelease = false;
        error.Region.Dispose();
        Assert.Equal(1, reservation.Charge.Releases);
    }

    [Fact]
    public void ChargeReleaseCanBeRetriedWithoutDoubleFree()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var reservation = new TestReservation(descriptor);
        OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, false).Value!;
        reservation.Charge!.FailNextRelease = true;
        OsPageRegionCleanupException error = Assert.Throws<OsPageRegionCleanupException>(region.Dispose);
        Assert.Same(region, error.Region);
        Assert.Equal(1, native.Releases);
        Assert.Equal(4096, region.Observe().ChargedBytes);
        region.Dispose();
        Assert.Equal(1, native.Releases);
        Assert.Equal(1, reservation.Charge.Releases);
        Assert.Equal(0, region.Observe().ChargedBytes);
    }

    [Fact]
    public void FailedHandoffAndCleanupRetainPendingReservation()
    {
        using var native = new TestNativeApi { FailRelease = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var reservation = new TestReservation(descriptor) { RejectCommit = true };
        OsPageRegionCleanupException error = Assert.Throws<OsPageRegionCleanupException>(() =>
            OsPageRegion.TryReserve(native, descriptor, reservation, false));
        Assert.Equal(0, reservation.Releases);
        native.FailRelease = false;
        error.Region.Dispose();
        Assert.Equal(1, reservation.Releases);
    }

    [Fact]
    public void LockSubsetSharesPhysicalIdentityAndBlocksDiscardUntilUnlock()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var subset = new ResourceDomainId(Guid.NewGuid());
        var reservation = new TestReservation(descriptor)
        {
            Reserved = new[]
            {
                new MemoryResourceCharge(descriptor.Domain, MemoryResourceUnit.Bytes, 4096),
                new MemoryResourceCharge(subset, MemoryResourceUnit.Bytes, 4096)
            }
        };
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, reservation, false, subset).Value!;
        Assert.Equal(descriptor.Allocation, reservation.Charge!.Allocation);
        Assert.Equal(2, reservation.Charge.ActualCharges.Count);
        Assert.Equal(4096, region.Observe().LockedBytes);
        Assert.False(region.Decommit());
        native.FailUnlock = true;
        Assert.False(region.Unlock());
        Assert.Null(region.Observe().LockedBytes);
        native.FailUnlock = false;
        Assert.True(region.Unlock());
        Assert.True(region.Decommit());
    }

    [Fact]
    public void NumaPolicyNeverTargetsForbiddenOrStaleNodesAndOnlyBindsReservedRanges()
    {
        using var native = new TestNativeApi();
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 12288);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, new TestReservation(descriptor), true).Value!;
        var placement = new TestNumaApi();
        DateTimeOffset sampled = DateTimeOffset.UnixEpoch;
        OsNumaTopologyObservation topology = OsNumaTopologySource.Parse("0-3",
            "Mems_allowed_list:\t1,3\n", sampled);
        TimeSpan age = TimeSpan.FromSeconds(1);
        Assert.False(region.BindToNode(placement, topology, 2, sampled, age));
        Assert.False(region.BindToNode(placement, topology, 1, sampled.AddSeconds(2), age));
        Assert.False(region.BindToNode(placement, topology, 1, sampled.AddSeconds(-1), age));
        Assert.Equal(0, placement.Calls);
        Assert.True(region.BindToNode(placement, topology, 3, sampled, age));
        Assert.Equal(native.Address + 4096, placement.Address);
        Assert.Equal((nuint)4096, placement.Bytes);
        Assert.Equal(3, region.Observe().RequestedNumaNode);
        Assert.True(region.Observe().NumaPolicyAccepted);
        Assert.True(region.Commit());
        Assert.False(region.BindToNode(placement, topology, 1, sampled, age));
        Assert.Equal(1, placement.Calls);
    }

    [Fact]
    public void ExplicitAllocationIsDistinctFromUnknownPhysicalObservation()
    {
        using var native = new TestNativeApi { UsesExplicitLargePages = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        using OsPageRegion region = OsPageRegion.TryReserve(native, descriptor, new TestReservation(descriptor), false).Value!;
        Assert.True(region.Commit());
        Assert.True(region.Observe().ExplicitLargeMappingAllocated);
        Assert.Equal(OsPageStrategy.ExplicitLarge, region.Observe().RequestedStrategy);
        Assert.False(region.HintTransparentLargePages());
        Assert.Null(region.Observe().ObservedPhysicalPageBytes);
    }

    [Fact]
    public void DeniedLockReleasesMappingAndTheSingleCharge()
    {
        using var native = new TestNativeApi { FailLock = true };
        MemoryAllocationDescriptor descriptor = Descriptor(4096, 4096);
        var subset = new ResourceDomainId(Guid.NewGuid());
        var reservation = new TestReservation(descriptor)
        {
            Reserved = new[]
            {
                new MemoryResourceCharge(descriptor.Domain, MemoryResourceUnit.Bytes, 4096),
                new MemoryResourceCharge(subset, MemoryResourceUnit.Bytes, 4096)
            }
        };
        Assert.Equal(MemoryFailure.TierUnavailable,
            OsPageRegion.TryReserve(native, descriptor, reservation, false, out int? nativeError, subset).Failure);
        Assert.Equal(13, nativeError);
        Assert.Equal(1, native.Releases);
        Assert.Equal(1, reservation.Charge!.Releases);
    }

    private sealed class TestNumaApi : IOsNumaRangeApi
    {
        public int Calls
        {
            get; private set;
        }
        public nint Address
        {
            get; private set;
        }
        public nuint Bytes
        {
            get; private set;
        }
        public OsPageCall Bind(nint address, nuint bytes, int node)
        {
            Calls++;
            Address = address;
            Bytes = bytes;
            return new(true, 0);
        }
    }

    [Fact]
    public void LiveNativeOperationsPreserveIndependentNeighborRegion()
    {
        IOsPageNativeApi? native = OsPageNativeApi.Detect();
        // Unsupported rows are not claimed by this adapter or this test.
        Assert.NotNull(native);
        int page = native.PageBytes;
        MemoryAllocationDescriptor firstDescriptor = Descriptor(page, page * 3L, page);
        MemoryAllocationDescriptor neighborDescriptor = Descriptor(page, page, page);
        using OsPageRegion first = OsPageRegion.TryReserve(native, firstDescriptor,
            new TestReservation(firstDescriptor), true).Value!;
        using OsPageRegion neighbor = OsPageRegion.TryReserve(native, neighborDescriptor,
            new TestReservation(neighborDescriptor), false).Value!;
        Assert.True(first.Commit());
        Assert.True(neighbor.Commit());
        first.Write(0, new byte[] { 4, 5, 6 });
        neighbor.Write(0, new byte[] { 7, 8, 9 });
        Assert.Throws<ArgumentOutOfRangeException>(() => first.Write(long.MaxValue, new byte[1]));
        Assert.True(first.Seal());
        byte[] content = new byte[3];
        first.Read(0, content);
        Assert.Equal(new byte[] { 4, 5, 6 }, content);
        Assert.True(first.Decommit());
        Assert.True(first.Commit());
        first.Read(0, content);
        Assert.Equal(new byte[3], content);
        neighbor.Read(0, content);
        Assert.Equal(new byte[] { 7, 8, 9 }, content);
    }

    private static MemoryAllocationDescriptor Descriptor(long logical, long capacity, int page = 4096)
        => new(new AllocationId(Guid.NewGuid()), new ResourceDomainId(Guid.NewGuid()),
            MemoryAllocationLayout.TryCreate(logical, capacity, page).Value!);

    private sealed class TestReservation(MemoryAllocationDescriptor descriptor) : IMemoryReservation
    {
        public IReadOnlyList<MemoryResourceCharge> Reserved
        {
            get;
            set;
        } = new[]
        {
            new MemoryResourceCharge(descriptor.Domain, MemoryResourceUnit.Bytes, descriptor.Layout.CapacityBytes)
        };
        public bool RejectCommit
        {
            get; init;
        }
        public TestCharge? Charge
        {
            get; private set;
        }
        public int Releases
        {
            get; private set;
        }

        public MemoryOperationResult<IMemoryAllocationCharge> Commit(AllocationId allocation,
            IReadOnlyList<MemoryResourceCharge> actualCharges) => throw new NotSupportedException();

        public MemoryOperationResult<IMemoryAllocationCharge> CommitPhysical(MemoryAllocationDescriptor physical,
            IReadOnlyList<MemoryResourceCharge> actualCharges)
        {
            if (RejectCommit)
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BudgetRejected);
            }
            Assert.Null(Charge);
            Charge = new TestCharge(physical, actualCharges);
            return MemoryOperationResult<IMemoryAllocationCharge>.Success(Charge);
        }

        public void Dispose() => Releases++;
    }

    private sealed class TestCharge(MemoryAllocationDescriptor descriptor,
        IReadOnlyList<MemoryResourceCharge> charges) : IMemoryAllocationCharge
    {
        public AllocationId Allocation => descriptor.Allocation;
        public MemoryAllocationDescriptor Descriptor => descriptor;
        public IReadOnlyList<MemoryResourceCharge> ActualCharges => charges;
        public int Releases
        {
            get; private set;
        }
        public bool FailNextRelease
        {
            get; set;
        }
        public void Dispose()
        {
            if (FailNextRelease)
            {
                FailNextRelease = false;
                throw new InvalidOperationException("Injected charge release failure.");
            }
            Releases++;
        }
    }

    // Contract fixtures do not assert an OS capability is available or qualified.
    private sealed class TestNativeApi : IOsPageNativeApi, IDisposable
    {
        public int PageBytes => 4096;
        public string Backend => "contract-fixture";
        public bool UsesExplicitLargePages
        {
            get; init;
        }
        public int Reserves
        {
            get; private set;
        }
        public int Releases
        {
            get; private set;
        }
        public nint Address
        {
            get; private set;
        }
        public nint LastAddress
        {
            get; private set;
        }
        public nuint LastBytes
        {
            get; private set;
        }
        public bool FailLock
        {
            get; init;
        }
        public bool FailProtection
        {
            get; set;
        }
        public bool FailDecommit
        {
            get; init;
        }
        public bool FailRelease
        {
            get; set;
        }
        public bool FailUnlock
        {
            get; set;
        }

        public unsafe nint Reserve(nuint bytes, out int error)
        {
            Reserves++;
            Address = (nint)NativeMemory.AlignedAlloc(bytes, (nuint)PageBytes);
            error = Address == 0 ? 12 : 0;
            return Address;
        }

        public OsPageCall Commit(nint address, nuint bytes) => Capture(address, bytes);
        public OsPageCall Protect(nint address, nuint bytes, bool writable)
        {
            Capture(address, bytes);
            return new(!FailProtection, FailProtection ? 13 : 0);
        }
        public OsPageCall Decommit(nint address, nuint bytes)
        {
            Capture(address, bytes);
            return new(!FailDecommit, FailDecommit ? 22 : 0);
        }
        public OsPageCall Lock(nint address, nuint bytes)
        {
            Capture(address, bytes);
            return new(!FailLock, FailLock ? 13 : 0);
        }
        public OsPageCall Unlock(nint address, nuint bytes) => new(!FailUnlock, FailUnlock ? 13 : 0);
        public OsPageCall HintTransparentLargePages(nint address, nuint bytes) => Capture(address, bytes);
        public unsafe OsPageCall Release(nint address, nuint bytes)
        {
            if (FailRelease)
            {
                return new(false, 22);
            }
            Assert.Equal(Address, address);
            NativeMemory.AlignedFree((void*)Address);
            Address = 0;
            Releases++;
            return new(true, 0);
        }
        public unsafe void Dispose()
        {
            if (Address != 0)
            {
                NativeMemory.AlignedFree((void*)Address);
                Address = 0;
            }
        }
        private OsPageCall Capture(nint address, nuint bytes)
        {
            LastAddress = address;
            LastBytes = bytes;
            return new(true, 0);
        }
    }
}

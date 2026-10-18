using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Disk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryCapabilityOwnerIntegrationTests
{
    [Fact]
    public async Task CallerOwnedRootClosesOnlyAfterEveryActualBorrowerAndReaderDrains()
    {
        using var fixture = new DiskFixture(2);
        MemoryContentIdentity content = Identity();
        using DiskSegmentLease second = fixture.PublishAndRead(fixture.Stores[1], content);
        using DiskSegmentLease first = fixture.Stores[1].Acquire(fixture.LastPublishedSegment, content).Value!;
        long charged = fixture.Ledger.Snapshot().Used["disk"];
        using var competing = new MemoryStream(new byte[] { 4 });
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Stores[0].Publish([new(Identity(), competing, competing.Length)],
            DiskSpillClassification.PublicImmutableReconstructible, true).Failure);
        Assert.Equal(charged, fixture.Ledger.Snapshot().Used["disk"]);
        var roster = (DiskSegmentStore[])fixture.Stores.Clone();
        MemoryCapabilityOwner owner = MemoryCapabilityOwner.FromDisk(fixture.Root, roster, 2);
        roster[1] = roster[0];
        owner.BeginRetirement();
        owner.BeginRetirement();
        Assert.True(fixture.Stores[0].Drained.IsCompletedSuccessfully);
        Assert.False(owner.Drained.IsCompleted);
        fixture.Root.Validate();
        using var abandoned = new CancellationTokenSource();
        abandoned.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner.Drained.WaitAsync(abandoned.Token));
        Assert.False(owner.Drained.IsCompleted);
        first.Dispose();
        Assert.True(fixture.Stores[0].Drained.IsCompletedSuccessfully);
        Assert.False(fixture.Stores[1].Drained.IsCompleted);
        Assert.False(owner.Drained.IsCompleted);
        fixture.Root.Validate();
        using (var copy = new MemoryStream())
        {
            Assert.True(second.CopyTo(copy).Succeeded);
            Assert.Equal(new byte[] { 1, 2, 3 }, copy.ToArray());
        }
        Assert.True(fixture.Ledger.Snapshot().Used["disk"] > 0);
        second.Dispose();
        await owner.Drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.All(fixture.Stores, store => Assert.True(store.Drained.IsCompletedSuccessfully));
        Assert.Throws<ObjectDisposedException>(fixture.Root.Validate);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task MissingOriginalInodeRetainsRootAndPhysicalChargeUntilProvenCleanup()
    {
        using var fixture = new DiskFixture(1);
        using (DiskSegmentLease reader = fixture.PublishAndRead(fixture.Stores[0], Identity()))
        {
            using var copy = new MemoryStream();
            Assert.True(reader.CopyTo(copy).Succeeded);
            Assert.Equal(3, copy.Length);
        }
        string name = Assert.Single(fixture.Root.EnumerateNames(16));
        string original = Path.Combine(fixture.DirectoryPath, name);
        string moved = Path.Combine(fixture.DirectoryPath, "held-original");
        File.Move(original, moved);
        MemoryCapabilityOwner owner = MemoryCapabilityOwner.FromDisk(fixture.Root, fixture.Stores, 1);
        owner.BeginRetirement();
        Assert.False(owner.Drained.IsCompleted);
        Assert.False(fixture.Stores[0].Drained.IsCompleted);
        Assert.True(fixture.Ledger.Snapshot().Used["disk"] > 0);
        fixture.Root.Validate();
        File.Move(moved, original);
        fixture.Stores[0].RetryCleanup();
        await owner.Drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Throws<ObjectDisposedException>(fixture.Root.Validate);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public void InvalidBorrowerRosterDoesNotTakeOrRetireCallerOwnership()
    {
        using var fixture = new DiskFixture(1);
        Assert.Throws<ArgumentOutOfRangeException>(() => MemoryCapabilityOwner.FromDisk(fixture.Root, [], 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => MemoryCapabilityOwner.FromDisk(fixture.Root, fixture.Stores, 0));
        Assert.Throws<ArgumentException>(() => MemoryCapabilityOwner.FromDisk(fixture.Root,
            [fixture.Stores[0], fixture.Stores[0]], 2));
        fixture.Root.Validate();
        using DiskSegmentLease reader = fixture.PublishAndRead(fixture.Stores[0], Identity());
        Assert.False(fixture.Stores[0].Drained.IsCompleted);
    }

    [Fact]
    public void GpuAdapterConsumesTheActualModuleDrainAndDriverDisposal()
    {
        ResourceDomainId host = new(Guid.NewGuid());
        ResourceDomainId slots = new(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null),
            new(slots, "slots", MemoryResourceUnit.OperationSlots, null)]);
        var ledger = new MemoryReservationCoordinator(topology,
            [new(host, MemoryResourceUnit.Bytes, 128), new(slots, MemoryResourceUnit.OperationSlots, 4)], 1, 16, 32);
        var driver = new MemoryCapabilityGpuDriverFixture();
        var qualification = new MemoryCapabilityStatus("fixture", 1, MemoryCapabilityMode.Auto, MemoryDetection.Present,
            MemoryQualification.Qualified, MemoryQualification.Qualified, MemoryOnlineState.Online,
            "fixture", MemoryAdmission.Admitted, "controlled driver only, not hardware qualification");
        using var device = new GpuMemoryDevice(driver, ledger, new(host, host, slots), new(128, 8, 4, 4, 4), new(1), qualification);
        MemoryCapabilityOwner owner = MemoryCapabilityOwner.FromGpu(device);
        Assert.Same(device.Drained, owner.Drained);
        Assert.False(owner.Drained.IsCompleted);
        owner.BeginRetirement();
        owner.BeginRetirement();
        Assert.True(owner.Drained.IsCompletedSuccessfully);
        Assert.Equal(1, driver.DisposeCalls);
    }

    private static MemoryContentIdentity Identity() => new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));

    // Real Linux descriptors/files and canonical accounting; finite capacity facts are
    // fixture policy inputs, not qualified disk/volume or production numerical evidence.
    private sealed class DiskFixture : IDisposable
    {
        public string DirectoryPath { get; } = Path.Combine(Path.GetTempPath(), "memory-owner-" + Guid.NewGuid().ToString("N"));
        public OwnedSpillRoot Root
        {
            get;
        }
        public DiskSegmentStore[] Stores
        {
            get;
        }
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public Guid LastPublishedSegment
        {
            get; private set;
        }

        public DiskFixture(int borrowers)
        {
            Directory.CreateDirectory(DirectoryPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Root = new(DirectoryPath, Guid.NewGuid());
            DiskFileFootprint footprint = Root.ObserveRootFootprint();
            ResourceDomainId volume = new(Guid.NewGuid());
            ResourceDomainId disk = new(Guid.NewGuid());
            ResourceDomainId host = new(Guid.NewGuid());
            ResourceDomainId slots = new(Guid.NewGuid());
            ResourceDomainId inodeCapacity = new(Guid.NewGuid());
            ResourceDomainId inodes = new(Guid.NewGuid());
            var topology = new MemoryResourceTopology([new(volume, footprint.CapacityIdentity, MemoryResourceUnit.Bytes, null),
                new(disk, "disk", MemoryResourceUnit.Bytes, volume), new(host, "host", MemoryResourceUnit.Bytes, null),
                new(slots, "slots", MemoryResourceUnit.OperationSlots, null),
                new(inodeCapacity, footprint.CapacityIdentity + ":inodes", MemoryResourceUnit.Inodes, null),
                new(inodes, "inodes", MemoryResourceUnit.Inodes, inodeCapacity)]);
            Ledger = new(topology, [new(volume, MemoryResourceUnit.Bytes, 131072), new(disk, MemoryResourceUnit.Bytes, 131072),
                new(host, MemoryResourceUnit.Bytes, 131072), new(slots, MemoryResourceUnit.OperationSlots, 16),
                new(inodeCapacity, MemoryResourceUnit.Inodes, 16), new(inodes, MemoryResourceUnit.Inodes, 16)],
                1, 64, 128, existingPhysicalDomains: [disk, inodes]);
            DateTimeOffset now = DateTimeOffset.UtcNow;
            MemoryResourceObservation Observation(ResourceDomainId domain, MemoryResourceUnit unit, long amount)
                => new(domain, unit, MemoryObservationState.Available, amount, "fixture-only-budget", now);
            var sample = new DiskCapacityObservation(footprint.CapacityIdentity, Observation(volume, MemoryResourceUnit.Bytes, 131072),
                Observation(volume, MemoryResourceUnit.Bytes, 131072), Observation(inodeCapacity, MemoryResourceUnit.Inodes, 16),
                DiskBackingKind.Independent, now.AddMinutes(10), 1);
            var budget = new DiskBudgetAdmission(Ledger, disk, volume, host, slots, inodes, inodeCapacity, 131072, 0, () => sample);
            var bound = new DiskPhysicalAllocationBound(footprint.CapacityIdentity, footprint.Inode, 32768, 32768, 1, now.AddMinutes(10));
            Stores = new DiskSegmentStore[borrowers];
            for (int index = 0; index < borrowers; index++)
            {
                Stores[index] = new(Root, budget, new(8, 4, 4096, 32768, 128, 16), new FrozenDiskPhysicalAllocationPolicy(bound));
            }
        }

        public DiskSegmentLease PublishAndRead(DiskSegmentStore store, MemoryContentIdentity content)
        {
            using var input = new MemoryStream(new byte[] { 1, 2, 3 });
            MemoryOperationResult<DiskSegmentPublication> result = store.Publish([new(content, input, input.Length)],
                DiskSpillClassification.PublicImmutableReconstructible, true);
            Assert.True(result.Succeeded, result.Failure?.ToString());
            DiskSegmentPublication published = result.Value!;
            LastPublishedSegment = published.SegmentId;
            return store.Acquire(published.SegmentId, content).Value!;
        }

        public void Dispose()
        {
            foreach (DiskSegmentStore store in Stores)
            {
                store.Disable();
            }
            Root.Dispose();
            Directory.Delete(DirectoryPath, recursive: true);
        }
    }
}

// A source-contract fixture, never a hardware qualification. Unsupported transfer
// methods throw so these lifecycle tests cannot fabricate a successful native copy.
internal sealed class MemoryCapabilityGpuDriverFixture : IGpuDriverSession
{
    private ulong _nextAddress;
    public GpuDeviceIdentity Identity { get; } = new("fixture", "fixture", "fixture", 1, true);
    public bool FailFree
    {
        get; init;
    }
    public int DisposeCalls
    {
        get; private set;
    }
    public GpuDeviceAddress AllocateDevice(long bytes) => new(++_nextAddress);
    public void FreeDevice(GpuDeviceAddress address)
    {
        if (FailFree)
        {
            throw new GpuDriverException("fixture-free", 1);
        }
    }
    public GpuHostAddress AllocateHost(long bytes, bool cpuReadback) => throw new NotSupportedException();
    public void FreeHost(GpuHostAddress address) => throw new NotSupportedException();
    public void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source) => throw new NotSupportedException();
    public void ReadHost(GpuHostAddress address, Span<byte> destination) => throw new NotSupportedException();
    public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes) => throw new NotSupportedException();
    public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes) => throw new NotSupportedException();
    public GpuCompletion Query(GpuSubmission submission) => throw new NotSupportedException();
    public void ReleaseSubmission(GpuSubmission submission) => throw new NotSupportedException();
    public void Dispose() => DisposeCalls++;
}

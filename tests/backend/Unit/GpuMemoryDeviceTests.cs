using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

// UNIT SIMULATION ONLY: Controlled driver barriers prove owner behavior, not native qualification.
public sealed class GpuMemoryDeviceTests
{
    [Fact]
    public async Task CancelledWaitRetainsSourceDestinationStagingAndSlotUntilActualCompletion()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, [1, 2, 3, 4, 5, 6, 7, 8]);
        using var operation = device.TryUpload(allocation, source, allocation.Location).Value!;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        allocation.Dispose();
        operation.Dispose();
        device.PollCompletions();
        Assert.False(source.Released);
        Assert.Equal(0, fixture.Driver.Frees);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["registered"]);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.True((await operation.WaitAsync()).Succeeded);
        Assert.True(source.Released);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]); // idle pool remains charged
        device.Dispose();
        Assert.All(fixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public async Task CompleteReadbackCopiesAllBytesAndRetainsPoolUntilConsumerDisposal()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        byte[] bytes = [0, 255, 2, 128, 4, 5, 6, 7];
        var upload = device.TryUpload(allocation, new Source(fixture.Content, bytes), allocation.Location).Value!;
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.True((await upload.WaitAsync()).Succeeded);
        using var readback = device.TryReadback(allocation, allocation.Location).Value!;
        device.PollCompletions();
        Assert.True((await readback.WaitAsync()).Succeeded);
        var destination = new byte[8];
        readback.CopyReadbackTo(destination);
        Assert.Equal(bytes, destination);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Throws<ArgumentException>(() => readback.CopyReadbackTo(new byte[7]));
        readback.Dispose();
        Assert.Throws<InvalidOperationException>(() => readback.CopyReadbackTo(destination));
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
    }

    [Fact]
    public void UninitializedOrAlreadyUploadedAllocationCannotExposeOrMutateImmutableContent()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        Assert.Equal(MemoryFailure.StaleLocation, device.TryReadback(allocation, allocation.Location).Failure);
        Assert.Equal(MemoryFailure.StaleLocation, allocation.TryAcquirePeerHold(allocation.Location).Failure);
        Assert.True(device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location).Succeeded);
        var other = new Source(fixture.Content, new byte[8]);
        Assert.Equal(MemoryFailure.StaleLocation, device.TryUpload(allocation, other, allocation.Location).Failure);
        Assert.False(other.Released);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.Equal(MemoryFailure.StaleLocation, device.TryUpload(allocation, other, allocation.Location).Failure);
    }

    [Fact]
    public async Task DeviceLossQuarantinesAndBlocksNewEpochGrowthAndStaleReadback()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        using var operation = device.TryUpload(allocation, source, allocation.Location).Value!;
        fixture.Driver.Completion = GpuCompletion.Uncertain;
        device.PollCompletions();
        Assert.Equal(MemoryFailure.DeviceLost, (await operation.WaitAsync()).Failure);
        Assert.True(device.Snapshot().RestartRequired);
        Assert.Equal(new DeviceEpoch(2), device.Snapshot().Epoch);
        for (int index = 0; index < 50; index++)
        {
            device.InvalidateEpoch();
            Assert.Equal(MemoryFailure.DeviceLost, device.TryAllocate(fixture.Content, 8, new(1)).Failure);
        }
        Assert.Equal(new DeviceEpoch(2), device.Snapshot().Epoch);
        Assert.False(source.Released);
        Assert.False(allocation.IsCurrent);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(1, device.Snapshot().QuarantinedOperations);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.True(source.Released);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]); // faulted allocation remains charged
        Assert.Equal(0, fixture.Driver.Frees);
    }

    [Fact]
    public async Task PartialSubmitExceptionDoesNotFreePossiblyActiveDmaResources()
    {
        var fixture = new Fixture();
        fixture.Driver.ThrowSubmit = true;
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        using var operation = device.TryUpload(allocation, source, allocation.Location).Value!;
        Assert.Equal(MemoryFailure.DeviceLost, (await operation.WaitAsync()).Failure);
        operation.Dispose();
        allocation.Dispose();
        device.Dispose();
        Assert.False(source.Released);
        Assert.Equal(0, fixture.Driver.Frees);
        Assert.Equal(0, fixture.Driver.Disposals);
        Assert.Equal(1, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(1, device.Snapshot().QuarantinedOperations);
    }

    [Fact]
    public void CombinedStagingAndSlotAdmissionRejectsWithoutPartialBackingOrSourceCustody()
    {
        var fixture = new Fixture(hostCap: 7);
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        Assert.Equal(MemoryFailure.BudgetRejected, device.TryUpload(allocation, source, allocation.Location).Failure);
        Assert.Equal(0, fixture.Driver.HostAllocations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.False(source.Released);
    }

    [Fact]
    public void SharedUmaDeviceAndStagingConsumeOneHostCapacityInsteadOfIndependentHeadroom()
    {
        var fixture = new Fixture(shared: true, hostCap: 12);
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, device.TryUpload(allocation,
            new Source(fixture.Content, new byte[8]), allocation.Location).Failure);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Driver.HostAllocations);
    }

    [Fact]
    public void SharedDeviceWithoutCommonHostRelationshipIsRejectedBeforeAllocation()
    {
        var fixture = new Fixture();
        fixture.Driver.Identity = fixture.Driver.Identity with
        {
            SharesHostCapacity = true
        };
        Assert.Throws<ArgumentException>(() => fixture.Create());
        Assert.Equal(0, fixture.Driver.DeviceAllocations);
    }

    [Fact]
    public void DisableStopsNewWorkAndDrainsActiveOwnersBeforeFreeingContext()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        Assert.True(device.TryUpload(allocation, source, allocation.Location).Succeeded);
        device.Dispose();
        Assert.Equal(MemoryFailure.TierUnavailable, device.TryAllocate(fixture.Content, 8, new(1)).Failure);
        Assert.Equal(0, fixture.Driver.Disposals);
        Assert.False(source.Released);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.True(source.Released);
        Assert.Equal(1, fixture.Driver.Disposals);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReadbackConsumerAndPeerHoldsDrainBeforeAllocationRelease()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        using var hold = allocation.TryAcquirePeerHold(allocation.Location).Value!;
        Assert.Same(fixture.Driver, hold.Session);
        allocation.Dispose();
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        hold.Dispose();
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["device"]);
    }

    [Fact]
    public void PoolReusesOnlySameAttributeAndCapacityWithoutDroppingItsPhysicalCharge()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        fixture.Driver.Completion = GpuCompletion.Complete;
        for (int index = 0; index < 20; index++)
        {
            using var allocation = device.TryAllocate(fixture.Content, 8, new((ulong)index + 1)).Value!;
            device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location);
            device.PollCompletions();
        }
        Assert.Equal(1, fixture.Driver.HostAllocations);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["registered"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["device"]);
    }

    [Fact]
    public void UnqualifiedSessionCannotBePromotedLocally()
    {
        var fixture = new Fixture();
        Assert.Throws<ArgumentException>(() => fixture.Create(Fixture.Qualified with
        {
            RuntimeQualification = MemoryQualification.NotVerified
        }));
        Assert.Throws<ArgumentException>(() => fixture.Create(Fixture.Qualified with
        {
            Requested = MemoryCapabilityMode.Disabled
        }));
        Assert.Equal(0, fixture.Driver.DeviceAllocations);
    }

    [Fact]
    public void NativeAllocationFailureAfterPossibleSuccessRetainsAdmissionAndStopsGrowth()
    {
        var fixture = new Fixture();
        fixture.Driver.ThrowAllocation = true;
        using var device = fixture.Create();
        Assert.Equal(MemoryFailure.DeviceLost, device.TryAllocate(fixture.Content, 8, new(1)).Failure);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(1, device.Snapshot().UncertainReservations);
        Assert.True(device.Snapshot().RestartRequired);
        Assert.Equal(MemoryFailure.DeviceLost, device.TryAllocate(fixture.Content, 8, new(1)).Failure);
        Assert.Equal(1, fixture.Driver.DeviceAllocations);
        device.Dispose();
        Assert.Equal(0, fixture.Driver.Frees);
        Assert.Equal(0, fixture.Driver.Disposals);
    }

    [Fact]
    public async Task PeerCopyRetainsBothDeviceOwnersAndPublishesOnlyCompleteIdenticalBytes()
    {
        var sourceFixture = new Fixture();
        var destinationFixture = new Fixture { Content = sourceFixture.Content };
        using var sourceDevice = sourceFixture.Create();
        using var destinationDevice = destinationFixture.Create();
        using var source = sourceDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        using var destination = destinationDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        byte[] bytes = [1, 9, 2, 8, 3, 7, 4, 6];
        sourceDevice.TryUpload(source, new Source(sourceFixture.Content, bytes), source.Location);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        sourceDevice.PollCompletions();
        sourceFixture.Driver.Completion = GpuCompletion.Pending;
        var facts = GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present);
        using var peer = destinationDevice.TryPeerUpload(destination, source, Fixture.Qualified,
            facts, MemoryQualification.Qualified, "unit simulation").Value!;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => peer.WaitAsync(cancellation.Token));
        source.Dispose();
        Assert.Equal(8, sourceFixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(1, destinationFixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(MemoryFailure.StaleLocation, destinationDevice.TryReadback(destination, destination.Location).Failure);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        destinationDevice.PollCompletions();
        Assert.True((await peer.WaitAsync()).Succeeded);
        Assert.Equal(0, sourceFixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(0, destinationFixture.Ledger.Snapshot().Used["slots"]);
        using var readback = destinationDevice.TryReadback(destination, destination.Location).Value!;
        destinationFixture.Driver.Completion = GpuCompletion.Complete;
        destinationDevice.PollCompletions();
        byte[] actual = new byte[8];
        readback.CopyReadbackTo(actual);
        Assert.Equal(bytes, actual);
    }

    [Fact]
    public async Task RegistrySnapshotDoesNotWaitForPeerDriverOrAcquirePeerOperationLock()
    {
        var sourceFixture = new Fixture();
        var destinationFixture = new Fixture { Content = sourceFixture.Content };
        using var sourceDevice = sourceFixture.Create();
        using var destinationDevice = destinationFixture.Create();
        using var source = sourceDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        using var destination = destinationDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        sourceDevice.TryUpload(source, new Source(sourceFixture.Content, new byte[8]), source.Location);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        sourceDevice.PollCompletions();
        using var peer = destinationDevice.TryPeerUpload(destination, source, Fixture.Qualified,
            GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present),
            MemoryQualification.Qualified, "unit simulation").Value!;
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        sourceFixture.Driver.BeforeQuery = () =>
        {
            started.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        Task polling = Task.Run(destinationDevice.PollCompletions);
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            var snapshot = await Task.Run(destinationDevice.Snapshot).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, snapshot.Operations);
        }
        finally
        {
            release.Set();
            await polling;
            sourceFixture.Driver.BeforeQuery = null;
        }
        Assert.True((await peer.WaitAsync()).Succeeded);
    }

    [Fact]
    public async Task PeerLossRetainsSlotAndBothAllocationsAndPreventsUninitializedReads()
    {
        var sourceFixture = new Fixture();
        var destinationFixture = new Fixture { Content = sourceFixture.Content };
        using var sourceDevice = sourceFixture.Create();
        using var destinationDevice = destinationFixture.Create();
        using var source = sourceDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        using var destination = destinationDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        sourceDevice.TryUpload(source, new Source(sourceFixture.Content, new byte[8]), source.Location);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        sourceDevice.PollCompletions();
        sourceFixture.Driver.ThrowSubmit = true;
        using var peer = destinationDevice.TryPeerUpload(destination, source, Fixture.Qualified,
            GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present),
            MemoryQualification.Qualified, "unit simulation").Value!;
        Assert.Equal(MemoryFailure.DeviceLost, (await peer.WaitAsync()).Failure);
        source.Dispose();
        destination.Dispose();
        destinationDevice.Dispose();
        Assert.Equal(8, sourceFixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(8, destinationFixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(1, destinationFixture.Ledger.Snapshot().Used["slots"]);
        Assert.True(destinationDevice.Snapshot().RestartRequired);
        Assert.Equal(1, destinationDevice.Snapshot().QuarantinedOperations);
    }

    private sealed class Fixture
    {
        public static readonly MemoryCapabilityStatus Qualified = new("unit-simulation", 1, MemoryCapabilityMode.Auto,
            MemoryDetection.Present, MemoryQualification.Qualified, MemoryQualification.Qualified,
            MemoryOnlineState.Online, "simulated-copy", MemoryAdmission.Admitted, "unit simulation only");
        private readonly ResourceDomainId _host = new(Guid.NewGuid());
        private readonly ResourceDomainId _device = new(Guid.NewGuid());
        private readonly ResourceDomainId _registered = new(Guid.NewGuid());
        private readonly ResourceDomainId _slots = new(Guid.NewGuid());
        public MemoryContentIdentity Content { get; init; } = new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
        public Driver Driver { get; } = new();
        public MemoryReservationCoordinator Ledger
        {
            get;
        }

        public Fixture(bool shared = false, long hostCap = 128)
        {
            Driver.Identity = Driver.Identity with
            {
                SharesHostCapacity = shared
            };
            var topology = new MemoryResourceTopology([
                new(_host, "host", MemoryResourceUnit.Bytes, null),
                new(_device, shared ? "host" : "device", MemoryResourceUnit.Bytes, shared ? _host : null),
                new(_registered, "registered", MemoryResourceUnit.Bytes, _host),
                new(_slots, "slots", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new(topology, [new(_host, MemoryResourceUnit.Bytes, hostCap),
                new(_device, MemoryResourceUnit.Bytes, 128), new(_registered, MemoryResourceUnit.Bytes, hostCap),
                new(_slots, MemoryResourceUnit.OperationSlots, 4)], 1, 100, 200);
        }

        public GpuMemoryDevice Create(MemoryCapabilityStatus? status = null)
            => new(Driver, Ledger, new(_device, _registered, _slots), new(128, 8, 4, 4, 4), new(1), status ?? Qualified);
    }

    private sealed class Source(MemoryContentIdentity content, byte[] bytes) : IMemoryHostReadLease
    {
        public MemoryContentIdentity Content => content;
        public MemoryLocationToken Location { get; } = new(new(Guid.NewGuid()), new(Guid.NewGuid()), new(1), new(1));
        public bool Released
        {
            get; private set;
        }
        public ReadOnlyMemory<byte> Memory => Released ? throw new ObjectDisposedException(nameof(Source)) : bytes;
        public void Dispose() => Released = true;
    }

    private sealed class Driver : IGpuPeerDriverSession
    {
        private readonly Dictionary<ulong, byte[]> _devices = [];
        private readonly Dictionary<nint, byte[]> _hosts = [];
        private readonly Dictionary<nint, Action> _pending = [];
        private long _sequence;
        public GpuDeviceIdentity Identity { get; set; } = new("unit", "barrier", "simulated", 1, false);
        public Action? BeforeQuery { get; set; }
        public GpuCompletion Completion { get; set; } = GpuCompletion.Pending;
        public bool ThrowSubmit
        {
            get; set;
        }
        public bool ThrowAllocation
        {
            get; set;
        }
        public int Frees
        {
            get; private set;
        }
        public int DeviceAllocations
        {
            get; private set;
        }
        public int HostAllocations
        {
            get; private set;
        }
        public int Disposals
        {
            get; private set;
        }
        public GpuDeviceAddress AllocateDevice(long bytes)
        {
            ulong id = (ulong)++_sequence;
            _devices.Add(id, new byte[(int)bytes]);
            DeviceAllocations++;
            if (ThrowAllocation)
            {
                throw new GpuDriverException("after-native-allocation", 999);
            }
            return new(id);
        }
        public void FreeDevice(GpuDeviceAddress address)
        {
            Assert.Empty(_pending);
            Assert.True(_devices.Remove(address.Value));
            Frees++;
        }
        public GpuHostAddress AllocateHost(long bytes, bool cpuReadback)
        {
            nint id = (nint)(++_sequence);
            _hosts.Add(id, new byte[(int)bytes]);
            HostAllocations++;
            return new(id);
        }
        public void FreeHost(GpuHostAddress address)
        {
            Assert.Empty(_pending);
            Assert.True(_hosts.Remove(address.Value));
            Frees++;
        }
        public void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source) => source.CopyTo(_hosts[address.Value]);
        public void ReadHost(GpuHostAddress address, Span<byte> destination) => _hosts[address.Value].AsSpan(0, destination.Length).CopyTo(destination);
        public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes)
            => Submit(() => _hosts[source.Value].AsSpan(0, (int)bytes).CopyTo(_devices[destination.Value]));
        public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes)
            => Submit(() => _devices[source.Value].AsSpan(0, (int)bytes).CopyTo(_hosts[destination.Value]));
        public MemoryDetection DetectPeerAccess(IGpuPeerDriverSession destination) => MemoryDetection.Present;
        public GpuSubmission SubmitPeerTransfer(GpuDeviceAddress source, IGpuPeerDriverSession destination,
            GpuDeviceAddress destinationAddress, long bytes)
            => Submit(() => _devices[source.Value].AsSpan(0, (int)bytes).CopyTo(((Driver)destination)._devices[destinationAddress.Value]));
        private GpuSubmission Submit(Action action)
        {
            nint id = (nint)(++_sequence);
            _pending.Add(id, action);
            if (ThrowSubmit)
            {
                throw new GpuDriverException("after-submit", 999);
            }
            return new(id, id);
        }
        public GpuCompletion Query(GpuSubmission submission)
        {
            BeforeQuery?.Invoke();
            if (Completion == GpuCompletion.Complete)
            {
                _pending[submission.Event]();
            }
            return Completion;
        }
        public void ReleaseSubmission(GpuSubmission submission) => Assert.True(_pending.Remove(submission.Event));
        public void Dispose()
        {
            Assert.Empty(_pending);
            Assert.Empty(_devices);
            Assert.Empty(_hosts);
            Disposals++;
        }
    }
}

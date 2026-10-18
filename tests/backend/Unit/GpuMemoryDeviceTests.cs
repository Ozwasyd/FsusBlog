using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

// UNIT SIMULATION ONLY: Controlled driver barriers prove owner behavior, not native qualification.
public sealed class GpuMemoryDeviceTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task SourceReleaseFailureTerminatesWaitsWithoutRetryingOrClaimingDrain(bool reuseStaging, bool loseEpoch)
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        fixture.Driver.Completion = GpuCompletion.Complete;
        if (reuseStaging)
        {
            using var warmup = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
            device.TryUpload(warmup, new Source(fixture.Content, new byte[8]), warmup.Location);
            device.PollCompletions();
        }
        using var allocation = device.TryAllocate(fixture.Content, 8, new(2)).Value!;
        var cleanupError = new InvalidOperationException("Controlled CPU source-owner release failure.");
        var source = new Source(fixture.Content, new byte[8]) { DisposeFailure = cleanupError };
        using var operation = device.TryUpload(allocation, source, allocation.Location).Value!;
        if (loseEpoch)
        {
            device.InvalidateEpoch();
        }
        device.PollCompletions();
        Assert.Equal(loseEpoch ? MemoryFailure.DeviceLost : MemoryFailure.OwnershipViolation,
            (await operation.WaitAsync().WaitAsync(TimeSpan.FromSeconds(5))).Failure);
        Assert.Same(cleanupError, operation.CleanupFailure);
        Assert.Equal(1, source.Disposals);
        Assert.False(source.Released);
        int frees = fixture.Driver.Frees;
        device.Dispose();
        var drainError = await Assert.ThrowsAsync<InvalidOperationException>(() => device.Drained);
        if (!loseEpoch)
        {
            Assert.Same(cleanupError, drainError.InnerException);
        }
        for (int index = 0; index < 3; index++)
        {
            operation.Dispose();
            device.Dispose();
            device.PollCompletions();
        }
        Assert.Equal(1, source.Disposals);
        Assert.Equal(frees, fixture.Driver.Frees);
        Assert.Equal(0, fixture.Driver.Disposals);
        Assert.True(device.Drained.IsFaulted);
        Assert.Equal(1, device.Snapshot().QuarantinedOperations);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
    }

    [Fact]
    public async Task DrainedWaitCancellationDoesNotReleasePendingDmaOrCancelDeviceDrain()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        Task drained = device.Drained;
        Assert.Same(drained, device.Drained);
        Assert.False(drained.IsCompleted);
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        using var operation = device.TryUpload(allocation, source, allocation.Location).Value!;
        fixture.Driver.BeforeDispose = () => Assert.False(drained.IsCompleted);
        device.Dispose();
        device.Dispose();
        device.PollCompletions();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => drained.WaitAsync(cancellation.Token));
        Assert.False(drained.IsCompleted);
        Assert.False(source.Released);
        Assert.Equal(0, fixture.Driver.Disposals);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        await drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(source.Released);
        Assert.Equal(1, fixture.Driver.Disposals);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
        device.Dispose();
        device.PollCompletions();
        Assert.Equal(1, fixture.Driver.Disposals);
        Assert.True(drained.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task EmptyDeviceDrainedWaitsForActualDriverTeardown()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        fixture.Driver.BeforeDispose = () =>
        {
            started.Set();
            Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
        };
        Task disposing = Task.Run(device.Dispose);
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            Assert.False(device.Drained.IsCompleted);
        }
        finally
        {
            release.Set();
            await disposing.WaitAsync(TimeSpan.FromSeconds(5));
        }
        await device.Drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, fixture.Driver.Disposals);
    }

    [Fact]
    public async Task DrainedWaitsForEveryExternalAllocationHold()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        using var first = allocation.TryAcquirePeerHold(allocation.Location).Value!;
        using var last = allocation.TryAcquirePeerHold(allocation.Location).Value!;
        device.Dispose();
        first.Dispose();
        Assert.False(device.Drained.IsCompleted);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(0, fixture.Driver.Disposals);
        last.Dispose();
        await device.Drained.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, fixture.Driver.Disposals);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DrainedRequiresLastMappingConsumerAndConfirmedUnmap(bool failUnmap)
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        var mapper = new MappingDriver(fixture.Driver) { ThrowUnmap = failUnmap };
        using var mapping = GpuMappedReadLease.Map(mapper,
            allocation.TryAcquirePeerHold(allocation.Location).Value!, 0, 8, 1);
        using var consumer = mapping.TryAcquireConsumer().Value!;
        device.Dispose();
        mapping.Dispose();
        Assert.False(device.Drained.IsCompleted);
        Assert.Equal(0, mapper.Unmaps);
        Assert.Equal(0, fixture.Driver.Disposals);
        consumer.Dispose();
        Assert.Equal(1, mapper.Unmaps);
        if (failUnmap)
        {
            Assert.True(mapping.IsQuarantined);
            Assert.False(device.Drained.IsCompleted);
            Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
            Assert.Equal(0, fixture.Driver.Disposals);
            device.InvalidateEpoch();
            await Assert.ThrowsAsync<InvalidOperationException>(() => device.Drained);
            Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
            Assert.Equal(0, fixture.Driver.Disposals);
        }
        else
        {
            await device.Drained.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, fixture.Driver.Disposals);
            Assert.All(fixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
        }
    }

    [Fact]
    public async Task DrainedWaitsForActualPeerCompletionAndBothDeviceOwners()
    {
        var sourceFixture = new Fixture();
        var destinationFixture = new Fixture(sourceFixture);
        using var sourceDevice = sourceFixture.Create();
        using var destinationDevice = destinationFixture.Create();
        using var source = sourceDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        using var destination = destinationDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        sourceDevice.TryUpload(source, new Source(sourceFixture.Content, new byte[8]), source.Location);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        sourceDevice.PollCompletions();
        sourceFixture.Driver.Completion = GpuCompletion.Pending;
        using var peer = destinationDevice.TryPeerUpload(destination, source, Fixture.Qualified,
            GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present),
            MemoryQualification.Qualified, "unit simulation").Value!;
        sourceDevice.Dispose();
        destinationDevice.Dispose();
        destinationDevice.PollCompletions();
        Assert.False(sourceDevice.Drained.IsCompleted);
        Assert.False(destinationDevice.Drained.IsCompleted);
        Assert.Equal(1, sourceFixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(1, sourceFixture.Ledger.Snapshot().Used["peer-slots"]);
        sourceFixture.Driver.BeforeDispose = () =>
        {
            Assert.False(destinationDevice.Drained.IsCompleted);
            Assert.Equal(0, sourceFixture.Ledger.Snapshot().Used["slots"]);
            Assert.Equal(0, sourceFixture.Ledger.Snapshot().Used["peer-slots"]);
        };
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        destinationDevice.PollCompletions();
        await Task.WhenAll(sourceDevice.Drained, destinationDevice.Drained).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, sourceFixture.Driver.Disposals);
        Assert.Equal(1, destinationFixture.Driver.Disposals);
        Assert.All(sourceFixture.Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData("allocation")]
    [InlineData("submit")]
    [InlineData("query")]
    [InlineData("submission-release")]
    [InlineData("device-free")]
    [InlineData("host-free")]
    [InlineData("driver-teardown")]
    public async Task DrainedFaultsOnUnprovenCustodyWithoutPretendingCleanupSucceeded(string failure)
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        fixture.Driver.ThrowAllocation = failure == "allocation";
        var allocated = device.TryAllocate(fixture.Content, 8, new(1));
        if (allocated.Succeeded)
        {
            fixture.Driver.ThrowSubmit = failure == "submit";
            fixture.Driver.ThrowSubmissionRelease = failure == "submission-release";
            device.TryUpload(allocated.Value!, new Source(fixture.Content, new byte[8]), allocated.Value!.Location);
            fixture.Driver.Completion = failure == "query" ? GpuCompletion.Uncertain : GpuCompletion.Complete;
            device.PollCompletions();
        }
        fixture.Driver.ThrowFreeDevice = failure == "device-free";
        fixture.Driver.ThrowFreeHost = failure == "host-free";
        fixture.Driver.ThrowDispose = failure == "driver-teardown";
        Assert.False(device.Drained.IsCompleted);
        device.Dispose();
        await Assert.ThrowsAsync<InvalidOperationException>(() => device.Drained);
        var retained = fixture.Ledger.Snapshot();
        int frees = fixture.Driver.Frees;
        int disposals = fixture.Driver.Disposals;
        device.Dispose();
        device.InvalidateEpoch();
        device.PollCompletions();
        Assert.True(device.Drained.IsFaulted);
        Assert.Equal(retained.Used, fixture.Ledger.Snapshot().Used);
        Assert.Equal(frees, fixture.Driver.Frees);
        Assert.Equal(disposals, fixture.Driver.Disposals);
        Assert.True(device.Snapshot().RestartRequired);
        if (failure != "driver-teardown")
        {
            Assert.Contains(retained.Used.Values, value => value > 0);
            Assert.Equal(0, disposals);
        }
    }

    [Fact]
    public async Task DeviceLossCannotCompleteDrainAndLaterDmaProofOnlyReleasesTheCompletedOperation()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var source = new Source(fixture.Content, new byte[8]);
        device.TryUpload(allocation, source, allocation.Location);
        device.Dispose();
        Assert.False(device.Drained.IsCompleted);
        device.InvalidateEpoch();
        await Assert.ThrowsAsync<InvalidOperationException>(() => device.Drained);
        device.PollCompletions();
        Assert.False(source.Released);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(0, fixture.Driver.Frees);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        Assert.True(source.Released);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(8, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Driver.Frees);
        Assert.Equal(0, fixture.Driver.Disposals);
        Assert.True(device.Drained.IsFaulted);
    }

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
        Assert.Throws<ArgumentException>(() => fixture.Create(Fixture.Qualified with { Detection = MemoryDetection.Absent }));
        Assert.Equal(0, fixture.Driver.DeviceAllocations);
    }

    [Fact]
    public void PeerSourceHoldsHaveDeviceWideBoundAcrossDistinctAllocations()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var first = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        using var second = device.TryAllocate(fixture.Content, 8, new(2)).Value!;
        device.TryUpload(first, new Source(fixture.Content, new byte[8]), first.Location);
        device.TryUpload(second, new Source(fixture.Content, new byte[8]), second.Location);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        using var one = first.TryAcquirePeerHold(first.Location).Value!;
        using var two = first.TryAcquirePeerHold(first.Location).Value!;
        using var three = second.TryAcquirePeerHold(second.Location).Value!;
        using var four = second.TryAcquirePeerHold(second.Location).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, second.TryAcquirePeerHold(second.Location).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, device.TryReadback(first, first.Location).Failure);
        Assert.Equal(4, device.Snapshot().Operations);
    }

    [Fact]
    public void PeerTransferCannotCreateSeparateAccountingAuthority()
    {
        var sourceFixture = new Fixture();
        var other = new Fixture { Content = sourceFixture.Content };
        using var sourceDevice = sourceFixture.Create();
        using var destinationDevice = other.Create();
        using var source = sourceDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        using var destination = destinationDevice.TryAllocate(sourceFixture.Content, 8, new(1)).Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, destinationDevice.TryPeerUpload(destination, source,
            Fixture.Qualified, GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present),
            MemoryQualification.Qualified, "unit simulation").Failure);
        Assert.Equal(0, sourceFixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(0, other.Ledger.Snapshot().Used["slots"]);
    }

    [Fact]
    public void MismatchedPeerContentRemainsACorrectnessFailure()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var source = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        var wrong = new MemoryContentIdentity(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
        using var destination = device.TryAllocate(wrong, 8, new(1)).Value!;
        var result = device.TryPeerUpload(destination, source, Fixture.Qualified,
            GpuPeerCapabilityFacts.ClassicDeviceAllocation(1, MemoryDetection.Present),
            MemoryQualification.Qualified, "unit simulation");
        Assert.Equal(MemoryFailure.Corruption, result.Failure);
        Assert.True(result.IsCorrectnessFailure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
    }

    [Fact]
    public void ReadbackFaultInvalidatesDeviceAndRetainsConsumerCustody()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        device.TryUpload(allocation, new Source(fixture.Content, new byte[8]), allocation.Location);
        fixture.Driver.Completion = GpuCompletion.Complete;
        device.PollCompletions();
        using var readback = device.TryReadback(allocation, allocation.Location).Value!;
        device.PollCompletions();
        fixture.Driver.ThrowReadback = true;
        Assert.Throws<GpuDriverException>(() => readback.CopyReadbackTo(new byte[8]));
        readback.Dispose();
        Assert.False(allocation.IsCurrent);
        Assert.True(device.Snapshot().RestartRequired);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.Equal(1, device.Snapshot().QuarantinedOperations);
    }

    [Fact]
    public void FailedContextTeardownIsQuarantinedWithoutAmbiguousRetry()
    {
        var fixture = new Fixture();
        using var device = fixture.Create();
        fixture.Driver.ThrowDispose = true;
        device.Dispose();
        Assert.True(device.Snapshot().RestartRequired);
        Assert.Equal(1, fixture.Driver.Disposals);
        device.Dispose();
        device.PollCompletions();
        Assert.Equal(1, fixture.Driver.Disposals);
    }

    [Fact]
    public void ConfirmedNativeBudgetRejectionReleasesAdmissionAndKeepsDeviceEligible()
    {
        var fixture = new Fixture();
        fixture.Driver.RejectAllocation = true;
        using var device = fixture.Create();
        Assert.Equal(MemoryFailure.BudgetRejected, device.TryAllocate(fixture.Content, 8, new(1)).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["device"]);
        Assert.True(device.Snapshot().Accepting);
        Assert.False(device.Snapshot().RestartRequired);
        fixture.Driver.RejectAllocation = false;
        using var allocation = device.TryAllocate(fixture.Content, 8, new(1)).Value!;
        Assert.True(allocation.IsCurrent);
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
        var destinationFixture = new Fixture(sourceFixture);
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
        Assert.Equal(1, destinationFixture.Ledger.Snapshot().Used["peer-slots"]);
        Assert.Equal(MemoryFailure.StaleLocation, destinationDevice.TryReadback(destination, destination.Location).Failure);
        sourceFixture.Driver.Completion = GpuCompletion.Complete;
        destinationDevice.PollCompletions();
        Assert.True((await peer.WaitAsync()).Succeeded);
        Assert.Equal(0, sourceFixture.Ledger.Snapshot().Used["device"]);
        Assert.Equal(0, destinationFixture.Ledger.Snapshot().Used["peer-slots"]);
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
        var destinationFixture = new Fixture(sourceFixture);
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
        var destinationFixture = new Fixture(sourceFixture);
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
        Assert.Equal(8, destinationFixture.Ledger.Snapshot().Used["peer-device"]);
        Assert.Equal(1, destinationFixture.Ledger.Snapshot().Used["peer-slots"]);
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

        private readonly ResourceDomainId _peerDevice = new(Guid.NewGuid());
        private readonly ResourceDomainId _peerSlots = new(Guid.NewGuid());
        public Fixture(Fixture peer)
        {
            _host = peer._host;
            _device = peer._peerDevice;
            _registered = peer._registered;
            _slots = peer._peerSlots;
            Ledger = peer.Ledger;
            Content = peer.Content;
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
                new(_peerDevice, "peer-device", MemoryResourceUnit.Bytes, null),
                new(_registered, "registered", MemoryResourceUnit.Bytes, _host),
                new(_slots, "slots", MemoryResourceUnit.OperationSlots, null),
                new(_peerSlots, "peer-slots", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new(topology, [new(_host, MemoryResourceUnit.Bytes, hostCap),
                new(_device, MemoryResourceUnit.Bytes, 128), new(_peerDevice, MemoryResourceUnit.Bytes, 128), new(_registered, MemoryResourceUnit.Bytes, hostCap),
                new(_slots, MemoryResourceUnit.OperationSlots, 4), new(_peerSlots, MemoryResourceUnit.OperationSlots, 4)], 1, 100, 200);
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
        public Exception? DisposeFailure
        {
            get; init;
        }
        public int Disposals
        {
            get; private set;
        }
        public void Dispose()
        {
            Disposals++;
            if (DisposeFailure is not null)
            {
                throw DisposeFailure;
            }
            Released = true;
        }
    }

    private sealed class MappingDriver(IGpuDriverSession session) : IGpuMappedDriverApi
    {
        public IGpuDriverSession Session => session;
        public string DriverApi => "unit-mapping";
        public int ApiVersion => session.Identity.ApiVersion;
        public GpuMappingCoherency Coherency => GpuMappingCoherency.Coherent;
        public bool ThrowUnmap
        {
            get; set;
        }
        public int Unmaps
        {
            get; private set;
        }
        public GpuDriverMapping Map(IGpuPeerAllocationHold allocation, long offset, long length) => new(1);
        public GpuMappingSynchronization SynchronizeForRead(GpuDriverMapping mapping, MemoryLocationToken location)
            => new(DriverApi, ApiVersion, location, 1, true);
        public void Read(GpuDriverMapping mapping, long relativeOffset, Span<byte> destination)
            => throw new NotSupportedException("This unit control exercises mapping custody only.");
        public void Unmap(GpuDriverMapping mapping)
        {
            Unmaps++;
            if (ThrowUnmap)
            {
                throw new GpuDriverException("unit-unmap-uncertain", 999);
            }
        }
    }

    private sealed class Driver : IGpuPeerDriverSession
    {
        private readonly Dictionary<ulong, byte[]> _devices = [];
        private readonly Dictionary<nint, byte[]> _hosts = [];
        private readonly Dictionary<nint, Action> _pending = [];
        private readonly Dictionary<nint, nint> _pendingHosts = [];
        private long _sequence;
        public GpuDeviceIdentity Identity { get; set; } = new("unit", "barrier", "simulated", 1, false);
        public bool RejectAllocation
        {
            get; set;
        }
        public Action? BeforeQuery
        {
            get; set;
        }
        public Action? BeforeDispose
        {
            get; set;
        }
        public bool ThrowFreeDevice
        {
            get; set;
        }
        public bool ThrowFreeHost
        {
            get; set;
        }
        public bool ThrowSubmissionRelease
        {
            get; set;
        }
        public bool ThrowReadback
        {
            get; set;
        }
        public bool ThrowDispose
        {
            get; set;
        }
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
            if (RejectAllocation)
            {
                throw new GpuAllocationRejectedException();
            }
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
            if (ThrowFreeDevice)
            {
                throw new GpuDriverException("device-free-uncertain", 999);
            }
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
            Assert.DoesNotContain(address.Value, _pendingHosts.Values);
            if (ThrowFreeHost)
            {
                throw new GpuDriverException("host-free-uncertain", 999);
            }
            Assert.True(_hosts.Remove(address.Value));
            Frees++;
        }
        public void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source) => source.CopyTo(_hosts[address.Value]);
        public void ReadHost(GpuHostAddress address, Span<byte> destination)
        {
            if (ThrowReadback)
            {
                throw new GpuDriverException("readback-fault", 999);
            }
            _hosts[address.Value].AsSpan(0, destination.Length).CopyTo(destination);
        }
        public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes)
            => Submit(() => _hosts[source.Value].AsSpan(0, (int)bytes).CopyTo(_devices[destination.Value]), source.Value);
        public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes)
            => Submit(() => _devices[source.Value].AsSpan(0, (int)bytes).CopyTo(_hosts[destination.Value]), destination.Value);
        public MemoryDetection DetectPeerAccess(IGpuPeerDriverSession destination) => MemoryDetection.Present;
        public GpuSubmission SubmitPeerTransfer(GpuDeviceAddress source, IGpuPeerDriverSession destination,
            GpuDeviceAddress destinationAddress, long bytes)
            => Submit(() => _devices[source.Value].AsSpan(0, (int)bytes).CopyTo(((Driver)destination)._devices[destinationAddress.Value]));
        private GpuSubmission Submit(Action action, nint host = 0)
        {
            nint id = (nint)(++_sequence);
            _pending.Add(id, action);
            if (host != 0)
            {
                _pendingHosts.Add(id, host);
            }
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
        public void ReleaseSubmission(GpuSubmission submission)
        {
            if (ThrowSubmissionRelease)
            {
                throw new GpuDriverException("submission-release-uncertain", 999);
            }
            Assert.True(_pending.Remove(submission.Event));
            _pendingHosts.Remove(submission.Event);
        }
        public void Dispose()
        {
            Assert.Empty(_pending);
            Assert.Empty(_devices);
            Assert.Empty(_hosts);
            BeforeDispose?.Invoke();
            Disposals++;
            if (ThrowDispose)
            {
                throw new GpuDriverException("context-teardown", 999);
            }
        }
    }
}

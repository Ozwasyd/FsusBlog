using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class GpuPeerMappingTests
{
    [Fact]
    public void DrainBlocksNewConsumersAndUnmapsOnlyAfterFinalReadConsumer()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[] { 9, 2, 6, 5, 3, 5 });
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 1, 4, 2);
        GpuMappedReadConsumer first = lease.TryAcquireConsumer().Value!;
        GpuMappedReadConsumer second = lease.TryAcquireConsumer().Value!;
        lease.Dispose();
        Assert.Equal(MemoryFailure.TierUnavailable, lease.TryAcquireConsumer().Failure);
        Assert.Equal(0, driver.Unmaps);
        Assert.False(allocation.Disposed);
        byte[] actual = new byte[4];
        Assert.Null(first.Read(0, actual));
        Assert.Equal(new byte[] { 2, 6, 5, 3 }, actual);
        Assert.Equal(allocation.Location, lease.Synchronization!.Location);
        Assert.True(lease.Synchronization.Completed);
        first.Dispose();
        Assert.Equal(0, driver.Unmaps);
        second.Dispose();
        Assert.Equal(1, driver.Unmaps);
        Assert.True(allocation.Disposed);
        Assert.Equal(MemoryFailure.OwnershipViolation, second.Read(0, actual));
        second.Dispose();
        lease.Dispose();
        Assert.Equal(1, driver.Unmaps);
    }

    [Fact]
    public void EpochLossBlocksReadsAndNewConsumersWithoutDereference()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        allocation.IsCurrent = false;
        Assert.Equal(MemoryFailure.StaleLocation, consumer.Read(0, new byte[4]));
        Assert.Equal(MemoryFailure.StaleLocation, lease.TryAcquireConsumer().Failure);
        Assert.Equal(0, driver.Reads);
        lease.Dispose();
        Assert.False(allocation.Disposed);
        consumer.Dispose();
        Assert.True(allocation.Disposed);
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(3, 2)]
    [InlineData(long.MaxValue, 1)]
    public void OutOfRangeReadDoesNotCallDriver(long offset, int length)
    {
        var driver = new MappingDriver();
        using GpuMappedReadLease lease = GpuMappedReadLease.Map(driver,
            new GpuPeerTestHold(driver.AllocationSession, new byte[4]), 0, 4, 2);
        using GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        Assert.Equal(MemoryFailure.BoundsViolation, consumer.Read(offset, new byte[length]));
        Assert.Equal(0, driver.Reads);
        Assert.Null(lease.Synchronization);
    }

    [Fact]
    public void WrongEpochSynchronizationQuarantinesMappingAndRetainsBacking()
    {
        var driver = new MappingDriver { WrongEpoch = true };
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, consumer.Read(0, new byte[4]));
        Assert.True(lease.IsQuarantined);
        Assert.Equal(0, driver.Reads);
        lease.Dispose();
        consumer.Dispose();
        Assert.False(allocation.Disposed);
        Assert.Equal(0, driver.Unmaps);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MapOrUnmapFailureRetainsBacking(bool failMap)
    {
        var driver = new MappingDriver { ThrowOnMap = failMap, ThrowOnUnmap = !failMap };
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        lease.Dispose();
        Assert.True(lease.IsQuarantined);
        Assert.NotNull(lease.DriverFailure);
        Assert.False(allocation.Disposed);
    }

    [Fact]
    public void ApiVersionMismatchRejectsBeforeMappingAndReleasesUnsubmittedHold()
    {
        var driver = new MappingDriver { ApiVersion = 11000 };
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        Assert.Throws<InvalidOperationException>(() => GpuMappedReadLease.Map(driver, allocation, 0, 4, 2));
        Assert.Equal(0, driver.Maps);
        Assert.True(allocation.Disposed);
    }

    [Fact]
    public void PreheldDisabledOwnerCannotStartMapping()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]) { CanSubmit = false };
        Assert.True(allocation.IsCurrent);
        Assert.Throws<InvalidOperationException>(() => GpuMappedReadLease.Map(driver, allocation, 0, 4, 2));
        Assert.Equal(0, driver.Maps);
        Assert.True(allocation.Disposed);
    }

    [Fact]
    public void DisabledOwnerBlocksNewConsumersWhileExistingReadConsumerDrains()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[] { 1, 2, 3, 4 });
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        allocation.CanSubmit = false;
        Assert.Equal(MemoryFailure.TierUnavailable, lease.TryAcquireConsumer().Failure);
        byte[] actual = new byte[4];
        Assert.Null(consumer.Read(0, actual));
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, actual);
        lease.Dispose();
        Assert.False(allocation.Disposed);
        Assert.Equal(0, driver.Unmaps);
        consumer.Dispose();
        Assert.True(allocation.Disposed);
        Assert.Equal(1, driver.Unmaps);
    }

    [Fact]
    public void ApiIdentityChangeInvalidatesExistingLease()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        using GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        using GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        driver.ApiVersion++;
        Assert.Equal(MemoryFailure.StaleLocation, consumer.Read(0, new byte[4]));
        Assert.Equal(MemoryFailure.StaleLocation, lease.TryAcquireConsumer().Failure);
        Assert.Equal(0, driver.Reads);
    }

    [Fact]
    public void ConsumerAdmissionUsesSuppliedBoundAndRecoversAfterRelease()
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        using GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 1);
        GpuMappedReadConsumer first = lease.TryAcquireConsumer().Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, lease.TryAcquireConsumer().Failure);
        Assert.Equal(0, driver.Unmaps);
        first.Dispose();
        using GpuMappedReadConsumer next = lease.TryAcquireConsumer().Value!;
        Assert.Null(next.Read(0, new byte[4]));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void InvalidConsumerBoundRejectsBeforeDriverMap(int maximumConsumers)
    {
        var driver = new MappingDriver();
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[4]);
        Assert.Throws<ArgumentOutOfRangeException>(() => GpuMappedReadLease.Map(driver, allocation, 0, 4, maximumConsumers));
        Assert.Equal(0, driver.Maps);
        Assert.True(allocation.Disposed);
    }

    [Fact]
    public async Task ReadAndFinalConsumerDrainCannotUnmapDuringDriverAccess()
    {
        using var entered = new ManualResetEventSlim();
        using var allowRead = new ManualResetEventSlim();
        var driver = new MappingDriver
        {
            DuringRead = () =>
            {
                entered.Set();
                Assert.True(allowRead.Wait(TimeSpan.FromSeconds(5)));
            }
        };
        var allocation = new GpuPeerTestHold(driver.AllocationSession, new byte[] { 1, 2, 3, 4 });
        GpuMappedReadLease lease = GpuMappedReadLease.Map(driver, allocation, 0, 4, 2);
        GpuMappedReadConsumer consumer = lease.TryAcquireConsumer().Value!;
        byte[] actual = new byte[4];
        Task read = Task.Run(() => Assert.Null(consumer.Read(0, actual)));
        Task? drain = null;
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            drain = Task.Run(() =>
            {
                lease.Dispose();
                consumer.Dispose();
            });
            Assert.Equal(0, driver.Unmaps);
            Assert.False(allocation.Disposed);
        }
        finally
        {
            allowRead.Set();
        }
        await read.WaitAsync(TimeSpan.FromSeconds(5));
        if (drain is not null)
        {
            await drain.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, actual);
        Assert.Equal(1, driver.Unmaps);
        Assert.True(allocation.Disposed);
    }

    private sealed class MappingDriver : IGpuMappedDriverApi
    {
        private GpuPeerTestHold? _allocation;
        private int _offset;
        public GpuPeerTestSession AllocationSession { get; } = new();
        public IGpuDriverSession Session => AllocationSession;
        public GpuMappingCoherency Coherency => GpuMappingCoherency.DriverSynchronized;
        public string DriverApi => "supported-test-map";
        public int ApiVersion { get; set; } = 12000;
        public int Maps
        {
            get; private set;
        }
        public int Reads
        {
            get; private set;
        }
        public int Unmaps
        {
            get; private set;
        }
        public bool WrongEpoch
        {
            get; set;
        }
        public bool ThrowOnMap
        {
            get; set;
        }
        public bool ThrowOnUnmap
        {
            get; set;
        }
        public Action? DuringRead
        {
            get; set;
        }
        public GpuDriverMapping Map(IGpuPeerAllocationHold allocation, long offset, long length)
        {
            Maps++;
            _allocation = (GpuPeerTestHold)allocation;
            _offset = (int)offset;
            if (ThrowOnMap)
            {
                throw new GpuDriverException("map", 1);
            }
            return new(1);
        }
        public GpuMappingSynchronization SynchronizeForRead(GpuDriverMapping mapping, MemoryLocationToken location)
            => new(DriverApi, ApiVersion, WrongEpoch ? location with
            {
                Epoch = new(2)
            } : location, 1, true);
        public void Read(GpuDriverMapping mapping, long relativeOffset, Span<byte> destination)
        {
            Reads++;
            DuringRead?.Invoke();
            _allocation!.Bytes.AsSpan(_offset + (int)relativeOffset, destination.Length).CopyTo(destination);
        }
        public void Unmap(GpuDriverMapping mapping)
        {
            if (ThrowOnUnmap)
            {
                throw new GpuDriverException("unmap", 1);
            }
            Unmaps++;
        }
    }
}

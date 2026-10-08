using System.Buffers;
using System.Reflection;
using System.Threading.Tasks.Sources;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ManagedMemoryBackingTests
{
    [Fact]
    public async Task SharedRolesAndSmallViewsKeepOneInspectablePhysicalDescriptorUntilDrain()
    {
        var fixture = new Fixture(64);
        using ManagedMemoryBacking owner = fixture.Create(64);
        var roles = new List<ManagedMemoryBacking.MemoryRoleLease>();
        foreach (MemoryRoleKind kind in Enum.GetValues<MemoryRoleKind>())
        {
            roles.Add(owner.TryRetainRole(owner.Location, kind).Value!);
        }
        IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location, 1, 1).Value!;
        MemoryAllocationObservation observed = Assert.Single(fixture.Ledger.Allocations());
        Assert.Same(owner.Descriptor, observed.Descriptor);
        Assert.Equal(owner.Location.Allocation, observed.Allocation);
        Assert.Equal(3, observed.Descriptor!.Layout.LogicalBytes);
        Assert.Equal(64, observed.Descriptor.Layout.CapacityBytes);
        Assert.Equal(0, observed.Descriptor.Layout.AlignmentSlack);
        Assert.Equal(61, observed.Descriptor.Layout.RetainedSlack);
        Assert.Single(reader.Memory.ToArray());
        owner.Close();
        foreach (ManagedMemoryBacking.MemoryRoleLease role in roles)
        {
            role.Dispose();
        }
        Assert.Single(fixture.Ledger.Allocations());
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        reader.Dispose();
        await owner.Drained;
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(64, observed.Descriptor.Layout.CapacityBytes);
    }

    [Fact]
    public void ClrOutOfRangeCapacityIsRejectedBeforeCreatingAnyReservation()
    {
        var fixture = new Fixture(long.MaxValue);
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.TryCreate(int.MaxValue).Failure);
        Assert.Empty(fixture.Ledger.EventWindow().Events);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Allocations);
    }

    [Fact]
    public async Task UnclassifiedBackingIsClearedOnlyAfterTheFinalReaderEnds()
    {
        var fixture = new Fixture(64);
        using ManagedMemoryBacking owner = fixture.Create(64);
        // Independent forensic observation of the actual managed allocation; this
        // fixture reference prevents GC reclaim and is not a product serving lease.
        byte[] allocation = (byte[])typeof(ManagedMemoryBacking).GetField("_buffer",
            BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(owner)!;
        IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location).Value!;
        owner.Close();
        Assert.Equal(new byte[] { 1, 2, 3 }, allocation.AsSpan(0, 3).ToArray());
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        reader.Dispose();
        await owner.Drained;
        Assert.All(allocation, value => Assert.Equal((byte)0, value));
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task ActualConsumerAndSlotSurviveOuterCancellationUntilTerminalRead()
    {
        var fixture = new Fixture(64);
        var transport = new BarrierTransport();
        int releases = 0;
        using ManagedMemoryBacking owner = fixture.Create(64, _ =>
        {
            Assert.True(transport.Terminal);
            Interlocked.Increment(ref releases);
        });
        Task<MemoryOperationResult<MemoryOperationCompletion>> operation = owner.ConsumeAsync(owner.Location, transport.Start).AsTask();
        await transport.Started.Task;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        owner.Close();
        Assert.False(owner.Drained.IsCompleted);
        Assert.False(operation.IsCompleted);
        Assert.Equal(1, owner.Snapshot().Operations);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["operations"]);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        Assert.Equal(0, releases);
        await Task.Run(transport.Complete);
        Assert.True((await operation).Succeeded);
        await owner.Drained;
        Assert.Equal(new byte[] { 1, 2, 3 }, transport.Copied);
        Assert.Equal(1, transport.Consumptions);
        Assert.Equal(1, releases);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["operations"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task RolesAndPinRetainCapacityAfterReaderAndRootClose()
    {
        var fixture = new Fixture(64);
        int releases = 0;
        using ManagedMemoryBacking owner = fixture.Create(64, _ => releases++);
        ManagedMemoryBacking.MemoryRoleLease role = owner.TryRetainRole(owner.Location, MemoryRoleKind.LastGood).Value!;
        IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location).Value!;
        ReadOnlyMemory<byte> captured = reader.Memory;
        MemoryHandle pin = captured.Pin();
        MemoryHandle copiedPin = pin;
        owner.Close();
        reader.Dispose();
        reader.Dispose();
        Assert.Throws<ObjectDisposedException>(() => captured.Span.Length);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(1, owner.Snapshot().Pins);
        Assert.Equal(1, owner.Snapshot().LastGoodRoles);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        pin.Dispose();
        copiedPin.Dispose();
        Assert.Equal(0, owner.Snapshot().Pins);
        Assert.Equal(0, releases);
        role.Dispose();
        role.Dispose();
        owner.Dispose();
        await owner.Drained;
        Assert.Equal(1, releases);
        Assert.Equal(MemoryRetirementState.Released, owner.Snapshot().State);
        Assert.Equal(0, owner.Snapshot().Roles);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task ReaderSelectedBeforeCloseRetriesAgainstFreshLocation()
    {
        var fixture = new Fixture(128);
        using ManagedMemoryBacking old = fixture.Create(64);
        using ManagedMemoryBacking current = fixture.Create(64);
        ManagedMemoryBacking selected = old;
        old.Close();
        await old.Drained;
        Assert.Equal(MemoryFailure.OwnershipViolation, selected.TryAcquireHostView(selected.Location).Failure);
        Assert.Equal(MemoryFailure.StaleLocation, current.TryAcquireHostView(old.Location).Failure);
        using IMemoryHostReadLease retry = current.TryAcquireHostView(current.Location).Value!;
        Assert.Equal(new byte[] { 1, 2, 3 }, retry.Memory.ToArray());
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task SmallOverlayAndLongReaderCannotBeFreedForAnotherGeneration()
    {
        var fixture = new Fixture(64);
        using ManagedMemoryBacking old = fixture.Create(64);
        ManagedMemoryBacking.MemoryRoleLease overlay = old.TryRetainRole(old.Location, MemoryRoleKind.Overlay).Value!;
        IMemoryHostReadLease reader = old.TryAcquireHostView(old.Location, 1, 1).Value!;
        old.Close();
        Assert.Equal(1, reader.Memory.Length);
        Assert.Equal(2, reader.Memory.Span[0]);
        Assert.Equal(64, old.Snapshot().Capacity);
        for (int generation = 0; generation < 16; generation++)
        {
            Assert.Equal(MemoryFailure.BudgetRejected, fixture.TryCreate(64).Failure);
        }
        reader.Dispose();
        Assert.False(old.Drained.IsCompleted);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        overlay.Dispose();
        await old.Drained;
        using ManagedMemoryBacking next = fixture.Create(64);
        Assert.NotEqual(old.Location.Allocation, next.Location.Allocation);
        Assert.Equal(MemoryFailure.StaleLocation, next.TryAcquireHostView(old.Location).Failure);
    }

    [Fact]
    public async Task ConsumerFaultAndActualCancellationCleanUpWithoutMaskingCorrectness()
    {
        var fixture = new Fixture(64);
        using ManagedMemoryBacking owner = fixture.Create(64);
        var expected = new InvalidDataException("consumer-corruption");
        InvalidDataException actual = await Assert.ThrowsAsync<InvalidDataException>(() => owner.ConsumeAsync(
            owner.Location, (_, _) => ValueTask.FromException(expected)).AsTask());
        Assert.Same(expected, actual);
        Assert.Equal(0, owner.Snapshot().Operations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["operations"]);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        MemoryOperationResult<MemoryOperationCompletion> result = await owner.ConsumeAsync(owner.Location,
            (_, token) => ValueTask.FromCanceled(token), cancellation.Token);
        Assert.Equal(MemoryFailure.Cancelled, result.Failure);
        Assert.Equal(0, owner.Snapshot().Operations);
        owner.Close();
        await owner.Drained;
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task FiniteHoldAndOperationCapsRejectGrowthWithoutLosingExistingOwner()
    {
        var fixture = new Fixture(64, operationCap: 0);
        using ManagedMemoryBacking owner = fixture.Create(64, holdLimit: 2);
        using IMemoryHostReadLease first = owner.TryAcquireHostView(owner.Location).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, owner.TryAcquireHostView(owner.Location).Failure);
        Assert.Throws<InsufficientMemoryException>(() => first.Memory.Pin());
        Assert.Equal(0, owner.Snapshot().Pins);
        Assert.Equal(MemoryFailure.BudgetRejected,
            (await owner.ConsumeAsync(owner.Location, (_, _) => throw new InvalidOperationException("must-not-start"))).Failure);
        Assert.Equal(1, owner.Snapshot().Readers);
        Assert.Equal(0, owner.Snapshot().Operations);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task CapturedMemoryRejectsPostDisposeAndNeverExposesCapacityPadding()
    {
        var fixture = new Fixture(64);
        using ManagedMemoryBacking owner = fixture.Create(64);
        IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location).Value!;
        ReadOnlyMemory<byte> captured = reader.Memory;
        Assert.Equal(3, captured.Length);
        Assert.Equal(MemoryFailure.BoundsViolation, owner.TryAcquireHostView(owner.Location, 2, int.MaxValue).Failure);
        reader.Dispose();
        Assert.Throws<ObjectDisposedException>(() => captured.ToArray());
        Assert.Throws<ObjectDisposedException>(() => reader.Memory);
        owner.Close();
        await owner.Drained;
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task ConcurrentCloseAndCrossThreadDisposalsReleaseExactlyOnce()
    {
        var fixture = new Fixture(64);
        int releases = 0;
        using ManagedMemoryBacking owner = fixture.Create(64, _ => Interlocked.Increment(ref releases));
        var readers = Enumerable.Range(0, 32).Select(_ => owner.TryAcquireHostView(owner.Location).Value!).ToArray();
        await Task.WhenAll(Enumerable.Range(0, 16).Select(_ => Task.Run(owner.Dispose)));
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        await Task.WhenAll(readers.Select(reader => Task.Run(() =>
        {
            Assert.Equal(3, reader.Memory.Length);
            reader.Dispose();
            reader.Dispose();
        })));
        await owner.Drained;
        Assert.Equal(1, releases);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task CanonicalSharedProducerSurvivesCanceledWaiterWithoutDuplicateBuild()
    {
        var fixture = new Fixture(64);
        var transport = new BarrierTransport();
        using ManagedMemoryBacking owner = fixture.Create(64);
        var flight = new BoundedTaskSingleFlight<ManagedMemoryBacking>(maxActiveKeys: 1);
        int builds = 0;
        async Task<ManagedMemoryBacking> Build(CancellationToken token)
        {
            Assert.False(token.CanBeCanceled);
            Interlocked.Increment(ref builds);
            Assert.True((await owner.ConsumeAsync(owner.Location, transport.Start)).Succeeded);
            return owner;
        }
        using var canceledWaiter = new CancellationTokenSource();
        Task<ManagedMemoryBacking> first = flight.RunAsync(CachePolicyId.ArticleDetail, "memory-managed-fixture", Build, canceledWaiter.Token);
        await transport.Started.Task;
        Task<ManagedMemoryBacking> second = flight.RunAsync(CachePolicyId.ArticleDetail, "memory-managed-fixture", Build);
        canceledWaiter.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.Equal(1, builds);
        Assert.Equal(1, flight.ActiveKeyCount);
        Assert.False(second.IsCompleted);
        Assert.Equal(1, owner.Snapshot().Operations);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["payload"]);
        transport.Complete();
        Assert.Same(owner, await second);
        Assert.Equal(1, builds);
        Assert.Equal(1, transport.Consumptions);
        using IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location).Value!;
        Assert.Equal(new byte[] { 1, 2, 3 }, reader.Memory.ToArray());
    }

    private sealed class Fixture
    {
        private readonly ResourceDomainId _payload = new(Guid.NewGuid());
        private readonly ResourceDomainId _operations = new(Guid.NewGuid());
        public Fixture(long capacity, long operationCap = 8)
        {
            var topology = new MemoryResourceTopology([
                new(_payload, "payload", MemoryResourceUnit.Bytes, null),
                new(_operations, "operations", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new MemoryReservationCoordinator(topology, [
                new(_payload, MemoryResourceUnit.Bytes, capacity),
                new(_operations, MemoryResourceUnit.OperationSlots, operationCap)
            ], policyRevision: 1, entryLimit: 128, eventCapacity: 1024);
        }
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public MemoryOperationResult<ManagedMemoryBacking> TryCreate(int capacity, Action<int>? recorder = null, int holdLimit = 128)
            => ManagedMemoryBacking.TryCreate(Ledger, _payload, _operations,
                new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid())), new(1), new(1),
                new byte[] { 1, 2, 3 }, capacity, holdLimit, recorder);
        public ManagedMemoryBacking Create(int capacity, Action<int>? recorder = null, int holdLimit = 128)
            => TryCreate(capacity, recorder, holdLimit).Value!;
    }

    private sealed class BarrierTransport : IValueTaskSource
    {
        private ManualResetValueTaskSourceCore<bool> _source = new() { RunContinuationsAsynchronously = true };
        private ReadOnlyMemory<byte> _input;
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Terminal
        {
            get; private set;
        }
        public int Consumptions
        {
            get; private set;
        }
        public byte[]? Copied
        {
            get; private set;
        }
        public ValueTask Start(ReadOnlyMemory<byte> input, CancellationToken token)
        {
            _input = input;
            Started.SetResult();
            return new(this, _source.Version);
        }
        public void Complete()
        {
            try
            {
                Copied = _input.ToArray();
                Terminal = true;
                _source.SetResult(true);
            }
            catch (Exception exception)
            {
                Terminal = true;
                _source.SetException(exception);
            }
        }
        public void GetResult(short token)
        {
            Assert.Equal(0, Consumptions++);
            _source.GetResult(token);
        }
        public ValueTaskSourceStatus GetStatus(short token) => _source.GetStatus(token);
        public void OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
            => _source.OnCompleted(continuation, state, token, flags);
    }
}

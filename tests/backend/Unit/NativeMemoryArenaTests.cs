using System.Buffers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Host;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NativeMemoryArenaTests
{
    [Fact]
    public async Task SegmentsAndOversizedBlobsReserveRoundedCapacityBeforeRealAllocation()
    {
        var fixture = new Fixture(alignment: 16);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice first = fixture.Append(builder, [1, 2, 3]);
        NativeMemorySlice second = fixture.Append(builder, [4, 5]);
        NativeMemorySlice oversized = fixture.Append(builder, new byte[65]);
        NativeMemorySlice last = fixture.Append(builder, new byte[60]);
        Assert.Equal(MemoryFailure.OwnershipViolation, first.TryAcquireHostView(first.Location).Failure);
        Assert.Equal(first.Location.Allocation, second.Location.Allocation);
        Assert.NotEqual(first.Location.Allocation, oversized.Location.Allocation);
        Assert.NotEqual(first.Location.Allocation, last.Location.Allocation);
        Assert.Equal(new[] { 64, 80, 64 }, fixture.Allocator.Capacities);
        Assert.Equal(208, fixture.Ledger.Snapshot().Used["native-payload"]);
        Assert.Equal(3, fixture.Ledger.Snapshot().Reservations);
        using NativeMemoryArena arena = builder.Seal().Value!;
        builder.Dispose();
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(3, fixture.Ledger.Snapshot().Allocations);
        Assert.Equal(new NativeMemoryArenaSnapshot(208, 130, 78, 208, 0, null), arena.Snapshot());
        MemoryAllocationObservation observed = fixture.Ledger.Allocations().Single(item => item.Allocation == oversized.Location.Allocation);
        Assert.Equal(65, observed.Descriptor!.Layout.LogicalBytes);
        Assert.Equal(15, observed.Descriptor.Layout.AlignmentSlack);
        Assert.Equal(80, observed.Descriptor.Layout.CapacityBytes);
        using (IMemoryHostReadLease lease = second.TryAcquireHostView(second.Location).Value!)
        {
            Assert.Equal(new byte[] { 4, 5 }, lease.Memory.ToArray());
        }
        arena.Dispose();
        await arena.Drained;
        Assert.Equal(new NativeMemoryArenaSnapshot(208, 130, 78, 0, 208, 777), arena.Snapshot(777));
        fixture.AssertDrained(3);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(16)]
    public async Task CanaryTailNeverEntersSlicesHashesOrSerialization(int alignment)
    {
        var fixture = new Fixture(alignment: alignment);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        byte[] input = [9, 8, 7];
        NativeMemorySlice slice = fixture.Append(builder, input);
        input[0] = 99;
        using NativeMemoryArena arena = builder.Seal().Value!;
        using (IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!)
        {
            Assert.Equal(3, lease.Memory.Length);
            Assert.Equal(new byte[] { 9, 8, 7 }, lease.Memory.ToArray());
            Assert.Equal(SHA256.HashData(new byte[] { 9, 8, 7 }), SHA256.HashData(lease.Memory.Span));
            using var destination = new MemoryStream();
            await destination.WriteAsync(lease.Memory);
            Assert.Equal(new byte[] { 9, 8, 7 }, destination.ToArray());
        }
        arena.Dispose();
        await arena.Drained;
        byte[] beforeFree = Assert.Single(fixture.Allocator.BytesBeforeFree);
        Assert.All(beforeFree.Skip(3), item => Assert.Equal(0xA5, item));
        fixture.AssertDrained(1);
    }

    [Fact]
    public void InvalidAlignmentAndPolicyBoundsAreRejectedBeforeAllocatorCalls()
    {
        foreach (int alignment in new[] { 0, -1, 3, 2, int.MaxValue })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 128, 1024, 8, 16, 32, alignment));
        }
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(0, 128, 1024, 8, 16, 32));
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 32, 1024, 8, 16, 32));
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 128, 63, 8, 16, 32));
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 128, 1024, 0, 16, 32));
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 128, 1024, 8, 0, 32));
        Assert.Throws<ArgumentOutOfRangeException>(() => new NativeMemoryArenaPolicy(64, 128, 1024, 8, 16, 0));
    }

    [Fact]
    public void ExtremeLengthRoundingAndOffsetsCannotWrapIntoSmallAllocationOrView()
    {
        var fixture = new Fixture(alignment: 16);
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.Policy.Plan(long.MaxValue).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.Policy.Plan(int.MaxValue).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, MemoryAllocationLayout.TryPlan(long.MaxValue, 2, 16, long.MaxValue).Failure);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        Assert.Equal(MemoryFailure.BoundsViolation, builder.TryAppend(Fixture.Content(), new(1), new(1), new byte[129]).Failure);
        Assert.Empty(fixture.Ledger.EventWindow().Events);
        Assert.Empty(fixture.Allocator.Capacities);
        NativeMemorySlice slice = fixture.Append(builder, [1, 2, 3]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        foreach ((int offset, int length) in new[] { (-1, 1), (0, -1), (int.MaxValue, 1), (1, int.MaxValue), (3, 1) })
        {
            Assert.Equal(MemoryFailure.BoundsViolation, slice.TryAcquireHostView(slice.Location, offset, length).Failure);
        }
        using IMemoryHostReadLease empty = slice.TryAcquireHostView(slice.Location, 3, 0).Value!;
        Assert.Empty(empty.Memory.ToArray());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailureOnAllocationNDiscardsOnlyCandidateAndPreservesEarlierSealedBytes(bool throwFailure)
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder firstBuilder = fixture.Builder();
        NativeMemorySlice previous = fixture.Append(firstBuilder, [11, 12, 13]);
        using NativeMemoryArena previousArena = firstBuilder.Seal().Value!;
        fixture.Allocator.FailAt = 3;
        fixture.Allocator.ThrowFailure = throwFailure;
        using NativeMemoryArenaBuilder candidate = fixture.Builder();
        NativeMemorySlice abandoned = fixture.Append(candidate, new byte[64]);
        MemoryOperationResult<NativeMemorySlice> failure = candidate.TryAppend(Fixture.Content(), new(1), new(1), [99]);
        Assert.Equal(MemoryFailure.TierUnavailable, failure.Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, candidate.Seal().Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, abandoned.TryAcquireHostView(abandoned.Location).Failure);
        Assert.Equal(1, fixture.Ledger.Snapshot().Allocations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(64, fixture.Ledger.Snapshot().Used["native-payload"]);
        Assert.Single(fixture.Allocator.BytesBeforeFree);
        using (IMemoryHostReadLease lease = previous.TryAcquireHostView(previous.Location).Value!)
        {
            Assert.Equal(new byte[] { 11, 12, 13 }, lease.Memory.ToArray());
        }
        previousArena.Dispose();
        await previousArena.Drained;
        fixture.AssertDrained(2);
    }

    [Fact]
    public async Task RolesReadersPinsAndCopiedHandlesRetainOneChargeUntilActualDrain()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [1, 2, 3]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        IDisposable[] roles = Enum.GetValues<MemoryRoleKind>().Select(role => slice.TryRetainRole(slice.Location, role).Value!).ToArray();
        IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!;
        ReadOnlyMemory<byte> captured = lease.Memory;
        MemoryHandle pin = captured.Pin();
        MemoryHandle copiedPin = pin;
        arena.Dispose();
        arena.Dispose();
        Assert.Equal(MemoryFailure.OwnershipViolation, slice.TryAcquireHostView(slice.Location).Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, slice.TryRetainRole(slice.Location, MemoryRoleKind.Current).Failure);
        foreach (IDisposable role in roles)
        {
            role.Dispose();
            role.Dispose();
        }
        // Existing readers can pin while closing; no new independent reader starts.
        MemoryHandle closingPin = captured.Pin();
        lease.Dispose();
        lease.Dispose();
        Assert.Throws<ObjectDisposedException>(() => captured.ToArray());
        Assert.Throws<ObjectDisposedException>(() => captured.Pin());
        Assert.False(arena.Drained.IsCompleted);
        Assert.Equal(2, slice.Snapshot().Pins);
        Assert.Single(fixture.Ledger.Allocations());
        AssertPinnedBytes(closingPin, [1, 2, 3]);
        pin.Dispose();
        copiedPin.Dispose();
        Assert.False(arena.Drained.IsCompleted);
        closingPin.Dispose();
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    private static unsafe void AssertPinnedBytes(MemoryHandle pin, byte[] expected)
        => Assert.Equal(expected, new ReadOnlySpan<byte>(pin.Pointer, expected.Length).ToArray());

    [Fact]
    public async Task AdjacentSlicesStayWithinTheirOwnInitializedBoundariesDuringSubsequentAppends()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice first = fixture.Append(builder, [1, 2, 3]);
        NativeMemorySlice middle = fixture.Append(builder, [4, 5]);
        byte[] endBytes = Enumerable.Range(10, 59).Select(value => (byte)value).ToArray();
        NativeMemorySlice end = fixture.Append(builder, endBytes);
        using NativeMemoryArena arena = builder.Seal().Value!;
        Assert.Single(fixture.Ledger.Allocations());
        using (IMemoryHostReadLease reader = first.TryAcquireHostView(first.Location).Value!)
        {
            Assert.Equal(new byte[] { 1, 2, 3 }, reader.Memory.ToArray());
        }
        using (IMemoryHostReadLease reader = middle.TryAcquireHostView(middle.Location).Value!)
        {
            using MemoryHandle pin = reader.Memory.Pin();
            AssertPinnedBytes(pin, [4, 5]);
        }
        using (IMemoryHostReadLease reader = end.TryAcquireHostView(end.Location).Value!)
        {
            Assert.Equal(endBytes, reader.Memory.ToArray());
        }
        arena.Dispose();
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    [Fact]
    public async Task RepeatedCandidateBuildAndRetirementExplainAllRemainingOwnership()
    {
        var fixture = new Fixture();
        for (int iteration = 0; iteration < 64; iteration++)
        {
            using NativeMemoryArenaBuilder builder = fixture.Builder();
            NativeMemorySlice slice = fixture.Append(builder, [(byte)iteration]);
            using NativeMemoryArena arena = builder.Seal().Value!;
            using (IMemoryHostReadLease reader = slice.TryAcquireHostView(slice.Location).Value!)
            {
                Assert.Equal(new byte[] { (byte)iteration }, reader.Memory.ToArray());
            }
            arena.Dispose();
            await arena.Drained;
            fixture.AssertDrained(iteration + 1);
        }
    }

    [Fact]
    public async Task CrossThreadDuplicateDisposalDoesNotUnderflowOrDoubleFree()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [1]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!;
        IDisposable role = slice.TryRetainRole(slice.Location, MemoryRoleKind.Overlay).Value!;
        MemoryHandle pin = lease.Memory.Pin();
        MemoryHandle copy = pin;
        await Task.WhenAll(Task.Run(arena.Dispose), Task.Run(arena.Dispose), Task.Run(lease.Dispose),
            Task.Run(lease.Dispose), Task.Run(role.Dispose), Task.Run(role.Dispose));
        Assert.False(arena.Drained.IsCompleted);
        await Task.WhenAll(Task.Run(pin.Dispose), Task.Run(copy.Dispose));
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    [Fact]
    public async Task PinAndLeaseDisposalRaceEitherRetainsActualBytesOrRejectsDisposedMemory()
    {
        var fixture = new Fixture();
        for (int iteration = 0; iteration < 64; iteration++)
        {
            using NativeMemoryArenaBuilder builder = fixture.Builder();
            NativeMemorySlice slice = fixture.Append(builder, [3, 4]);
            using NativeMemoryArena arena = builder.Seal().Value!;
            IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!;
            ReadOnlyMemory<byte> captured = lease.Memory;
            var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Task pinning = Task.Run(async () =>
            {
                await start.Task;
                MemoryHandle pin;
                try
                {
                    pin = captured.Pin();
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                using (pin)
                {
                    AssertPinnedBytes(pin, [3, 4]);
                }
            });
            Task disposing = Task.Run(async () =>
            {
                await start.Task;
                arena.Dispose();
                lease.Dispose();
            });
            start.SetResult();
            await Task.WhenAll(pinning, disposing);
            await arena.Drained;
            fixture.AssertDrained(iteration + 1);
        }
    }

    [Fact]
    public async Task AllocatorRelinquishmentRemainsObservableWhenLedgerReleaseFaults()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        fixture.Append(builder, [1]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        // Isolate the existing ledger's terminal sequence-overflow path. Private
        // observation is fixture-only; no product accounting authority is bypassed.
        FieldInfo sequence = typeof(MemoryReservationCoordinator).GetField("_sequence", BindingFlags.Instance | BindingFlags.NonPublic)!;
        ulong previous = (ulong)sequence.GetValue(fixture.Ledger)!;
        NativeMemoryBlock block = Assert.Single((NativeMemoryBlock[])typeof(NativeMemoryArena)
            .GetField("_blocks", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(arena)!);
        IMemoryAllocationCharge charge = (IMemoryAllocationCharge)typeof(NativeMemoryBlock)
            .GetField("_charge", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(block)!;
        try
        {
            sequence.SetValue(fixture.Ledger, ulong.MaxValue);
            Assert.Throws<InvalidOperationException>(arena.Dispose);
            await Assert.ThrowsAsync<InvalidOperationException>(() => arena.Drained);
            Assert.Equal(0, arena.Snapshot().RetainedBytes);
            Assert.Equal(64, arena.Snapshot().AllocatorRelinquishedBytes);
            Assert.Single(fixture.Ledger.Allocations());
            Assert.Equal(64, fixture.Ledger.Snapshot().Used["native-payload"]);
            Assert.Single(fixture.Allocator.BytesBeforeFree);
        }
        finally
        {
            sequence.SetValue(fixture.Ledger, previous);
            charge.Dispose();
        }
        Assert.Empty(fixture.Allocator.Live);
        Assert.Empty(fixture.Ledger.Allocations());
    }

    [Fact]
    public async Task RetiredLocationCannotAcquireANewAllocationEvenWhenBytesAreReused()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder oldBuilder = fixture.Builder();
        NativeMemorySlice old = fixture.Append(oldBuilder, [1, 2]);
        using NativeMemoryArena oldArena = oldBuilder.Seal().Value!;
        IMemoryHostReadLease oldLease = old.TryAcquireHostView(old.Location).Value!;
        oldArena.Dispose();
        using NativeMemoryArenaBuilder newBuilder = fixture.Builder();
        NativeMemorySlice replacement = fixture.Append(newBuilder, [1, 2]);
        using NativeMemoryArena newArena = newBuilder.Seal().Value!;
        Assert.NotEqual(old.Location.Allocation, replacement.Location.Allocation);
        Assert.NotEqual(old.Location.Block, replacement.Location.Block);
        Assert.Equal(MemoryFailure.StaleLocation, replacement.TryAcquireHostView(old.Location).Failure);
        Assert.Equal(new byte[] { 1, 2 }, oldLease.Memory.ToArray());
        oldLease.Dispose();
        await oldArena.Drained;
        newArena.Dispose();
        await newArena.Drained;
        fixture.AssertDrained(2);
    }

    [Fact]
    public async Task SealClosesBuilderAndTransfersExactlyOneOwnershipResponsibility()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [1]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, builder.Seal().Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, builder.TryAppend(Fixture.Content(), new(1), new(1), [2]).Failure);
        builder.Dispose();
        builder.Dispose();
        Assert.Empty(fixture.Allocator.BytesBeforeFree);
        using (IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!)
        {
            Assert.Equal(new byte[] { 1 }, lease.Memory.ToArray());
        }
        arena.Dispose();
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    [Fact]
    public void UnsealedBuilderDisposalCleansEveryBlockAndReservation()
    {
        var fixture = new Fixture();
        NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, new byte[64]);
        fixture.Append(builder, new byte[65]);
        builder.Dispose();
        builder.Dispose();
        Assert.Equal(MemoryFailure.OwnershipViolation, builder.Seal().Failure);
        Assert.Equal(MemoryFailure.OwnershipViolation, slice.TryAcquireHostView(slice.Location).Failure);
        fixture.AssertDrained(2);
    }

    [Fact]
    public void FailedSealCleansBothCommittedAndUncommittedCandidateBlocks()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        fixture.Append(builder, new byte[64]);
        NativeMemorySlice second = fixture.Append(builder, [2]);
        using MemoryReservation conflict = fixture.Ledger.TryReserve([new(fixture.Payload, MemoryResourceUnit.Bytes, 1)]).Value!;
        using IMemoryAllocationCharge otherOwner = conflict.Commit(second.Location.Allocation,
            [new(fixture.Payload, MemoryResourceUnit.Bytes, 1)]).Value!;
        Assert.Equal(MemoryFailure.OwnershipViolation, builder.Seal().Failure);
        Assert.True(fixture.Ledger.Snapshot().Faulted);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["native-payload"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Single(fixture.Ledger.Allocations());
        Assert.Equal(2, fixture.Allocator.BytesBeforeFree.Count);
        otherOwner.Dispose();
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["native-payload"]);
    }

    [Theory]
    [InlineData(64, 8, 16)]
    [InlineData(1024, 1, 16)]
    public void ArenaAndBlockLimitsRejectGrowthAndCleanPartialCandidate(long maximumCapacity, int maximumBlocks, int maximumSlices)
    {
        var fixture = new Fixture(maximumArenaCapacity: maximumCapacity, maximumBlocks: maximumBlocks, maximumSlices: maximumSlices);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        fixture.Append(builder, new byte[64]);
        Assert.Equal(MemoryFailure.BudgetRejected, builder.TryAppend(Fixture.Content(), new(1), new(1), [2]).Failure);
        fixture.AssertDrained(1);
    }

    [Fact]
    public void SliceMetadataAndLedgerBudgetsRemainBounded()
    {
        var fixture = new Fixture(maximumSlices: 1);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        fixture.Append(builder, [1]);
        Assert.Equal(MemoryFailure.BudgetRejected, builder.TryAppend(Fixture.Content(), new(1), new(1), [2]).Failure);
        using NativeMemoryArena arena = builder.Seal().Value!;
        Assert.Single(arena.Slices);
        var rejected = new Fixture(payloadCap: 63);
        using NativeMemoryArenaBuilder deniedBuilder = rejected.Builder();
        Assert.Equal(MemoryFailure.BudgetRejected, deniedBuilder.TryAppend(Fixture.Content(), new(1), new(1), [1]).Failure);
        Assert.Empty(rejected.Allocator.Capacities);
        rejected.AssertDrained(0);
    }

    [Fact]
    public void HoldLimitsRejectNewReadersRolesAndPinsWithoutLosingOwnership()
    {
        var fixture = new Fixture(holdLimit: 2);
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [1]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        using IMemoryHostReadLease lease = slice.TryAcquireHostView(slice.Location).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, slice.TryAcquireHostView(slice.Location).Failure);
        Assert.Equal(MemoryFailure.BudgetRejected, slice.TryRetainRole(slice.Location, MemoryRoleKind.Current).Failure);
        Assert.Throws<InsufficientMemoryException>(() => lease.Memory.Pin());
        Assert.Equal(0, slice.Snapshot().Pins);
        Assert.Single(fixture.Ledger.Allocations());
    }

    [Fact]
    public async Task AsyncConsumerRetainsAdmissionUntilActualCompletionAfterCancellation()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [3, 4, 5]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        Task<MemoryOperationResult<MemoryOperationCompletion>> operation = slice.ConsumeAsync(slice.Location, async (bytes, _) =>
        {
            entered.SetResult();
            await finish.Task;
            Assert.Equal(new byte[] { 3, 4, 5 }, bytes.ToArray());
        }, cancellation.Token).AsTask();
        await entered.Task;
        arena.Dispose();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        Assert.False(arena.Drained.IsCompleted);
        Assert.Equal(1, slice.Snapshot().Operations);
        Assert.Equal(1, fixture.Ledger.Snapshot().Used["native-operations"]);
        finish.SetResult();
        Assert.True((await operation).Succeeded);
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    [Fact]
    public async Task ConsumerExceptionsAndCancellationReleaseOnlyTheirOwnHolds()
    {
        var fixture = new Fixture();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        NativeMemorySlice slice = fixture.Append(builder, [1]);
        using NativeMemoryArena arena = builder.Seal().Value!;
        await Assert.ThrowsAsync<IOException>(() => slice.ConsumeAsync(slice.Location,
            (_, _) => ValueTask.FromException(new IOException("consumer fault"))).AsTask());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        MemoryOperationResult<MemoryOperationCompletion> cancelled = await slice.ConsumeAsync(slice.Location,
            (_, token) => ValueTask.FromCanceled(token), cancellation.Token);
        Assert.Equal(MemoryFailure.Cancelled, cancelled.Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["native-operations"]);
        Assert.Equal(0, slice.Snapshot().Operations);
        Assert.Single(fixture.Ledger.Allocations());
        arena.Dispose();
        await arena.Drained;
        fixture.AssertDrained(1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ManagedAndNativeSourcesShareLeasePinAndByteOutputContracts(bool native)
    {
        var fixture = new Fixture();
        MemoryContentIdentity content = Fixture.Content();
        using NativeMemoryArenaBuilder builder = fixture.Builder();
        ManagedMemoryBacking? managed = null;
        NativeMemoryArena? arena = null;
        IMemoryHostViewSource source;
        MemoryLocationToken location;
        Task drained;
        if (native)
        {
            NativeMemorySlice slice = builder.TryAppend(content, new(1), new(1), new byte[] { 6, 7, 8 }).Value!;
            arena = builder.Seal().Value!;
            source = slice;
            location = slice.Location;
            drained = arena.Drained;
        }
        else
        {
            managed = ManagedMemoryBacking.TryCreate(fixture.Ledger, fixture.Payload, fixture.Operations,
                content, new(1), new(1), new byte[] { 6, 7, 8 }, 64, 32).Value!;
            source = managed;
            location = managed.Location;
            drained = managed.Drained;
        }
        IMemoryHostReadLease lease = source.TryAcquireHostView(location).Value!;
        Assert.Equal(content, lease.Content);
        Assert.Equal(location, lease.Location);
        Assert.Equal(new byte[] { 6, 7, 8 }, lease.Memory.ToArray());
        MemoryHandle pin = lease.Memory.Pin();
        managed?.Dispose();
        arena?.Dispose();
        Assert.Equal(MemoryFailure.OwnershipViolation, source.TryAcquireHostView(location).Failure);
        lease.Dispose();
        Assert.False(drained.IsCompleted);
        pin.Dispose();
        await drained;
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["native-payload"]);
    }

    [Theory]
    [InlineData(MemoryCapabilityMode.Auto)]
    [InlineData(MemoryCapabilityMode.Disabled)]
    [InlineData(MemoryCapabilityMode.Required)]
    public void DiscoveryReportsInputsWithoutInventingQualificationOrSelectingItself(MemoryCapabilityMode mode)
    {
        var policy = new MemoryCapabilityPolicyRevision(1,
            mode == MemoryCapabilityMode.Auto ? new Dictionary<string, MemoryCapabilityMode>()
                : new Dictionary<string, MemoryCapabilityMode> { ["NativeMemory"] = mode });
        NativeMemoryBackendDiscovery discovery = NativeMemoryBackendDiscovery.Discover(policy);
        Assert.Equal(mode, discovery.Status.Requested);
        Assert.Equal(mode == MemoryCapabilityMode.Disabled ? MemoryDetection.Unknown : MemoryDetection.Present, discovery.Status.Detection);
        Assert.Equal(MemoryQualification.NotVerified, discovery.Status.ReleaseQualification);
        Assert.Equal(MemoryQualification.NotVerified, discovery.Status.RuntimeQualification);
        Assert.Null(discovery.Status.EffectivePath);
        Assert.Equal(RuntimeInformation.ProcessArchitecture, discovery.Architecture);
    }

    private sealed class Fixture
    {
        internal ResourceDomainId Payload { get; } = new(Guid.NewGuid());
        internal ResourceDomainId Operations { get; } = new(Guid.NewGuid());
        internal MemoryReservationCoordinator Ledger
        {
            get;
        }
        internal NativeMemoryArenaPolicy Policy
        {
            get;
        }
        internal RecordingAllocator Allocator
        {
            get;
        }

        internal Fixture(int alignment = 1, long maximumArenaCapacity = 1024, int maximumBlocks = 8,
            int maximumSlices = 16, int holdLimit = 32, long payloadCap = 4096)
        {
            var topology = new MemoryResourceTopology([
                new(Payload, "native-payload", MemoryResourceUnit.Bytes, null),
                new(Operations, "native-operations", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new(topology, [new(Payload, MemoryResourceUnit.Bytes, payloadCap),
                new(Operations, MemoryResourceUnit.OperationSlots, 4)], 1, 64, 256);
            Policy = new(64, 128, maximumArenaCapacity, maximumBlocks, maximumSlices, holdLimit, alignment);
            Allocator = new(Ledger);
        }

        internal NativeMemoryArenaBuilder Builder() => new(Ledger, Payload, Operations, Policy, Allocator);
        internal static MemoryContentIdentity Content() => new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
        internal NativeMemorySlice Append(NativeMemoryArenaBuilder builder, ReadOnlySpan<byte> payload)
        {
            MemoryOperationResult<NativeMemorySlice> result = builder.TryAppend(Content(), new(1), new(1), payload);
            Assert.True(result.Succeeded, result.Failure?.ToString());
            return result.Value!;
        }

        internal void AssertDrained(int frees)
        {
            Assert.Equal(frees, Allocator.BytesBeforeFree.Count);
            Assert.Equal(0, Ledger.Snapshot().Reservations);
            Assert.Empty(Ledger.Allocations());
            Assert.All(Ledger.Snapshot().Used.Values, value => Assert.Equal(0, value));
            Assert.False(Ledger.Snapshot().Faulted);
            Assert.Empty(Allocator.Live);
        }
    }

    private sealed class RecordingAllocator(MemoryReservationCoordinator ledger) : INativeMemoryAllocator
    {
        private int _calls;
        internal int FailAt
        {
            get; set;
        }
        internal bool ThrowFailure
        {
            get; set;
        }
        internal List<int> Capacities { get; } = [];
        internal List<byte[]> BytesBeforeFree { get; } = [];
        internal Dictionary<nint, (int Capacity, int Alignment)> Live { get; } = [];

        public unsafe nint Allocate(int capacity, int alignment)
        {
            Assert.True(ledger.Snapshot().Reservations > 0);
            MemoryAccountingEvent last = ledger.EventWindow().Events.Last();
            Assert.Equal("reserved", last.Kind);
            Assert.Equal(capacity, last.Delta["native-payload"]);
            if (++_calls == FailAt)
            {
                if (ThrowFailure)
                {
                    throw new OutOfMemoryException("allocation N fault injection");
                }
                return 0;
            }
            nint address = NativeMemoryAllocator.Instance.Allocate(capacity, alignment);
            Assert.NotEqual(0, address);
            if (alignment != 1)
            {
                Assert.Equal(0, address % alignment);
            }
            new Span<byte>((void*)address, capacity).Fill(0xA5);
            Live.Add(address, (capacity, alignment));
            Capacities.Add(capacity);
            return address;
        }

        public unsafe void ClearAndFree(nint address, int capacity, int alignment)
        {
            Assert.True(Live.Remove(address, out var allocation));
            Assert.Equal((capacity, alignment), allocation);
            BytesBeforeFree.Add(new ReadOnlySpan<byte>((void*)address, capacity).ToArray());
            NativeMemoryAllocator.Instance.ClearAndFree(address, capacity, alignment);
        }
    }
}

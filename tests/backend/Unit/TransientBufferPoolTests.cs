using System.Buffers;
using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Transient;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TransientBufferPoolTests
{
    [Fact]
    public void T08_ReturnRetainsActualBucketCharge_TrimRefundsExactlyOnce()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.RequestScratch, new(64, 8, 2, 64));
        IMemoryOwner<byte> lease = pool.TryRent(17).Value!;
        lease.Memory.Span.Fill(0xA5);
        AllocationId allocation = ((TransientBufferLease)lease).Allocation;
        Assert.Equal(32, ((TransientBufferLease)lease).Capacity);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        Assert.Equal(17, ledger.Allocations().Single().Descriptor!.Layout.LogicalBytes);
        Memory<byte> captured = lease.Memory;
        lease.Dispose();
        Assert.Throws<ObjectDisposedException>(() => captured.Span.ToArray());
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        Assert.Equal(32, pool.Snapshot().RetainedBytes);
        Assert.DoesNotContain(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
        using (IMemoryOwner<byte> reused = pool.TryRent(20).Value!)
        {
            Assert.Equal(allocation, ((TransientBufferLease)reused).Allocation);
            Assert.All(reused.Memory.ToArray(), value => Assert.Equal(0, value));
            Assert.Single(ledger.EventWindow().Events.Where(item => item.Kind == "committed"));
        }
        Assert.Equal(1, pool.Trim(1));
        Assert.Equal(0, pool.Trim(1));
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events.Where(item => item.Kind == "allocation-released"));
    }

    [Fact]
    public void T01_IndependentPoolsCompeteForTheSameFinalHostBudget()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var first = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 8, 1, 32));
        using var second = new TransientBufferPool(ledger, host, TransientWorkload.Compression, new(32, 8, 1, 32));
        using IMemoryOwner<byte> lease = first.TryRent(17).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, second.TryRent(1).Failure);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        Assert.Equal(0, ledger.Snapshot().Reservations);
        Assert.Single(ledger.Allocations());
    }

    [Fact]
    public async Task T11_CanceledOuterWaitDoesNotReturnTheStillRunningConsumer()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.SocketSend, new(32, 8, 1, 32));
        IMemoryOwner<byte> lease = pool.TryRent(20).Value!;
        lease.Memory.Span[0] = 91;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        Task operation = ((TransientBufferLease)lease).ConsumeAsync(async (memory, _) =>
        {
            entered.SetResult();
            await complete.Task;
            Assert.Equal(91, memory.Span[0]);
        }, cancellation.Token).AsTask();
        await entered.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        lease.Dispose();
        pool.Dispose();
        Assert.False(pool.Drained.IsCompleted);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        complete.SetResult();
        await operation;
        await pool.Drained;
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void PinCopiesKeepBackingChargedThroughCloseAndReturnOnlyOnce()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Recovery, new(32, 3, 0, 0));
        IMemoryOwner<byte> lease = pool.TryRent(17).Value!;
        MemoryHandle pin = lease.Memory.Pin();
        MemoryHandle copy = pin;
        lease.Dispose();
        pool.Dispose();
        Assert.False(pool.Drained.IsCompleted);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        pin.Dispose();
        copy.Dispose();
        Assert.True(pool.Drained.IsCompletedSuccessfully);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events.Where(item => item.Kind == "allocation-released"));
    }

    [Fact]
    public void DisposedPinCopyDoesNotKeepARefundedArrayAlive()
    {
        var (pinCopy, backing) = CreateDisposedPinCopy();
        // This is a forensic root check after every owner has explicitly ended,
        // not a GC-driven cleanup path or an assertion of OS reclamation.
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        Assert.False(backing.IsAlive);
        GC.KeepAlive(pinCopy);
        pinCopy.Dispose();
    }

    [Fact]
    public void AutoRetention_DisableDrainsIdleCapacityAndPreservesMandatoryAdmission()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.BackgroundBuild, new(32, 2, 1, 32));
        IMemoryOwner<byte> first = pool.TryRent(17).Value!;
        first.Dispose();
        Assert.Equal(32, pool.Snapshot().RetainedBytes);
        pool.ApplyMode(MemoryCapabilityMode.Disabled);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        IMemoryOwner<byte> second = pool.TryRent(17).Value!;
        Assert.Equal(17, ((TransientBufferLease)second).Capacity);
        Assert.Equal(MemoryFailure.BudgetRejected, pool.TryRent(17).Failure);
        second.Dispose();
        Assert.Equal(0, pool.Snapshot().RetainedBuffers);
        pool.ApplyMode(MemoryCapabilityMode.Auto);
        using IMemoryOwner<byte> third = pool.TryRent(17).Value!;
        Assert.Equal(32, ((TransientBufferLease)third).Capacity);
    }

    [Fact]
    public void RepeatedParallelBurstsNeverExceedCapacityOrRetentionLimits()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(128);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 1, 64));
        Parallel.For(0, 256, _ =>
        {
            var rent = pool.TryRent(33);
            if (rent.Succeeded)
            {
                using IMemoryOwner<byte> lease = rent.Value!;
                Assert.InRange(ledger.Snapshot().Used["host"], 0, 128);
                lease.Memory.Span.Fill(1);
            }
            else
            {
                Assert.Equal(MemoryFailure.BudgetRejected, rent.Failure);
            }
        });
        Assert.Equal(0, pool.Snapshot().Holds);
        Assert.InRange(pool.Snapshot().RetainedBuffers, 0, 1);
        Assert.InRange(pool.Snapshot().RetainedBytes, 0, 64);
        pool.Trim(1);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.False(ledger.Snapshot().Faulted);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (MemoryHandle Copy, WeakReference Backing) CreateDisposedPinCopy()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Recovery, new(32, 3, 0, 0));
        IMemoryOwner<byte> lease = pool.TryRent(17).Value!;
        var buffer = (TransientBufferPool.Buffer)typeof(TransientBufferLease)
            .GetField("_buffer", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(lease)!;
        var backing = new WeakReference(buffer.Bytes);
        MemoryHandle original = lease.Memory.Pin();
        MemoryHandle copy = original;
        lease.Dispose();
        pool.Dispose();
        original.Dispose();
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        return (copy, backing);
    }
}

using FsusBlog.Server.Infrastructure.Memory.Transient;
using FsusBlog.Server.Infrastructure.NotificationStream;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationPayloadLeaseTests
{
    [Fact]
    public async Task T40_OnePayloadRemainsChargedThroughFastAndSlowRecipientCompletion()
    {
        var (ledger, host, _) = TransientBufferPoolTests.CreateLedger(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.WebSocketFanout, new(64, 8, 0, 0));
        byte[] source = [1, 2, 3, 4, 5];
        SharedNotificationStreamFrame frame = NotificationPayloadLease.TryCreate(pool, source).Value!;
        source[0] = 255;
        var fast = new NotificationStreamConnection("fast", "user", [], 2, queueByteCapacity: 16);
        var slow = new NotificationStreamConnection("slow", "user", [], 1, queueByteCapacity: 8);
        frame.Retain();
        Assert.True(fast.TryEnqueue(frame));
        frame.Retain();
        Assert.True(slow.TryEnqueue(frame));
        frame.Release();
        Assert.Single(ledger.Allocations());
        Assert.Equal(8, ledger.Snapshot().Used["host"]);
        using var cancellation = new CancellationTokenSource();
        var fastWrite = await fast.ReadForWriteAsync(cancellation.Token);
        Assert.Equal(1, fastWrite.Frame.Memory.Span[0]);
        fast.CompleteSocketWrite(fastWrite, true, "completed");
        fastWrite.Frame.Release();
        var slowWrite = await slow.ReadForWriteAsync(cancellation.Token);
        frame.Retain();
        Assert.False(slow.TryEnqueue(frame));
        Assert.True(slow.IsClosed);
        Assert.Equal("fsus_replay_required:connection_frame_budget", slow.CloseInstruction.Reason);
        pool.Dispose();
        Assert.False(pool.Drained.IsCompleted);
        Assert.Equal(8, ledger.Snapshot().Used["host"]);
        slow.CompleteSocketWrite(slowWrite, true, "completed");
        slowWrite.Frame.Release();
        await pool.Drained;
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Equal(1, fast.DeliverySnapshot.SocketWriteCompleted);
        Assert.Equal(1, slow.DeliverySnapshot.SocketWriteCompleted);
        Assert.Equal(1, slow.DeliverySnapshot.ReplayRequired);
    }

    [Fact]
    public async Task T41_ShutdownDisposesQueuedHoldsButKeepsInFlightOwnerAndReplayObligation()
    {
        var (ledger, host, _) = TransientBufferPoolTests.CreateLedger(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.WebSocketFanout, new(64, 8, 0, 0));
        SharedNotificationStreamFrame frame = NotificationPayloadLease.TryCreate(pool, new byte[17]).Value!;
        var connection = new NotificationStreamConnection("shutdown", "user", [], 2, queueByteCapacity: 64);
        frame.Retain();
        Assert.True(connection.TryEnqueue(frame));
        frame.Retain();
        Assert.True(connection.TryEnqueue(frame));
        frame.Release();
        using var cancellation = new CancellationTokenSource();
        var write = await connection.ReadForWriteAsync(cancellation.Token);
        connection.Complete();
        pool.Dispose();
        Assert.Equal(0, connection.QueuedFrameCount);
        Assert.Equal(1, connection.InFlightWriteCount);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        Assert.False(pool.Drained.IsCompleted);
        connection.CompleteSocketWrite(write, false, "transport-canceled");
        write.Frame.Release();
        await pool.Drained;
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Equal(2, connection.DeliverySnapshot.ReplayRequired);
        Assert.Equal(0, connection.DeliverySnapshot.SocketWriteCompleted);
        Assert.Throws<ObjectDisposedException>(() => frame.Memory.ToArray());
    }

    [Fact]
    public void T40_ByteLimitIsIndependentOfFrameCount()
    {
        var (ledger, host, _) = TransientBufferPoolTests.CreateLedger(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.WebSocketFanout, new(64, 8, 0, 0));
        SharedNotificationStreamFrame frame = NotificationPayloadLease.TryCreate(pool, new byte[17]).Value!;
        var connection = new NotificationStreamConnection("bytes", "user", [], 8, queueByteCapacity: 16);
        frame.Retain();
        Assert.False(connection.TryEnqueue(frame));
        Assert.Equal("fsus_replay_required:connection_byte_budget", connection.CloseInstruction.Reason);
        Assert.Equal(0, connection.QueuedFrameCount);
        frame.Release();
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Equal(1, connection.DeliverySnapshot.ReplayRequired);
    }
}

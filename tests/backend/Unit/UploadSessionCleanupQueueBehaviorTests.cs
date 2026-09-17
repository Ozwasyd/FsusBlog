using FsusBlog.Server.Services.Background;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UploadSessionCleanupQueueBehaviorTests
{
    [Fact]
    public void TryRequestScan_BoundedCapacityRejectsTheFirstOverflow()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);

        for (int i = 0; i < UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            Assert.True(queue.TryRequestScan());
        }

        Assert.False(queue.TryRequestScan());
        Assert.Equal(UploadSessionCleanupQueue.SignalCapacity, queue.DrainPendingSignals());
    }

    [Fact]
    public void ConsumeOverflowedSignal_ConsumesOverflowOnlyOnce()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        for (int i = 0; i <= UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            queue.TryRequestScan();
        }

        Assert.True(queue.ConsumeOverflowedSignal());
        Assert.False(queue.ConsumeOverflowedSignal());
    }

    [Fact]
    public void TryRequestScan_DefaultWindowCoalescesUntilClockReachesBoundary()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-06-25T00:00:00Z"));
        var queue = new UploadSessionCleanupQueue(clock);

        Assert.True(queue.TryRequestScan());
        Assert.False(queue.TryRequestScan());
        clock.Advance(TimeSpan.FromSeconds(44));
        Assert.False(queue.TryRequestScan());
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.True(queue.TryRequestScan());

        Assert.Equal(2, queue.DrainPendingSignals());
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan value) => _now = _now.Add(value);
    }
}

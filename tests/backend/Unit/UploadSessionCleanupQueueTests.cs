using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UploadSessionCleanupQueueTests
{
    [Fact]
    public void TryRequestScan_BuffersSignalsArrivingDuringCleanup()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);

        for (int i = 0; i < UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            Assert.True(queue.TryRequestScan());
        }

        Assert.Equal(UploadSessionCleanupQueue.SignalCapacity, queue.DrainPendingSignals());
        Assert.False(queue.ConsumeOverflowedSignal());
    }

    [Fact]
    public void TryRequestScan_WhenChannelIsFullMarksOverflow()
    {
        var queue = new UploadSessionCleanupQueue(minSignalInterval: TimeSpan.Zero);
        for (int i = 0; i < UploadSessionCleanupQueue.SignalCapacity; i++)
        {
            Assert.True(queue.TryRequestScan());
        }

        Assert.False(queue.TryRequestScan());

        Assert.True(queue.ConsumeOverflowedSignal());
        Assert.False(queue.ConsumeOverflowedSignal());
    }

    [Fact]
    public void SourceUsesWaitModeAndRetriesOverflowAfterCleanup()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Background/UploadSessionCleanupWorker.cs");

        Assert.Contains("FullMode = BoundedChannelFullMode.Wait", source, StringComparison.Ordinal);
        Assert.DoesNotContain("BoundedChannelFullMode.DropWrite", source, StringComparison.Ordinal);
        Assert.Contains("queue.ConsumeOverflowedSignal()", source, StringComparison.Ordinal);
    }

    [Fact]
    public void TryRequestScan_DefaultWindowCoalescesRepeatedSignals()
    {
        var queue = new UploadSessionCleanupQueue();

        Assert.True(queue.TryRequestScan());
        Assert.False(queue.TryRequestScan());
        Assert.False(queue.TryRequestScan());

        Assert.Equal(1, queue.DrainPendingSignals());
    }
}

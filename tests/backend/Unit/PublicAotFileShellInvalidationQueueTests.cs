using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotFileShellInvalidationQueueTests
{
    [Fact]
    public void Saturation_CoalescesToOneDominatingAllInvalidation()
    {
        var queue = new PublicAotFileShellInvalidationQueue(capacity: 2);

        Assert.True(queue.TryWrite(PublicAotInvalidationMessage.Key("article:1")));
        Assert.True(queue.TryWrite(PublicAotInvalidationMessage.Prefix("taxonomy:")));
        Assert.False(queue.TryWrite(PublicAotInvalidationMessage.Key("article:2")));
        Assert.False(queue.TryWrite(PublicAotInvalidationMessage.Key("article:3")));

        PublicAotFileShellInvalidationQueueSnapshot saturated = queue.Snapshot();
        Assert.Equal(2, saturated.QueuedCount);
        Assert.Equal(1, saturated.CoalescedAllPendingCount);
        Assert.Equal(2, saturated.CoalescedCount);
        Assert.Equal(4, saturated.Sequence);

        Assert.True(queue.TryReadForTests(out PublicAotInvalidationMessage first));
        Assert.Equal(PublicAotInvalidationMessage.TypeKey, first.Type);
        queue.MarkProcessed();
        Assert.True(queue.TryReadForTests(out _));
        queue.MarkProcessed();
        Assert.True(queue.TryTakeCoalescedAll(out PublicAotInvalidationMessage all));
        Assert.Equal(PublicAotInvalidationMessage.TypeAll, all.Type);
        queue.MarkProcessed();

        PublicAotFileShellInvalidationQueueSnapshot drained = queue.Snapshot();
        Assert.Equal(0, drained.QueuedCount);
        Assert.Equal(0, drained.InFlightCount);
        Assert.Equal(0, drained.CoalescedAllPendingCount);
        Assert.Equal(0, drained.TerminalFailureCount);
    }

    [Fact]
    public void WorkerFailure_RetainsAllMarkerUntilSuccessfulRetry()
    {
        var queue = new PublicAotFileShellInvalidationQueue(capacity: 1);
        Assert.True(queue.TryWrite(PublicAotInvalidationMessage.Key("article:1")));
        Assert.True(queue.TryReadForTests(out _));

        queue.MarkFailedForRetry();

        PublicAotFileShellInvalidationQueueSnapshot failed = queue.Snapshot();
        Assert.Equal(0, failed.InFlightCount);
        Assert.Equal(1, failed.CoalescedAllPendingCount);
        Assert.Equal(1, failed.TerminalFailureCount);
        Assert.True(queue.TryTakeCoalescedAll(out PublicAotInvalidationMessage retry));
        Assert.Equal(PublicAotInvalidationMessage.TypeAll, retry.Type);
        Assert.Equal(1, queue.Snapshot().InFlightCount);

        queue.MarkProcessed();

        PublicAotFileShellInvalidationQueueSnapshot recovered = queue.Snapshot();
        Assert.Equal(0, recovered.InFlightCount);
        Assert.Equal(0, recovered.CoalescedAllPendingCount);
        Assert.Equal(0, recovered.TerminalFailureCount);
    }

    [Fact]
    public void ClosedWriter_FailsClosedWithObservableAllMarker()
    {
        var queue = new PublicAotFileShellInvalidationQueue(capacity: 1);
        queue.Complete();

        Assert.False(queue.TryWrite(PublicAotInvalidationMessage.Key("article:1")));

        PublicAotFileShellInvalidationQueueSnapshot snapshot = queue.Snapshot();
        Assert.Equal(0, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.CoalescedAllPendingCount);
        Assert.Equal(1, snapshot.CoalescedCount);
        Assert.Equal(1, snapshot.Sequence);
    }
}

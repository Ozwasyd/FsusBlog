using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBackfillQueueWrapperTests
{
    [Fact]
    public void QueueFull_RetainsLatestTargetAsDurablePendingWithoutLeakingReservations()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler(capacity: 32);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            Assert.True(Schedule(scheduler, $"home:{i}", $"cache:{i}", version: 1));
        }

        var overflow = new PublicAotBackfillRequest(PublicPageKind.ArticleDetail, "article:99", "/article/99", string.Empty, "cache:overflow")
        {
            ScheduledInvalidationVersion = 7
        };
        Assert.False(scheduler.TrySchedule(overflow));
        PublicAotBackfillQueueSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(scheduler.QueueCapacity, scheduler.InFlightCount);
        Assert.Equal(scheduler.QueueCapacity, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.DurablePendingCount);
        Assert.Equal(7, snapshot.TargetGeneration);
        Assert.Equal("durable-pending", snapshot.LastDisposition);
        Assert.Equal("queue-full", snapshot.LastFailureReason);
        Assert.Equal(scheduler.QueueCapacity + 1, snapshot.OutstandingCount);
    }

    [Fact]
    public void OlderGenerationArrivingLate_CannotCoverNewerTarget()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler();
        var stale = Request("article:42", "cache:article:42", 1);
        var fresh = Request("article:42", "cache:article:42", 2);
        Assert.True(scheduler.TrySchedule(stale));
        Assert.True(scheduler.TrySchedule(fresh));
        Assert.False(scheduler.ShouldProcess(stale));
        Assert.True(scheduler.ShouldProcess(fresh));
        Assert.Equal(2, scheduler.Snapshot().TargetGeneration);
    }

    [Fact]
    public void DequeueMarksInFlightWhileQueuedIsZero()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler();
        var request = Request("home", "cache:home", 3);
        Assert.True(scheduler.TrySchedule(request));
        scheduler.Begin(request);
        PublicAotBackfillQueueSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(0, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.InFlightCount);
        Assert.Equal("in-flight", snapshot.LastDisposition);
        scheduler.Complete(request);
        Assert.Equal(0, scheduler.Snapshot().OutstandingCount);
        Assert.Equal("committed", scheduler.Snapshot().LastDisposition);
    }

    [Fact]
    public void WorkerFailureKeepsDurablePendingAndReplayRestoresExactTarget()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler(capacity: 32);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            Assert.True(Schedule(scheduler, $"home:{i}", $"cache:{i}", 1));
        }

        var failed = Request("article:7", "cache:article:7", 11);
        Assert.False(scheduler.TrySchedule(failed));
        Assert.Equal(11, scheduler.Snapshot().TargetGeneration);

        PublicAotBackfillRequest queued = Request("home:0", "cache:0", 1);
        scheduler.Begin(queued);
        scheduler.Complete(queued, committed: true);
        scheduler.ReplayDurablePending();
        PublicAotBackfillQueueSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(11, snapshot.TargetGeneration);
        Assert.True(snapshot.QueuedCount + snapshot.DurablePendingCount >= 1);
        Assert.False(scheduler.ShouldProcess(Request("article:7", "cache:article:7", 10)));
    }

    [Fact]
    public void DrainCountsQueuedInFlightDurablePendingAndTargetGeneration()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler(capacity: 32);
        for (int i = 0; i < scheduler.QueueCapacity; i++)
        {
            Assert.True(Schedule(scheduler, $"page:{i}", $"cache:{i}", 1));
        }

        Assert.False(scheduler.TrySchedule(Request("late", "cache:late", 9)));
        var inFlight = Request("page:0", "cache:0", 1);
        scheduler.Begin(inFlight);
        var participant = new PublicAotBackfillReleaseDrainParticipant(scheduler, TimeProvider.System);
        ReleaseDrainParticipantSnapshot drain = participant.Snapshot();
        Assert.Equal("pending", drain.Status);
        Assert.Contains(drain.Blockers!, static item => item.StartsWith("queued=", StringComparison.Ordinal));
        Assert.Contains(drain.Blockers!, static item => item == "in-flight=1");
        Assert.Contains(drain.Blockers!, static item => item == "durable-pending=1");
        Assert.Contains(drain.Blockers!, static item => item == "target-generation=9");
        Assert.Equal(scheduler.Snapshot().OutstandingCount, drain.PendingCount);
    }

    [Fact]
    public void GenerationRegressionIsRejectedAsCoalescedToNewer()
    {
        PublicAotBackfillScheduler scheduler = CreateScheduler();
        Assert.True(scheduler.TrySchedule(Request("article:1", "cache:article:1", 5)));
        scheduler.Complete(Request("article:1", "cache:article:1", 5));
        var older = Request("article:1", "cache:article:1", 4);
        scheduler.RetainDurablePending(older, "restart-replay");
        scheduler.ReplayDurablePending();
        Assert.Equal(0, scheduler.Snapshot().DurablePendingCount);
        Assert.False(scheduler.ShouldProcess(older));
        Assert.Equal("coalesced-to-newer", scheduler.Snapshot().LastDisposition);
    }

    private static PublicAotBackfillScheduler CreateScheduler(int capacity = 32)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:BackfillQueueCapacity"] = capacity.ToString()
            })
            .Build();
        return new PublicAotBackfillScheduler(configuration);
    }

    private static bool Schedule(PublicAotBackfillScheduler scheduler, string routeKey, string cacheKey, long version)
        => scheduler.TrySchedule(Request(routeKey, cacheKey, version));

    private static PublicAotBackfillRequest Request(string routeKey, string cacheKey, long version)
        => new(PublicPageKind.Home, routeKey, "/", string.Empty, cacheKey)
        {
            ScheduledInvalidationVersion = version
        };
}

using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentMutationOutboxRuntimeStateTests
{
    [Fact]
    public void Update_ExposesBacklogLatencyRetryFailureAndPoisonState()
    {
        var state = new CommentMutationOutboxRuntimeState();
        DateTime completedAt = new(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);

        state.Update(backlog: 9, failed: 2, poison: 1, oldestAgeSeconds: 47, processedDelta: 3, completedAt, "TimeoutException");
        CommentMutationOutboxRuntimeSnapshot snapshot = state.CreateSnapshot();

        Assert.Equal(9, snapshot.BacklogCount);
        Assert.Equal(2, snapshot.FailedCount);
        Assert.Equal(1, snapshot.PoisonCount);
        Assert.Equal(47, snapshot.OldestAgeSeconds);
        Assert.Equal(3, snapshot.ProcessedCount);
        Assert.Equal(completedAt, snapshot.LastCompletedAtUtc);
        Assert.Equal("TimeoutException", snapshot.LastError);
    }

    [Fact]
    public void BuildSourceEventId_IsStablePerEventAndConsumer()
    {
        long first = CommentMutationOutboxWorker.BuildSourceEventId("018ff010-1234-7abc-8def-0123456789ab", "reply");
        long replay = CommentMutationOutboxWorker.BuildSourceEventId("018ff010-1234-7abc-8def-0123456789ab", "reply");
        long otherConsumer = CommentMutationOutboxWorker.BuildSourceEventId("018ff010-1234-7abc-8def-0123456789ab", "deletion");

        Assert.True(first > 0);
        Assert.Equal(first, replay);
        Assert.NotEqual(first, otherConsumer);
    }

    [Fact]
    public void ResolveRealtimeAction_FailsClosedForOutOfOrderModerationAndDeleteEvents()
    {
        var delayedApproval = new CommentMutationOutboxEvent
        {
            EventType = CommentMutationEventTypes.ModerationChanged,
            PreviousStatus = CommentModerationStatus.Pending,
            NextStatus = CommentModerationStatus.Approved
        };
        var deleted = new Comment
        {
            IsDeleted = true,
            ModerationStatus = CommentModerationStatus.Hidden
        };
        Assert.Equal(CommentOutboxRealtimeAction.None, CommentMutationOutboxWorker.ResolveRealtimeAction(delayedApproval, deleted));

        var delayedHide = new CommentMutationOutboxEvent
        {
            EventType = CommentMutationEventTypes.ModerationChanged,
            PreviousStatus = CommentModerationStatus.Approved,
            NextStatus = CommentModerationStatus.Hidden
        };
        var reapproved = new Comment
        {
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        };
        Assert.Equal(CommentOutboxRealtimeAction.None, CommentMutationOutboxWorker.ResolveRealtimeAction(delayedHide, reapproved));

        Assert.Equal(
            CommentOutboxRealtimeAction.Remove,
            CommentMutationOutboxWorker.ResolveRealtimeAction(
                new CommentMutationOutboxEvent { EventType = CommentMutationEventTypes.Deleted },
                deleted));
    }
}

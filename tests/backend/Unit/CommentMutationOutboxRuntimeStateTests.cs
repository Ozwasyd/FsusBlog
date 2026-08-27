using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentMutationOutboxRuntimeStateTests
{
    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void ClaimLeasePolicy_DefaultsToSixtySecondsAndHeartbeatIsStrictlyLessThanOneThird()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();

        Assert.Equal(TimeSpan.FromSeconds(60), CommentMutationOutboxWorker.GetClaimLeaseDuration(configuration));
        Assert.Equal(TimeSpan.FromSeconds(19), CommentMutationOutboxWorker.GetHeartbeatInterval(configuration));
        Assert.True(CommentMutationOutboxWorker.GetHeartbeatInterval(configuration)
            < CommentMutationOutboxWorker.GetClaimLeaseDuration(configuration) / 3);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "content-lifecycle-fail-closed")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void Update_ExposesClaimLeaseLifecycle()
    {
        var state = new CommentMutationOutboxRuntimeState();
        state.Update(1, 0, 0, 3, 0, DateTime.UtcNow, null, owned: 1, renewed: 4, lost: 2, reclaimed: 3, oldestLeaseAgeSeconds: 19);

        CommentMutationOutboxRuntimeSnapshot snapshot = state.CreateSnapshot();
        Assert.Equal(1, snapshot.OwnedCount);
        Assert.Equal(4, snapshot.RenewedCount);
        Assert.Equal(2, snapshot.LostCount);
        Assert.Equal(3, snapshot.ReclaimedCount);
        Assert.Equal(19, snapshot.OldestLeaseAgeSeconds);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "content-lifecycle-fail-closed")]
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

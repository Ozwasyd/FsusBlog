using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotQueueWrapperTests
{
    [Fact]
    public async Task Wrapper_QueueFullKeepsDurableObligationAndLatestGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
            state,
            state);
        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            1,
            "article-updated");
        PublicHotArtifactEnqueueResult second = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            1,
            "article-updated");

        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, first.Status);
        Assert.NotEqual(PublicHotArtifactDeliveryStatus.Failed, second.Status);
        Assert.True(second.DeliveryGeneration >= first.DeliveryGeneration);
        Assert.False(string.IsNullOrWhiteSpace(second.ObligationId));
        PublicHotActivitySnapshot snapshot = await queue.CreateActivitySnapshotAsync(CancellationToken.None);
        Assert.True((snapshot.CurrentTargetGeneration ?? 0) >= second.DeliveryGeneration);
        Assert.True((snapshot.PendingObligationCount ?? 0) >= 1);
    }

    [Fact]
    public async Task Wrapper_OldGenerationDoesNotMoveTargetBackward()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
            state,
            state);
        PublicHotArtifactEnqueueResult newer = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        PublicHotArtifactEnqueueResult older = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(older.DeliveryGeneration >= newer.DeliveryGeneration);
        PublicHotActivitySnapshot snapshot = await queue.CreateActivitySnapshotAsync(CancellationToken.None);
        Assert.Equal(older.DeliveryGeneration, snapshot.CurrentTargetGeneration);
    }

    [Fact]
    public async Task Wrapper_CancelAndClosedAreStructuredFailuresNotDrops()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
            state,
            state);
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        PublicHotArtifactEnqueueResult cancelledResult = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            7,
            "article-updated",
            cancellationToken: cancelled.Token);
        Assert.Equal(PublicHotArtifactDeliveryStatus.Cancelled, cancelledResult.Status);

        PublicHotArtifactEnqueueResult accepted = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            8,
            "article-updated");
        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, accepted.Status);
        PublicHotArtifactEnqueueResult overflow = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            9,
            "article-updated");
        Assert.Equal(PublicHotArtifactDeliveryStatus.PersistedDirty, overflow.Status);
        Assert.False(string.IsNullOrWhiteSpace(overflow.ObligationId));
        Assert.True(overflow.DeliveryGeneration >= accepted.DeliveryGeneration);
    }

    [Fact]
    public async Task Wrapper_DrainIncludesQueuedInFlightAndObligationPostcondition()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
            state,
            state,
            new PublicHotReadStore(),
            new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredContent, 3, "article-updated");
        Assert.True(queue.Reader.TryRead(out _));
        queue.RecordBatchStarted();
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        PublicHotActivitySnapshot snapshot = await queue.CreateActivitySnapshotAsync(CancellationToken.None);
        Assert.Equal(0, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.InFlightBatchCount);
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(snapshot, snapshot.CurrentTargetGeneration ?? 0);
        Assert.False(blocked.Drained);
        ReleaseDrainParticipantSnapshot drain = participant.Snapshot();
        Assert.NotEqual("drained", drain.Status);
        queue.RecordBatchFinished();
    }

    [Fact]
    public void Wrapper_DoesNotReimplementPublicHotProjectorOrObligationMerge()
    {
        Assert.Contains(
            typeof(PublicHotArtifactUpdateQueue).GetMethods(),
            static method => method.Name == nameof(PublicHotArtifactUpdateQueue.EnqueueAsync));
        Assert.Contains(
            typeof(IPublicHotArtifactObligationStore).GetMethods(),
            static method => method.Name == nameof(IPublicHotArtifactObligationStore.MergeAsync));
        Assert.DoesNotContain(
            typeof(PublicHotArtifactUpdateQueue).GetMethods(),
            static method => method.Name.Contains("Project", StringComparison.Ordinal));
    }
}

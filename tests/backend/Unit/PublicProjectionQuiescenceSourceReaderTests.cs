using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicProjectionQuiescenceSourceReaderTests
{
    [Fact]
    public async Task DequeuedPublicHotWorkUsesAuthoritativeObligationPredicateAndReadingDoesNotClearIt()
    {
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }),
            new InMemoryPublicHotArtifactDeliveryStateStore(),
            store: new PublicHotReadStore(),
            revocations: new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredContent, 7, "article-updated");
        Assert.True(queue.Reader.TryRead(out _));
        PublicHotActivitySnapshot before = await queue.CreateActivitySnapshotAsync(CancellationToken.None);
        var reader = new PublicProjectionQuiescenceSourceReader(queue, null, null, null);
        QuiescenceSourceCapture result = await reader.ReadPublicHotAsync();
        Assert.Equal(0, result.Metrics["queued-count"]);
        Assert.Equal(1, result.Metrics["pending-obligation-count"]);
        foreach (string blocker in PublicHotQuiescence.Evaluate(before, before.CurrentTargetGeneration!.Value).Blockers)
        {
            Assert.Contains(blocker, result.Blockers);
        }
        Assert.False(result.RuntimeQualified);
        Assert.Equal(before, await queue.CreateActivitySnapshotAsync(CancellationToken.None));
    }

    [Fact]
    public void AotQueueZeroCannotHideWorkerInFlightAndReadingDoesNotCompleteRequest()
    {
        var scheduler = new PublicAotBackfillScheduler(new ConfigurationBuilder().Build());
        var request = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:home")
        {
            ScheduledInvalidationVersion = 7
        };
        Assert.True(scheduler.TrySchedule(request));
        scheduler.Begin(request);
        PublicAotBackfillQueueSnapshot before = scheduler.Snapshot();
        var reader = new PublicProjectionQuiescenceSourceReader(null, scheduler, null, null);
        QuiescenceSourceCapture result = reader.ReadPublicAot();
        Assert.Equal(0, result.Metrics["queued-count"]);
        Assert.Equal(1, result.Metrics["in-flight-count"]);
        Assert.Equal(7, result.Metrics["target-generation"]);
        Assert.Null(result.Metrics["active-manifest-generation"]);
        Assert.False(result.RuntimeQualified);
        Assert.Equal(before, scheduler.Snapshot());
        Assert.Equal(result.SemanticDigest, reader.ReadPublicAot().SemanticDigest);
    }

    [Fact]
    public void EmptyRedisInboxCannotHideDispatcherInFlightOrInventAcknowledgements()
    {
        var ingress = new DistributedInvalidationIngressRuntimeState(4);
        ingress.RecordInFlightChanged(1);
        DistributedInvalidationIngressSnapshot before = ingress.Snapshot();
        var reader = new PublicProjectionQuiescenceSourceReader(null, null, ingress, null);
        QuiescenceSourceCapture result = reader.ReadRedisInvalidation();
        Assert.Equal(0, result.Metrics["pending-inbox-count"]);
        Assert.Equal(1, result.Metrics["in-flight-count"]);
        Assert.Null(result.Metrics["unacknowledged-count"]);
        Assert.Null(result.Metrics["acked-generation"]);
        Assert.False(result.RuntimeQualified);
        Assert.Equal(before, ingress.Snapshot());
        ingress.RecordInFlightChanged(1);
        Assert.NotEqual(result.SemanticDigest, reader.ReadRedisInvalidation().SemanticDigest);
    }

    [Fact]
    public void UnavailableLedgerKeepsPendingInboxUnknown()
    {
        var ingress = new DistributedInvalidationIngressRuntimeState(4);
        ingress.RecordPendingLedger(new DistributedInvalidationPendingInboxSnapshot(0, null, false));
        QuiescenceSourceCapture result = new PublicProjectionQuiescenceSourceReader(null, null, ingress, null).ReadRedisInvalidation();
        Assert.Null(result.Metrics["pending-inbox-count"]);
        Assert.False(result.RuntimeQualified);
    }

    [Fact]
    public async Task DirtyCacheUsesSharedReadOnlySnapshotAndNeverFlushesOrMarksClean()
    {
        IHotStatsInvalidationCoalescer coalescer = Substitute.For<IHotStatsInvalidationCoalescer>();
        var snapshot = new HotStatsInvalidationSnapshot(7, 2, 1, 0, 2, 1, 0, true, true, null, null, null, null);
        coalescer.SnapshotAsync(Arg.Any<CancellationToken>()).Returns(snapshot);
        var reader = new PublicProjectionQuiescenceSourceReader(null, null, null, coalescer);
        QuiescenceSourceCapture result = await reader.ReadCacheFlushAsync();
        Assert.Equal(1, result.Metrics["stats-dirty"]);
        Assert.Equal(1, result.Metrics["hot-articles-dirty"]);
        Assert.Equal(7, result.Metrics["hot-articles-version"]);
        Assert.Null(result.Metrics["in-flight-flush-count"]);
        Assert.False(result.RuntimeQualified);
        Assert.Single(coalescer.ReceivedCalls());
        Assert.Equal(nameof(IHotStatsInvalidationCoalescer.SnapshotAsync), coalescer.ReceivedCalls().Single().GetMethodInfo().Name);
    }

    [Fact]
    public async Task SharedReadFailureCannotFallBackToLocalZeroSnapshot()
    {
        IHotStatsInvalidationCoalescer coalescer = Substitute.For<IHotStatsInvalidationCoalescer>();
        coalescer.SnapshotAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<HotStatsInvalidationSnapshot>(new IOException("test-only")));
        QuiescenceSourceCapture result = await new PublicProjectionQuiescenceSourceReader(null, null, null, coalescer).ReadCacheFlushAsync();
        Assert.False(result.SourceAvailable);
        Assert.All(result.Metrics.Values, static value => Assert.Null(value));
        Assert.Contains("shared-cache-source=unavailable", result.Blockers);
        Assert.Single(coalescer.ReceivedCalls());
    }

    [Fact]
    public async Task MissingOwnersStayUnknownAndCancellationPrecedesRead()
    {
        var reader = new PublicProjectionQuiescenceSourceReader(null, null, null, null);
        foreach (QuiescenceSourceCapture result in new[]
        {
            await reader.ReadPublicHotAsync(), reader.ReadPublicAot(), reader.ReadRedisInvalidation(), await reader.ReadCacheFlushAsync()
        })
        {
            Assert.False(result.SourceAvailable);
            Assert.All(result.Metrics.Values, static value => Assert.Null(value));
            Assert.False(result.RuntimeQualified);
        }
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => reader.ReadPublicHotAsync(cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => reader.ReadPublicAot(cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => reader.ReadRedisInvalidation(cancellation.Token));
        await Assert.ThrowsAsync<OperationCanceledException>(() => reader.ReadCacheFlushAsync(cancellation.Token));
    }
}

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Taxonomy;

using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationOutboxFailurePropagationTests
{
    public static TheoryData<string> CoordinatorCriticalEdges => new()
    {
        ArticleMutationReplayEdges.PublicArtifactRevocation,
        ArticleMutationReplayEdges.SearchProjection,
        ArticleMutationReplayEdges.TaxonomyProjection,
        ArticleMutationReplayEdges.ArticleDetailAeds,
        ArticleMutationReplayEdges.PublicHotRead
    };

    [Theory]
    [MemberData(nameof(CoordinatorCriticalEdges))]
    public async Task ReplayOutboxAsync_CriticalProjectorFailureReturnsFailedResult(string failedEdge)
    {
        ArticleMutationSideEffectCoordinator coordinator = CreateCoordinator(failedEdge);
        HashSet<string> completedEdges = ArticleMutationReplayEdges.Required
            .Where(edge => !string.Equals(edge, failedEdge, StringComparison.Ordinal))
            .ToHashSet(StringComparer.Ordinal);
        completedEdges.Add(ArticleMutationReplayEdges.IntegrityProof);
        completedEdges.Add(ArticleMutationReplayEdges.Notification);

        ArticleMutationReplayResult result = await coordinator.ReplayOutboxAsync(
            42,
            "deleted",
            "outbox-critical-failure",
            default,
            completedEdges,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Empty(result.CompletedEdges);
        Assert.Contains(failedEdge, result.FailedEdges[failedEdge], StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReplayOutboxAsync_NotificationFailureIsRecordedWithoutBlockingCriticalConvergence()
    {
        IMessageRealtimePublisher realtimePublisher = Substitute.For<IMessageRealtimePublisher>();
        realtimePublisher
            .PushArticleChangedAsync(Arg.Any<ArticleNoticeDto>(), Arg.Any<string?>())
            .Returns(Task.FromException(new InvalidOperationException("notification-failed")));
        ArticleMutationSideEffectCoordinator coordinator = CreateCoordinator(
            failedCriticalEdge: null,
            realtimePublisher);
        HashSet<string> completedEdges = ArticleMutationReplayEdges.Required.ToHashSet(StringComparer.Ordinal);
        completedEdges.Add(ArticleMutationReplayEdges.IntegrityProof);

        ArticleMutationReplayResult result = await coordinator.ReplayOutboxAsync(
            42,
            "deleted",
            "outbox-best-effort-failure",
            default,
            completedEdges,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.CompletedEdges);
        Assert.Equal("notification-failed", result.FailedEdges[ArticleMutationReplayEdges.Notification]);
        await realtimePublisher.Received(1).PushArticleChangedAsync(
            Arg.Any<ArticleNoticeDto>(),
            ArticleMutationDeliveryKey.Build("outbox-best-effort-failure", ArticleMutationReplayEdges.Notification));
    }

    [Fact]
    public async Task ReplayOutboxAsync_CancellationIsNeverDowngradedToBestEffortFailure()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        IMessageRealtimePublisher realtimePublisher = Substitute.For<IMessageRealtimePublisher>();
        realtimePublisher
            .PushArticleChangedAsync(Arg.Any<ArticleNoticeDto>(), Arg.Any<string?>())
            .Returns(_ => Task.FromCanceled(cancellation.Token));
        ArticleMutationSideEffectCoordinator coordinator = CreateCoordinator(
            failedCriticalEdge: null,
            realtimePublisher);
        HashSet<string> completedEdges = ArticleMutationReplayEdges.Required.ToHashSet(StringComparer.Ordinal);
        completedEdges.Add(ArticleMutationReplayEdges.IntegrityProof);

        await Assert.ThrowsAsync<TaskCanceledException>(() => coordinator.ReplayOutboxAsync(
            42,
            "deleted",
            "outbox-cancelled",
            default,
            completedEdges,
            cancellation.Token));
    }

    [Fact]
    public void DispatcherCriticalEdgesRemainPartOfTheRequiredCompletionGate()
    {
        Assert.Contains(ArticleMutationReplayEdges.PublicAotInvalidation, ArticleMutationReplayEdges.Required);
        Assert.Contains(ArticleMutationReplayEdges.HttpCacheInvalidation, ArticleMutationReplayEdges.Required);

        string processRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "ProcessOneAsync");
        string edgeRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "RunDispatcherEdgeAsync");

        Assert.Contains("RunDispatcherEdgeAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required", processRuntime, StringComparison.Ordinal);
        Assert.Contains("MarkRetryAsync", edgeRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("BoundaryExecutor.ExecuteAsync", edgeRuntime, StringComparison.Ordinal);
    }

    private static ArticleMutationSideEffectCoordinator CreateCoordinator(
        string? failedCriticalEdge,
        IMessageRealtimePublisher? realtimePublisher = null)
    {
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ITaxonomyCountProjectionService taxonomy = Substitute.For<ITaxonomyCountProjectionService>();
        IArticleDetailAedsArtifactProjector detail = Substitute.For<IArticleDetailAedsArtifactProjector>();
        IPublicArtifactRevocationCoordinator revocations = Substitute.For<IPublicArtifactRevocationCoordinator>();
        IPublicHotArtifactDeliveryStateStore deliveryState =
            failedCriticalEdge == ArticleMutationReplayEdges.PublicHotRead
                ? new FailingDeliveryStateStore()
                : new InMemoryPublicHotArtifactDeliveryStateStore();
        var publicHot = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
            deliveryState);

        Task failure = Task.FromException(new InvalidOperationException($"{failedCriticalEdge}-failed"));
        switch (failedCriticalEdge)
        {
            case ArticleMutationReplayEdges.PublicArtifactRevocation:
                revocations.RevokeArticleAsync(42, Arg.Any<CancellationToken>()).Returns(failure);
                break;
            case ArticleMutationReplayEdges.SearchProjection:
                break;
            case ArticleMutationReplayEdges.TaxonomyProjection:
                taxonomy.ReconcileArticleAsync(42, Arg.Any<CancellationToken>()).Returns(failure);
                break;
            case ArticleMutationReplayEdges.ArticleDetailAeds:
                detail.RemoveAsync(42, Arg.Any<CancellationToken>()).Returns(failure);
                break;
        }

        var projections = new ArticleMutationProjectionInvalidator(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            cache,
            taxonomy,
            detail,
            revocations,
            publicHot,
            NullLogger<ArticleMutationProjectionInvalidator>.Instance);
        ISearchIndexService search = Substitute.For<ISearchIndexService>();
        if (failedCriticalEdge == ArticleMutationReplayEdges.SearchProjection)
        {
            search.DeleteIndexAsync(42).Returns(failure);
        }
        var delivery = new ArticleMutationDelivery(
            search,
            realtimePublisher ?? Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<FsusBlog.Server.Infrastructure.Integrity.IIntegrityProofScheduler>());

        return new ArticleMutationSideEffectCoordinator(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<IArticlePublicMutationFence>(),
            projections,
            delivery,
            new ArticleAssetCleanupPolicy(new ArticleAssetCleanupQueue()),
            TimeProvider.System,
            NullLogger<ArticleMutationSideEffectCoordinator>.Instance);
    }

    private sealed class FailingDeliveryStateStore : IPublicHotArtifactDeliveryStateStore
    {
        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => throw new InvalidOperationException("public-hot-read-failed");

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }
}

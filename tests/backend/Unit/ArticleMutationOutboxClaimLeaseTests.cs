using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationOutboxClaimLeaseTests
{
    [Fact]
    public void ClaimStateMachine_PersistsOwnerHeartbeatAndIndependentRetrySchedule()
    {
        foreach (string property in new[]
        {
            nameof(ArticleMutationOutboxEvent.ClaimToken),
            nameof(ArticleMutationOutboxEvent.ClaimedBy),
            nameof(ArticleMutationOutboxEvent.ClaimedAt),
            nameof(ArticleMutationOutboxEvent.HeartbeatAt),
            nameof(ArticleMutationOutboxEvent.ClaimExpiresAt)
        })
        {
            Assert.NotNull(typeof(ArticleMutationOutboxEvent).GetProperty(property));
        }

        string claim = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "ClaimPendingOutboxEventsAsync");
        Assert.Contains("previous_status", claim, StringComparison.Ordinal);
        Assert.Contains("claim_token = @ClaimToken", claim, StringComparison.Ordinal);
        Assert.Contains("claimed_by = @ClaimedBy", claim, StringComparison.Ordinal);
        Assert.Contains("heartbeat_at = @ClaimNow", claim, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at = @ClaimDeadline", claim, StringComparison.Ordinal);
        Assert.Contains("COALESCE(GREATEST(claim_expires_at, next_retry_at)", claim, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE SKIP LOCKED", claim, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcurrentWorkers_OnlyCurrentClaimTokenCanWriteReceiptRetryOrCompletion()
    {
        string heartbeat = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "EnsureClaimOwnedAsync");
        string upsert = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "BuildReplayEdgeUpsertSql");
        string retry = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "MarkRetryAsync");
        string complete = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "BuildCompleteSql");

        Assert.Contains("claim_token = @ClaimToken", heartbeat, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at > @HeartbeatAt", heartbeat, StringComparison.Ordinal);
        Assert.Contains("owned_claim", upsert, StringComparison.Ordinal);
        Assert.Contains("claim_token = @ClaimToken", upsert, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at > @UpdatedAt", upsert, StringComparison.Ordinal);
        Assert.Contains("claim_token = @ClaimToken", retry, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at > @TransitionAt", retry, StringComparison.Ordinal);
        Assert.Contains("claim_token = @ClaimToken", complete, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at > @ProcessedAt", complete, StringComparison.Ordinal);
        Assert.Contains("NOT EXISTS", complete, StringComparison.Ordinal);
        Assert.Contains("edge.status IN ('completed', 'skipped')", complete, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ClaimCommitFailure_CannotReachExternalEffects()
    {
        var coordinator = Substitute.For<IArticleMutationSideEffectCoordinator>();
        var cache = Substitute.For<ICacheInvalidationDispatcher>();
        var publicAot = Substitute.For<IPublicAotInvalidationService>();
        var services = new ServiceCollection();
        services.AddScoped(_ => Substitute.For<ISqlSugarClient>());
        services.AddScoped<IDbConcurrencyGate>(_ => new CommitFailureDbGate());
        services.AddScoped(_ => cache);
        services.AddScoped(_ => publicAot);
        services.AddScoped(_ => coordinator);
        await using ServiceProvider provider = services.BuildServiceProvider();
        var dispatcher = new ArticleMutationOutboxDispatcher(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ArticleMutationOutboxDispatcher>.Instance,
            TimeProvider.System,
            Substitute.For<IBackgroundWorkerLease>(),
            Substitute.For<IActiveReleaseTransactionalCommitGuard>());

        Assert.Equal(0, await dispatcher.ProcessPendingAsync(CancellationToken.None));
        await coordinator.DidNotReceiveWithAnyArgs().ReplayOutboxAsync(
            default,
            default!,
            default!,
            default,
            default!,
            default);
        await cache.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default);
        await publicAot.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default!, default!, default);
    }

    [Fact]
    public void WorkerCrash_ExpiredClaimIsReclaimableButLiveClaimIsHeartbeated()
    {
        string claim = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "ClaimPendingOutboxEventsAsync");
        string batchHeartbeat = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "MaintainClaimHeartbeatsAsync");
        string detector = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "DetectStuckClaimsAsync");

        Assert.Contains("status = 'processing'", claim, StringComparison.Ordinal);
        Assert.Contains("<= @ClaimNow", claim, StringComparison.Ordinal);
        Assert.Contains("next_retry_at = @ClaimDeadline", claim, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at = @ClaimExpiresAt", batchHeartbeat, StringComparison.Ordinal);
        Assert.Contains("next_retry_at = @ClaimExpiresAt", batchHeartbeat, StringComparison.Ordinal);
        Assert.Contains("claim_expires_at > @HeartbeatAt", batchHeartbeat, StringComparison.Ordinal);
        Assert.Contains("article-mutation-outbox-stale-claims-detected", detector, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DuplicateDelivery_ReusesStableContentHashAndPassesItToNotificationPublisher()
    {
        string first = ArticleMutationDeliveryKey.Build("event-1125", ArticleMutationReplayEdges.Notification);
        string duplicate = ArticleMutationDeliveryKey.Build("event-1125", ArticleMutationReplayEdges.Notification);
        string otherEdge = ArticleMutationDeliveryKey.Build("event-1125", ArticleMutationReplayEdges.SearchProjection);
        Assert.Equal(64, first.Length);
        Assert.Equal(first, duplicate);
        Assert.NotEqual(first, otherEdge);

        IMessageRealtimePublisher publisher = Substitute.For<IMessageRealtimePublisher>();
        var delivery = new ArticleMutationDelivery(
            Substitute.For<ISearchIndexService>(),
            publisher,
            Substitute.For<IIntegrityProofScheduler>());
        await delivery.NotifyAsync(1125, "Updated", idempotencyKey: first);
        await publisher.Received(1).PushArticleChangedAsync(
            Arg.Is<ArticleNoticeDto>(notice => notice.ArticleId == 1125 && notice.Action == "Updated"),
            first);

        string redisPublisher = RuntimeMetadataInspection.DescribeMethods(
            typeof(RedisNotificationStreamPublisher),
            "PublishAsync");
        string backlogStore = RuntimeMetadataInspection.DescribeType(typeof(NotificationStreamBacklogStore));
        Assert.Contains("GetOrCreateEventIdAsync", redisPublisher, StringComparison.Ordinal);
        Assert.Contains("AppendAsync", redisPublisher, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamAppendResult.get_Appended", redisPublisher, StringComparison.Ordinal);
        Assert.Contains("fsus:notification-stream:v2:idempotency:", backlogStore, StringComparison.Ordinal);
        Assert.Contains("StreamRangeAsync", backlogStore, StringComparison.Ordinal);

        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        database.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<int?>(),
                Arg.Any<Order>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(new[]
            {
                new StreamEntry("1125-0", [new NameValueEntry("f", new byte[] { 1 })])
            }));
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis),
            keyScope,
            NullLogger<NotificationStreamBacklogStore>.Instance);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1]);
        try
        {
            string route = NotificationStreamTargetRouteCodec.TryEncode(
                new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed)).Value!;
            var append = await store.AppendAsync(1125, route, frame, idempotent: true);
            Assert.True(append.IsSuccess);
            Assert.False(append.Value.Appended);
            Assert.DoesNotContain(
                database.ReceivedCalls(),
                static call => call.GetMethodInfo().Name == nameof(IDatabase.StreamAddAsync));
        }
        finally
        {
            frame.Release();
        }
    }

    [Fact]
    public void ClaimLeaseExpandMigration_IsAdditiveAndOnlineCompatible()
    {
        const string MigrationId = "20260715-post-article-mutation-outbox-claim-lease";
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            descriptor => descriptor.MigrationId == MigrationId);
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[MigrationId];

        Assert.True(descriptor.Transactional);
        Assert.Contains("article_mutation_outbox.claim_token:varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_mutation_outbox.claim_expires_at:timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_mutation_outbox_edge.delivery_key:varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
    }

    private sealed class CommitFailureDbGate : IDbConcurrencyGate
    {
        public Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => onTimeout(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => default;
    }
}

using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.VisitLog;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicContentInvalidationFlowTests
{
    [Fact]
    public void OutboxReplay_InvalidatesPublicAotBeforeReplayingSideEffects()
    {
        Type dispatcher = typeof(ArticleMutationOutboxDispatcher);
        ConstructorInfo constructor = Assert.Single(dispatcher.GetConstructors());
        string pendingRuntime = RuntimeMetadataInspection.DescribeMethods(dispatcher, "ProcessPendingAsync");
        string processRuntime = RuntimeMetadataInspection.DescribeMethods(dispatcher, "ProcessOneAsync");
        (int Offset, MethodBase Method)[] calls = ReadCalledMethods(AsyncMoveNext(
            dispatcher.GetMethod("ProcessOneAsync", BindingFlags.NonPublic | BindingFlags.Instance)!)).ToArray();
        int[] dispatcherEdges = calls
            .Where(static call => call.Method.Name == "RunDispatcherEdgeAsync")
            .Select(static call => call.Offset)
            .ToArray();
        int replay = Assert.Single(calls, static call => call.Method.Name == "ReplayOutboxAsync").Offset;

        Assert.Contains(constructor.GetParameters(), static parameter => parameter.ParameterType == typeof(IServiceScopeFactory));
        Assert.Contains("IPublicAotInvalidationService", pendingRuntime, StringComparison.Ordinal);
        Assert.Contains("LoadAotScopesByArticleIdAsync", pendingRuntime, StringComparison.Ordinal);
        Assert.Contains("IPublicAotInvalidationService.InvalidateArticleMutationAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("ICacheInvalidationDispatcher.InvalidateArticleMutationAsync", processRuntime, StringComparison.Ordinal);
        Assert.Equal(2, dispatcherEdges.Length);
        Assert.True(dispatcherEdges[0] < dispatcherEdges[1]);
        Assert.True(dispatcherEdges[1] < replay);
    }

    [Fact]
    public void OutboxReplay_UsesExplicitResultBeforeMarkingProcessed()
    {
        Type result = typeof(ArticleMutationReplayResult);
        MethodInfo replayMethod = typeof(ArticleMutationSideEffectCoordinator).GetMethod(nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync))!;
        string replayRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationSideEffectCoordinator), nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync));
        string processRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationOutboxDispatcher), "ProcessOneAsync");
        string retryRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationOutboxDispatcher), "MarkRetryAsync");

        Assert.Equal(typeof(Task<ArticleMutationReplayResult>), replayMethod.ReturnType);
        Assert.NotNull(result.GetProperty(nameof(ArticleMutationReplayResult.IsSuccess)));
        Assert.DoesNotContain("BoundaryExecutor.ExecuteAsync", replayRuntime, StringComparison.Ordinal);
        Assert.Contains("IArticleMutationSideEffectCoordinator.ReplayOutboxAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayResult.get_IsSuccess", processRuntime, StringComparison.Ordinal);
        Assert.Contains("MarkRetryAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("article-outbox-complete", processRuntime, StringComparison.Ordinal);
        Assert.Contains("article-outbox-retry", retryRuntime, StringComparison.Ordinal);
        Assert.Contains("retry_count = retry_count + 1", retryRuntime, StringComparison.Ordinal);
        Assert.Contains("retry_count = @ExpectedRetryCount", retryRuntime, StringComparison.Ordinal);
        Assert.Contains("status = 'processing'", retryRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("SetColumns", retryRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void OutboxReplay_TracksRequiredEdgesBeforeMarkingEventProcessed()
    {
        Type edge = typeof(ArticleMutationOutboxEdge);
        Assert.Equal("article_mutation_outbox_edge", edge.GetCustomAttribute<SugarTable>()!.TableName);
        foreach (string property in new[] { "OutboxEventId", "EdgeName", "AttemptCount", "LastError", "UpdatedAt" })
        {
            Assert.NotNull(edge.GetProperty(property));
        }
        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId.Contains("article-mutation-outbox-edge", StringComparison.Ordinal));
        string fingerprint = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("CREATE TABLE IF NOT EXISTS article_mutation_outbox_edge", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_mutation_outbox_edge_event_name", fingerprint, StringComparison.Ordinal);

        Assert.Equal("search-projection", ArticleMutationReplayEdges.SearchProjection);
        Assert.Equal("article-detail-aeds", ArticleMutationReplayEdges.ArticleDetailAeds);
        Assert.Equal("public-artifact-revocation", ArticleMutationReplayEdges.PublicArtifactRevocation);
        Assert.Equal("public-hot-read", ArticleMutationReplayEdges.PublicHotRead);
        Assert.Contains(ArticleMutationReplayEdges.PublicArtifactRevocation, ArticleMutationReplayEdges.Required);
        Assert.Equal(typeof(IReadOnlySet<string>), typeof(IArticleMutationSideEffectCoordinator)
            .GetMethod(nameof(IArticleMutationSideEffectCoordinator.ReplayOutboxAsync))!.GetParameters()[4].ParameterType);
        Assert.NotNull(typeof(ArticleMutationReplayResult).GetProperty(nameof(ArticleMutationReplayResult.CompletedEdges)));
        Assert.NotNull(typeof(ArticleMutationReplayResult).GetProperty(nameof(ArticleMutationReplayResult.SkippedEdges)));
        Assert.NotNull(typeof(ArticleMutationReplayResult).GetProperty(nameof(ArticleMutationReplayResult.FailedEdges)));
        string pendingRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationOutboxDispatcher), "ProcessPendingAsync");
        string processRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationOutboxDispatcher), "ProcessOneAsync");
        Assert.Contains("LoadCompletedEdgesByOutboxIdAsync", pendingRuntime, StringComparison.Ordinal);
        Assert.Contains("ReplayOutboxAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("UpsertReplayEdgesAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required", processRuntime, StringComparison.Ordinal);
        Assert.Contains("MarkRetryAsync", processRuntime, StringComparison.Ordinal);
        Assert.Contains("article-outbox-complete", processRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void OutboxDispatcher_BatchesClaimScopeAndReplayEdgeWrites()
    {
        Type dispatcher = typeof(ArticleMutationOutboxDispatcher);
        string processPending = RuntimeMetadataInspection.DescribeMethods(dispatcher, "ProcessPendingAsync");
        string claim = RuntimeMetadataInspection.DescribeMethods(dispatcher, "ClaimPendingOutboxEventsAsync");
        string upsert = RuntimeMetadataInspection.DescribeMethods(dispatcher, "UpsertReplayEdgesAsync");
        string runtime = RuntimeMetadataInspection.DescribeType(dispatcher);

        Assert.Contains("ClaimPendingOutboxEventsAsync", processPending, StringComparison.Ordinal);
        Assert.Contains("LoadCompletedEdgesByOutboxIdAsync", processPending, StringComparison.Ordinal);
        Assert.Contains("LoadAotScopesByArticleIdAsync", processPending, StringComparison.Ordinal);
        Assert.DoesNotContain("article-outbox-read", processPending, StringComparison.Ordinal);
        Assert.Contains("article-outbox-batch-claim", processPending, StringComparison.Ordinal);

        Assert.Contains("UPDATE article_mutation_outbox", claim, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE SKIP LOCKED", claim, StringComparison.Ordinal);
        Assert.Contains("RETURNING", claim, StringComparison.Ordinal);
        Assert.Contains("GetDataReaderAsync", claim, StringComparison.Ordinal);

        Assert.Contains("ON CONFLICT (outbox_event_id, edge_name) DO UPDATE", upsert, StringComparison.Ordinal);
        Assert.DoesNotContain("FirstAsync", upsert, StringComparison.Ordinal);
        Assert.DoesNotContain("RecordReplayEdgeAsync", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("article-outbox-aot-scope-category", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("article-outbox-aot-scope-tags", runtime, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OutboxReplay_TreatsFullPublicHotQueueAsDurableObligation()
    {
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
            new InMemoryPublicHotArtifactDeliveryStateStore());
        PublicHotArtifactEnqueueResult accepted = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "outbox-updated");
        PublicHotArtifactEnqueueResult persisted = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            43,
            "outbox-updated");
        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, accepted.Status);
        Assert.Equal(PublicHotArtifactDeliveryStatus.PersistedDirty, persisted.Status);
        PublicHotArtifactDeliveryReceipt.RequireDurable(persisted, "outbox-updated");
        FieldInfo channel = typeof(PublicHotArtifactUpdateQueue)
            .GetField("_channel", BindingFlags.NonPublic | BindingFlags.Instance)!;
        object channelOptionsRuntime = channel.GetValue(queue)!;
        Assert.Contains("BoundedChannel", channelOptionsRuntime.GetType().Name, StringComparison.Ordinal);

        Type projections = typeof(ArticleMutationProjectionInvalidator);
        string queueRuntime = RuntimeMetadataInspection.DescribeMethods(projections, nameof(ArticleMutationProjectionInvalidator.QueuePublicHotUpdateAsync));
        string ensureRuntime = RuntimeMetadataInspection.DescribeMethods(projections, nameof(ArticleMutationProjectionInvalidator.EnsurePublicHotUpdateQueuedAsync));
        string replayRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleMutationSideEffectCoordinator), nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync));
        Assert.Contains("PublicHotArtifactUpdateQueue.EnqueueAsync", queueRuntime, StringComparison.Ordinal);
        Assert.Contains("PublicHotArtifactDeliveryReceipt.RequireDurable", queueRuntime, StringComparison.Ordinal);
        Assert.Contains("EnsurePublicHotUpdateQueuedAsync", replayRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationProjectionInvalidator.RevokeArticleAsync", replayRuntime, StringComparison.Ordinal);
        Assert.Contains("QueuePublicHotUpdateAsync", ensureRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotUpdateWorker_ReplaysEveryCoalescedArticleId()
    {
        string worker = RuntimeMetadataInspection.DescribeMethods(
            typeof(PublicHotArtifactUpdateWorker),
            "ExecuteAsync");

        Assert.Contains("HashSet`1", worker, StringComparison.Ordinal);
        Assert.Contains("CollectUpdate", worker, StringComparison.Ordinal);
        Assert.Contains("HashSet`1.Enumerator", worker, StringComparison.Ordinal);
        Assert.Contains("IPublicHotArtifactProjector.RebuildAfterArticleMutationAsync", worker, StringComparison.Ordinal);
        Assert.Contains("IPublicArtifactRevocationCoordinator.CompleteRebuildAsync", worker, StringComparison.Ordinal);
        Assert.Contains(
            "PublicHotArtifactUpdateQueue.EnqueueAsync",
            RuntimeMetadataInspection.DescribeMethods(typeof(PublicArtifactRevocationSubscriber), "QueueRebuildWhenConfirmed"),
            StringComparison.Ordinal);
        Assert.DoesNotContain("Nullable`1.GetValueOrDefault", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDeletionFlows_RevokeArtifactsBeforeAsynchronousRebuild()
    {
        string deleted = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.AfterDeletedAsync));
        string permanentlyDeleted = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.AfterPermanentlyDeletedAsync));
        string trashCleared = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.AfterTrashClearedAsync));
        string projectionRuntime = RuntimeMetadataInspection.DescribeType(typeof(ArticleMutationProjectionInvalidator));
        string fenceRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticlePublicMutationFence),
            nameof(ArticlePublicMutationFence.CommitPublicMutationFenceAsync));

        Assert.Contains("IArticlePublicMutationFence.CompleteArticleMutationFenceAsync", deleted, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationProjectionInvalidator.RevokeArticleAsync", permanentlyDeleted, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationProjectionInvalidator.RevokeAllAsync", trashCleared, StringComparison.Ordinal);
        Assert.Contains("IPublicArtifactRevocationCoordinator.RevokeArticleAsync", projectionRuntime, StringComparison.Ordinal);
        Assert.Contains("IPublicArtifactRevocationCoordinator.RevokeAllAsync", projectionRuntime, StringComparison.Ordinal);
        Assert.Contains("PublicHotArtifactUpdateQueue.EnqueueAsync", projectionRuntime, StringComparison.Ordinal);
        Assert.Contains("PromoteAndReleaseAsync", fenceRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublicHotViewProjection_RefreshesRankingWithoutFullSnapshotRebuild()
    {
        string worker = RuntimeMetadataInspection.DescribeMethods(typeof(PublicHotArtifactUpdateWorker), "ExecuteAsync");

        Assert.Contains("IPublicHotArtifactProjector.RebuildAfterViewProjectionAsync", worker, StringComparison.Ordinal);
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 2 }),
            new InMemoryPublicHotArtifactDeliveryStateStore());
        PublicHotArtifactEnqueueResult queued = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.BestEffortView,
            1,
            "article-view-projection-batch");
        Assert.Equal(PublicHotArtifactDirtyReason.ViewProjection, queued.DirtyReason);
        MethodInfo apply = AsyncMoveNext(typeof(ArticleViewProjectionService).GetMethod(nameof(ArticleViewProjectionService.ApplyAsync))!);
        Assert.Contains(ReadCalledMethods(apply), static call => call.Method.DeclaringType == typeof(PublicHotArtifactUpdateQueue)
            && call.Method.Name == nameof(PublicHotArtifactUpdateQueue.EnqueueAsync));
        MethodInfo flush = AsyncMoveNext(typeof(ArticleServiceViewFlushSink).GetMethod(nameof(ArticleServiceViewFlushSink.FlushArticleViewsAsync))!);
        Assert.Contains(ReadCalledMethods(flush), static call => call.Method.DeclaringType == typeof(PublicHotArtifactUpdateQueue)
            && call.Method.Name == nameof(PublicHotArtifactUpdateQueue.EnqueueAsync));
    }

    [Fact]
    public void ScheduledPublish_ReliesOnOutboxForNewlyPublishedArticleSideEffects()
    {
        Type worker = typeof(ScheduledPublishWorker);
        string method = RuntimeMetadataInspection.DescribeMethods(worker, "PublishDueArticlesAsync");
        string claim = RuntimeMetadataInspection.DescribeMethods(worker, "ClaimDueArticlesAsync");

        Assert.Contains("ScheduledPublishQuery.get_ClaimDueArticlesSql", claim, StringComparison.Ordinal);
        Assert.Contains("ORDER BY due.due_at, article.id", ScheduledPublishQuery.ClaimDueArticlesSql, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE OF article SKIP LOCKED", ScheduledPublishQuery.ClaimDueArticlesSql, StringComparison.Ordinal);
        Assert.DoesNotContain("scheduled-publish-body-batch-query", method, StringComparison.Ordinal);
        Assert.DoesNotContain("scheduled-publish-tags-batch-query", method, StringComparison.Ordinal);
        Assert.DoesNotContain("scheduled-publish-body-query", method, StringComparison.Ordinal);
        Assert.DoesNotContain("scheduled-publish-tags-query", method, StringComparison.Ordinal);
        Assert.Contains("BuildScheduledPublishOutboxEvent", claim, StringComparison.Ordinal);
        Assert.Contains("ScheduledPublishBatchCommit", claim, StringComparison.Ordinal);
        Assert.DoesNotContain("ISearchIndexService.AddOrUpdateIndexAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("IPublicAotInvalidationService.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("ICacheInvalidationDispatcher.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);
        Assert.Contains("TransactionSideEffectGuard.CanPublishAfterCommit", claim, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminAotRebuild_InvalidatesAotBeforeQueueingPublicHotRead()
    {
        MethodInfo method = typeof(AdminArtifactOperations).GetMethod(nameof(AdminArtifactOperations.RunCacheActionAsync))!;
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(AdminArtifactOperations),
            nameof(AdminArtifactOperations.RunCacheActionAsync));
        (int Offset, MethodBase Method)[] calls = ReadCalledMethods(AsyncMoveNext(method)).ToArray();

        Assert.Contains("IPublicAotInvalidationService.InvalidateArticleMutationAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("IPublicAotInvalidationService.InvalidateAllAsync", runtime, StringComparison.Ordinal);
        int aotAll = Assert.Single(calls, static call =>
            call.Method.Name == nameof(IPublicAotInvalidationService.InvalidateAllAsync)).Offset;
        int publicHotQueue = Assert.Single(calls, static call =>
            call.Method.Name == nameof(PublicHotArtifactUpdateQueue.EnqueueAsync)).Offset;
        Assert.True(publicHotQueue > aotAll);
    }

    [Fact]
    public void AdminCacheAction_ExposesOnlyRuntimeArticleDetailAedsV3Actions()
    {
        Type service = typeof(AdminArtifactOperations);
        string runtime = RuntimeMetadataInspection.DescribeMethods(service, nameof(AdminArtifactOperations.RunCacheActionAsync));
        Assert.Contains(Assert.Single(service.GetConstructors()).GetParameters(), static parameter =>
            parameter.ParameterType == typeof(IArticleDetailAedsArtifactMaintenanceService));
        Assert.Contains("recompute-article-rights", runtime, StringComparison.Ordinal);
        Assert.Contains("rebuild-article-detail-aeds-v3", runtime, StringComparison.Ordinal);
        Assert.Contains("IArticleDetailAedsArtifactMaintenanceService.RecomputeArticleRightsAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("IArticleDetailAedsArtifactMaintenanceService.RebuildArticleDetailAedsV3Async", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("clear-legacy-public-artifacts", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("IArticleDetailAedsArtifactMaintenanceService.ClearLegacyPublicArtifactsAsync", runtime, StringComparison.Ordinal);

        var services = new ServiceCollection();
        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());
        ServiceDescriptor registration = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(IArticleDetailAedsArtifactMaintenanceService));
        Assert.Equal(typeof(ArticleDetailAedsArtifactMaintenanceService), registration.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, registration.Lifetime);
    }

    [Fact]
    public void ArticleMutationOutbox_RightsSnapshotChangesReplayArticleDetailAedsRequiredEdge()
    {
        string createRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleService), nameof(ArticleService.CreateAsync));
        string updateRuntime = RuntimeMetadataInspection.DescribeMethods(typeof(ArticleService), nameof(ArticleService.UpdateAsync));
        MethodInfo outbox = typeof(ArticleService).GetMethod(
            "RecordArticleMutationOutboxAsync",
            BindingFlags.NonPublic | BindingFlags.Instance,
            binder: null,
            [typeof(int), typeof(string), typeof(ArticleVersionCoordinates)],
            modifiers: null)!;

        Assert.Contains("RecordArticleMutationOutboxAsync", createRuntime, StringComparison.Ordinal);
        Assert.Contains("created", createRuntime, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync", updateRuntime, StringComparison.Ordinal);
        Assert.Contains("updated", updateRuntime, StringComparison.Ordinal);
        Assert.Contains(outbox.GetParameters(), static parameter =>
            parameter.Name == "version" && parameter.ParameterType == typeof(ArticleVersionCoordinates));
        string payload = ArticlePublicationTransitionWriter.BuildOutboxPayload(
            42,
            ArticleMutationEventTypes.Updated,
            new ArticleVersionCoordinates(7, 2, 11, null, 13, 3));
        Assert.Contains("\"rightsSnapshotId\":11", payload, StringComparison.Ordinal);
        Assert.Contains(ArticleMutationReplayEdges.ArticleDetailAeds, ArticleMutationReplayEdges.Required);
    }

    [Fact]
    public void ArticleDetailAedsArtifactMaintenanceService_RebuildAllUsesPagingAndBoundedConcurrency()
    {
        Type service = typeof(ArticleDetailAedsArtifactMaintenanceService);
        string rebuild = RuntimeMetadataInspection.DescribeMethods(service, nameof(ArticleDetailAedsArtifactMaintenanceService.RebuildArticleDetailAedsV3Async));
        string batch = RuntimeMetadataInspection.DescribeMethods(service, "RebuildArticleBatchAsync");

        Assert.Contains("LoadPublicArticleIdsPageAsync", rebuild, StringComparison.Ordinal);
        Assert.Contains("RebuildArticleBatchAsync", rebuild, StringComparison.Ordinal);
        Assert.Contains("ResolveBackfillParallelism", rebuild, StringComparison.Ordinal);
        Assert.Contains("GetPublicProjectionBackfillStateAsync", rebuild, StringComparison.Ordinal);
        Assert.Contains("RecordPublicProjectionBackfillProgressAsync", rebuild, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.get_ProcessorCount", batch, StringComparison.Ordinal);
        Assert.Contains("ParallelOptions.set_MaxDegreeOfParallelism", batch, StringComparison.Ordinal);
        Assert.Contains("CreateAsyncScope", batch, StringComparison.Ordinal);
        Assert.DoesNotContain("Task`1.get_Result", batch, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactMaintenanceService_RecomputeRightsRepairsSentinelSnapshots()
    {
        Type service = typeof(ArticleDetailAedsArtifactMaintenanceService);
        string recompute = RuntimeMetadataInspection.DescribeMethods(service, nameof(ArticleDetailAedsArtifactMaintenanceService.RecomputeArticleRightsAsync));
        string repair = RuntimeMetadataInspection.DescribeMethods(service, "RecomputeRightsSnapshotAsync");

        Assert.Contains("rights-v3:policy-hash:recompute", repair, StringComparison.Ordinal);
        Assert.Contains("rights-v3:content-hash:recompute", repair, StringComparison.Ordinal);
        Assert.Contains("LoadRightsRecomputeCandidatesAsync", recompute, StringComparison.Ordinal);
        Assert.Contains("ArticleCanonicalHashV1.ComputeHashHex", repair, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsCanonicalHashV1.ComputeHashHex", repair, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO article_rights_snapshot", repair, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (article_id, article_revision_id)", repair, StringComparison.Ordinal);
    }

    [Fact]
    public void RedisBackedPublicAotInvalidateAll_SkipsPerMemberRegistryUnregister()
    {
        Type cache = typeof(PublicAotShellCache);
        MethodInfo invalidateAll = cache.GetMethod(nameof(PublicAotShellCache.InvalidateAllAsync))!;
        MethodInfo removeMany = cache.GetMethod("RemoveManyCacheEntriesAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        Assert.Equal(typeof(bool), removeMany.GetParameters().Single(static parameter => parameter.Name == "unregisterKeys").ParameterType);
        Assert.True((bool)removeMany.GetParameters().Single(static parameter => parameter.Name == "unregisterKeys").DefaultValue!);
        string removeRuntime = RuntimeMetadataInspection.DescribeMethods(cache, "RemoveManyCacheEntriesAsync");
        Assert.Contains("UnregisterKeysAsync", removeRuntime, StringComparison.Ordinal);
        (int Offset, MethodBase Method)[] calls = ReadCalledMethods(AsyncMoveNext(invalidateAll)).ToArray();
        int removeDocuments = Assert.Single(calls, static call => call.Method.Name == "RemoveManyCacheEntriesAsync").Offset;
        int removeRegistries = Assert.Single(calls, static call => call.Method.Name == "KeyDeleteAsync").Offset;
        Assert.True(removeRegistries > removeDocuments);
    }

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<(int Offset, MethodBase Method)> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(
                    BitConverter.ToInt32(il, offset + 1),
                    method.DeclaringType?.GetGenericArguments(),
                    method.GetGenericArguments());
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return (offset, called);
        }
    }
}

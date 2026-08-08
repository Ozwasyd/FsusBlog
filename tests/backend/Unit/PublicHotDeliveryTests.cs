using System.Collections.Frozen;
using System.Reflection;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotDeliveryTests
{
    [Fact]
    public async Task RequiredCapacityOne_PersistsObligationBeforeCancellationIsReported()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);

        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-created");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        PublicHotArtifactEnqueueResult second = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-updated", cancellationToken: cancelled.Token);

        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, first.Status);
        Assert.Equal(PublicHotArtifactDeliveryStatus.Cancelled, second.Status);
        Assert.Equal(0, second.DeliveryGeneration);
        Assert.Throws<OperationCanceledException>(
            () => PublicHotArtifactDeliveryReceipt.RequireDurable(second, "taxonomy-updated"));
        PublicHotArtifactUpdate? recovery = await queue.LoadRecoveryUpdateAsync(CancellationToken.None);
        Assert.NotNull(recovery);
        Assert.Equal(first.DeliveryGeneration, recovery.Value.DeliveryGeneration);
        Assert.Equal(PublicHotArtifactDeliveryClass.FullRebuildMarker, recovery.Value.DeliveryClass);
    }

    [Fact]
    public async Task RequiredTaxonomyCapacityOne_ReturnsPersistedDirtyWithLatestGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-created");
        PublicHotArtifactEnqueueResult full = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-updated");

        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, first.Status);
        Assert.Equal(PublicHotArtifactDeliveryStatus.PersistedDirty, full.Status);
        Assert.True(full.DeliveryGeneration > first.DeliveryGeneration);
        PublicHotArtifactDeliveryReceipt.RequireDurable(full, "taxonomy-updated");
        Assert.Equal(
            full.DeliveryGeneration,
            (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task DuplicateFullRebuildMarkers_CoalesceWithoutLosingLatestGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.FullRebuildMarker,
            null,
            "first-full-rebuild");
        PublicHotArtifactEnqueueResult second = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.FullRebuildMarker,
            null,
            "second-full-rebuild");

        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, first.Status);
        Assert.Equal(PublicHotArtifactDeliveryStatus.Coalesced, second.Status);
        Assert.True(second.DeliveryGeneration > first.DeliveryGeneration);
        PublicHotArtifactDeliveryReceipt.RequireDurable(second, "second-full-rebuild");
        Assert.Equal(
            second.DeliveryGeneration,
            (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task RequiredClosedChannel_ReturnsClosedAndRetainsDurableRecovery()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredContent, 41, "buffered-before-close");
        CloseChannel(queue);

        PublicHotArtifactEnqueueResult result = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent, 42, "article-updated");

        Assert.Equal(PublicHotArtifactDeliveryStatus.Closed, result.Status);
        Assert.Throws<InvalidOperationException>(
            () => PublicHotArtifactDeliveryReceipt.RequireDurable(result, "article-updated"));
        PublicHotArtifactUpdate? recovery = await queue.LoadRecoveryUpdateAsync(CancellationToken.None);
        Assert.Equal(result.DeliveryGeneration, recovery!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task CancellationAfterDurableWrite_ReturnsCancelledAndRetainsRecoveryGeneration()
    {
        using var cancelled = new CancellationTokenSource();
        var state = new CancelAfterPersistStateStore(cancelled);
        var queue = CreateQueue(1, state);

        PublicHotArtifactEnqueueResult result = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated",
            cancellationToken: cancelled.Token);

        Assert.Equal(PublicHotArtifactDeliveryStatus.Cancelled, result.Status);
        Assert.True(result.DeliveryGeneration > 0);
        Assert.Equal(
            result.DeliveryGeneration,
            (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task CorruptPendingGeneration_FailsClosed()
    {
        var queue = CreateQueue(1, new CorruptStateStore());
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.LoadRecoveryUpdateAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ThousandBestEffortViews_CoalesceOverflowIntoLatestDurableFullRebuild()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        long latest = 0;
        int persisted = 0;
        for (int articleId = 1; articleId <= 1000; articleId++)
        {
            PublicHotArtifactEnqueueResult result = await queue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.BestEffortView, articleId, "article-view-projection-batch");
            latest = result.DeliveryGeneration;
            persisted += result.Status == PublicHotArtifactDeliveryStatus.PersistedDirty ? 1 : 0;
        }

        Assert.Equal(999, persisted);
        PublicHotArtifactUpdate? recovery = await queue.LoadRecoveryUpdateAsync(CancellationToken.None);
        Assert.NotNull(recovery);
        Assert.Equal(latest, recovery.Value.DeliveryGeneration);
        Assert.Equal(PublicHotArtifactDeliveryClass.FullRebuildMarker, recovery.Value.DeliveryClass);
    }

    [Fact]
    public async Task RestartRecovery_CoversMarkerBeforeAndAfterChannelWrite()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var writer = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult accepted = await writer.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent, 7, "article-published");

        var restartedBeforePublish = CreateQueue(1, state);
        PublicHotArtifactUpdate? afterChannelWriteBeforePublish = await restartedBeforePublish
            .LoadRecoveryUpdateAsync(CancellationToken.None);
        Assert.Equal(accepted.DeliveryGeneration, afterChannelWriteBeforePublish!.Value.DeliveryGeneration);

        PublicHotArtifactEnqueueResult full = await writer.EnqueueAsync(
            PublicHotArtifactDeliveryClass.BestEffortView, 8, "article-view-projection-batch");
        var restartedAfterOverflow = CreateQueue(1, state);
        PublicHotArtifactUpdate? afterMarkerBeforeChannelWrite = await restartedAfterOverflow
            .LoadRecoveryUpdateAsync(CancellationToken.None);
        Assert.Equal(full.DeliveryGeneration, afterMarkerBeforeChannelWrite!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task RestartAfterMarkerBeforeChannelWrite_PublishesAndCompletesObligation()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        long generation = await state.MarkDirtyAsync(PublicHotArtifactDeliveryClass.RequiredTaxonomy, CancellationToken.None);
        var restarted = CreateQueue(1, state);

        await ProcessRecoveryAsync(restarted);

        Assert.True(generation > 0);
        Assert.Null(await restarted.LoadRecoveryUpdateAsync(CancellationToken.None));
    }

    [Fact]
    public async Task RestartAfterChannelWriteBeforePublish_PublishesAndCompletesObligation()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var writer = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult receipt = await writer.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent, 42, "article-updated");
        var restarted = CreateQueue(1, state);

        await ProcessRecoveryAsync(restarted);

        Assert.True(receipt.DeliveryGeneration > 0);
        Assert.Null(await restarted.LoadRecoveryUpdateAsync(CancellationToken.None));
    }

    [Fact]
    public async Task CompareAndClear_DoesNotEraseNewerConcurrentGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        long first = await state.MarkDirtyAsync(PublicHotArtifactDeliveryClass.RequiredContent, CancellationToken.None);
        long second = await state.MarkDirtyAsync(PublicHotArtifactDeliveryClass.RequiredContent, CancellationToken.None);

        await state.CompleteAsync(first, CancellationToken.None);

        Assert.Equal(second, await state.GetPendingGenerationAsync(CancellationToken.None));
    }

    [Fact]
    public async Task CompareAndClear_WithHigherPublishedGeneration_ClearsOlderPendingGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        long pending = await state.MarkDirtyAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            CancellationToken.None);

        await state.CompleteAsync(pending + 1, CancellationToken.None);

        Assert.Equal(0, await state.GetPendingGenerationAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData(PublicHotArtifactDeliveryStatus.Closed)]
    [InlineData(PublicHotArtifactDeliveryStatus.Failed)]
    public void RequiredCaller_PropagatesUndeliveredReceipt(PublicHotArtifactDeliveryStatus status)
    {
        var receipt = new PublicHotArtifactEnqueueResult(
            status,
            "required-caller-negative",
            PublicHotArtifactDirtyReason.Content);

        Assert.Throws<InvalidOperationException>(
            () => PublicHotArtifactDeliveryReceipt.RequireDurable(receipt, "required-caller-negative"));
    }

    [Fact]
    public void RequiredCaller_PropagatesCancelledReceipt()
    {
        var receipt = new PublicHotArtifactEnqueueResult(
            PublicHotArtifactDeliveryStatus.Cancelled,
            "required-caller-cancelled",
            PublicHotArtifactDirtyReason.Content);

        Assert.Throws<OperationCanceledException>(
            () => PublicHotArtifactDeliveryReceipt.RequireDurable(receipt, "required-caller-cancelled"));
    }

    [Theory]
    [InlineData(PublicHotArtifactDeliveryStatus.Accepted, true)]
    [InlineData(PublicHotArtifactDeliveryStatus.PersistedDirty, true)]
    [InlineData(PublicHotArtifactDeliveryStatus.Coalesced, true)]
    [InlineData(PublicHotArtifactDeliveryStatus.Cancelled, false)]
    [InlineData(PublicHotArtifactDeliveryStatus.Closed, false)]
    [InlineData(PublicHotArtifactDeliveryStatus.Failed, false)]
    public void TaxonomyCaller_ExhaustivelyRejectsNonDurableDelivery(
        PublicHotArtifactDeliveryStatus status,
        bool durable)
    {
        var receipt = new PublicHotArtifactEnqueueResult(
            status,
            "taxonomy-caller-status",
            PublicHotArtifactDirtyReason.Content);

        Assert.Equal(durable, BinaryEndpoints.IsRequiredTaxonomyDeliveryDurable(receipt));
    }

    [Fact]
    public async Task PersistenceFailure_ReturnsFailedAndCallerRejectsSuccess()
    {
        var queue = CreateQueue(1, new FailingStateStore());
        PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy,
            null,
            "taxonomy-persistence-failed",
            cancellationToken: CancellationToken.None);

        Assert.Equal(PublicHotArtifactDeliveryStatus.Failed, receipt.Status);
        Assert.Throws<InvalidOperationException>(
            () => PublicHotArtifactDeliveryReceipt.RequireDurable(receipt, "taxonomy-persistence-failed"));
    }

    [Fact]
    public async Task DuplicateRequiredUpdates_AdvanceButNeverRegressRecoveryGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        PublicHotArtifactEnqueueResult duplicate = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(duplicate.DeliveryGeneration > first.DeliveryGeneration);
        Assert.Equal(
            duplicate.DeliveryGeneration,
            (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value.DeliveryGeneration);
    }

    [Fact]
    public async Task ThousandViewUpdates_WorkerPublishesAndCompletesLatestPendingGeneration()
    {
        var state = new TrackingStateStore();
        var queue = CreateQueue(1, state);
        long latest = 0;
        for (int articleId = 1; articleId <= 1000; articleId++)
        {
            PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.BestEffortView,
                articleId,
                "article-view-projection-batch");
            latest = receipt.DeliveryGeneration;
        }

        PublicHotArtifactUpdate pending = (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value;
        Assert.Equal(latest, pending.DeliveryGeneration);
        var store = new PublicHotReadStore();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, CountingProjector>()
            .BuildServiceProvider();
        var worker = CreateWorker(queue, store, services);

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        Assert.True(store.Current.Version > 0);
        Assert.Equal(latest, state.LastCompletedGeneration);
        Assert.Null(await queue.LoadRecoveryUpdateAsync(CancellationToken.None));
    }

    [Fact]
    public async Task FullRebuildCompletion_RecordsScopeNodeKindCoverageInDurableLedger()
    {
        var state = new TrackingStateStore();
        var queue = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult enqueued = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.FullRebuildMarker,
            null,
            "distributed-invalidation:article_mutation");
        PublicHotArtifactUpdate pending = (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value;
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.RecordReconcileCoverageAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "node-b",
            Topology = DistributedInvalidationTopologyManifest.Create(
                DistributedInvalidationOptions.DefaultChannel,
                ["node-a", "node-b"])
        };
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, EmptyProjector>()
            .AddSingleton<IDistributedInvalidationDeliveryLedger>(ledger)
            .AddSingleton(options)
            .AddSingleton<IRuntimeKeyScope, DefaultRuntimeKeyScope>()
            .BuildServiceProvider();
        var worker = CreateWorker(queue, new PublicHotReadStore(), services);

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        Assert.Equal(enqueued.DeliveryGeneration, state.LastCompletedGeneration);
        foreach (string kind in DistributedInvalidationEventKinds.All)
        {
            await ledger.Received(1).RecordReconcileCoverageAsync(
                Arg.Is<string>(value => !string.IsNullOrWhiteSpace(value)),
                "node-b",
                kind,
                enqueued.DeliveryGeneration,
                Arg.Is<string>(value => value.Contains("public-hot-full-rebuild", StringComparison.Ordinal)),
                Arg.Any<CancellationToken>());
        }
    }

    [Fact]
    public async Task ExecuteAsync_StartupRecoveryPublishesAndCompletesPersistedMarker()
    {
        var state = new TrackingStateStore();
        long generation = await state.MarkDirtyAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            CancellationToken.None);
        var queue = CreateQueue(1, state);
        var store = new PublicHotReadStore();
        var projector = new CountingProjector();
        await using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => projector)
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);

        await worker.StartAsync(CancellationToken.None);
        await WaitUntilAsync(async () =>
            await state.GetPendingGenerationAsync(CancellationToken.None) == 0);
        await worker.StopAsync(CancellationToken.None);

        Assert.Equal(generation, state.LastCompletedGeneration);
        Assert.Equal(1, projector.InitialBuildCount);
        Assert.Equal(1, store.Current.Version);
    }

    [Fact]
    public async Task ProcessOnce_ArticleDeltaWithoutPublishedBaselineBuildsInitialSnapshot()
    {
        var state = new TrackingStateStore();
        var queue = CreateQueue(1, state);
        PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate pending));
        var store = new PublicHotReadStore();
        var projector = new CountingProjector();
        await using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => projector)
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        Assert.Equal(1, projector.InitialBuildCount);
        Assert.Equal(0, projector.ArticleBuildCount);
        Assert.Equal(receipt.DeliveryGeneration, state.LastCompletedGeneration);
        Assert.Equal(1, store.Current.Version);
    }

    [Fact]
    public async Task ExecuteAsync_PostPublishRecoveryCompletesLatestOfThousandViewGenerations()
    {
        var state = new TrackingStateStore();
        var queue = CreateQueue(1, state);
        var store = new PublicHotReadStore();
        store.Publish(CreateSnapshot(1));
        var projector = new BlockingFirstViewProjector();
        await using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => projector)
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);
        await worker.StartAsync(CancellationToken.None);

        await state.FirstPendingRead.Task.WaitAsync(TimeSpan.FromSeconds(10));
        PublicHotArtifactEnqueueResult first = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.BestEffortView,
            1,
            "article-view-projection-batch");
        Assert.Equal(PublicHotArtifactDeliveryStatus.Accepted, first.Status);
        await projector.FirstViewBuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        long latest = first.DeliveryGeneration;
        for (int articleId = 2; articleId <= 1000; articleId++)
        {
            PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.BestEffortView,
                articleId,
                "article-view-projection-batch");
            latest = receipt.DeliveryGeneration;
        }

        projector.ReleaseFirstViewBuild();
        await WaitUntilAsync(() => Task.FromResult(state.LastCompletedGeneration == latest));
        await worker.StopAsync(CancellationToken.None);

        Assert.Equal(latest, state.LastCompletedGeneration);
        Assert.Equal(0, await state.GetPendingGenerationAsync(CancellationToken.None));
        Assert.Equal(1, projector.ViewBuildCount);
        Assert.Equal(1, projector.InitialBuildCount);
        Assert.Equal(2, store.Current.Version);
    }

    [Fact]
    public async Task StopAsync_CancellationRetainsMarkerAndRestartExecuteAsyncRecoversIt()
    {
        var state = new TrackingStateStore();
        long generation = await state.MarkDirtyAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            CancellationToken.None);
        var firstQueue = CreateQueue(1, state);
        var firstStore = new PublicHotReadStore();
        var blockingProjector = new CancellationBlockingProjector();
        await using (ServiceProvider firstServices = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => blockingProjector)
            .BuildServiceProvider())
        {
            using var firstWorker = CreateWorker(firstQueue, firstStore, firstServices);
            await firstWorker.StartAsync(CancellationToken.None);
            await blockingProjector.BuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await firstWorker.StopAsync(CancellationToken.None);
        }

        Assert.Equal(generation, await state.GetPendingGenerationAsync(CancellationToken.None));
        Assert.Equal(0, state.LastCompletedGeneration);

        var restartedQueue = CreateQueue(1, state);
        var restartedStore = new PublicHotReadStore();
        var restartedProjector = new CountingProjector();
        await using ServiceProvider restartedServices = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => restartedProjector)
            .BuildServiceProvider();
        using var restartedWorker = CreateWorker(restartedQueue, restartedStore, restartedServices);
        await restartedWorker.StartAsync(CancellationToken.None);
        await WaitUntilAsync(() => Task.FromResult(state.LastCompletedGeneration == generation));
        await restartedWorker.StopAsync(CancellationToken.None);

        Assert.Equal(0, await state.GetPendingGenerationAsync(CancellationToken.None));
        Assert.Equal(generation, state.LastCompletedGeneration);
        Assert.Equal(1, restartedStore.Current.Version);
    }

    [Fact]
    public async Task FailedPublication_RetainsPendingGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate pending));
        var store = new PublicHotReadStore();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, ThrowingProjector>()
            .BuildServiceProvider();
        var worker = CreateWorker(queue, store, services);

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        PublicHotArtifactObligation failure = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(receipt.DeliveryGeneration, failure.TargetGeneration);
        Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, failure.State);
        Assert.Equal(PublicHotArtifactAttemptStage.Projector, Assert.Single(failure.Attempts).Stage);
    }

    [Fact]
    public async Task RevocationCompletionFailure_RetainsPendingGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate pending));
        var store = new PublicHotReadStore();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, CountingProjector>()
            .BuildServiceProvider();
        var worker = CreateWorker(queue, store, services, new ThrowingRevocations());

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        Assert.Equal(1, store.Current.Version);
        PublicHotArtifactObligation failure = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(receipt.DeliveryGeneration, failure.TargetGeneration);
        Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, failure.State);
        Assert.Equal(PublicHotArtifactAttemptStage.RevocationCompletion, failure.Attempts.Last().Stage);
    }

    [Fact]
    public async Task DurableObligation_MergesGenerationReasonsArticlesAndGlobalSemantics()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactObligation first = await state.MergeAsync(
            new(7, "article-updated", PublicHotArtifactDirtyReason.Content, 11, 4), CancellationToken.None);
        PublicHotArtifactObligation merged = await state.MergeAsync(
            new(null, "taxonomy-updated", PublicHotArtifactDirtyReason.Content, null, 9,
                PublicHotArtifactDeliveryClass.FullRebuildMarker), CancellationToken.None);
        PublicHotArtifactObligation final = await state.MergeAsync(
            new(8, "article-updated", PublicHotArtifactDirtyReason.Content, 12, 6), CancellationToken.None);

        Assert.Equal(first.ObligationId, final.ObligationId);
        Assert.Equal(9, final.TargetGeneration);
        Assert.True(final.RequiresFullRebuild);
        Assert.Equal([7, 8], final.ArticleIds);
        Assert.Equal(11, final.ExpectedReleaseIds[7]);
        Assert.Equal(12, final.ExpectedReleaseIds[8]);
    }

    [Fact]
    public async Task DurableObligation_FailureEvidenceIsBoundedAndTerminalIsRetained()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactObligation pending = await state.MergeAsync(
            new(7, "article-updated", PublicHotArtifactDirtyReason.Content, null, 1), CancellationToken.None);
        PublicHotArtifactObligation attempt1 = (await state.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
        PublicHotArtifactObligation retryable = await state.RecordFailureAsync(
            pending.ObligationId, attempt1.AttemptNumber, PublicHotArtifactAttemptStage.Projector,
            new TimeoutException("injected"), DateTimeOffset.UtcNow, 2, CancellationToken.None);
        PublicHotArtifactObligation attempt2 = (await state.ClaimEligibleAsync(DateTimeOffset.MaxValue, CancellationToken.None))!;
        PublicHotArtifactObligation terminal = await state.RecordFailureAsync(
            pending.ObligationId, attempt2.AttemptNumber, PublicHotArtifactAttemptStage.Publish,
            new TimeoutException("injected"), DateTimeOffset.UtcNow, 2, CancellationToken.None);

        Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, retryable.State);
        Assert.Equal(PublicHotArtifactObligationState.FailedTerminal, terminal.State);
        Assert.Equal(2, terminal.Attempts.Count);
        Assert.All(terminal.Attempts, evidence => Assert.NotEqual(PublicHotArtifactFailureKind.None, evidence.FailureKind));
        Assert.True(await state.HasTerminalFailureAsync(CancellationToken.None));
    }

    [Fact]
    public async Task DurableObligation_StaleFailureCannotOverwriteNewClaim()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactObligation created = await state.MergeAsync(
            new(7, "article-updated", PublicHotArtifactDirtyReason.Content, null, 1),
            CancellationToken.None);
        PublicHotArtifactObligation first = (await state.ClaimEligibleAsync(
            DateTimeOffset.UtcNow,
            CancellationToken.None))!;
        await state.RecordFailureAsync(
            created.ObligationId,
            first.AttemptNumber,
            PublicHotArtifactAttemptStage.Projector,
            new TimeoutException("injected"),
            DateTimeOffset.UtcNow,
            3,
            CancellationToken.None);
        PublicHotArtifactObligation second = (await state.ClaimEligibleAsync(
            DateTimeOffset.MaxValue,
            CancellationToken.None))!;

        await Assert.ThrowsAsync<InvalidOperationException>(() => state.RecordFailureAsync(
            created.ObligationId,
            first.AttemptNumber,
            PublicHotArtifactAttemptStage.Publish,
            new TimeoutException("stale"),
            DateTimeOffset.UtcNow,
            3,
            CancellationToken.None));

        PublicHotArtifactObligation retained = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(PublicHotArtifactObligationState.Processing, retained.State);
        Assert.Equal(second.AttemptNumber, retained.AttemptNumber);
    }

    [Fact]
    public async Task DurableObligation_InterruptedProcessingRecoversAndReplayDoesNotRegressGeneration()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        PublicHotArtifactObligation created = await state.MergeAsync(
            new(null, "startup", PublicHotArtifactDirtyReason.Content, null, 3,
                PublicHotArtifactDeliveryClass.FullRebuildMarker), CancellationToken.None);
        PublicHotArtifactObligation claim = (await state.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
        await state.RecoverInterruptedAsync(DateTimeOffset.UtcNow, CancellationToken.None);
        PublicHotArtifactObligation replay = (await state.ClaimEligibleAsync(DateTimeOffset.UtcNow, CancellationToken.None))!;
        Assert.True(replay.AttemptNumber > claim.AttemptNumber);
        Assert.True(await state.CompletePublishedAsync(created.ObligationId, replay.AttemptNumber, created.TargetGeneration, CancellationToken.None));
        Assert.False(await state.CompletePublishedAsync(created.ObligationId, replay.AttemptNumber, created.TargetGeneration - 1, CancellationToken.None));
        PublicHotArtifactObligation published = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(created.TargetGeneration, published.PublishedGeneration);
        Assert.True(published.Recovered);
        Assert.Equal(PublicHotArtifactAttemptStage.Completion, Assert.Single(published.Attempts).Stage);
    }

    [Fact]
    public async Task PublishFailure_LeavesRetryableDurableObligation()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredContent, 7, "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        using ServiceProvider services = new ServiceCollection().AddScoped<IPublicHotArtifactProjector, CountingProjector>().BuildServiceProvider();
        var worker = CreateWorker(queue, new ThrowingPublishStore(), services);

        await worker.ProcessOnceAsync(wakeup, CancellationToken.None);

        PublicHotArtifactObligation failure = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, failure.State);
        Assert.Equal(PublicHotArtifactAttemptStage.Publish, failure.Attempts.Last().Stage);
    }

    [Fact]
    public async Task DurableWorker_SuccessRecordsEveryPublicationStage()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        using ServiceProvider services = new ServiceCollection().AddScoped<IPublicHotArtifactProjector, EmptyProjector>().BuildServiceProvider();
        var worker = CreateWorker(queue, new PublicHotReadStore(), services);

        await worker.ProcessOnceAsync(wakeup, CancellationToken.None);

        PublicHotArtifactObligation completed = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(PublicHotArtifactObligationState.Published, completed.State);
        Assert.Equal(
            [PublicHotArtifactAttemptStage.Projector, PublicHotArtifactAttemptStage.Publish,
             PublicHotArtifactAttemptStage.RevocationCompletion, PublicHotArtifactAttemptStage.Completion],
            completed.Attempts.Select(static attempt => attempt.Stage));
        Assert.All(completed.Attempts, static attempt => Assert.Equal(PublicHotArtifactFailureKind.None, attempt.FailureKind));
    }

    [Fact]
    public async Task DurableWorker_CancellationRecordsProjectorFailureAndRetainsObligation()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        await queue.EnqueueAsync(PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var projector = new CancellationBlockingProjector();
        using ServiceProvider services = new ServiceCollection().AddScoped<IPublicHotArtifactProjector>(_ => projector).BuildServiceProvider();
        var worker = CreateWorker(queue, new PublicHotReadStore(), services);
        using var cancellation = new CancellationTokenSource();

        Task processing = worker.ProcessOnceAsync(wakeup, cancellation.Token);
        await projector.BuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        cancellation.Cancel();
        await processing;

        PublicHotArtifactObligation retained = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(PublicHotArtifactObligationState.FailedRetryable, retained.State);
        Assert.Equal(PublicHotArtifactAttemptStage.Projector, Assert.Single(retained.Attempts).Stage);
    }

    [Fact]
    public async Task DurableWorker_ConcurrentMergePreventsStaleCompletionAndRetainsLatestTarget()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state, state);
        PublicHotArtifactEnqueueResult initial = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-created");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var projector = new BlockingInitialProjector();
        using ServiceProvider services = new ServiceCollection().AddScoped<IPublicHotArtifactProjector>(_ => projector).BuildServiceProvider();
        var worker = CreateWorker(queue, new PublicHotReadStore(), services);

        Task processing = worker.ProcessOnceAsync(wakeup, CancellationToken.None);
        await projector.BuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        PublicHotArtifactEnqueueResult latest = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, "taxonomy-updated");
        projector.ReleaseBuild();
        await processing;

        PublicHotArtifactObligation retained = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.Equal(PublicHotArtifactObligationState.Pending, retained.State);
        Assert.Equal(latest.DeliveryGeneration, retained.TargetGeneration);
        Assert.True(retained.RequiresFullRebuild);
        Assert.Contains(retained.Attempts, static attempt => attempt.Stage == PublicHotArtifactAttemptStage.Completion);
        Assert.True(latest.DeliveryGeneration > initial.DeliveryGeneration);
    }

    private static PublicHotArtifactUpdateQueue CreateQueue(
        int capacity,
        IPublicHotArtifactDeliveryStateStore state,
        IPublicHotArtifactObligationStore? obligations = null)
        => new(Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = capacity }), state, obligations);

    private static PublicHotArtifactUpdateWorker CreateWorker(
        PublicHotArtifactUpdateQueue queue,
        PublicHotReadStore store,
        IServiceProvider services,
        IPublicArtifactRevocationCoordinator? revocations = null)
        => new(
            queue,
            store,
            revocations ?? new NoopRevocations(),
            CreateTestRuntime(),
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PublicHotReadOptions { UpdateDebounceMilliseconds = 0 }),
            NullLogger<PublicHotArtifactUpdateWorker>.Instance);

    private static DeploymentRuntimeState CreateTestRuntime()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        return new DeploymentRuntimeState(
            new ReleaseIdentityProvider(configuration),
            configuration,
            new TestWebHostEnvironment(Environments.Development),
            TimeProvider.System);
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await condition().ConfigureAwait(false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token).ConfigureAwait(false);
        }
    }

    private static async Task ProcessRecoveryAsync(PublicHotArtifactUpdateQueue queue)
    {
        PublicHotArtifactUpdate pending = (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value;
        var store = new PublicHotReadStore();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, EmptyProjector>()
            .BuildServiceProvider();
        var worker = CreateWorker(queue, store, services);
        await worker.ProcessOnceAsync(pending, CancellationToken.None);
        Assert.True(store.Current.Version > 0);
    }

    private static void CloseChannel(PublicHotArtifactUpdateQueue queue)
    {
        FieldInfo field = typeof(PublicHotArtifactUpdateQueue)
            .GetField("_channel", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var channel = (Channel<PublicHotArtifactUpdate>)field.GetValue(queue)!;
        Assert.True(channel.Writer.TryComplete());
    }

    private sealed class EmptyProjector : IPublicHotArtifactProjector
    {
        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct) => Task.FromResult(new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow)));
        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(PublicHotReadSnapshot current, int articleId, CancellationToken ct) => Task.FromResult(current);
        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(PublicHotReadSnapshot current, IReadOnlyCollection<int> articleIds, CancellationToken ct) => Task.FromResult(current);
    }

    private sealed class CountingProjector : IPublicHotArtifactProjector
    {
        private int _version;
        private int _initialBuildCount;
        private int _articleBuildCount;

        public int InitialBuildCount => Volatile.Read(ref _initialBuildCount);
        public int ArticleBuildCount => Volatile.Read(ref _articleBuildCount);

        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _initialBuildCount);
            return Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));
        }

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _articleBuildCount);
            return Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));
        }

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));
    }

    private sealed class BlockingFirstViewProjector : IPublicHotArtifactProjector
    {
        private readonly TaskCompletionSource _firstViewBuildStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseFirstViewBuild =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _initialBuildCount;
        private int _version;
        private int _viewBuildCount;

        public TaskCompletionSource FirstViewBuildStarted => _firstViewBuildStarted;
        public int InitialBuildCount => Volatile.Read(ref _initialBuildCount);
        public int ViewBuildCount => Volatile.Read(ref _viewBuildCount);
        public void ReleaseFirstViewBuild() => _releaseFirstViewBuild.TrySetResult();

        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _initialBuildCount);
            return Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));
        }

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));

        public async Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _viewBuildCount);
            _firstViewBuildStarted.TrySetResult();
            await _releaseFirstViewBuild.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            return CreateSnapshot(Interlocked.Increment(ref _version));
        }
    }

    private sealed class CancellationBlockingProjector : IPublicHotArtifactProjector
    {
        private readonly TaskCompletionSource _buildStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource BuildStarted => _buildStarted;

        public async Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
        {
            _buildStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException("unreachable");
        }

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
            => Task.FromException<PublicHotReadSnapshot>(new InvalidOperationException("unexpected article rebuild"));

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => Task.FromException<PublicHotReadSnapshot>(new InvalidOperationException("unexpected view rebuild"));
    }

    private sealed class BlockingInitialProjector : IPublicHotArtifactProjector
    {
        private readonly TaskCompletionSource _buildStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseBuild = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource BuildStarted => _buildStarted;
        public void ReleaseBuild() => _releaseBuild.TrySetResult();

        public async Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
        {
            _buildStarted.TrySetResult();
            await _releaseBuild.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            return CreateSnapshot(1);
        }

        public async Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(PublicHotReadSnapshot current, int articleId, CancellationToken cancellationToken)
        {
            _buildStarted.TrySetResult();
            await _releaseBuild.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            return current;
        }
        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(PublicHotReadSnapshot current, IReadOnlyCollection<int> articleIds, CancellationToken cancellationToken)
            => Task.FromResult(current);
    }

    private static PublicHotReadSnapshot CreateSnapshot(long version)
        => new(
            version,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, DateTimeOffset.UtcNow));

    private sealed class ThrowingProjector : IPublicHotArtifactProjector
    {
        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct)
            => Task.FromException<PublicHotReadSnapshot>(new InvalidOperationException("publication failed"));

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken ct)
            => Task.FromException<PublicHotReadSnapshot>(new InvalidOperationException("publication failed"));

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken ct)
            => Task.FromException<PublicHotReadSnapshot>(new InvalidOperationException("publication failed"));
    }

    private sealed class ThrowingPublishStore : PublicHotReadStore
    {
        public override void Publish(PublicHotReadSnapshot next)
            => throw new TimeoutException("injected publish failure");
    }

    private sealed class NoopRevocations : IPublicArtifactRevocationCoordinator
    {
        public long CurrentGeneration => 0;
        public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<bool> RecoverPendingMutationFenceAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RevokeAllAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task CompleteRebuildAsync(IReadOnlyCollection<int>? articleIds, long maximumGeneration, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class ThrowingRevocations : IPublicArtifactRevocationCoordinator
    {
        public long CurrentGeneration => 0;
        public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<bool> RecoverPendingMutationFenceAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RevokeAllAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task CompleteRebuildAsync(IReadOnlyCollection<int>? articleIds, long maximumGeneration, CancellationToken cancellationToken = default)
            => Task.FromException(new InvalidOperationException("injected revocation completion failure"));
    }

    private sealed class CorruptStateStore : IPublicHotArtifactDeliveryStateStore
    {
        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => Task.FromResult(1L);

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => throw new InvalidOperationException("public-hot delivery pending generation is corrupt");

        public Task CompleteAsync(long generation, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class CancelAfterPersistStateStore(CancellationTokenSource cancellation)
        : IPublicHotArtifactDeliveryStateStore
    {
        private readonly InMemoryPublicHotArtifactDeliveryStateStore _inner = new();

        public async Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
        {
            long generation = await _inner
                .MarkDirtyAsync(deliveryClass, CancellationToken.None)
                .ConfigureAwait(false);
            cancellation.Cancel();
            return generation;
        }

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => _inner.GetPendingGenerationAsync(cancellationToken);

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => _inner.CompleteAsync(generation, cancellationToken);
    }

    private sealed class FailingStateStore : IPublicHotArtifactDeliveryStateStore
    {
        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => throw new InvalidOperationException("delivery state unavailable");

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class TrackingStateStore : IPublicHotArtifactDeliveryStateStore
    {
        private readonly InMemoryPublicHotArtifactDeliveryStateStore _inner = new();
        private readonly TaskCompletionSource _firstPendingRead =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long _lastCompletedGeneration;

        public TaskCompletionSource FirstPendingRead => _firstPendingRead;
        public long LastCompletedGeneration => Volatile.Read(ref _lastCompletedGeneration);

        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => _inner.MarkDirtyAsync(deliveryClass, cancellationToken);

        public async Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
        {
            long generation = await _inner.GetPendingGenerationAsync(cancellationToken).ConfigureAwait(false);
            _firstPendingRead.TrySetResult();
            return generation;
        }

        public async Task CompleteAsync(long generation, CancellationToken cancellationToken)
        {
            await _inner.CompleteAsync(generation, cancellationToken).ConfigureAwait(false);
            InterlockedExtensions.Max(ref _lastCompletedGeneration, generation);
        }
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}


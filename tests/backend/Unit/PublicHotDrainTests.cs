using System.Collections.Frozen;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotDrainTests
{
    [Fact]
    public async Task QueueZeroButProjectorBlocked_DrainMustNotComplete()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var store = new PublicHotReadStore();
        var queue = CreateQueue(
            1,
            state,
            store: store,
            revocations: new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var projector = new BlockingInitialProjector();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => projector)
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);

        Task processing = worker.ProcessOnceAsync(wakeup, CancellationToken.None);
        await projector.BuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(0, snapshot.QueuedCount);
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(blocked.Drained);
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("active-projector-count=1", StringComparison.Ordinal));
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("in-flight-batch-count=1", StringComparison.Ordinal));
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("active-background-claim-count-for-public-hot=1", StringComparison.Ordinal));
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("store-state=Building", StringComparison.Ordinal));

        projector.ReleaseBuild();
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        await AssertDrainedAsync(participant, queue);
    }

    [Fact]
    public async Task ProjectorCompletedButPublishBlocked_DrainMustNotComplete()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var store = new BlockingPublishStore();
        var queue = CreateQueue(
            1,
            state,
            store: store,
            revocations: new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            7,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, CountingProjector>()
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);

        // Publish blocks synchronously; run the synchronous prefix on a pool
        // thread so the test thread can release the publish gate.
        Task processing = Task.Run(
            () => worker.ProcessOnceAsync(wakeup, CancellationToken.None));
        await store.PublishStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(0, snapshot.ActiveProjectorCount);
        Assert.Equal(1, snapshot.InFlightBatchCount);
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(snapshot, 1);
        Assert.False(blocked.Drained);
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("in-flight-batch-count=1", StringComparison.Ordinal));
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("store-state=Building", StringComparison.Ordinal));

        store.ReleasePublish();
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        await AssertDrainedAsync(participant, queue);
    }

    [Fact]
    public async Task PublishCompletedButRevocationCompletionBlocked_DrainMustNotComplete()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var store = new PublicHotReadStore();
        var queue = CreateQueue(
            1,
            state,
            store: store,
            revocations: new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            7,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var revocations = new BlockingRevocationCoordinator();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, CountingProjector>()
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services, revocations);

        Task processing = worker.ProcessOnceAsync(wakeup, CancellationToken.None);
        await revocations.CompletionStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(0, snapshot.ActiveProjectorCount);
        Assert.Equal(1, snapshot.InFlightBatchCount);
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(snapshot, 1);
        Assert.False(blocked.Drained);
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("in-flight-batch-count=1", StringComparison.Ordinal));

        revocations.ReleaseCompletion();
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        await AssertDrainedAsync(participant, queue);
    }

    [Fact]
    public async Task RevocationPendingCount_BlocksDrain()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(new PublicArtifactTombstone(
            42,
            1,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            TransitionPending: true));
        var queue = CreateQueue(1, state, revocations: registry);
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);

        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(blocked.Drained);
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("revocation-pending-count=1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TerminalObligation_BlocksDrainInsteadOfDraining()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(
            1,
            state,
            state,
            new PublicHotReadStore(),
            new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var store = new PublicHotReadStore();
        var options = new PublicHotReadOptions
        {
            UpdateDebounceMilliseconds = 0,
            PublicHotRecoveryMaximumAttempts = 1
        };
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, ThrowingProjector>()
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services, options: options);

        await worker.ProcessOnceAsync(wakeup, CancellationToken.None);

        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => participant.DrainAsync(timeout.Token));
        ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
        Assert.Equal("public_hot_not_quiescent", snapshot.ErrorCode);
        Assert.Contains(snapshot.Blockers!, static item => item.StartsWith("failed-terminal-obligation-count=1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task WorkerException_FinallyReleasesInFlightAndClaim_ButTerminalObligationStillBlocks()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(
            1,
            state,
            state,
            new PublicHotReadStore(),
            new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var store = new PublicHotReadStore();
        var options = new PublicHotReadOptions
        {
            UpdateDebounceMilliseconds = 0,
            PublicHotRecoveryMaximumAttempts = 1
        };
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, ThrowingProjector>()
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services, options: options);

        await worker.ProcessOnceAsync(wakeup, CancellationToken.None);

        PublicHotActivitySnapshot snapshot = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(0, snapshot.InFlightBatchCount);
        Assert.Equal(0, snapshot.ActiveProjectorCount);
        Assert.Equal(0, snapshot.ActiveBackgroundClaimCountForPublicHot);
        Assert.Equal(1, snapshot.FailedTerminalObligationCount);
        PublicHotQuiescenceResult blocked = PublicHotQuiescence.Evaluate(
            snapshot,
            snapshot.CurrentTargetGeneration ?? 1);
        Assert.False(blocked.Drained);
        Assert.Contains(blocked.Blockers, static item => item.StartsWith("failed-terminal-obligation-count=1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CollectorFailure_BlocksDrainInsteadOfAssumingZero()
    {
        var queue = CreateQueue(1, new ThrowingPendingStateStore());
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);

        ReleaseDrainParticipantSnapshot beforeObservation = participant.Snapshot();
        Assert.Equal("public_hot_activity_unavailable", beforeObservation.ErrorCode);
        Assert.Equal(1, beforeObservation.PendingCount);

        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => participant.DrainAsync(timeout.Token));
        ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
        Assert.Equal("public_hot_not_quiescent", snapshot.ErrorCode);
        Assert.Contains(snapshot.Blockers!, static item => item.StartsWith("collector-error=", StringComparison.Ordinal));
    }

    [Fact]
    public void SynchronousSnapshotBeforeObservation_FailsClosedOnObligationFields()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(1, state);
        PublicHotActivitySnapshot snapshot = queue.CreateActivitySnapshot();
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(result.Drained);
        Assert.Contains(result.Blockers, static item => item == "pending-obligation-count=unavailable");
        Assert.Contains(result.Blockers, static item => item == "failed-terminal-obligation-count=unavailable");
    }

    [Fact]
    public async Task StableFirstObservationThenNewBatchEnters_DrainMustNotComplete()
    {
        var gated = new GatedPendingGenerationStore();
        var queue = CreateQueue(
            1,
            gated,
            store: new PublicHotReadStore(),
            revocations: new PublicArtifactRevocationRegistry());
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        using var drainToken = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task drain = participant.DrainAsync(drainToken.Token);

        await WaitUntilAsync(() => Task.FromResult(gated.Calls >= 2));
        queue.RecordBatchStarted();
        gated.ReleaseGate();

        await Task.Delay(TimeSpan.FromMilliseconds(150));
        Assert.False(drain.IsCompleted);
        ReleaseDrainParticipantSnapshot blocked = participant.Snapshot();
        Assert.Contains(blocked.Blockers!, static item => item.StartsWith("in-flight-batch-count=1", StringComparison.Ordinal));

        queue.RecordBatchFinished();
        await drain.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(drain.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task AdvancedRequestedGeneration_OldPublishedGenerationMustNotPass()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(
            1,
            state,
            store: new PublicHotReadStore(),
            revocations: new PublicArtifactRevocationRegistry());
        PublicHotArtifactEnqueueResult receipt = await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out _));
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);
        using var drainToken = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task drain = participant.DrainAsync(drainToken.Token);

        await WaitUntilAsync(() =>
        {
            ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
            return Task.FromResult(
                snapshot.Blockers is { } blockers
                && blockers.Any(static item => item.StartsWith("published-generation=0<", StringComparison.Ordinal)));
        });

        await queue.CompleteGenerationAsync(receipt.DeliveryGeneration, CancellationToken.None);
        queue.RecordPublishedGeneration(receipt.DeliveryGeneration);
        await drain.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(drain.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task TimeoutReceipt_ListsExactBlockerAndValue()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(
            1,
            state,
            store: new PublicHotReadStore(),
            revocations: new PublicArtifactRevocationRegistry());
        queue.RecordBatchStarted();
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, new StalledDelayTimeProvider());

        using var timeout = new CancellationTokenSource();
        Task drain = participant.DrainAsync(timeout.Token);
        await WaitUntilAsync(() => Task.FromResult(
            participant.Snapshot().Blockers?.Contains("in-flight-batch-count=1", StringComparer.Ordinal) == true));
        timeout.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => drain);
        ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
        Assert.Equal("public_hot_not_quiescent", snapshot.ErrorCode);
        Assert.Contains(snapshot.Blockers!, static item => item == "in-flight-batch-count=1");
        queue.RecordBatchFinished();
    }

    [Fact]
    public async Task ActiveBackgroundClaim_IsVisibleWhileWorkerExecutes()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var store = new PublicHotReadStore();
        var queue = CreateQueue(
            1,
            state,
            store: store,
            revocations: new PublicArtifactRevocationRegistry());
        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.RequiredContent,
            42,
            "article-updated");
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate wakeup));
        var projector = new BlockingInitialProjector();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector>(_ => projector)
            .BuildServiceProvider();
        using var worker = CreateWorker(queue, store, services);

        Task processing = worker.ProcessOnceAsync(wakeup, CancellationToken.None);
        await projector.BuildStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        PublicHotActivitySnapshot during = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(1, during.ActiveBackgroundClaimCountForPublicHot);

        projector.ReleaseBuild();
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        PublicHotActivitySnapshot after = await queue
            .CreateActivitySnapshotAsync(CancellationToken.None)
            ;
        Assert.Equal(0, after.ActiveBackgroundClaimCountForPublicHot);
    }

    [Fact]
    public async Task AllMandatoryFieldsQualified_DrainCompletes()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = CreateQueue(
            1,
            state,
            store: new PublicHotReadStore(),
            revocations: new PublicArtifactRevocationRegistry());
        var participant = new PublicHotUpdateReleaseDrainParticipant(queue, TimeProvider.System);

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await participant.DrainAsync(timeout.Token);
        ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
        Assert.Equal(0, snapshot.PendingCount);
        Assert.Equal("drained", snapshot.Status);
        Assert.Null(snapshot.ErrorCode);
    }

    [Fact]
    public void Evaluate_UnknownCollector_FailsClosed()
    {
        var snapshot = new PublicHotActivitySnapshot(
            null, null, null, null, null, null, null, null, null, null, "boom");
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(result.Drained);
        Assert.Equal("boom", result.Error);
        Assert.Contains(result.Blockers, static item => item.StartsWith("collector-error=boom", StringComparison.Ordinal));
    }

    [Fact]
    public void Evaluate_NegativeCount_FailsClosed()
    {
        var snapshot = new PublicHotActivitySnapshot(0, -1, 0, "Ready", 0, 0, 0, 0, 0, 0);
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(result.Drained);
        Assert.Contains(result.Blockers, static item => item == "in-flight-batch-count=-1");
    }

    [Fact]
    public void Evaluate_BuildingStore_FailsClosed()
    {
        var snapshot = new PublicHotActivitySnapshot(0, 0, 0, "Building", 0, 0, 0, 0, 0, 0);
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 0);
        Assert.False(result.Drained);
        Assert.Contains(result.Blockers, static item => item == "store-state=Building");
    }

    [Fact]
    public void Evaluate_PublishedBelowRequested_FailsClosedWithExactValues()
    {
        var snapshot = new PublicHotActivitySnapshot(0, 0, 0, "Ready", 0, 0, 3, 0, 0, 5);
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 5);
        Assert.False(result.Drained);
        Assert.Contains(result.Blockers, static item => item == "published-generation=3<requested-drain-generation=5");
    }

    [Fact]
    public void Evaluate_AllQualified_ReturnsDrained()
    {
        var snapshot = new PublicHotActivitySnapshot(0, 0, 0, "Ready", 0, 0, 5, 0, 0, 5);
        PublicHotQuiescenceResult result = PublicHotQuiescence.Evaluate(snapshot, 5);
        Assert.True(result.Drained);
        Assert.Empty(result.Blockers);
        Assert.Null(result.Error);
    }

    private static async Task AssertDrainedAsync(
        PublicHotUpdateReleaseDrainParticipant participant,
        PublicHotArtifactUpdateQueue queue)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await participant.DrainAsync(timeout.Token);
        ReleaseDrainParticipantSnapshot snapshot = participant.Snapshot();
        Assert.Equal(0, snapshot.PendingCount);
        Assert.Equal("drained", snapshot.Status);
        Assert.Null(snapshot.ErrorCode);
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await condition())
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token);
        }
    }

    private static PublicHotArtifactUpdateQueue CreateQueue(
        int capacity,
        IPublicHotArtifactDeliveryStateStore state,
        IPublicHotArtifactObligationStore? obligations = null,
        PublicHotReadStore? store = null,
        PublicArtifactRevocationRegistry? revocations = null)
        => new(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = capacity }),
            state,
            obligations,
            store,
            revocations);

    private static PublicHotArtifactUpdateWorker CreateWorker(
        PublicHotArtifactUpdateQueue queue,
        PublicHotReadStore store,
        IServiceProvider services,
        IPublicArtifactRevocationCoordinator? revocations = null,
        PublicHotReadOptions? options = null)
        => new(
            queue,
            store,
            revocations ?? new NoopRevocations(),
            CreateTestRuntime(),
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(options ?? new PublicHotReadOptions { UpdateDebounceMilliseconds = 0 }),
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

    private static PublicHotReadSnapshot CreateSnapshot(long version)
        => new(
            version,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, DateTimeOffset.UtcNow));

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class CountingProjector : IPublicHotArtifactProjector
    {
        private int _version;

        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => Task.FromResult(CreateSnapshot(Interlocked.Increment(ref _version)));
    }

    private sealed class BlockingInitialProjector : IPublicHotArtifactProjector
    {
        private readonly TaskCompletionSource _buildStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseBuild =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource BuildStarted => _buildStarted;
        public void ReleaseBuild() => _releaseBuild.TrySetResult();

        public async Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
        {
            _buildStarted.TrySetResult();
            await _releaseBuild.Task.WaitAsync(cancellationToken);
            return CreateSnapshot(1);
        }

        public async Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
        {
            _buildStarted.TrySetResult();
            await _releaseBuild.Task.WaitAsync(cancellationToken);
            return current;
        }

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => Task.FromResult(current);
    }

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

    private sealed class BlockingPublishStore : PublicHotReadStore
    {
        private readonly TaskCompletionSource _publishStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releasePublish =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource PublishStarted => _publishStarted;
        public void ReleasePublish() => _releasePublish.TrySetResult();

        public override void Publish(PublicHotReadSnapshot next)
        {
            _publishStarted.TrySetResult();
            _releasePublish.Task.GetAwaiter().GetResult();
            base.Publish(next);
        }
    }

    private sealed class BlockingRevocationCoordinator : IPublicArtifactRevocationCoordinator
    {
        private readonly TaskCompletionSource _completionStarted =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseCompletion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource CompletionStarted => _completionStarted;
        public long CurrentGeneration => 1;
        public void ReleaseCompletion() => _releaseCompletion.TrySetResult();

        public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<bool> RecoverPendingMutationFenceAsync(
            PublicArtifactTombstone tombstone,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RevokeAllAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public async Task CompleteRebuildAsync(
            IReadOnlyCollection<int>? articleIds,
            long maximumGeneration,
            CancellationToken cancellationToken = default)
        {
            _completionStarted.TrySetResult();
            await _releaseCompletion.Task.WaitAsync(cancellationToken);
        }
    }

    private sealed class StalledDelayTimeProvider : TimeProvider
    {
        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
            => new StalledTimer();

        private sealed class StalledTimer : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period) => true;

            public void Dispose()
            {
            }

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
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

    private sealed class ThrowingPendingStateStore : IPublicHotArtifactDeliveryStateStore
    {
        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
            => throw new InvalidOperationException("public-hot pending generation collector failed");

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class GatedPendingGenerationStore : IPublicHotArtifactDeliveryStateStore
    {
        private readonly TaskCompletionSource _gate =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);
        public void ReleaseGate() => _gate.TrySetResult();

        public Task<long> MarkDirtyAsync(
            PublicHotArtifactDeliveryClass deliveryClass,
            CancellationToken cancellationToken)
            => Task.FromResult(0L);

        public async Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken)
        {
            int call = Interlocked.Increment(ref _calls);
            if (call > 1)
            {
                await _gate.Task.WaitAsync(cancellationToken);
            }

            return 0;
        }

        public Task CompleteAsync(long generation, CancellationToken cancellationToken)
            => Task.CompletedTask;
    }
}

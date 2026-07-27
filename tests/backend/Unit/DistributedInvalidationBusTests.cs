using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedInvalidationBusTests
{
    [Fact]
    public async Task SingleModePublisher_RemainsLocalOnlyWithoutEventOrTransport()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Runtime:Mode"] = "single"
            })
            .Build();
        DistributedInvalidationOptions options = DistributedInvalidationOptions.FromConfiguration(configuration);
        var publisher = new SingleNodeDistributedInvalidationPublisher();

        DistributedInvalidationPublishResult result = await publisher.PublishAsync(CreateRequest());

        Assert.False(options.Enabled);
        Assert.Equal(DistributedInvalidationPublishStatus.LocalOnly, result.Status);
        Assert.Null(result.EventId);
    }

    [Fact]
    public async Task DualNodePublication_AppliesOnceOnPeerAndNeverLoops()
    {
        var hub = new InMemoryTransportHub();
        var peerApplied = new TaskCompletionSource<DistributedInvalidationEvent>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var nodeAApplier = new RecordingLocalApplier();
        var nodeBApplier = new RecordingLocalApplier(peerApplied);
        using DistributedInvalidationBus nodeA = CreateBus("node-a", hub.CreateTransport(), nodeAApplier);
        using DistributedInvalidationBus nodeB = CreateBus("node-b", hub.CreateTransport(), nodeBApplier);
        await nodeA.StartAsync(CancellationToken.None);
        await nodeB.StartAsync(CancellationToken.None);

        DistributedInvalidationPublishResult result = await nodeA.PublishAsync(CreateRequest());
        DistributedInvalidationEvent observed = await peerApplied.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await hub.RepublishLastAsync();
        await EventuallyAsync(() => nodeB.RuntimeSnapshotForTests().DuplicateCount == 1);

        Assert.Equal(DistributedInvalidationPublishStatus.Published, result.Status);
        Assert.Equal(result.EventId, observed.EventId);
        Assert.Equal(0, nodeAApplier.ApplyCount);
        Assert.Equal(1, nodeBApplier.ApplyCount);
        Assert.Equal(1, nodeBApplier.L1Generation);
        Assert.Equal(1, nodeBApplier.PublicAotGeneration);
        Assert.Equal(1, nodeBApplier.PublicHotReadGeneration);
        Assert.Equal(1, hub.OriginalPublishCount);
        await EventuallyAsync(() => nodeA.RuntimeSnapshotForTests().SelfIgnoredCount >= 1);

        await nodeA.StopAsync(CancellationToken.None);
        await nodeB.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ApplyFailure_RetriesThenRecordsConvergence()
    {
        var transport = new CapturingTransport();
        var applier = new RecordingLocalApplier(failuresBeforeSuccess: 1);
        using DistributedInvalidationBus bus = CreateBus("node-b", transport, applier, applyRetryCount: 2);
        DistributedInvalidationEvent invalidation = CreateEvent("node-a", "retry-event");

        await bus.HandlePayloadAsync(JsonSerializer.Serialize(invalidation), CancellationToken.None);

        Assert.Equal(2, applier.ApplyAttempts);
        Assert.Equal(1, applier.ApplyCount);
        Assert.Equal(1, bus.RuntimeSnapshotForTests().AppliedCount);
        Assert.Equal(0, bus.RuntimeSnapshotForTests().DegradedCount);
    }

    [Fact]
    public async Task RejectedRebuildWithoutDurableMarker_DoesNotRecordAppliedAndCanReplay()
    {
        var applier = new ResultLocalApplier(DegradedRetryableResult());
        using DistributedInvalidationBus bus = CreateBus("node-b", new CapturingTransport(), applier, applyRetryCount: 1);
        DistributedInvalidationEvent invalidation = CreateEvent("node-a", "rejected-without-marker");
        string payload = JsonSerializer.Serialize(invalidation);

        await bus.HandlePayloadAsync(payload, CancellationToken.None);
        await bus.HandlePayloadAsync(payload, CancellationToken.None);

        DistributedInvalidationRuntimeSnapshot snapshot = bus.RuntimeSnapshotForTests();
        Assert.Equal(2, applier.ApplyAttempts);
        Assert.Equal(0, snapshot.AppliedCount);
        Assert.Equal(0, snapshot.DuplicateCount);
        Assert.Equal(2, snapshot.DegradedCount);
    }

    [Fact]
    public async Task DurableRebuildMarker_RecordsAppliedWithObligationIdentity()
    {
        var applier = new ResultLocalApplier(DurableAppliedResult());
        using DistributedInvalidationBus bus = CreateBus("node-b", new CapturingTransport(), applier);
        DistributedInvalidationEvent invalidation = CreateEvent("node-a", "durable-marker");

        await bus.HandlePayloadAsync(JsonSerializer.Serialize(invalidation), CancellationToken.None);

        DistributedInvalidationRuntimeSnapshot snapshot = bus.RuntimeSnapshotForTests();
        Assert.Equal(1, snapshot.ReceivedCount);
        Assert.Equal(1, snapshot.LocalInvalidatedCount);
        Assert.Equal(1, snapshot.RebuildObligatedCount);
        Assert.Equal(1, snapshot.AppliedCount);
        Assert.Equal(DistributedInvalidationRebuildObligationStatus.Durable, snapshot.LastRebuildObligationStatus);
        Assert.Equal("obligation-42", snapshot.LastRebuildObligationId);
        Assert.Equal(42, snapshot.LastRebuildGeneration);
    }

    [Theory]
    [MemberData(nameof(NonAppliedResults))]
    public async Task IncompleteOrUnknownLocalApplyResult_FailsClosedAndReleasesDedupe(
        DistributedInvalidationLocalApplyResult? result)
    {
        var applier = new ResultLocalApplier(result);
        using DistributedInvalidationBus bus = CreateBus("node-b", new CapturingTransport(), applier, applyRetryCount: 1);
        DistributedInvalidationEvent invalidation = CreateEvent("node-a", Guid.NewGuid().ToString("N"));
        string payload = JsonSerializer.Serialize(invalidation);

        await bus.HandlePayloadAsync(payload, CancellationToken.None);
        await bus.HandlePayloadAsync(payload, CancellationToken.None);

        Assert.Equal(2, applier.ApplyAttempts);
        Assert.Equal(0, bus.RuntimeSnapshotForTests().AppliedCount);
    }

    public static IEnumerable<object?[]> NonAppliedResults()
    {
        yield return [null];
        yield return [new DistributedInvalidationLocalApplyResult(
            true, false, true, true,
            DistributedInvalidationRebuildObligationStatus.Durable,
            DistributedInvalidationLocalApplyStatus.Applied,
            "obligation-42", 42)];
        yield return [new DistributedInvalidationLocalApplyResult(
            true, true, true, false,
            DistributedInvalidationRebuildObligationStatus.Durable,
            DistributedInvalidationLocalApplyStatus.Applied,
            "obligation-42", 42)];
        yield return [new DistributedInvalidationLocalApplyResult(
            true, true, true, true,
            DistributedInvalidationRebuildObligationStatus.Failed,
            DistributedInvalidationLocalApplyStatus.FailedTerminal,
            null, null)];
        yield return [new DistributedInvalidationLocalApplyResult(
            true, true, true, true,
            (DistributedInvalidationRebuildObligationStatus)99,
            DistributedInvalidationLocalApplyStatus.Applied,
            "obligation-42", 42)];
    }

    [Fact]
    public async Task RedisPublicationFailure_IsObservableAndDoesNotThrow()
    {
        using DistributedInvalidationBus bus = CreateBus(
            "node-a",
            new ThrowingTransport(),
            new RecordingLocalApplier());

        DistributedInvalidationPublishResult result = await bus.PublishAsync(CreateRequest());

        Assert.Equal(DistributedInvalidationPublishStatus.Degraded, result.Status);
        Assert.Equal("degraded", bus.RuntimeSnapshotForTests().LastStatus);
        Assert.Equal("distributed_degraded", bus.CacheRuntimeSnapshotForTests().LastKind);
        Assert.Contains("publish:TransportFailed", result.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Publish_RecordsPublishedOnlyWhenSubscriberCountMeetsTopologyExpectation()
    {
        using DistributedInvalidationBus bus = CreateBus(
            "node-a",
            new StaticReceiptTransport(CreateReceipt(2)),
            new RecordingLocalApplier());

        DistributedInvalidationPublishResult result = await bus.PublishAsync(CreateRequest());
        DistributedInvalidationRuntimeSnapshot snapshot = bus.RuntimeSnapshotForTests();

        Assert.Equal(DistributedInvalidationPublishStatus.Published, result.Status);
        Assert.Equal(1, snapshot.PublishedCount);
        Assert.Equal(2, snapshot.LastSubscriberCount);
        Assert.Equal(2, snapshot.LastExpectedMinimumSubscribers);
        Assert.Equal(DistributedInvalidationOptions.DefaultChannel, snapshot.LastChannel);
        Assert.NotNull(snapshot.LastTopologyDigest);
    }

    [Fact]
    public async Task Publish_FailsClosedWhenOnlySourceSubscriberIsObservedButTopologyRequiresRemote()
    {
        using DistributedInvalidationBus bus = CreateBus(
            "node-a",
            new StaticReceiptTransport(CreateReceipt(1)),
            new RecordingLocalApplier());

        DistributedInvalidationPublishResult result = await bus.PublishAsync(CreateRequest());

        Assert.Equal(DistributedInvalidationPublishStatus.Degraded, result.Status);
        Assert.Equal(0, bus.RuntimeSnapshotForTests().PublishedCount);
        Assert.Contains("count:1;expected:2", result.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Publish_FailsClosedForZeroOrInvalidSubscriberCount()
    {
        foreach (long? count in new long?[] { 0, null, -1 })
        {
            using DistributedInvalidationBus bus = CreateBus(
                "node-a",
                new StaticReceiptTransport(CreateReceipt(count)),
                new RecordingLocalApplier());

            DistributedInvalidationPublishResult result = await bus.PublishAsync(CreateRequest());

            Assert.Equal(DistributedInvalidationPublishStatus.Degraded, result.Status);
            Assert.Equal(0, bus.RuntimeSnapshotForTests().PublishedCount);
        }
    }

    [Fact]
    public void DistributedMode_RejectsMissingTopologyManifest()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Runtime:Mode"] = "static-role",
                ["Runtime:DistributedInvalidation:NodeId"] = "node-a"
            })
            .Build();

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => DistributedInvalidationOptions.FromConfiguration(configuration));

        Assert.Equal("distributed_invalidation_topology_manifest_required", exception.Message);
    }

    [Theory]
    [InlineData(2, DistributedInvalidationTransportStatus.Delivered)]
    [InlineData(1, DistributedInvalidationTransportStatus.UnderDelivered)]
    [InlineData(0, DistributedInvalidationTransportStatus.UnderDelivered)]
    public async Task RedisTransport_PreservesRawSubscriberCountAndClassifiesAgainstTopology(
        long subscriberCount,
        DistributedInvalidationTransportStatus expectedStatus)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var subscriber = Substitute.For<ISubscriber>();
        redis.GetSubscriber().Returns(subscriber);
        subscriber.PublishAsync(
                Arg.Any<RedisChannel>(),
                Arg.Any<RedisValue>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(subscriberCount));
        DistributedInvalidationTopologyManifest topology = DistributedInvalidationTopologyManifest.Create(
            DistributedInvalidationOptions.DefaultChannel,
            ["node-a", "node-b"]);
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "node-a",
            Topology = topology
        };
        var transport = new RedisDistributedInvalidationTransport(
            redis,
            new DefaultRuntimeKeyScope(),
            options,
            TimeProvider.System);

        DistributedInvalidationTransportPublishResult receipt = await transport.PublishAsync("payload");

        Assert.Equal(subscriberCount, receipt.SubscriberCount);
        Assert.Equal(2, receipt.ExpectedMinimumSubscribers);
        Assert.Equal(DistributedInvalidationOptions.DefaultChannel, receipt.Channel);
        Assert.Equal(topology.Digest, receipt.TopologyDigest);
        Assert.True(receipt.PublisherNodeSubscribed);
        Assert.Equal(expectedStatus, receipt.TransportStatus);
        await subscriber.Received(1).PublishAsync(
            RedisChannel.Literal(DistributedInvalidationOptions.DefaultChannel),
            "payload",
            CommandFlags.None);
    }

    [Fact]
    public async Task RedisTransport_ConvertsRedisExceptionToTransportFailedReceipt()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var subscriber = Substitute.For<ISubscriber>();
        redis.GetSubscriber().Returns(subscriber);
        subscriber.PublishAsync(
                Arg.Any<RedisChannel>(),
                Arg.Any<RedisValue>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromException<long>(new InvalidOperationException("redis-unavailable")));
        DistributedInvalidationTopologyManifest topology = DistributedInvalidationTopologyManifest.Create(
            DistributedInvalidationOptions.DefaultChannel,
            ["node-a", "node-b"]);
        var transport = new RedisDistributedInvalidationTransport(
            redis,
            new DefaultRuntimeKeyScope(),
            new DistributedInvalidationOptions
            {
                RuntimeMode = RuntimeModeKind.StaticRole,
                NodeId = "node-a",
                Topology = topology
            },
            TimeProvider.System);

        DistributedInvalidationTransportPublishResult receipt = await transport.PublishAsync("payload");

        Assert.Equal(DistributedInvalidationTransportStatus.TransportFailed, receipt.TransportStatus);
        Assert.Null(receipt.SubscriberCount);
        Assert.Equal(2, receipt.ExpectedMinimumSubscribers);
        Assert.Equal(DistributedInvalidationOptions.DefaultChannel, receipt.Channel);
        Assert.Equal(topology.Digest, receipt.TopologyDigest);
        Assert.True(receipt.PublisherNodeSubscribed);
        Assert.Equal("InvalidOperationException", receipt.FailureReason);
    }

    [Fact]
    public async Task Dispatcher_CompletesLocalInvalidationBeforeDegradedPublication()
    {
        bool localInvalidationComplete = false;
        var cache = Substitute.For<IUnifiedCache>();
        var httpInvalidator = Substitute.For<IHttpCacheInvalidator>();
        httpInvalidator
            .InvalidateAsync(Arg.Any<CacheTag[]>())
            .Returns(callInfo =>
            {
                localInvalidationComplete = true;
                return Task.CompletedTask;
            });
        var publisher = new OrderingPublisher(() => localInvalidationComplete);
        var obligations = Substitute.For<IDistributedInvalidationObligationStore>();
        obligations.UpsertAsync(
                Arg.Any<DistributedInvalidationPublishResult>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new DistributedInvalidationConvergenceObligation(
                "test-obligation",
                "test-event",
                DistributedInvalidationEventKinds.ArticleMutation,
                "node-a",
                "test",
                "test-mutation",
                "test-topology",
                DistributedInvalidationPublishStatus.Degraded,
                DistributedInvalidationTransportStatus.UnderDelivered,
                DateTimeOffset.UtcNow,
                DistributedInvalidationConvergenceState.PendingRedelivery,
                0,
                null)));
        var dispatcher = new CacheInvalidationDispatcher(
            cache,
            cache,
            httpInvalidator,
            distributedInvalidationPublisher: publisher,
            distributedInvalidationObligations: obligations);

        await dispatcher.InvalidateArticleMutationAsync(42);

        Assert.True(publisher.LocalInvalidationWasComplete);
        Assert.Equal(DistributedInvalidationEventKinds.ArticleMutation, publisher.Request!.Kind);
        await httpInvalidator.Received(1).InvalidateAsync(
            Arg.Is<CacheTag[]>(tags => tags.Contains(CacheTag.ArticleList)));
    }

    [Fact]
    public async Task LocalApplier_InvalidatesRealL1AotAndPublicHotReadState()
    {
        var localCache = new CacheLocalStore(
            new MemoryCache(new MemoryCacheOptions()),
            TimeProvider.System);
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object>()).Returns(Substitute.For<IDatabase>());
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.ContentRootPath.Returns(Path.GetTempPath());
        environment.WebRootPath.Returns(Path.GetTempPath());
        var publicAotCache = new PublicAotFileShellCache(
            environment,
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            configuration: new ConfigurationBuilder().Build(),
            publicArtifactStorage: Substitute.For<IPublicArtifactStorage>());
        var tracker = new PublicAotInvalidationTracker();
        var hotRead = new PublicHotReadStore();
        var deliveryState = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(Options.Create(new PublicHotReadOptions
        {
            UpdateQueueCapacity = 1
        }), deliveryState, deliveryState);
        var cacheRuntime = new CacheInvalidationRuntimeState();
        var applier = new DistributedInvalidationLocalApplier(
            localCache,
            publicAotCache,
            tracker,
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            hotRead,
            queue,
            Substitute.For<IAotSeoConfigSnapshot>(),
            cacheRuntime,
            NullLogger<DistributedInvalidationLocalApplier>.Instance);

        await queue.EnqueueAsync(
            PublicHotArtifactDeliveryClass.FullRebuildMarker,
            null,
            "pre-fill-durable-marker");
        DistributedInvalidationLocalApplyResult? result = await applier.ApplyAsync(CreateEvent("node-a", "real-local-state"));

        Assert.Equal(1, localCache.DistributedInvalidationGenerationForTests);
        Assert.Equal(1, publicAotCache.DistributedMemoryInvalidationGenerationForTests);
        Assert.Equal(1, hotRead.DistributedInvalidationGenerationForTests);
        Assert.Equal(1, tracker.Snapshot().CurrentVersion);
        Assert.False(hotRead.IsReady);
        Assert.Equal(1, queue.QueuedCount);
        Assert.NotNull(result);
        Assert.True(result.IsApplied);
        Assert.Equal(DistributedInvalidationRebuildObligationStatus.Durable, result.RebuildObligationStatus);
        Assert.False(string.IsNullOrWhiteSpace(result.RebuildObligationId));
        Assert.True(result.RebuildGeneration > 0);
        Assert.Equal("distributed:article_mutation", cacheRuntime.Snapshot().LastKind);
        Assert.Contains("source:node-a", cacheRuntime.Snapshot().LastDetail, StringComparison.Ordinal);
    }

    private static DistributedInvalidationBus CreateBus(
        string nodeId,
        IDistributedInvalidationTransport transport,
        IDistributedInvalidationLocalApplier applier,
        int applyRetryCount = 2)
    {
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = nodeId,
            Topology = DistributedInvalidationTopologyManifest.Create(
                DistributedInvalidationOptions.DefaultChannel,
                ["node-a", "node-b"]),
            ApplyRetryCount = applyRetryCount,
            ApplyRetryDelay = TimeSpan.FromMilliseconds(1),
            DedupeCapacity = 128
        };
        var runtimeState = new DistributedInvalidationRuntimeState(TimeProvider.System);
        var cacheRuntimeState = new CacheInvalidationRuntimeState();
        var bus = new DistributedInvalidationBus(
            transport,
            applier,
            new DistributedInvalidationEventFactory(options, new DefaultRuntimeKeyScope(), TimeProvider.System),
            options,
            runtimeState,
            cacheRuntimeState,
            NullLogger<DistributedInvalidationBus>.Instance);
        return bus;
    }

    private static DistributedInvalidationRequest CreateRequest()
        => new(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article-list"],
            ["article:42"],
            ["public-aot", "public-hot-read"]);

    private static DistributedInvalidationEvent CreateEvent(string sourceNodeId, string eventId)
        => DistributedInvalidationEvent.Create(
            eventId,
            DistributedInvalidationEventKinds.ArticleMutation,
            sourceNodeId,
            "test",
            ["article-list"],
            ["article:42"],
            ["public-aot"],
            $"trace-{eventId}",
            TimeProvider.System);

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class RecordingLocalApplier : IDistributedInvalidationLocalApplier
    {
        private readonly TaskCompletionSource<DistributedInvalidationEvent>? _applied;
        private int _remainingFailures;

        public RecordingLocalApplier(
            TaskCompletionSource<DistributedInvalidationEvent>? applied = null,
            int failuresBeforeSuccess = 0)
        {
            _applied = applied;
            _remainingFailures = failuresBeforeSuccess;
        }

        public int ApplyAttempts
        {
            get; private set;
        }
        public int ApplyCount
        {
            get; private set;
        }
        public int L1Generation
        {
            get; private set;
        }
        public int PublicAotGeneration
        {
            get; private set;
        }
        public int PublicHotReadGeneration
        {
            get; private set;
        }

        public Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            ApplyAttempts++;
            if (_remainingFailures-- > 0)
            {
                throw new IOException("transient-local-apply-failure");
            }

            ApplyCount++;
            L1Generation++;
            PublicAotGeneration++;
            PublicHotReadGeneration++;
            _applied?.TrySetResult(invalidation);
            return Task.FromResult<DistributedInvalidationLocalApplyResult?>(QueuedAppliedResult());
        }
    }

    private sealed class ResultLocalApplier(DistributedInvalidationLocalApplyResult? result)
        : IDistributedInvalidationLocalApplier
    {
        public int ApplyAttempts
        {
            get; private set;
        }

        public Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            ApplyAttempts++;
            return Task.FromResult(result);
        }
    }

    private static DistributedInvalidationLocalApplyResult QueuedAppliedResult()
        => new(true, true, true, true,
            DistributedInvalidationRebuildObligationStatus.Queued,
            DistributedInvalidationLocalApplyStatus.Applied,
            null, 1);

    private static DistributedInvalidationLocalApplyResult DurableAppliedResult()
        => new(true, true, true, true,
            DistributedInvalidationRebuildObligationStatus.Durable,
            DistributedInvalidationLocalApplyStatus.Applied,
            "obligation-42", 42);

    private static DistributedInvalidationLocalApplyResult DegradedRetryableResult()
        => new(true, true, true, true,
            DistributedInvalidationRebuildObligationStatus.Rejected,
            DistributedInvalidationLocalApplyStatus.DegradedRetryable,
            null, null);

    private sealed class InMemoryTransportHub
    {
        private readonly ConcurrentBag<Channel<string>> _subscribers = [];

        public string? LastPayload
        {
            get; private set;
        }
        public int OriginalPublishCount
        {
            get; private set;
        }

        public IDistributedInvalidationTransport CreateTransport()
        {
            var channel = Channel.CreateUnbounded<string>();
            _subscribers.Add(channel);
            return new HubTransport(this, channel);
        }

        public Task RepublishLastAsync()
            => BroadcastAsync(LastPayload ?? throw new InvalidOperationException("No payload was published."));

        private Task<DistributedInvalidationTransportPublishResult> PublishAsync(string payload)
        {
            LastPayload = payload;
            OriginalPublishCount++;
            return PublishAndObserveAsync(payload);
        }

        private async Task<DistributedInvalidationTransportPublishResult> PublishAndObserveAsync(string payload)
        {
            await BroadcastAsync(payload);
            return CreateReceipt(_subscribers.Count);
        }

        private Task BroadcastAsync(string payload)
        {
            foreach (Channel<string> subscriber in _subscribers)
            {
                subscriber.Writer.TryWrite(payload);
            }
            return Task.CompletedTask;
        }

        private sealed class HubTransport(InMemoryTransportHub hub, Channel<string> channel)
            : IDistributedInvalidationTransport
        {
            public Task<DistributedInvalidationTransportPublishResult> PublishAsync(string payload, CancellationToken cancellationToken = default)
                => hub.PublishAsync(payload);

            public async IAsyncEnumerable<string> ReadAllAsync(
                [EnumeratorCancellation] CancellationToken cancellationToken = default)
            {
                await foreach (string payload in channel.Reader.ReadAllAsync(cancellationToken))
                {
                    yield return payload;
                }
            }
        }
    }

    private sealed class CapturingTransport : IDistributedInvalidationTransport
    {
        public Task<DistributedInvalidationTransportPublishResult> PublishAsync(string payload, CancellationToken cancellationToken = default)
            => Task.FromResult(CreateReceipt(2));

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private sealed class StaticReceiptTransport(DistributedInvalidationTransportPublishResult receipt)
        : IDistributedInvalidationTransport
    {
        public Task<DistributedInvalidationTransportPublishResult> PublishAsync(string payload, CancellationToken cancellationToken = default)
            => Task.FromResult(receipt);

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private sealed class ThrowingTransport : IDistributedInvalidationTransport
    {
        public Task<DistributedInvalidationTransportPublishResult> PublishAsync(string payload, CancellationToken cancellationToken = default)
            => Task.FromResult(DistributedInvalidationTransportPublishResult.Failed(
                DistributedInvalidationOptions.DefaultChannel,
                DistributedInvalidationTopologyManifest.Create(
                    DistributedInvalidationOptions.DefaultChannel,
                    ["node-a", "node-b"]),
                publisherNodeSubscribed: true,
                TimeProvider.System,
                "InvalidOperationException"));

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private static DistributedInvalidationTransportPublishResult CreateReceipt(long? count)
        => DistributedInvalidationTransportPublishResult.Observe(
            DistributedInvalidationOptions.DefaultChannel,
            count,
            DistributedInvalidationTopologyManifest.Create(
                DistributedInvalidationOptions.DefaultChannel,
                ["node-a", "node-b"]),
            publisherNodeSubscribed: true,
            TimeProvider.System);

    private sealed class OrderingPublisher(Func<bool> localInvalidationComplete)
        : IDistributedInvalidationPublisher
    {
        public bool LocalInvalidationWasComplete
        {
            get; private set;
        }
        public DistributedInvalidationRequest? Request
        {
            get; private set;
        }

        public Task<DistributedInvalidationPublishResult> PublishAsync(
            DistributedInvalidationRequest request,
            CancellationToken cancellationToken = default)
        {
            Request = request;
            LocalInvalidationWasComplete = localInvalidationComplete();
            return Task.FromResult(new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Degraded,
                "event-degraded",
                "redis-unavailable"));
        }
    }
}

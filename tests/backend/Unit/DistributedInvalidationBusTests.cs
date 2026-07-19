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
        Assert.Contains("publish:InvalidOperationException", result.Detail, StringComparison.Ordinal);
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
        var dispatcher = new CacheInvalidationDispatcher(
            cache,
            cache,
            httpInvalidator,
            distributedInvalidationPublisher: publisher);

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
        var queue = new PublicHotArtifactUpdateQueue(Options.Create(new PublicHotReadOptions
        {
            UpdateQueueCapacity = 4
        }));
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

        await applier.ApplyAsync(CreateEvent("node-a", "real-local-state"));

        Assert.Equal(1, localCache.DistributedInvalidationGenerationForTests);
        Assert.Equal(1, publicAotCache.DistributedMemoryInvalidationGenerationForTests);
        Assert.Equal(1, hotRead.DistributedInvalidationGenerationForTests);
        Assert.Equal(1, tracker.Snapshot().CurrentVersion);
        Assert.False(hotRead.IsReady);
        Assert.Equal(1, queue.QueuedCount);
        Assert.Equal("distributed:article_mutation", cacheRuntime.Snapshot().LastKind);
        Assert.Contains("source:node-a", cacheRuntime.Snapshot().LastDetail, StringComparison.Ordinal);
    }

    private static DistributedInvalidationBus CreateBus(
        string nodeId,
        IDistributedInvalidationTransport transport,
        RecordingLocalApplier applier,
        int applyRetryCount = 2)
    {
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = nodeId,
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

        public Task ApplyAsync(
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
            return Task.CompletedTask;
        }
    }

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

        private Task PublishAsync(string payload)
        {
            LastPayload = payload;
            OriginalPublishCount++;
            return BroadcastAsync(payload);
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
            public Task PublishAsync(string payload, CancellationToken cancellationToken = default)
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
        public Task PublishAsync(string payload, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private sealed class ThrowingTransport : IDistributedInvalidationTransport
    {
        public Task PublishAsync(string payload, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("redis-unavailable");

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

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

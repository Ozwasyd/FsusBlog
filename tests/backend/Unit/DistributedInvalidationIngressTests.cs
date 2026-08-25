using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedInvalidationIngressTests
{
    [Fact]
    public async Task CapacityOne_OneHundredMessages_NoEventLossAndPendingInboxComplete()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        var received = new ConcurrentQueue<DistributedInvalidationEvent>();
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                received.Enqueue(callInfo.ArgAt<DistributedInvalidationEvent>(0));
                return new DistributedInvalidationInboxReceipt(
                    false,
                    false,
                    false,
                    DistributedInvalidationInboxApplyState.Pending);
            });
        ledger.RecordFullReconcileObligationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using IngressHarness harness = CreateHarness(ledger, capacity: 1);
        List<string> payloads = [];
        for (int i = 0; i < 100; i++)
        {
            DistributedInvalidationEvent invalidation = CreateEvent($"event-{i}");
            string payload = JsonSerializer.Serialize(invalidation);
            payloads.Add(payload);
            await harness.Sink.HandlePayloadAsync(payload, harness.Channel.Writer);
        }

        Assert.Equal(100, received.Count);
        Assert.True(harness.Channel.Reader.TryRead(out string? item));
        DistributedInvalidationInboxReference? reference =
            DistributedInvalidationInboxReference.TryParse(item);
        Assert.NotNull(reference);
        Assert.Equal("event-0", reference.EventId);
        Assert.NotEqual(payloads[0], item);
        await ledger.Received(99).RecordFullReconcileObligationAsync(
            "test",
            "node-b",
            "ingress-queue-full",
            Arg.Any<CancellationToken>());

        harness.Ingress.RecordPendingLedger(
            new DistributedInvalidationPendingInboxSnapshot(100, TimeSpan.FromMinutes(1), true));
        DistributedInvalidationIngressSnapshot snapshot = harness.Ingress.Snapshot();
        Assert.Equal(100, snapshot.PendingInboxCount);
        Assert.Equal(1, snapshot.Capacity);
        Assert.True(snapshot.LedgerAvailable);
        Assert.False(snapshot.Degraded);
        Assert.Equal(99, snapshot.OverflowCount);
    }

    [Fact]
    public async Task QueueFull_EstablishesDurableFullReconcileObligation()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(
                false,
                false,
                false,
                DistributedInvalidationInboxApplyState.Pending));
        ledger.RecordFullReconcileObligationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using IngressHarness harness = CreateHarness(ledger, capacity: 1);
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(CreateEvent("first")),
            harness.Channel.Writer);
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(CreateEvent("second")),
            harness.Channel.Writer);

        await ledger.Received(1).RecordFullReconcileObligationAsync(
            "test",
            "node-b",
            "ingress-queue-full",
            Arg.Any<CancellationToken>());
        Assert.Equal(1, harness.Ingress.Snapshot().OverflowCount);
    }

    [Fact]
    public async Task InboxPersistedBeforeEnqueue_CrashThenRestartRecoversFromLedger()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        DistributedInvalidationEvent invalidation = CreateEvent("crash-event");
        var inboxEvents = new ConcurrentDictionary<string, DistributedInvalidationEvent>(StringComparer.Ordinal);
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                DistributedInvalidationEvent @event = callInfo.ArgAt<DistributedInvalidationEvent>(0);
                inboxEvents[$"{@event.RuntimeScope}:{@event.EventId}"] = @event;
                return new DistributedInvalidationInboxReceipt(
                    false,
                    false,
                    false,
                    DistributedInvalidationInboxApplyState.Pending);
            });
        ledger.ReadInboxEventAsync(
                "test",
                invalidation.EventId,
                "node-b",
                Arg.Any<CancellationToken>())
            .Returns(callInfo => inboxEvents.GetValueOrDefault(
                $"test:{callInfo.ArgAt<string>(1)}"));
        ledger.TryBeginApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        ledger.RecordApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<DistributedInvalidationInboxApplyState>(),
                Arg.Any<string?>(),
                Arg.Any<long?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using IngressHarness harness = CreateHarness(ledger, capacity: 1);
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(invalidation),
            harness.Channel.Writer);

        Assert.Single(inboxEvents);
        Assert.True(harness.Channel.Reader.Count == 1);

        using BusHarness restarted = CreateBusHarness(
            ledger,
            new CapturingTransport(),
            new RecordingLocalApplier());
        await restarted.Bus.HandleInboxReferenceAsync(
            new DistributedInvalidationInboxReference(
                invalidation.RuntimeScope,
                invalidation.EventId,
                "node-b"),
            CancellationToken.None);

        Assert.Equal(1, restarted.Applier.ApplyCount);
        Assert.Equal(1, restarted.Bus.RuntimeSnapshotForTests().AppliedCount);
    }

    [Fact]
    public async Task ChannelReferenceWithoutInboxRow_FailsClosed()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReadInboxEventAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns((DistributedInvalidationEvent?)null);

        using BusHarness harness = CreateBusHarness(
            ledger,
            new CapturingTransport(),
            new RecordingLocalApplier());
        await harness.Bus.HandleInboxReferenceAsync(
            new DistributedInvalidationInboxReference("test", "missing-event", "node-b"),
            CancellationToken.None);

        DistributedInvalidationRuntimeSnapshot snapshot = harness.Bus.RuntimeSnapshotForTests();
        Assert.Equal(0, snapshot.AppliedCount);
        Assert.Equal(0, harness.Applier.ApplyCount);
        Assert.Contains("inbox:reference-missing", snapshot.LastDetail, StringComparison.Ordinal);
        Assert.True(harness.Ingress.Snapshot().Degraded);
    }

    [Fact]
    public async Task DuplicateInboxReference_AppliesOnceOnly()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        DistributedInvalidationEvent invalidation = CreateEvent("duplicate-event");
        ledger.ReadInboxEventAsync(
                "test",
                invalidation.EventId,
                "node-b",
                Arg.Any<CancellationToken>())
            .Returns(invalidation);
        bool firstClaim = true;
        ledger.TryBeginApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                bool result = firstClaim;
                firstClaim = false;
                return result;
            });
        ledger.RecordApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<DistributedInvalidationInboxApplyState>(),
                Arg.Any<string?>(),
                Arg.Any<long?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using BusHarness harness = CreateBusHarness(
            ledger,
            new CapturingTransport(),
            new RecordingLocalApplier());
        var reference = new DistributedInvalidationInboxReference(
            invalidation.RuntimeScope,
            invalidation.EventId,
            "node-b");
        await harness.Bus.HandleInboxReferenceAsync(reference, CancellationToken.None);
        await harness.Bus.HandleInboxReferenceAsync(reference, CancellationToken.None);

        DistributedInvalidationRuntimeSnapshot snapshot = harness.Bus.RuntimeSnapshotForTests();
        Assert.Equal(1, harness.Applier.ApplyCount);
        Assert.Equal(1, snapshot.AppliedCount);
        Assert.Equal(1, snapshot.DuplicateCount);
    }

    [Fact]
    public async Task OverflowObligationWriteFailure_ReadinessFailsClosed()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(
                false,
                false,
                false,
                DistributedInvalidationInboxApplyState.Pending));
        ledger.RecordFullReconcileObligationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("ledger-down")));

        using IngressHarness harness = CreateHarness(ledger, capacity: 1);
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(CreateEvent("first")),
            harness.Channel.Writer);
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(CreateEvent("second")),
            harness.Channel.Writer);

        DistributedInvalidationIngressSnapshot snapshot = harness.Ingress.Snapshot();
        Assert.Equal(1, snapshot.OverflowCount);
        Assert.True(snapshot.Degraded);
        Assert.False(snapshot.LedgerAvailable);
        Assert.Contains("ingress:overflow-obligation", snapshot.LastError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SlowApply_KeepsMemoryQueuedAtOrBelowCapacity()
    {
        const int Capacity = 8;
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(
                false,
                false,
                false,
                DistributedInvalidationInboxApplyState.Pending));
        ledger.RecordFullReconcileObligationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using IngressHarness harness = CreateHarness(ledger, Capacity);
        for (int i = 0; i < 100; i++)
        {
            await harness.Sink.HandlePayloadAsync(
                JsonSerializer.Serialize(CreateEvent($"slow-{i}")),
                harness.Channel.Writer);
        }

        Assert.True(harness.Channel.Reader.Count <= Capacity);
        harness.Ingress.RecordQueued(harness.Channel.Reader.Count);
        DistributedInvalidationIngressSnapshot snapshot = harness.Ingress.Snapshot();
        Assert.True(snapshot.QueuedCount <= Capacity);
        Assert.Equal(100 - Capacity, snapshot.OverflowCount);
        Assert.Equal(100, snapshot.OverflowCount + snapshot.QueuedCount);
    }

    [Fact]
    public async Task Restart_ScansPendingInboxWithoutRedisRedelivery()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        DistributedInvalidationEvent pending = CreateEvent("restart-event");
        int pendingReadCount = 0;
        int claimAttemptCount = 0;
        int successfulClaimCount = 0;
        ledger.RecoverInterruptedAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        ledger.ReadPendingForNodeAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref pendingReadCount);
                return Task.FromResult<IReadOnlyList<DistributedInvalidationEvent>>([pending]);
            });
        ledger.ReadPendingInboxSnapshotAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationPendingInboxSnapshot(1, null, true));
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(
                false,
                false,
                false,
                DistributedInvalidationInboxApplyState.Pending));
        ledger.TryBeginApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref claimAttemptCount);
                return Interlocked.CompareExchange(ref successfulClaimCount, 1, 0) == 0;
            });
        ledger.RecordApplyAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<DistributedInvalidationInboxApplyState>(),
                Arg.Any<string?>(),
                Arg.Any<long?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var transport = new CapturingTransport();
        using BusHarness harness = CreateBusHarness(ledger, transport, new RecordingLocalApplier());
        await harness.Bus.StartAsync(CancellationToken.None);
        await EventuallyAsync(() => harness.Applier.ApplyCount == 1);
        await EventuallyAsync(() => Volatile.Read(ref pendingReadCount) >= 2);
        await harness.Bus.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(1, harness.Applier.ApplyCount);
        Assert.True(Volatile.Read(ref claimAttemptCount) >= 2);
        Assert.Equal(1, Volatile.Read(ref successfulClaimCount));
        await ledger.Received(1).RecordApplyAsync(
            Arg.Is<DistributedInvalidationEvent>(value =>
                value.EventId == pending.EventId
                && value.ReplayIdentity == pending.ReplayIdentity),
            "node-b",
            DistributedInvalidationInboxApplyState.Applied,
            null,
            1,
            Arg.Any<CancellationToken>());
        Assert.Equal(0, transport.YieldedItems);
        Assert.Equal(1, harness.Ingress.Snapshot().PendingInboxCount);
    }

    [Fact]
    public async Task SelfPublishedPayload_IsIgnoredBeforeEnqueueOrApply()
    {
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(
                Arg.Any<DistributedInvalidationEvent>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(
                false,
                false,
                false,
                DistributedInvalidationInboxApplyState.Pending));

        using IngressHarness harness = CreateHarness(ledger, capacity: 1, nodeId: "node-a");
        await harness.Sink.HandlePayloadAsync(
            JsonSerializer.Serialize(CreateEvent("self-event", sourceNodeId: "node-a")),
            harness.Channel.Writer);

        await ledger.DidNotReceiveWithAnyArgs().ReceiveAsync(default!, default!, default);
        Assert.False(harness.Channel.Reader.TryRead(out _));
        Assert.Equal(1, harness.RuntimeState.Snapshot().SelfIgnoredCount);
    }

    private static DistributedInvalidationOptions CreateOptions(int capacity, string nodeId = "node-b")
        => new()
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = nodeId,
            Topology = DistributedInvalidationTopologyManifest.Create(
                DistributedInvalidationOptions.DefaultChannel,
                ["node-a", "node-b"]),
            ApplyRetryCount = 1,
            ApplyRetryDelay = TimeSpan.FromMilliseconds(1),
            RecoveryReplayInterval = TimeSpan.FromMilliseconds(50),
            DedupeCapacity = 128,
            IngressCapacity = capacity
        };

    private static DistributedInvalidationEvent CreateEvent(string eventId, string sourceNodeId = "node-a")
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

    private static IngressHarness CreateHarness(
        IDistributedInvalidationDeliveryLedger ledger,
        int capacity,
        string nodeId = "node-b")
    {
        var services = new ServiceCollection()
            .AddSingleton(ledger)
            .BuildServiceProvider();
        var ingress = new DistributedInvalidationIngressRuntimeState(capacity);
        var runtimeState = new DistributedInvalidationRuntimeState(TimeProvider.System);
        var sink = new DistributedInvalidationIngressSink(
            CreateOptions(capacity, nodeId),
            ingress,
            runtimeState,
            services.GetRequiredService<IServiceScopeFactory>());
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(capacity)
        {
            SingleReader = false,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });
        return new IngressHarness(services, sink, ingress, channel, runtimeState);
    }

    private static BusHarness CreateBusHarness(
        IDistributedInvalidationDeliveryLedger ledger,
        IDistributedInvalidationTransport transport,
        RecordingLocalApplier applier,
        int capacity = 8)
    {
        var services = new ServiceCollection()
            .AddSingleton(ledger)
            .BuildServiceProvider();
        var ingress = new DistributedInvalidationIngressRuntimeState(capacity);
        DistributedInvalidationOptions options = CreateOptions(capacity);
        var bus = new DistributedInvalidationBus(
            transport,
            applier,
            new DistributedInvalidationEventFactory(
                options,
                new DefaultRuntimeKeyScope(),
                TimeProvider.System),
            options,
            new DistributedInvalidationRuntimeState(TimeProvider.System),
            new CacheInvalidationRuntimeState(),
            NullLogger<DistributedInvalidationBus>.Instance,
            services.GetRequiredService<IServiceScopeFactory>(),
            ingress);
        return new BusHarness(services, bus, applier, ingress);
    }

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class IngressHarness : IDisposable
    {
        public IngressHarness(
            ServiceProvider services,
            DistributedInvalidationIngressSink sink,
            DistributedInvalidationIngressRuntimeState ingress,
            Channel<string> channel,
            DistributedInvalidationRuntimeState runtimeState)
        {
            Services = services;
            Sink = sink;
            Ingress = ingress;
            Channel = channel;
            RuntimeState = runtimeState;
        }

        public ServiceProvider Services
        {
            get;
        }

        public DistributedInvalidationIngressSink Sink
        {
            get;
        }

        public DistributedInvalidationIngressRuntimeState Ingress
        {
            get;
        }

        public Channel<string> Channel
        {
            get;
        }

        public DistributedInvalidationRuntimeState RuntimeState
        {
            get;
        }

        public void Dispose()
            => Services.Dispose();
    }

    private sealed class BusHarness : IDisposable
    {
        public BusHarness(
            ServiceProvider services,
            DistributedInvalidationBus bus,
            RecordingLocalApplier applier,
            DistributedInvalidationIngressRuntimeState ingress)
        {
            Services = services;
            Bus = bus;
            Applier = applier;
            Ingress = ingress;
        }

        public ServiceProvider Services
        {
            get;
        }

        public DistributedInvalidationBus Bus
        {
            get;
        }

        public RecordingLocalApplier Applier
        {
            get;
        }

        public DistributedInvalidationIngressRuntimeState Ingress
        {
            get;
        }

        public void Dispose()
            => Services.Dispose();
    }

    private sealed class CapturingTransport : IDistributedInvalidationTransport
    {
        public int YieldedItems
        {
            get; private set;
        }

        public Task<DistributedInvalidationTransportPublishResult> PublishAsync(
            string payload,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("publish-not-expected");

        public async IAsyncEnumerable<string> ReadAllAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
            yield break;
        }
    }

    private sealed class RecordingLocalApplier : IDistributedInvalidationLocalApplier
    {
        public int ApplyCount
        {
            get; private set;
        }

        public Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            ApplyCount++;
            return Task.FromResult<DistributedInvalidationLocalApplyResult?>(
                new DistributedInvalidationLocalApplyResult(
                    true,
                    true,
                    true,
                    true,
                    DistributedInvalidationRebuildObligationStatus.Queued,
                    DistributedInvalidationLocalApplyStatus.Applied,
                    null,
                    1,
                    1));
        }
    }
}

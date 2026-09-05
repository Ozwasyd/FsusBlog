using System.Net.WebSockets;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamDeliveryAccountingTests
{
    private static readonly NotificationStreamDeliveryPolicy s_policy =
        NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.NoticeReceived);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeploymentDrain_ZeroCountsDoNotBecomeErrors(bool durableHandoff)
    {
        var (publisher, queue, manager, _) = CreatePublisher();
        if (durableHandoff)
        {
            Assert.True((await publisher.PublishAsync(NotificationStreamEventType.NoticeReceived, 7,
                new NotificationStreamUserTarget("proof-account"))).IsSuccess);
            NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
            queue.CompleteDelivery(item, false, false, "simulated-durable-handoff");
            item.Frame.Release();
        }

        var (provider, coordinator, state, registry) = CreateDrainHarness(manager, queue);
        await using (provider)
        {
            ReleaseDrainRunResult local = await registry.DrainAsync(TimeSpan.FromSeconds(1));
            Assert.True(local.Drained);
            Assert.Equal(0, Assert.Single(local.Participants).PendingCount);
            Assert.Equal(0, queue.DeliverySnapshot.Completed);
            Assert.Equal(0, manager.DeliverySnapshot.Completed);
            Assert.Equal(durableHandoff ? 1 : 0, queue.DeliverySnapshot.DurableReplayTransferred);

            await coordinator.DrainForHostStopAsync(CancellationToken.None);

            DeploymentDrainSnapshot drain = state.CreateSnapshot(0).Drain;
            DeploymentDrainComponentSnapshot[] notifications = drain.Components
                .Where(component => component.Name == "notification-stream").ToArray();
            Assert.NotEmpty(notifications);
            Assert.True(drain.Drained, string.Join(";", notifications.Select(component =>
                $"notification Error={component.Error}; PendingCount={component.PendingCount}")));
            Assert.False(drain.TimedOut);
            Assert.All(notifications, component => Assert.Null(component.Error));
            Assert.Contains(notifications, component => component.Status == (durableHandoff ? "replay-transferred" : "drained"));
        }
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("in-flight")]
    [InlineData("replay")]
    [InlineData("terminal")]
    public async Task DeploymentDrain_UnresolvedNotificationStillBlocks(string scenario)
    {
        var manager = CreateManager();
        var queue = NotificationStreamBackpressureTestSupport.CreateQueue();
        var connection = manager.RegisterConnection("blocking", "account", []);
        Assert.True(connection.TryEnqueue(SharedNotificationStreamFrame.FromArray([1]), s_policy, 1));
        NotificationStreamWriteLease? lease = null;
        if (scenario is "in-flight" or "terminal")
        {
            lease = await connection.ReadForWriteAsync(CancellationToken.None);
        }
        if (scenario == "terminal")
        {
            connection.CompleteWrite(lease!, true, "simulated-write-completed");
            lease!.Frame.Release();
            Assert.Throws<InvalidOperationException>(() => connection.CompleteWrite(lease, true, "duplicate"));
            lease = null;
        }
        if (scenario != "queued")
        {
            manager.RemoveConnection("blocking");
        }

        var (provider, coordinator, state, registry) = CreateDrainHarness(manager, queue);
        await using (provider)
        {
            try
            {
                ReleaseDrainParticipantSnapshot participant = Assert.Single(registry.Snapshot());
                Assert.True(participant.PendingCount > 0);
                await coordinator.DrainForHostStopAsync(CancellationToken.None);
                DeploymentDrainSnapshot drain = state.CreateSnapshot(manager.ConnectionCount).Drain;
                Assert.False(drain.Drained);
                Assert.True(drain.TimedOut);
                string expected = scenario switch
                {
                    "queued" => "connection-queued=1",
                    "in-flight" => "connection-in-flight=1",
                    "replay" => "unproven-replay=1",
                    _ => "terminal-failures=1"
                };
                Assert.Contains(drain.Components, component => component.Name == "notification-stream"
                    && component.PendingCount > 0
                    && component.Error?.Contains(expected, StringComparison.Ordinal) == true);
            }
            finally
            {
                if (lease is not null)
                {
                    connection.CompleteWrite(lease, false, "simulated-test-shutdown");
                    lease.Frame.Release();
                }
                manager.RemoveConnection("blocking");
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeploymentDrain_PendingFanoutStillBlocks(bool inFlight)
    {
        var manager = CreateManager();
        var queue = NotificationStreamBackpressureTestSupport.CreateQueue();
        var frame = SharedNotificationStreamFrame.FromArray([1]);
        Assert.True(queue.TryEnqueue(frame, new NotificationStreamUserTarget("account"), s_policy, "pending", 1).Accepted);
        frame.Release();
        NotificationStreamLocalFanoutWorkItem? item = inFlight
            ? await queue.DequeueAsync(CancellationToken.None)
            : null;
        var (provider, coordinator, state, _) = CreateDrainHarness(manager, queue);
        await using (provider)
        {
            try
            {
                await coordinator.DrainForHostStopAsync(CancellationToken.None);
                DeploymentDrainSnapshot drain = state.CreateSnapshot(0).Drain;
                Assert.False(drain.Drained);
                Assert.True(drain.TimedOut);
                string expected = inFlight ? "fanout-in-flight=1" : "fanout-queued=1";
                Assert.Contains(drain.Components, component => component.Name == "notification-stream"
                    && component.PendingCount > 0
                    && component.Error?.Contains(expected, StringComparison.Ordinal) == true);
            }
            finally
            {
                item ??= await queue.DequeueAsync(CancellationToken.None);
                queue.CompleteDelivery(item.Value, false, false, "simulated-test-shutdown");
                item.Value.Frame.Release();
            }
        }
    }

    private static (ServiceProvider, DeploymentDrainCoordinator, DeploymentRuntimeState, ReleaseDrainParticipantRegistry)
        CreateDrainHarness(NotificationStreamConnectionManager manager, NotificationStreamLocalFanoutQueue queue)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Deployment:DrainTimeoutSeconds"] = "1",
            ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "1"
        }).Build();
        var identity = new ReleaseIdentityProvider(configuration);
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Development");
        var state = new DeploymentRuntimeState(identity, configuration, environment, TimeProvider.System);
        var restart = new NotificationStreamRestartCoordinator(identity, state, manager, TimeProvider.System);
        var participant = new NotificationStreamReleaseDrainParticipant(restart, manager, TimeProvider.System, queue);
        var registry = new ReleaseDrainParticipantRegistry([participant], TimeProvider.System,
            NullLogger<ReleaseDrainParticipantRegistry>.Instance);
        var provider = new ServiceCollection().AddSingleton(manager).AddSingleton(registry).BuildServiceProvider();
        var coordinator = new DeploymentDrainCoordinator(state, provider, configuration, TimeProvider.System,
            NullLogger<DeploymentDrainCoordinator>.Instance);
        return (provider, coordinator, state, registry);
    }

    [Fact]
    public async Task WriteAwaited_RemovedConnectionRemainsInFlightUntilSocketCompletes()
    {
        var manager = CreateManager();
        var fanout = NotificationStreamBackpressureTestSupport.CreateQueue();
        var participant = CreateParticipant(manager, fanout);
        var connection = manager.RegisterConnection("blocked", "account", []);
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);
        Assert.True(connection.TryEnqueue(frame, s_policy, 1));
        using var socket = new ControlledSocket();
        using var gate = new SemaphoreSlim(1, 1);

        Task send = NotificationStreamSessionService.WriteNextQueuedFrameAsync(socket, connection, gate, CancellationToken.None);
        try
        {
            await socket.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            manager.RemoveConnection("blocked");
            Assert.Equal(0, manager.ConnectionCount);
            Assert.Equal(0, manager.DeliverySnapshot.Queued);
            Assert.Equal(1, manager.DeliverySnapshot.InFlight);
            Assert.Equal(0, manager.DeliverySnapshot.Completed);
            Assert.True(participant.Snapshot().PendingCount > 0);
            Assert.Equal(3, frame.Length);
            frame.Retain();
            frame.Release();
        }
        finally
        {
            socket.Finish.TrySetResult();
            await send.WaitAsync(TimeSpan.FromSeconds(5));
        }

        Assert.Equal(0, manager.DeliverySnapshot.Outstanding);
        Assert.Equal(1, manager.DeliverySnapshot.Completed);
        Assert.Equal("drained", participant.Snapshot().Status);
        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WriteFailureOrCancellation_RetainsUnprovenReplayAndReleasesFrame(bool cancel)
    {
        var manager = CreateManager();
        var connection = manager.RegisterConnection("failed", "account", []);
        var frame = SharedNotificationStreamFrame.FromArray([4]);
        Assert.True(connection.TryEnqueue(frame, s_policy, 2));
        using var socket = new ControlledSocket();
        using var gate = new SemaphoreSlim(1, 1);
        using var cancellation = new CancellationTokenSource();
        Task send = NotificationStreamSessionService.WriteNextQueuedFrameAsync(socket, connection, gate, cancellation.Token);
        await socket.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (cancel)
        {
            await cancellation.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send);
        }
        else
        {
            socket.Finish.SetException(new IOException("simulated socket failure"));
            await Assert.ThrowsAsync<IOException>(() => send);
        }

        manager.RemoveConnection("failed");
        Assert.Equal(0, manager.DeliverySnapshot.InFlight);
        Assert.Equal(0, manager.DeliverySnapshot.Completed);
        Assert.Equal(1, manager.DeliverySnapshot.ReplayRequired);
        Assert.Equal(0, manager.DeliverySnapshot.DurableReplayTransferred);
        Assert.True(connection.IsClosed);
        Assert.Equal(NotificationStreamRestartCloseCodes.ReplayRequired, connection.CloseInstruction.CloseCode);
        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public async Task DisconnectDrain_DoesNotAcknowledgeAnotherInFlightFrame()
    {
        var manager = CreateManager();
        var connection = manager.RegisterConnection("two", "account", []);
        var writing = SharedNotificationStreamFrame.FromArray([1]);
        var queued = SharedNotificationStreamFrame.FromArray([2, 3]);
        Assert.True(connection.TryEnqueue(writing, s_policy, 1));
        Assert.True(connection.TryEnqueue(queued, s_policy, 2));
        NotificationStreamWriteLease lease = await connection.ReadForWriteAsync(CancellationToken.None);

        manager.RemoveConnection("two");

        Assert.Equal(1, connection.InFlightWriteCount);
        Assert.Equal(0, connection.QueuedFrameCount);
        Assert.Equal(1, manager.DeliverySnapshot.ReplayRequired);
        Assert.Throws<InvalidOperationException>(() => queued.Release());
        connection.CompleteWrite(lease, true, "written");
        lease.Frame.Release();
        Assert.Equal(1, manager.DeliverySnapshot.Completed);
        Assert.Equal(0, manager.DeliverySnapshot.InFlight);
    }

    [Fact]
    public async Task InFlightFrame_StillConsumesTheConnectionBudget()
    {
        var connection = new NotificationStreamConnection("bounded", "account", [], queueCapacity: 1, queueByteCapacity: 1);
        var first = SharedNotificationStreamFrame.FromArray([1]);
        Assert.True(connection.TryEnqueue(first, s_policy, 1));
        NotificationStreamWriteLease lease = await connection.ReadForWriteAsync(CancellationToken.None);
        var next = SharedNotificationStreamFrame.FromArray([2]);
        Assert.False(connection.TryEnqueue(next, s_policy, 2));
        Assert.Equal(1, connection.InFlightWriteCount);
        Assert.Equal(1, connection.DeliverySnapshot.ReplayRequired);
        connection.CompleteWrite(lease, true, "written");
        lease.Frame.Release();
        Assert.Throws<InvalidOperationException>(() => next.Release());
    }

    [Fact]
    public async Task FanoutDequeue_RemainsVisibleUntilDispatchAndRecordsFailure()
    {
        var manager = CreateManager();
        var queue = NotificationStreamBackpressureTestSupport.CreateQueue();
        var participant = CreateParticipant(manager, queue);
        var frame = SharedNotificationStreamFrame.FromArray([5]);
        Assert.True(queue.TryEnqueue(frame, new NotificationStreamUserTarget("account"), s_policy, "event", 5).Accepted);
        frame.Release();
        var clock = new BlockingFailureClock();
        using var worker = new NotificationStreamLocalFanoutWorker(queue, manager,
            NullLogger<NotificationStreamLocalFanoutWorker>.Instance, clock);
        Task dispatch = Task.Run(() => worker.ProcessOnceAsync(CancellationToken.None));
        try
        {
            await clock.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(0, queue.DeliverySnapshot.Queued);
            Assert.Equal(1, queue.DeliverySnapshot.InFlight);
            Assert.True(participant.Snapshot().PendingCount > 0);
        }
        finally
        {
            clock.Release.TrySetResult();
            await dispatch.WaitAsync(TimeSpan.FromSeconds(5));
        }

        Assert.Equal(0, queue.DeliverySnapshot.InFlight);
        Assert.Equal(0, queue.DeliverySnapshot.Completed);
        Assert.Equal(1, queue.DeliverySnapshot.ReplayRequired);
        Assert.Equal("notification_replay_unproven", participant.Snapshot().ErrorCode);
        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public void RemovedConnections_AreCollectibleAtHighCardinality()
    {
        var manager = CreateManager();
        WeakReference[] removed = Enumerable.Range(0, 512).Select(index => RegisterAndRemove(manager, index)).ToArray();
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        Assert.All(removed, item => Assert.False(item.IsAlive));
        Assert.Equal(0, manager.ConnectionCount);
        Assert.Equal(512, manager.DeliverySnapshot.Outstanding);
        Assert.Equal(512, manager.DeliverySnapshot.ReplayRequired);
        GC.KeepAlive(manager);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference RegisterAndRemove(NotificationStreamConnectionManager manager, int index)
    {
        string id = index.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var connection = manager.RegisterConnection(id, "account", []);
        Assert.True(connection.TryEnqueue(SharedNotificationStreamFrame.FromArray([1]), s_policy, index + 1));
        var reference = new WeakReference(connection);
        manager.RemoveConnection(id);
        return reference;
    }

    [Theory]
    [InlineData("matching")]
    [InlineData("event")]
    [InlineData("target")]
    [InlineData("untrusted-proof")]
    public async Task AppendProof_TransfersOnlyTheMatchingEventToDurableReplay(string scenario)
    {
        var (publisher, queue, manager, _) = CreatePublisher();
        var target = new NotificationStreamUserTarget("proof-account");
        var published = await publisher.PublishAsync(NotificationStreamEventType.NoticeReceived, 7, target);
        Assert.True(published.IsSuccess);
        NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
        Assert.NotNull(item.Acceptance);
        bool mismatch = scenario != "matching";
        var deliveryTarget = scenario == "target" ? new NotificationStreamUserTarget("other-account") : target;
        var connection = manager.RegisterConnection("proof", deliveryTarget.AccountId, []);
        NotificationStreamBacklogAcceptance? proof = scenario == "untrusted-proof" ? new UntrustedAcceptance() : item.Acceptance;
        manager.Publish(item.Frame, deliveryTarget, item.Policy, scenario == "event" ? 8 : item.EventId, 0, proof);
        queue.CompleteDelivery(item, true, false, "dispatched");
        item.Frame.Release();
        manager.RemoveConnection("proof");

        Assert.Equal(mismatch ? 1 : 0, manager.DeliverySnapshot.ReplayRequired);
        Assert.Equal(mismatch ? 0 : 1, manager.DeliverySnapshot.DurableReplayTransferred);
        Assert.Equal(0, manager.DeliverySnapshot.Completed);
        Assert.Equal(mismatch ? "pending" : "replay-transferred", CreateParticipant(manager, queue).Snapshot().Status);
    }

    private sealed class UntrustedAcceptance : NotificationStreamBacklogAcceptance;

    [Fact]
    public async Task PendingAppend_DoesNotIssueProofUntilTheWriteCompletes()
    {
        var (publisher, queue, _, database) = CreatePublisher();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var appended = new TaskCompletionSource<RedisValue>(TaskCreationOptions.RunContinuationsAsynchronously);
        database.StreamAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
            Arg.Any<RedisValue?>(), Arg.Any<int?>(), Arg.Any<bool>(), Arg.Any<CommandFlags>())
            .Returns(_ =>
            {
                entered.TrySetResult();
                return appended.Task;
            });
        var publishing = publisher.PublishAsync(NotificationStreamEventType.NoticeReceived, 7,
            new NotificationStreamUserTarget("proof-account"));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(publishing.IsCompleted);
            Assert.Equal(0, queue.DeliverySnapshot.Queued);
            Assert.Equal(0, queue.DeliverySnapshot.DurableReplayTransferred);
        }
        finally
        {
            appended.TrySetResult("7-0");
        }

        Assert.True((await publishing.WaitAsync(TimeSpan.FromSeconds(5))).IsSuccess);
        NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
        queue.CompleteDelivery(item, false, false, "simulated-process-handoff");
        item.Frame.Release();
        Assert.Equal(1, queue.DeliverySnapshot.DurableReplayTransferred);
        Assert.Equal(0, queue.DeliverySnapshot.Completed);
        Assert.Equal(0, queue.DeliverySnapshot.Outstanding);
    }

    [Fact]
    public async Task RejectedConnectionAdmission_DoesNotCommitFanout()
    {
        var manager = CreateManager();
        var connection = manager.RegisterConnection("closed", "account", []);
        connection.Complete();
        var queue = NotificationStreamBackpressureTestSupport.CreateQueue();
        var frame = SharedNotificationStreamFrame.FromArray([6]);
        Assert.True(queue.TryEnqueue(frame, new NotificationStreamUserTarget("account"), s_policy, "rejected", 6).Accepted);
        frame.Release();
        using var worker = new NotificationStreamLocalFanoutWorker(queue, manager,
            NullLogger<NotificationStreamLocalFanoutWorker>.Instance, TimeProvider.System);

        await worker.ProcessOnceAsync(CancellationToken.None);

        Assert.Equal(0, queue.DeliverySnapshot.Completed);
        Assert.Equal(0, queue.DeliverySnapshot.InFlight);
        Assert.Equal(1, queue.DeliverySnapshot.ReplayRequired);
        manager.RemoveConnection("closed");
        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AppendFalseOrFailure_DoesNotIssueAcceptanceOrEnqueue(bool fail)
    {
        var (publisher, queue, _, database) = CreatePublisher();
        if (fail)
        {
            database.StreamAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                Arg.Any<RedisValue?>(), Arg.Any<int?>(), Arg.Any<bool>(), Arg.Any<CommandFlags>())
                .Returns(Task.FromException<RedisValue>(new IOException("simulated Redis append failure")));
        }
        else
        {
            database.ScriptEvaluateAsync(Arg.Any<string>(), Arg.Any<RedisKey[]>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
                .Returns(RedisResult.Create((RedisValue)7));
            database.StreamRangeAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue?>(), Arg.Any<RedisValue?>(), Arg.Any<int?>(),
                Arg.Any<Order>(), Arg.Any<CommandFlags>()).Returns([new StreamEntry("7-0", [])]);
        }

        var result = await publisher.PublishAsync(NotificationStreamEventType.NoticeReceived, 7,
            new NotificationStreamUserTarget("proof-account"), idempotencyKey: fail ? null : "already-appended");

        Assert.Equal(!fail, result.IsSuccess);
        Assert.Equal(0, queue.DeliverySnapshot.Queued);
        Assert.Equal(0, queue.DeliverySnapshot.DurableReplayTransferred);
    }

    private static (RedisNotificationStreamPublisher, NotificationStreamLocalFanoutQueue, NotificationStreamConnectionManager, IDatabase) CreatePublisher()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var scope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        scope.PrefixKey(Arg.Any<string>()).Returns(call => "queues-accounting:" + call.Arg<string>());
        database.LockTakeAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan>(), Arg.Any<CommandFlags>()).Returns(true);
        database.LockReleaseAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>()).Returns(true);
        database.StringIncrementAsync(Arg.Any<RedisKey>(), Arg.Any<long>(), Arg.Any<CommandFlags>()).Returns(7L);
        database.StreamAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue?>(),
            Arg.Any<int?>(), Arg.Any<bool>(), Arg.Any<CommandFlags>()).Returns((RedisValue)"7-0");
        var backlog = new NotificationStreamBacklogStore(redis, scope, NullLogger<NotificationStreamBacklogStore>.Instance);
        var queue = NotificationStreamBackpressureTestSupport.CreateQueue();
        var manager = CreateManager();
        return (new RedisNotificationStreamPublisher(backlog, queue, manager, new PolicyTestFrameCodec(),
            NullLogger<RedisNotificationStreamPublisher>.Instance), queue, manager, database);
    }

    private static NotificationStreamConnectionManager CreateManager()
        => new(new ConfigurationBuilder().Build(), NullLogger<NotificationStreamConnectionManager>.Instance);

    private static NotificationStreamReleaseDrainParticipant CreateParticipant(
        NotificationStreamConnectionManager manager, NotificationStreamLocalFanoutQueue queue)
    {
        var configuration = new ConfigurationBuilder().Build();
        var identity = new ReleaseIdentityProvider(configuration);
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Development");
        var deployment = new DeploymentRuntimeState(identity, configuration, environment, TimeProvider.System);
        var restart = new NotificationStreamRestartCoordinator(identity, deployment, manager, TimeProvider.System);
        return new NotificationStreamReleaseDrainParticipant(restart, manager, TimeProvider.System, queue);
    }

    private sealed class BlockingFailureClock : TimeProvider
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override DateTimeOffset GetUtcNow()
        {
            Entered.TrySetResult();
            Release.Task.GetAwaiter().GetResult();
            throw new IOException("simulated dispatcher observation failure");
        }
    }

    private sealed class ControlledSocket : WebSocket
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Finish { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;
        public override void Abort() => Finish.TrySetCanceled();
        public override void Dispose() => Finish.TrySetCanceled();
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) => throw new NotSupportedException();
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
            => SendAsync(buffer.AsMemory(), messageType, endOfMessage, cancellationToken).AsTask();
        public override async ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken = default)
        {
            Entered.TrySetResult();
            await Finish.Task.WaitAsync(cancellationToken);
        }
    }
}

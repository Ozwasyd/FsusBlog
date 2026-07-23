using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamBackpressurePolicyTests
{
    [Fact]
    public void DeliveryPolicyCatalog_CoversEveryActiveEventAndFailsClosedForUnknown()
    {
        NotificationStreamEventType[] active = Enum.GetValues<NotificationStreamEventType>();

        Assert.Equal(active.Length, NotificationStreamDeliveryPolicyCatalog.All.Count);
        Assert.All(active, eventType =>
        {
            NotificationStreamDeliveryPolicy policy = NotificationStreamDeliveryPolicyCatalog.GetRequired(eventType);
            Assert.Equal(eventType, policy.EventType);
            Assert.True(policy.MaximumUsefulAge > TimeSpan.Zero);
            Assert.Equal(NotificationStreamDurability.BacklogRequired, policy.Durability);
            if (policy.LossPolicy is NotificationStreamLossPolicy.Replaceable or NotificationStreamLossPolicy.Coalescible)
            {
                Assert.False(string.IsNullOrWhiteSpace(policy.CoalescingKey));
            }
        });
        Assert.Throws<InvalidOperationException>(() =>
            NotificationStreamDeliveryPolicyCatalog.GetRequired((NotificationStreamEventType)short.MaxValue));
    }

    [Fact]
    public async Task LocalFanout_StateLaneCoalescesSameKeyToLatestFrame()
    {
        NotificationStreamLocalFanoutQueue queue = CreateQueue();
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.UnreadCountUpdated);
        var target = new NotificationStreamUserTarget("account-1");
        SharedNotificationStreamFrame first = SharedNotificationStreamFrame.FromArray([1]);
        SharedNotificationStreamFrame latest = SharedNotificationStreamFrame.FromArray([2]);

        NotificationStreamFanoutEnqueueResult firstResult =
            queue.TryEnqueue(first, target, policy, "unread:account-1", 10);
        NotificationStreamFanoutEnqueueResult latestResult =
            queue.TryEnqueue(latest, target, policy, "unread:account-1", 11);
        first.Release();
        latest.Release();

        Assert.Equal(NotificationStreamFanoutEnqueueStatus.Enqueued, firstResult.Status);
        Assert.Equal(NotificationStreamFanoutEnqueueStatus.Coalesced, latestResult.Status);
        Assert.Equal(1, queue.CoalescedCount);

        NotificationStreamLocalFanoutWorkItem dequeued = await queue.DequeueAsync(CancellationToken.None);
        Assert.Equal(11, dequeued.EventId);
        Assert.Equal(1, dequeued.CoalescedOccurrences);
        Assert.Equal((byte)2, dequeued.Frame.Memory.Span[0]);
        dequeued.Frame.Release();
    }

    [Fact]
    public async Task LocalFanout_FullLosslessLaneDoesNotBlockLowLane()
    {
        NotificationStreamLocalFanoutQueue queue = CreateQueue();
        NotificationStreamDeliveryPolicy lossless =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);
        NotificationStreamDeliveryPolicy low =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.SearchIndexUpdated);
        var target = new NotificationStreamUserTarget("account-2");

        for (int i = 0; i < 4; i++)
        {
            SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([(byte)i]);
            Assert.True(queue.TryEnqueue(frame, target, lossless, $"message:{i}", i + 1).Accepted);
            frame.Release();
        }

        SharedNotificationStreamFrame overflow = SharedNotificationStreamFrame.FromArray([5]);
        NotificationStreamFanoutEnqueueResult overflowResult =
            queue.TryEnqueue(overflow, target, lossless, "message:overflow", 6);
        overflow.Release();
        SharedNotificationStreamFrame lowFrame = SharedNotificationStreamFrame.FromArray([9]);
        NotificationStreamFanoutEnqueueResult lowResult =
            queue.TryEnqueue(lowFrame, target, low, "search:manifest", 7);
        lowFrame.Release();

        Assert.Equal(NotificationStreamFanoutEnqueueStatus.ReplayRequired, overflowResult.Status);
        Assert.True(lowResult.Accepted);
        for (int i = 0; i < 5; i++)
        {
            NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
            item.Frame.Release();
        }
    }

    [Fact]
    public async Task LocalFanout_RoundRobinPreventsLowLaneStarvation()
    {
        NotificationStreamLocalFanoutQueue queue = CreateQueue();
        NotificationStreamDeliveryPolicy lossless =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);
        NotificationStreamDeliveryPolicy low =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.SearchIndexUpdated);
        var target = new NotificationStreamUserTarget("account-fair");
        for (int i = 0; i < 4; i++)
        {
            SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([(byte)i]);
            queue.TryEnqueue(frame, target, lossless, $"message:{i}", i + 1);
            frame.Release();
        }

        SharedNotificationStreamFrame lowFrame = SharedNotificationStreamFrame.FromArray([9]);
        queue.TryEnqueue(lowFrame, target, low, "search:manifest", 99);
        lowFrame.Release();

        var firstRound = new List<long>(3);
        for (int i = 0; i < 3; i++)
        {
            NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
            firstRound.Add(item.EventId);
            item.Frame.Release();
        }

        Assert.Contains(99, firstRound);
        for (int i = 0; i < 2; i++)
        {
            NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(CancellationToken.None);
            item.Frame.Release();
        }
    }

    [Fact]
    public void Connection_ByteOverflowClosesWithExplicitReplayInstruction()
    {
        var connection = new NotificationStreamConnection(
            "connection-1",
            "account-1",
            [],
            queueCapacity: 4,
            queueByteCapacity: 3,
            queueMaximumAge: TimeSpan.FromMinutes(1));
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1, 2, 3, 4]);
        frame.Retain();

        Assert.False(connection.TryEnqueue(frame, policy, eventId: 42));
        Assert.True(connection.IsClosed);
        Assert.Equal(NotificationStreamRestartCloseCodes.ReplayRequired, connection.CloseInstruction.CloseCode);
        Assert.StartsWith(NotificationStreamRestartReasons.ReplayRequired, connection.CloseInstruction.Reason, StringComparison.Ordinal);
        Assert.Equal(1, connection.ResyncCount);
        Assert.Equal(1, connection.DroppedCount);

        frame.Release();
        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public void Connection_PolicyCanRequireFullResyncOnOverflow()
    {
        var connection = new NotificationStreamConnection(
            "connection-security-state",
            "account-security-state",
            [],
            queueCapacity: 4,
            queueByteCapacity: 1,
            queueMaximumAge: TimeSpan.FromMinutes(1));
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.SessionRevoked);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1, 2]);
        frame.Retain();

        Assert.False(connection.TryEnqueue(frame, policy, eventId: 43));
        Assert.Equal(NotificationStreamRestartCloseCodes.FullResyncRequired, connection.CloseInstruction.CloseCode);
        Assert.False(connection.CloseInstruction.PreserveCursor);
        Assert.True(connection.CloseInstruction.RequireFullResync);
        Assert.StartsWith(NotificationStreamRestartReasons.FullResyncRequired, connection.CloseInstruction.Reason, StringComparison.Ordinal);

        frame.Release();
    }

    [Fact]
    public void ReplayLiveHandoff_RegisteredConnectionBuffersLiveFrameUntilReplayCompletes()
    {
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance);
        NotificationStreamConnection connection =
            manager.RegisterConnection("connection-replay", "account-replay", []);
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);

        SharedNotificationStreamFrame live = SharedNotificationStreamFrame.FromArray([51]);
        Assert.Equal(
            1,
            manager.Publish(
                live,
                new NotificationStreamUserTarget("account-replay"),
                policy,
                eventId: 51));
        live.Release();

        SharedNotificationStreamFrame replay = SharedNotificationStreamFrame.FromArray([50]);
        Assert.Equal((byte)50, replay.Memory.Span[0]);
        replay.Release();
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? bufferedLive));
        Assert.Equal((byte)51, bufferedLive.Memory.Span[0]);
        connection.AcknowledgeDequeuedFrame();
        bufferedLive.Release();
        Assert.Equal(0, connection.QueuedFrameCount);
        Assert.Equal(0, connection.QueuedBytes);
        manager.RemoveConnection("connection-replay");
    }

    [Fact]
    public void SlowConsumerOverflow_DoesNotDelayOrCloseUnrelatedTarget()
    {
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance);
        NotificationStreamConnection slow =
            manager.RegisterConnection("connection-slow", "account-slow", [], queueCapacityOverride: 32);
        NotificationStreamConnection healthy =
            manager.RegisterConnection("connection-healthy", "account-healthy", [], queueCapacityOverride: 32);
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);

        for (int i = 1; i <= 33; i++)
        {
            SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([(byte)i]);
            manager.Publish(frame, new NotificationStreamUserTarget("account-slow"), policy, i);
            frame.Release();
        }

        SharedNotificationStreamFrame healthyFrame = SharedNotificationStreamFrame.FromArray([99]);
        Assert.Equal(
            1,
            manager.Publish(
                healthyFrame,
                new NotificationStreamUserTarget("account-healthy"),
                policy,
                eventId: 99));
        healthyFrame.Release();

        Assert.True(slow.IsClosed);
        Assert.False(healthy.IsClosed);
        Assert.True(healthy.Reader.TryRead(out SharedNotificationStreamFrame? delivered));
        Assert.Equal((byte)99, delivered.Memory.Span[0]);
        healthy.AcknowledgeDequeuedFrame();
        delivered.Release();
        manager.RemoveConnection("connection-slow");
        manager.RemoveConnection("connection-healthy");
    }

    [Fact]
    public async Task Connection_ConcurrentPublishKeepsFrameAndByteAccountingAligned()
    {
        var connection = new NotificationStreamConnection(
            "connection-concurrent",
            "account-concurrent",
            [],
            queueCapacity: 1024,
            queueByteCapacity: 4 * 1024 * 1024,
            queueMaximumAge: TimeSpan.FromMinutes(1));
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.InboxMessageAppend);
        long expectedBytes = 0;

        await Parallel.ForEachAsync(Enumerable.Range(1, 512), async (eventId, _) =>
        {
            int length = eventId % 97 + 1;
            SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray(new byte[length]);
            frame.Retain();
            Assert.True(connection.TryEnqueue(frame, policy, eventId));
            frame.Release();
            Interlocked.Add(ref expectedBytes, length);
            await Task.CompletedTask;
        });

        Assert.Equal(512, connection.QueuedFrameCount);
        Assert.Equal(expectedBytes, connection.QueuedBytes);
        int drained = 0;
        while (connection.Reader.TryRead(out SharedNotificationStreamFrame? frame))
        {
            connection.AcknowledgeDequeuedFrame();
            frame.Release();
            drained++;
        }

        Assert.Equal(512, drained);
        Assert.Equal(0, connection.QueuedFrameCount);
        Assert.Equal(0, connection.QueuedBytes);
    }

    [Fact]
    public async Task Publisher_UnrelatedRoutesEnterRedisOrderingScopesConcurrently()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var bothLockAttemptsEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseLockAttempts = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        int concurrentLockAttempts = 0;
        int maximumConcurrentLockAttempts = 0;
        database.LockTakeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan>(),
                Arg.Any<CommandFlags>())
            .Returns(async _ =>
            {
                int current = Interlocked.Increment(ref concurrentLockAttempts);
                UpdateMaximum(ref maximumConcurrentLockAttempts, current);
                if (current == 2)
                {
                    bothLockAttemptsEntered.TrySetResult(true);
                }

                await releaseLockAttempts.Task;
                Interlocked.Decrement(ref concurrentLockAttempts);
                return true;
            });
        database.LockReleaseAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        database.StringIncrementAsync(Arg.Any<RedisKey>(), Arg.Any<long>(), Arg.Any<CommandFlags>())
            .Returns(1L, 2L);
        database.StreamAddAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue?>(),
                Arg.Any<int?>(),
                Arg.Any<bool>(),
                Arg.Any<CommandFlags>())
            .Returns((RedisValue)"1-0", (RedisValue)"2-0");
        var store = new NotificationStreamBacklogStore(
            redis,
            keyScope,
            NullLogger<NotificationStreamBacklogStore>.Instance);
        NotificationStreamLocalFanoutQueue fanout = CreateQueue();
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance);
        var publisher = new RedisNotificationStreamPublisher(
            store,
            fanout,
            manager,
            new PolicyTestFrameCodec(),
            NullLogger<RedisNotificationStreamPublisher>.Instance);

        Task first = publisher.PublishAsync(
            NotificationStreamEventType.UnreadCountUpdated,
            1,
            new NotificationStreamUserTarget("account-a"));
        Task second = publisher.PublishAsync(
            NotificationStreamEventType.UnreadCountUpdated,
            2,
            new NotificationStreamUserTarget("account-b"));

        try
        {
            await bothLockAttemptsEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        }
        finally
        {
            releaseLockAttempts.TrySetResult(true);
        }
        await Task.WhenAll(first, second);

        Assert.Equal(2, maximumConcurrentLockAttempts);
        for (int i = 0; i < 2; i++)
        {
            NotificationStreamLocalFanoutWorkItem item = await fanout.DequeueAsync(CancellationToken.None);
            item.Frame.Release();
        }
    }

    [Fact]
    public void BackpressureMetrics_ExposeLowCardinalityQueueAndRecoverySignals()
    {
        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.notification_stream.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<int>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        NotificationStreamDeliveryPolicy policy =
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.UnreadCountUpdated);

        NotificationStreamMetrics.RecordPublishCriticalSectionWait(TimeSpan.FromMilliseconds(2), 1);
        NotificationStreamMetrics.RecordFanoutLaneDepth(policy.Priority, 3, 128, TimeSpan.FromMilliseconds(4));
        NotificationStreamMetrics.RecordFanoutCoalesced(policy);
        NotificationStreamMetrics.RecordFanoutDropped(policy, "lane-frame-budget");
        NotificationStreamMetrics.RecordFanoutExpired(policy, TimeSpan.FromMinutes(3));
        NotificationStreamMetrics.RecordConnectionBackpressure(policy, 4, 256, TimeSpan.FromMilliseconds(8));
        NotificationStreamMetrics.RecordConnectionSendLatency(TimeSpan.FromMilliseconds(5));
        NotificationStreamMetrics.RecordFanoutLatency(
            TimeSpan.FromMilliseconds(3),
            new NotificationStreamUserTarget("metric-target"));
        NotificationStreamMetrics.RecordReplayLiveTransitionGap(TimeSpan.FromMilliseconds(7));
        NotificationStreamMetrics.RecordSlowDisconnect("connection_frame_budget", 10, 11);

        Assert.Contains("fsus.notification_stream.publish_critical_section_wait_ms", measurements);
        Assert.Contains("fsus.notification_stream.publish_lock_scope_count", measurements);
        Assert.Contains("fsus.notification_stream.queue_depth", measurements);
        Assert.Contains("fsus.notification_stream.queue_bytes", measurements);
        Assert.Contains("fsus.notification_stream.queue_oldest_age_ms", measurements);
        Assert.Contains("fsus.notification_stream.fanout_coalesced", measurements);
        Assert.Contains("fsus.notification_stream.fanout_dropped", measurements);
        Assert.Contains("fsus.notification_stream.fanout_expired", measurements);
        Assert.Contains("fsus.notification_stream.connection_resync", measurements);
        Assert.Contains("fsus.notification_stream.send_latency_ms", measurements);
        Assert.Contains("fsus.notification_stream.fanout_latency_ms", measurements);
        Assert.Contains("fsus.notification_stream.replay_live_transition_gap_ms", measurements);
        Assert.Contains("fsus.notification_stream.slow_disconnects", measurements);
    }

    private static NotificationStreamLocalFanoutQueue CreateQueue()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["NotificationStream:LocalFanoutQueueCapacity"] = "12",
                ["NotificationStream:Fanout:LosslessFrameCapacity"] = "4",
                ["NotificationStream:Fanout:StateFrameCapacity"] = "4",
                ["NotificationStream:Fanout:LowFrameCapacity"] = "4",
                ["NotificationStream:Fanout:LosslessByteBudget"] = "4096",
                ["NotificationStream:Fanout:StateByteBudget"] = "4096",
                ["NotificationStream:Fanout:LowByteBudget"] = "4096"
            })
            .Build();
        return new NotificationStreamLocalFanoutQueue(configuration);
    }

    private static void UpdateMaximum(ref int location, int value)
    {
        int current = Volatile.Read(ref location);
        while (value > current)
        {
            int observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    private sealed class PolicyTestFrameCodec : INotificationFrameCodec
    {
        public byte[] EncodeHeartbeatFrame() => [0];

        public SharedNotificationStreamFrame EncodeEventFrame<TPayload>(
            long eventId,
            NotificationStreamEventType eventType,
            TPayload payload)
            => SharedNotificationStreamFrame.FromArray([(byte)eventId, (byte)eventType]);
    }
}

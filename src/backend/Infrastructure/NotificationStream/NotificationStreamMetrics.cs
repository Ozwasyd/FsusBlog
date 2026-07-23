using System.Diagnostics.Metrics;

using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal static class NotificationStreamMetrics
{
    private static readonly Meter s_meter = new("FsusBlog.NotificationStream", "2.0.0");

    private static long s_activeConnections;

    private static readonly Counter<long> s_handshakeFailureCounter = s_meter.CreateCounter<long>("fsus.notification_stream.handshake_failures");
    private static readonly Counter<long> s_heartbeatCounter = s_meter.CreateCounter<long>("fsus.notification_stream.heartbeats");
    private static readonly Counter<long> s_slowDisconnectCounter = s_meter.CreateCounter<long>("fsus.notification_stream.slow_disconnects");
    private static readonly Counter<long> s_replayCounter = s_meter.CreateCounter<long>("fsus.notification_stream.replay_hits");
    private static readonly Counter<long> s_replayMissCounter = s_meter.CreateCounter<long>("fsus.notification_stream.replay_misses");
    private static readonly Counter<long> s_replayDedupedCounter = s_meter.CreateCounter<long>("fsus.notification_stream.replay_deduped_entries");
    private static readonly Counter<long> s_publishFanoutCounter = s_meter.CreateCounter<long>("fsus.notification_stream.publish_fanout");
    private static readonly Counter<long> s_fanoutCoalescedCounter = s_meter.CreateCounter<long>("fsus.notification_stream.fanout_coalesced");
    private static readonly Counter<long> s_fanoutDroppedCounter = s_meter.CreateCounter<long>("fsus.notification_stream.fanout_dropped");
    private static readonly Counter<long> s_fanoutExpiredCounter = s_meter.CreateCounter<long>("fsus.notification_stream.fanout_expired");
    private static readonly Counter<long> s_connectionResyncCounter = s_meter.CreateCounter<long>("fsus.notification_stream.connection_resync");
    private static readonly Histogram<int> s_queueDepthHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.queue_depth");
    private static readonly Histogram<long> s_queueBytesHistogram = s_meter.CreateHistogram<long>("fsus.notification_stream.queue_bytes");
    private static readonly Histogram<double> s_queueOldestAgeHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.queue_oldest_age_ms");
    private static readonly Histogram<double> s_sendLatencyHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.send_latency_ms");
    private static readonly Histogram<double> s_fanoutLatencyHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.fanout_latency_ms");
    private static readonly Histogram<double> s_replayLiveTransitionGapHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.replay_live_transition_gap_ms");
    private static readonly Histogram<double> s_publishCriticalSectionWaitHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.publish_critical_section_wait_ms");
    private static readonly Histogram<int> s_publishLockScopeHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.publish_lock_scope_count");
    private static readonly Histogram<int> s_flushBatchHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.flush_batch_size");
    private static readonly Histogram<double> s_flushDurationHistogram = s_meter.CreateHistogram<double>("fsus.notification_stream.flush_duration_ms");
    private static readonly Histogram<int> s_replayRouteHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.replay_routes");
    private static readonly Histogram<int> s_replayScanHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.replay_scanned_entries");
    private static readonly Histogram<int> s_replayRedisCommandHistogram = s_meter.CreateHistogram<int>("fsus.notification_stream.replay_redis_commands");
    private static readonly Histogram<long> s_publishAllocationEstimateHistogram = s_meter.CreateHistogram<long>("fsus.notification_stream.publish_allocation_estimate_bytes");

    static NotificationStreamMetrics()
    {
        s_meter.CreateObservableGauge("fsus.notification_stream.connections", () => new Measurement<long>(Volatile.Read(ref s_activeConnections)));
    }

    public static void ConnectionOpened() => Interlocked.Increment(ref s_activeConnections);

    public static void ConnectionClosed() => Interlocked.Decrement(ref s_activeConnections);

    public static void RecordHandshakeFailure(string reason)
        => s_handshakeFailureCounter.Add(1, new KeyValuePair<string, object?>("reason", reason));

    public static void RecordHeartbeatSent() => s_heartbeatCounter.Add(1);

    public static void RecordSlowDisconnect(string reason, long lastCursor, long failedEventId)
    {
        s_slowDisconnectCounter.Add(1, new KeyValuePair<string, object?>("reason", reason));
        s_connectionResyncCounter.Add(1, new KeyValuePair<string, object?>("reason", reason));
    }

    public static void RecordQueueDepth(int depth) => s_queueDepthHistogram.Record(depth);

    public static void RecordPublishCriticalSectionWait(TimeSpan wait, int routeLockCount)
    {
        s_publishCriticalSectionWaitHistogram.Record(wait.TotalMilliseconds);
        s_publishLockScopeHistogram.Record(routeLockCount);
    }

    public static void RecordFanoutLaneDepth(
        NotificationStreamPriorityClass priority,
        int depth,
        long bytes,
        TimeSpan oldestAge)
    {
        KeyValuePair<string, object?> lane = new("lane", Lane(priority));
        s_queueDepthHistogram.Record(depth, lane);
        s_queueBytesHistogram.Record(bytes, lane);
        s_queueOldestAgeHistogram.Record(oldestAge.TotalMilliseconds, lane);
    }

    public static void RecordFanoutCoalesced(NotificationStreamDeliveryPolicy policy)
        => s_fanoutCoalescedCounter.Add(1, new KeyValuePair<string, object?>("lane", Lane(policy.Priority)));

    public static void RecordFanoutDropped(NotificationStreamDeliveryPolicy policy, string reason)
        => s_fanoutDroppedCounter.Add(
            1,
            new KeyValuePair<string, object?>("lane", Lane(policy.Priority)),
            new KeyValuePair<string, object?>("reason", reason));

    public static void RecordFanoutExpired(NotificationStreamDeliveryPolicy policy, TimeSpan age)
    {
        s_fanoutExpiredCounter.Add(1, new KeyValuePair<string, object?>("lane", Lane(policy.Priority)));
        s_queueOldestAgeHistogram.Record(age.TotalMilliseconds, new KeyValuePair<string, object?>("lane", Lane(policy.Priority)));
    }

    public static void RecordConnectionQueue(
        NotificationStreamDeliveryPolicy policy,
        int depth,
        long bytes,
        TimeSpan oldestAge)
    {
        KeyValuePair<string, object?> lane = new("lane", Lane(policy.Priority));
        s_queueDepthHistogram.Record(depth, lane);
        s_queueBytesHistogram.Record(bytes, lane);
        s_queueOldestAgeHistogram.Record(oldestAge.TotalMilliseconds, lane);
    }

    public static void RecordConnectionBackpressure(
        NotificationStreamDeliveryPolicy policy,
        int depth,
        long bytes,
        TimeSpan oldestAge)
    {
        RecordConnectionQueue(policy, depth, bytes, oldestAge);
        s_connectionResyncCounter.Add(1, new KeyValuePair<string, object?>("lane", Lane(policy.Priority)));
    }

    public static void RecordConnectionSendLatency(TimeSpan latency)
        => s_sendLatencyHistogram.Record(latency.TotalMilliseconds);

    public static void RecordFanoutLatency(TimeSpan latency, NotificationStreamTarget target)
    {
        string targetType = target switch
        {
            NotificationStreamUserTarget => "user",
            NotificationStreamGroupTarget => "group",
            NotificationStreamMultiUserTarget => "multi_user",
            _ => "unknown"
        };
        s_fanoutLatencyHistogram.Record(
            latency.TotalMilliseconds,
            new KeyValuePair<string, object?>("target", targetType));
    }

    public static void RecordReplayLiveTransitionGap(TimeSpan duration)
        => s_replayLiveTransitionGapHistogram.Record(duration.TotalMilliseconds);

    public static void RecordReplay(
        int hitCount,
        bool missedGap,
        int routeCount = 0,
        int scannedEntries = 0,
        int dedupedEntries = 0,
        int redisCommandCount = 0)
    {
        s_replayRouteHistogram.Record(routeCount);
        s_replayScanHistogram.Record(scannedEntries);
        s_replayRedisCommandHistogram.Record(redisCommandCount);

        if (hitCount > 0)
        {
            s_replayCounter.Add(hitCount);
        }

        if (dedupedEntries > 0)
        {
            s_replayDedupedCounter.Add(dedupedEntries);
        }

        if (missedGap)
        {
            s_replayMissCounter.Add(1);
        }
    }

    public static void RecordPublishFanout(int delivered, NotificationStreamTarget target, long allocationEstimateBytes)
    {
        string targetType = target switch
        {
            NotificationStreamUserTarget => "user",
            NotificationStreamGroupTarget => "group",
            NotificationStreamMultiUserTarget => "multi_user",
            _ => "unknown"
        };

        s_publishFanoutCounter.Add(delivered, new KeyValuePair<string, object?>("target", targetType));
        s_publishAllocationEstimateHistogram.Record(allocationEstimateBytes, new KeyValuePair<string, object?>("target", targetType));
    }

    public static void RecordFlushBatch(int batchSize, TimeSpan duration)
    {
        s_flushBatchHistogram.Record(batchSize);
        s_flushDurationHistogram.Record(duration.TotalMilliseconds);
    }

    private static string Lane(NotificationStreamPriorityClass priority)
        => priority switch
        {
            NotificationStreamPriorityClass.Lossless => "lossless",
            NotificationStreamPriorityClass.State => "state",
            NotificationStreamPriorityClass.Low => "low",
            _ => "unknown"
        };
}

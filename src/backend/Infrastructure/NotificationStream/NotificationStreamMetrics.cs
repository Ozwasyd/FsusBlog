using System.Diagnostics.Metrics;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal static class NotificationStreamMetrics
{
    private static readonly Meter Meter = new("FsusBlog.NotificationStream", "2.0.0");

    private static long _activeConnections;

    private static readonly Counter<long> HandshakeFailureCounter = Meter.CreateCounter<long>("fsus.notification_stream.handshake_failures");
    private static readonly Counter<long> HeartbeatCounter = Meter.CreateCounter<long>("fsus.notification_stream.heartbeats");
    private static readonly Counter<long> SlowDisconnectCounter = Meter.CreateCounter<long>("fsus.notification_stream.slow_disconnects");
    private static readonly Counter<long> ReplayCounter = Meter.CreateCounter<long>("fsus.notification_stream.replay_hits");
    private static readonly Counter<long> ReplayMissCounter = Meter.CreateCounter<long>("fsus.notification_stream.replay_misses");
    private static readonly Counter<long> ReplayDedupedCounter = Meter.CreateCounter<long>("fsus.notification_stream.replay_deduped_entries");
    private static readonly Counter<long> PublishFanoutCounter = Meter.CreateCounter<long>("fsus.notification_stream.publish_fanout");
    private static readonly Histogram<int> QueueDepthHistogram = Meter.CreateHistogram<int>("fsus.notification_stream.queue_depth");
    private static readonly Histogram<int> FlushBatchHistogram = Meter.CreateHistogram<int>("fsus.notification_stream.flush_batch_size");
    private static readonly Histogram<double> FlushDurationHistogram = Meter.CreateHistogram<double>("fsus.notification_stream.flush_duration_ms");
    private static readonly Histogram<int> ReplayRouteHistogram = Meter.CreateHistogram<int>("fsus.notification_stream.replay_routes");
    private static readonly Histogram<int> ReplayScanHistogram = Meter.CreateHistogram<int>("fsus.notification_stream.replay_scanned_entries");
    private static readonly Histogram<int> ReplayRedisCommandHistogram = Meter.CreateHistogram<int>("fsus.notification_stream.replay_redis_commands");
    private static readonly Histogram<long> PublishAllocationEstimateHistogram = Meter.CreateHistogram<long>("fsus.notification_stream.publish_allocation_estimate_bytes");

    static NotificationStreamMetrics()
    {
        Meter.CreateObservableGauge("fsus.notification_stream.connections", () => new Measurement<long>(Volatile.Read(ref _activeConnections)));
    }

    public static void ConnectionOpened() => Interlocked.Increment(ref _activeConnections);

    public static void ConnectionClosed() => Interlocked.Decrement(ref _activeConnections);

    public static void RecordHandshakeFailure(string reason)
        => HandshakeFailureCounter.Add(1, new KeyValuePair<string, object?>("reason", reason));

    public static void RecordHeartbeatSent() => HeartbeatCounter.Add(1);

    public static void RecordSlowDisconnect() => SlowDisconnectCounter.Add(1);

    public static void RecordQueueDepth(int depth) => QueueDepthHistogram.Record(depth);

    public static void RecordReplay(
        int hitCount,
        bool missedGap,
        int routeCount = 0,
        int scannedEntries = 0,
        int dedupedEntries = 0,
        int redisCommandCount = 0)
    {
        ReplayRouteHistogram.Record(routeCount);
        ReplayScanHistogram.Record(scannedEntries);
        ReplayRedisCommandHistogram.Record(redisCommandCount);

        if (hitCount > 0)
        {
            ReplayCounter.Add(hitCount);
        }

        if (dedupedEntries > 0)
        {
            ReplayDedupedCounter.Add(dedupedEntries);
        }

        if (missedGap)
        {
            ReplayMissCounter.Add(1);
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

        PublishFanoutCounter.Add(delivered, new KeyValuePair<string, object?>("target", targetType));
        PublishAllocationEstimateHistogram.Record(allocationEstimateBytes, new KeyValuePair<string, object?>("target", targetType));
    }

    public static void RecordFlushBatch(int batchSize, TimeSpan duration)
    {
        FlushBatchHistogram.Record(batchSize);
        FlushDurationHistogram.Record(duration.TotalMilliseconds);
    }
}

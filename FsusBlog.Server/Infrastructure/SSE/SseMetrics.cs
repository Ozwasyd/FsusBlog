using System.Diagnostics.Metrics;

namespace FsusBlog.Server.Infrastructure.Sse;

internal static class SseMetrics
{
    private static readonly Meter Meter = new("FsusBlog.Sse", "2.0.0");

    private static long _activeConnections;

    private static readonly Counter<long> SlowDisconnectCounter = Meter.CreateCounter<long>("fsus.sse.slow_disconnects");
    private static readonly Counter<long> ReplayCounter = Meter.CreateCounter<long>("fsus.sse.replay_hits");
    private static readonly Counter<long> ReplayMissCounter = Meter.CreateCounter<long>("fsus.sse.replay_misses");
    private static readonly Histogram<int> QueueDepthHistogram = Meter.CreateHistogram<int>("fsus.sse.queue_depth");
    private static readonly Histogram<int> FlushBatchHistogram = Meter.CreateHistogram<int>("fsus.sse.flush_batch_size");
    private static readonly Histogram<double> FlushDurationHistogram = Meter.CreateHistogram<double>("fsus.sse.flush_duration_ms");

    static SseMetrics()
    {
        Meter.CreateObservableGauge("fsus.sse.connections", () => new Measurement<long>(Volatile.Read(ref _activeConnections)));
    }

    public static void ConnectionOpened() => Interlocked.Increment(ref _activeConnections);

    public static void ConnectionClosed() => Interlocked.Decrement(ref _activeConnections);

    public static void RecordSlowDisconnect() => SlowDisconnectCounter.Add(1);

    public static void RecordQueueDepth(int depth) => QueueDepthHistogram.Record(depth);

    public static void RecordReplay(int hitCount, bool missedGap)
    {
        if (hitCount > 0)
        {
            ReplayCounter.Add(hitCount);
        }

        if (missedGap)
        {
            ReplayMissCounter.Add(1);
        }
    }

    public static void RecordFlushBatch(int batchSize, TimeSpan duration)
    {
        FlushBatchHistogram.Record(batchSize);
        FlushDurationHistogram.Record(duration.TotalMilliseconds);
    }
}
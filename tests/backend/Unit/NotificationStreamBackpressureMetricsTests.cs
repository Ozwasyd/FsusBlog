using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamBackpressureMetricsTests
{
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
}

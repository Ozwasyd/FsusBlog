using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.Cache;

internal static class OwnedFrameCacheTelemetry
{
    private static readonly Meter s_meter = new("FsusBlog.Server.OwnedFrameCache", "1.0.0");
    private static readonly Counter<long> s_buildCount = s_meter.CreateCounter<long>("fsus.cache.owned_frame.build.count");
    private static readonly Histogram<long> s_logicalBytes = s_meter.CreateHistogram<long>("fsus.cache.owned_frame.logical_bytes", "By");
    private static readonly Histogram<long> s_capacityBytes = s_meter.CreateHistogram<long>("fsus.cache.owned_frame.capacity_bytes", "By");
    private static readonly Histogram<long> s_capacityOverheadBytes = s_meter.CreateHistogram<long>("fsus.cache.owned_frame.capacity_overhead_bytes", "By");

    internal static void RecordBuild(
        CachePolicyId policyId,
        AedsFrameType frameType,
        int logicalLength,
        int capacity,
        string storageKind)
    {
        TagList tags = default;
        tags.Add("fsus.cache.policy", policyId.ToString());
        tags.Add("fsus.aeds.frame_type", frameType.ToString());
        tags.Add("fsus.cache.frame_class", AedsFrameSensitivity.RequiresClear(frameType) ? "sensitive" : "public-immutable");
        tags.Add("fsus.cache.storage_kind", storageKind);
        s_buildCount.Add(1, tags);
        s_logicalBytes.Record(logicalLength, tags);
        s_capacityBytes.Record(capacity, tags);
        s_capacityOverheadBytes.Record(Math.Max(0, capacity - logicalLength), tags);
    }
}

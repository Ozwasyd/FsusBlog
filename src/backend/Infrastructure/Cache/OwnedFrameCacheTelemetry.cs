using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.Cache;

internal static class OwnedFrameCacheTelemetry
{
    private static readonly Meter Meter = new("FsusBlog.Server.OwnedFrameCache", "1.0.0");
    private static readonly Counter<long> BuildCount = Meter.CreateCounter<long>("fsus.cache.owned_frame.build.count");
    private static readonly Histogram<long> LogicalBytes = Meter.CreateHistogram<long>("fsus.cache.owned_frame.logical_bytes", "By");
    private static readonly Histogram<long> CapacityBytes = Meter.CreateHistogram<long>("fsus.cache.owned_frame.capacity_bytes", "By");
    private static readonly Histogram<long> CapacityOverheadBytes = Meter.CreateHistogram<long>("fsus.cache.owned_frame.capacity_overhead_bytes", "By");

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
        BuildCount.Add(1, tags);
        LogicalBytes.Record(logicalLength, tags);
        CapacityBytes.Record(capacity, tags);
        CapacityOverheadBytes.Record(Math.Max(0, capacity - logicalLength), tags);
    }
}

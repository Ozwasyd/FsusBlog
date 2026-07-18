using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricBatchRequestPod
{
    public readonly int MetricCount;
    public readonly int MetricValueCount;
    public readonly int DimensionCount;
    public readonly Utf8SliceRef PageType;
    public readonly Utf8SliceRef RouteKey;
    public readonly Utf8SliceRef AotSource;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricItemPod
{
    public readonly double Value;
    public readonly long TimestampUnixMs;
    public readonly int MetricValueCount;
    public readonly int DimensionCount;
    public readonly byte HasValue;
    public readonly byte HasTimestamp;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Name;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricValuePod
{
    public readonly double Value;
    public readonly Utf8SliceRef Key;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricDimensionPod
{
    public readonly Utf8SliceRef Key;
    public readonly Utf8SliceRef Value;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricIngestResponsePod
{
    public readonly int AcceptedCount;
    public readonly int RejectedCount;
    public readonly byte Accepted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

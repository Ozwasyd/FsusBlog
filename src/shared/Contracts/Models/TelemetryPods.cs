using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RumMetricBatchRequest</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RumMetricItem</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RumMetricValue</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricValuePod
{
    public readonly double Value;
    public readonly Utf8SliceRef Key;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RumMetricDimension</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricDimensionPod
{
    public readonly Utf8SliceRef Key;
    public readonly Utf8SliceRef Value;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RumMetricIngestResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RumMetricIngestResponsePod
{
    public readonly int AcceptedCount;
    public readonly int RejectedCount;
    public readonly byte Accepted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
}

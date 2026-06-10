using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteRumMetricBatchRequest(RumMetricBatchRequest request, IBufferWriter<byte> destination)
    {
        IReadOnlyList<RumMetricBatchItem> metrics = request.Metrics ?? [];
        int metricValueCount = 0;
        int dimensionCount = 0;
        foreach (RumMetricBatchItem item in metrics)
        {
            metricValueCount += item.Metrics?.Count ?? 0;
            dimensionCount += item.Dimensions?.Count ?? 0;
        }

        var blob = new ArrayBufferWriter<byte>(Math.Max(128, metrics.Count * 32));
        var header = new MutableRumMetricBatchRequestPod
        {
            MetricCount = metrics.Count,
            MetricValueCount = metricValueCount,
            DimensionCount = dimensionCount,
            PageType = PodUtf8Codec.AppendSlice(request.PageType, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob),
            AotSource = PodUtf8Codec.AppendSlice(request.AotSource, blob)
        };

        var itemPods = new List<RumMetricItemPod>(metrics.Count);
        var valuePods = new List<RumMetricValuePod>(metricValueCount);
        var dimensionPods = new List<RumMetricDimensionPod>(dimensionCount);
        foreach (RumMetricBatchItem item in metrics)
        {
            itemPods.Add(CreateRumMetricItemPod(item, blob));
            if (item.Metrics is not null)
            {
                foreach ((string key, double value) in item.Metrics)
                {
                    valuePods.Add(Cast<MutableRumMetricValuePod, RumMetricValuePod>(new MutableRumMetricValuePod
                    {
                        Value = value,
                        Key = PodUtf8Codec.AppendSlice(key, blob)
                    }));
                }
            }

            if (item.Dimensions is not null)
            {
                foreach ((string key, string value) in item.Dimensions)
                {
                    dimensionPods.Add(Cast<MutableRumMetricDimensionPod, RumMetricDimensionPod>(new MutableRumMetricDimensionPod
                    {
                        Key = PodUtf8Codec.AppendSlice(key, blob),
                        Value = PodUtf8Codec.AppendSlice(value, blob)
                    }));
                }
            }
        }

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableRumMetricBatchRequestPod, RumMetricBatchRequestPod>(header));
        foreach (RumMetricItemPod item in itemPods)
        {
            writer.WritePod(item);
        }

        foreach (RumMetricValuePod value in valuePods)
        {
            writer.WritePod(value);
        }

        foreach (RumMetricDimensionPod dimension in dimensionPods)
        {
            writer.WritePod(dimension);
        }

        writer.WriteBytes(blob.WrittenSpan);
    }

    public static byte[] EncodeRumMetricBatchRequest(RumMetricBatchRequest request)
        => EncodeToArray(256 + (request.Metrics?.Count ?? 0) * 96, writer => WriteRumMetricBatchRequest(request, writer));

    public static bool TryDecodeRumMetricBatchRequest(ReadOnlyMemory<byte> source, out RumMetricBatchRequest request)
    {
        request = new RumMetricBatchRequest(string.Empty, string.Empty, string.Empty, []);
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out RumMetricBatchRequestPod header) ||
            header.MetricCount <= 0 ||
            header.MetricCount > RumTelemetryContractLimits.MaxMetricsPerBatch ||
            header.MetricValueCount < 0 ||
            header.DimensionCount < 0 ||
            header.MetricValueCount > header.MetricCount * RumTelemetryContractLimits.MaxMetricValuesPerMetric ||
            header.DimensionCount > header.MetricCount * RumTelemetryContractLimits.MaxDimensionsPerMetric)
        {
            return false;
        }

        var itemPods = new RumMetricItemPod[header.MetricCount];
        int actualMetricValueCount = 0;
        int actualDimensionCount = 0;
        for (int i = 0; i < itemPods.Length; i++)
        {
            if (!reader.TryReadPod(out itemPods[i]) ||
                itemPods[i].MetricValueCount < 0 ||
                itemPods[i].MetricValueCount > RumTelemetryContractLimits.MaxMetricValuesPerMetric ||
                itemPods[i].DimensionCount < 0 ||
                itemPods[i].DimensionCount > RumTelemetryContractLimits.MaxDimensionsPerMetric ||
                itemPods[i].HasValue > 1 ||
                itemPods[i].HasTimestamp > 1)
            {
                return false;
            }

            actualMetricValueCount += itemPods[i].MetricValueCount;
            actualDimensionCount += itemPods[i].DimensionCount;
        }

        if (actualMetricValueCount != header.MetricValueCount || actualDimensionCount != header.DimensionCount)
        {
            return false;
        }

        var valuePods = new RumMetricValuePod[header.MetricValueCount];
        for (int i = 0; i < valuePods.Length; i++)
        {
            if (!reader.TryReadPod(out valuePods[i]))
            {
                return false;
            }
        }

        var dimensionPods = new RumMetricDimensionPod[header.DimensionCount];
        for (int i = 0; i < dimensionPods.Length; i++)
        {
            if (!reader.TryReadPod(out dimensionPods[i]))
            {
                return false;
            }
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> blob) || !reader.IsConsumed ||
            !TryReadRumSlice(header.PageType, blob, RumTelemetryContractLimits.MaxDimensionValueLength, allowEmpty: true, out string pageType) ||
            !TryReadRumSlice(header.RouteKey, blob, RumTelemetryContractLimits.MaxRouteKeyLength, allowEmpty: true, out string routeKey) ||
            !TryReadRumSlice(header.AotSource, blob, RumTelemetryContractLimits.MaxDimensionValueLength, allowEmpty: true, out string aotSource))
        {
            return false;
        }

        var items = new List<RumMetricBatchItem>(header.MetricCount);
        int valueIndex = 0;
        int dimensionIndex = 0;
        foreach (RumMetricItemPod itemPod in itemPods)
        {
            if (!TryReadRumSlice(itemPod.Name, blob, RumTelemetryContractLimits.MaxMetricNameLength, allowEmpty: false, out string name))
            {
                return false;
            }

            Dictionary<string, double>? values = itemPod.MetricValueCount == 0 ? null : new Dictionary<string, double>(itemPod.MetricValueCount, StringComparer.Ordinal);
            for (int i = 0; i < itemPod.MetricValueCount; i++)
            {
                RumMetricValuePod valuePod = valuePods[valueIndex++];
                if (!TryReadRumSlice(valuePod.Key, blob, RumTelemetryContractLimits.MaxDimensionKeyLength, allowEmpty: false, out string key))
                {
                    return false;
                }

                values![key] = valuePod.Value;
            }

            Dictionary<string, string>? dimensions = itemPod.DimensionCount == 0 ? null : new Dictionary<string, string>(itemPod.DimensionCount, StringComparer.Ordinal);
            for (int i = 0; i < itemPod.DimensionCount; i++)
            {
                RumMetricDimensionPod dimensionPod = dimensionPods[dimensionIndex++];
                if (!TryReadRumSlice(dimensionPod.Key, blob, RumTelemetryContractLimits.MaxDimensionKeyLength, allowEmpty: false, out string key) ||
                    !TryReadRumSlice(dimensionPod.Value, blob, RumTelemetryContractLimits.MaxDimensionValueLength, allowEmpty: false, out string value))
                {
                    return false;
                }

                dimensions![key] = value;
            }

            items.Add(new RumMetricBatchItem(
                name,
                itemPod.HasValue == 1 ? itemPod.Value : null,
                itemPod.HasTimestamp == 1 ? DateTimeOffset.FromUnixTimeMilliseconds(itemPod.TimestampUnixMs).UtcDateTime : null,
                values,
                dimensions));
        }

        request = new RumMetricBatchRequest(pageType, routeKey, aotSource, items);
        return true;
    }

    public static void WriteRumMetricIngestResponse(RumMetricIngestResponse response, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableRumMetricIngestResponsePod, RumMetricIngestResponsePod>(new MutableRumMetricIngestResponsePod
        {
            AcceptedCount = response.AcceptedCount,
            RejectedCount = response.RejectedCount,
            Accepted = response.Accepted ? (byte)1 : (byte)0
        }));
    }

    public static byte[] EncodeRumMetricIngestResponse(RumMetricIngestResponse response)
        => EncodeToArray(16, writer => WriteRumMetricIngestResponse(response, writer));

    public static bool TryDecodeRumMetricIngestResponse(ReadOnlyMemory<byte> source, out RumMetricIngestResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out RumMetricIngestResponsePod pod) || pod.Accepted > 1 || !reader.IsConsumed)
        {
            response = new RumMetricIngestResponse(false);
            return false;
        }

        response = new RumMetricIngestResponse(pod.Accepted == 1, pod.AcceptedCount, pod.RejectedCount);
        return true;
    }

    private static RumMetricItemPod CreateRumMetricItemPod(RumMetricBatchItem item, ArrayBufferWriter<byte> blob)
        => Cast<MutableRumMetricItemPod, RumMetricItemPod>(new MutableRumMetricItemPod
        {
            Value = item.Value.GetValueOrDefault(),
            TimestampUnixMs = item.Timestamp.HasValue ? ToRumUnixMs(item.Timestamp.Value) : 0,
            MetricValueCount = item.Metrics?.Count ?? 0,
            DimensionCount = item.Dimensions?.Count ?? 0,
            HasValue = item.Value.HasValue ? (byte)1 : (byte)0,
            HasTimestamp = item.Timestamp.HasValue ? (byte)1 : (byte)0,
            Name = PodUtf8Codec.AppendSlice(item.Name, blob)
        });

    private static bool TryReadRumSlice(in Utf8SliceRef slice, ReadOnlySpan<byte> blob, int maxBytes, bool allowEmpty, out string value)
    {
        value = string.Empty;
        if (slice.Length == 0)
        {
            return allowEmpty;
        }

        if (slice.Length < 0 || slice.Length > maxBytes || slice.Offset < 0 || slice.Offset + slice.Length > blob.Length)
        {
            return false;
        }

        try
        {
            value = PodUtf8Codec.ReadSlice(slice, blob);
            return allowEmpty || value.Length > 0;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    private static long ToRumUnixMs(DateTime value)
    {
        DateTime utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRumMetricBatchRequestPod
    {
        public int MetricCount;
        public int MetricValueCount;
        public int DimensionCount;
        public Utf8SliceRef PageType;
        public Utf8SliceRef RouteKey;
        public Utf8SliceRef AotSource;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRumMetricItemPod
    {
        public double Value;
        public long TimestampUnixMs;
        public int MetricValueCount;
        public int DimensionCount;
        public byte HasValue;
        public byte HasTimestamp;
        public ushort Reserved0;
        public Utf8SliceRef Name;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRumMetricValuePod
    {
        public double Value;
        public Utf8SliceRef Key;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRumMetricDimensionPod
    {
        public Utf8SliceRef Key;
        public Utf8SliceRef Value;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRumMetricIngestResponsePod
    {
        public int AcceptedCount;
        public int RejectedCount;
        public byte Accepted;
        public byte Reserved0;
        public ushort Reserved1;
    }
}

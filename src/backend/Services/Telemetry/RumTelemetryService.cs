using System.Collections.Frozen;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Telemetry;

public interface IRumTelemetryService
{
    Task<RumMetricIngestResponse> IngestAsync(RumMetricRequest request, CancellationToken cancellationToken = default);

    Task<RumMetricIngestResponse> IngestBatchAsync(RumMetricBatchRequest request, CancellationToken cancellationToken = default);
}

public sealed class RumTelemetryService(ISqlSugarClient db) : IRumTelemetryService
{
    public const int MaxFrameBytes = RumTelemetryContractLimits.MaxFrameBytes;

    private static readonly FrozenSet<string> AllowedNames = new[]
    {
        "web_vital_lcp",
        "web_vital_cls",
        "navigation_timing",
        "hydration_time",
        "wasm_decode_timing",
        "markdown_render_timing"
    }.ToFrozenSet(StringComparer.Ordinal);

    private static readonly FrozenSet<string> AllowedPageTypes = new[]
    {
        "home",
        "article",
        "filter",
        "archive",
        "about",
        "public",
        "unknown"
    }.ToFrozenSet(StringComparer.Ordinal);

    private static readonly FrozenSet<string> AllowedAotSources = new[]
    {
        "server-aot",
        "spa",
        "unknown"
    }.ToFrozenSet(StringComparer.Ordinal);

    private static readonly FrozenSet<string> AllowedMetricKeys = new[]
    {
        "value",
        "domInteractive",
        "responseStart",
        "durationMs"
    }.ToFrozenSet(StringComparer.Ordinal);

    private static readonly FrozenDictionary<string, FrozenSet<string>> AllowedDimensionValues = new Dictionary<string, FrozenSet<string>>(StringComparer.Ordinal)
    {
        ["visibility"] = new[] { "visible", "hidden", "prerender", "unknown" }.ToFrozenSet(StringComparer.Ordinal),
        ["renderMode"] = new[] { "server-aot", "spa", "unknown" }.ToFrozenSet(StringComparer.Ordinal),
        ["routeKind"] = new[] { "home", "article", "filter", "archive", "about", "public", "unknown" }.ToFrozenSet(StringComparer.Ordinal)
    }.ToFrozenDictionary(StringComparer.Ordinal);

    public async Task<RumMetricIngestResponse> IngestAsync(RumMetricRequest request, CancellationToken cancellationToken = default)
    {
        RumMetricAuditContext? context = Normalize(request);
        if (context is null)
        {
            return new RumMetricIngestResponse(false, 0, 1);
        }

        var metric = CreateMetricEntity(context, DateTime.UtcNow);

        await db.Insertable(metric).ExecuteCommandAsync(cancellationToken);
        return new RumMetricIngestResponse(true, 1, 0);
    }

    public async Task<RumMetricIngestResponse> IngestBatchAsync(RumMetricBatchRequest request, CancellationToken cancellationToken = default)
    {
        IReadOnlyList<RumMetricBatchItem> items = request.Metrics ?? [];
        if (items.Count is <= 0 or > RumTelemetryContractLimits.MaxMetricsPerBatch ||
            (request.RouteKey?.Length ?? 0) > RumTelemetryContractLimits.MaxRouteKeyLength)
        {
            return new RumMetricIngestResponse(false, 0, Math.Max(items.Count, 1));
        }

        int rejected = 0;
        DateTime createdAt = DateTime.UtcNow;
        var entities = new List<FrontendRumMetric>(items.Count);
        foreach (RumMetricBatchItem item in items)
        {
            if (!IsBatchItemShapeAllowed(item))
            {
                rejected++;
                continue;
            }

            RumMetricAuditContext? context = Normalize(new RumMetricRequest(
                item.Name,
                request.PageType,
                request.AotSource,
                item.Value,
                item.Metrics,
                item.Timestamp));
            if (context is null)
            {
                rejected++;
                continue;
            }

            entities.Add(CreateMetricEntity(context, createdAt));
        }

        if (entities.Count > 0)
        {
            await db.Insertable(entities).ExecuteCommandAsync(cancellationToken);
        }

        return new RumMetricIngestResponse(entities.Count > 0, entities.Count, rejected);
    }

    internal static RumMetricAuditContext? Normalize(RumMetricRequest request)
    {
        if (!AllowedNames.Contains(request.Name))
        {
            return null;
        }

        string pageType = AllowedPageTypes.Contains(request.PageType) ? request.PageType : "public";
        string aotSource = AllowedAotSources.Contains(request.AotSource) ? request.AotSource : "unknown";
        double? value = NormalizeMetricValue(request.Value);
        Dictionary<string, double> metrics = [];

        if (value.HasValue)
        {
            metrics["value"] = value.Value;
        }

        if (request.Metrics is not null)
        {
            foreach ((string key, double metricValue) in request.Metrics)
            {
                if (!AllowedMetricKeys.Contains(key))
                {
                    continue;
                }

                double? normalized = NormalizeMetricValue(metricValue);
                if (normalized.HasValue)
                {
                    metrics[key] = normalized.Value;
                }
            }
        }

        if (metrics.Count == 0)
        {
            return null;
        }

        DateTime timestamp = request.Timestamp?.ToUniversalTime() ?? DateTime.UtcNow;
        DateTime oldest = DateTime.UtcNow.AddHours(-1);
        DateTime newest = DateTime.UtcNow.AddMinutes(5);
        if (timestamp < oldest || timestamp > newest)
        {
            timestamp = DateTime.UtcNow;
        }

        return new RumMetricAuditContext(
            request.Name,
            pageType,
            aotSource,
            value,
            metrics,
            timestamp);
    }

    private static double? NormalizeMetricValue(double? value)
    {
        if (!value.HasValue || !double.IsFinite(value.Value))
        {
            return null;
        }

        return RoundingHelper.Round4(Math.Clamp(value.Value, 0d, 600_000d));
    }

    internal static bool IsBatchItemShapeAllowed(RumMetricBatchItem item)
    {
        if (string.IsNullOrWhiteSpace(item.Name) ||
            item.Name.Length > RumTelemetryContractLimits.MaxMetricNameLength ||
            (item.Metrics?.Count ?? 0) > RumTelemetryContractLimits.MaxMetricValuesPerMetric ||
            (item.Dimensions?.Count ?? 0) > RumTelemetryContractLimits.MaxDimensionsPerMetric)
        {
            return false;
        }

        if (item.Metrics is not null)
        {
            foreach (string key in item.Metrics.Keys)
            {
                if (key.Length > RumTelemetryContractLimits.MaxDimensionKeyLength)
                {
                    return false;
                }
            }
        }

        if (item.Dimensions is null)
        {
            return true;
        }

        foreach ((string key, string value) in item.Dimensions)
        {
            if (!AllowedDimensionValues.TryGetValue(key, out FrozenSet<string>? allowedValues) ||
                key.Length > RumTelemetryContractLimits.MaxDimensionKeyLength ||
                value.Length > RumTelemetryContractLimits.MaxDimensionValueLength ||
                !allowedValues.Contains(value))
            {
                return false;
            }
        }

        return true;
    }

    private static FrontendRumMetric CreateMetricEntity(RumMetricAuditContext context, DateTime createdAt)
        => new()
        {
            Name = context.Name,
            PageType = context.PageType,
            AotSource = context.AotSource,
            Value = context.Value,
            MetricsJson = JsonSerializer.Serialize(context.Metrics, RumTelemetryJsonContext.Default.DictionaryStringDouble),
            OccurredAtUtc = context.Timestamp,
            CreatedAtUtc = createdAt
        };
}

internal sealed record RumMetricAuditContext(
    string Name,
    string PageType,
    string AotSource,
    double? Value,
    Dictionary<string, double> Metrics,
    DateTime Timestamp);

[JsonSerializable(typeof(Dictionary<string, double>))]
internal sealed partial class RumTelemetryJsonContext : JsonSerializerContext;

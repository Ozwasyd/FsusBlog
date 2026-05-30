using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;

namespace FsusBlog.Server.Services.Telemetry;

public sealed class RumTelemetryService(ISqlSugarClient db)
{
    private static readonly HashSet<string> AllowedNames = new(StringComparer.Ordinal)
    {
        "web_vital_lcp",
        "web_vital_cls",
        "navigation_timing",
        "hydration_time",
        "wasm_decode_timing",
        "markdown_render_timing"
    };

    private static readonly HashSet<string> AllowedPageTypes = new(StringComparer.Ordinal)
    {
        "home",
        "article",
        "filter",
        "archive",
        "about",
        "public",
        "unknown"
    };

    private static readonly HashSet<string> AllowedAotSources = new(StringComparer.Ordinal)
    {
        "server-aot",
        "spa",
        "unknown"
    };

    private static readonly HashSet<string> AllowedMetricKeys = new(StringComparer.Ordinal)
    {
        "value",
        "domInteractive",
        "responseStart",
        "durationMs"
    };

    public async Task<RumMetricIngestResponse> IngestAsync(RumMetricRequest request, CancellationToken cancellationToken = default)
    {
        RumMetricAuditContext? context = Normalize(request);
        if (context is null)
        {
            return new RumMetricIngestResponse(false);
        }

        var log = new AuditLog
        {
            Source = AuditSourceCatalog.Frontend,
            Type = AuditTypeCatalog.Performance,
            OccurredAtUtc = context.Timestamp,
            EventInfo = $"rum:{context.Name}",
            ContextPayload = JsonSerializer.SerializeToUtf8Bytes(context)
        };

        await db.Insertable(log).ExecuteCommandAsync(cancellationToken);
        return new RumMetricIngestResponse(true);
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

        return Math.Round(Math.Clamp(value.Value, 0d, 600_000d), 4);
    }
}

internal sealed record RumMetricAuditContext(
    string Name,
    string PageType,
    string AotSource,
    double? Value,
    IReadOnlyDictionary<string, double> Metrics,
    DateTime Timestamp);

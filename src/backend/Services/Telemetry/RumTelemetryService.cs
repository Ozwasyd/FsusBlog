using System.Collections.Frozen;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Telemetry;

public interface IRumTelemetryService
{
    Task<RumMetricIngestResponse> IngestAsync(RumMetricRequest request, CancellationToken cancellationToken = default);

    Task<RumMetricIngestResponse> IngestBatchAsync(RumMetricBatchRequest request, CancellationToken cancellationToken = default);
}

public sealed class RumTelemetryService(RumTelemetryChannel channel) : IRumTelemetryService
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
        var batch = new RumMetricBatchRequest(
            request.PageType,
            request.PageType,
            request.AotSource,
            [
                new RumMetricBatchItem(
                    request.Name,
                    request.Value,
                    request.Timestamp,
                    request.Metrics,
                    null)
            ]);
        return await IngestBatchAsync(batch, cancellationToken);
    }

    public Task<RumMetricIngestResponse> IngestBatchAsync(RumMetricBatchRequest request, CancellationToken cancellationToken = default)
    {
        IReadOnlyList<RumMetricBatchItem> items = request.Metrics ?? [];
        if (items.Count is <= 0 or > RumTelemetryContractLimits.MaxMetricsPerBatch ||
            (request.RouteKey?.Length ?? 0) > RumTelemetryContractLimits.MaxRouteKeyLength)
        {
            channel.RecordRejectedBatch();
            return Task.FromResult(new RumMetricIngestResponse(false, 0, Math.Max(items.Count, 1)));
        }

        int rejected = 0;
        var acceptedItems = new List<RumMetricBatchItem>(items.Count);
        foreach (RumMetricBatchItem item in items)
        {
            if (!IsBatchItemShapeAllowed(item))
            {
                rejected++;
                continue;
            }

            acceptedItems.Add(item);
        }

        if (acceptedItems.Count == 0)
        {
            channel.RecordRejectedBatch();
            return Task.FromResult(new RumMetricIngestResponse(false, 0, rejected));
        }

        RumTelemetryEnqueueResult enqueue = channel.TryEnqueue(request with { Metrics = acceptedItems });
        if (!enqueue.Accepted)
        {
            return Task.FromResult(new RumMetricIngestResponse(false, 0, rejected + acceptedItems.Count));
        }

        return Task.FromResult(new RumMetricIngestResponse(
            true,
            acceptedItems.Count,
            rejected + enqueue.DroppedMetricCount));
    }

    internal static RumTelemetryBuildResult BuildMetricEntities(
        IReadOnlyList<RumMetricBatchRequest> requests,
        DateTime createdAt)
    {
        var entities = new List<FrontendRumMetric>();
        int rejected = 0;
        foreach (RumMetricBatchRequest request in requests)
        {
            IReadOnlyList<RumMetricBatchItem> items = request.Metrics ?? [];
            if (items.Count == 0 || (request.RouteKey?.Length ?? 0) > RumTelemetryContractLimits.MaxRouteKeyLength)
            {
                rejected += Math.Max(items.Count, 1);
                continue;
            }

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
        }

        return new RumTelemetryBuildResult(entities, rejected);
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

public sealed class RumTelemetryChannel
{
    private const int DefaultCapacity = 4096;
    private readonly Channel<RumMetricBatchRequest> channel;
    private readonly object gate = new();
    private readonly int capacity;
    private int queuedBatches;
    private long acceptedBatches;
    private long rejectedBatches;
    private long droppedBatches;
    private long droppedMetrics;

    public RumTelemetryChannel()
        : this(DefaultCapacity)
    {
    }

    public RumTelemetryChannel(int capacity)
    {
        this.capacity = Math.Clamp(capacity, 1, 1_000_000);
        channel = Channel.CreateBounded<RumMetricBatchRequest>(new BoundedChannelOptions(this.capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });
    }

    public RumTelemetryEnqueueResult TryEnqueue(RumMetricBatchRequest request)
    {
        int droppedBatch = 0;
        int droppedMetric = 0;
        lock (gate)
        {
            if (queuedBatches >= capacity)
            {
                if (channel.Reader.TryRead(out RumMetricBatchRequest? dropped))
                {
                    queuedBatches--;
                    droppedBatch = 1;
                    droppedMetric = dropped.Metrics?.Count ?? 0;
                    droppedBatches++;
                    droppedMetrics += droppedMetric;
                }
                else
                {
                    queuedBatches = 0;
                }
            }

            if (!channel.Writer.TryWrite(request))
            {
                if (queuedBatches > 0)
                {
                    queuedBatches--;
                }

                rejectedBatches++;
                return new RumTelemetryEnqueueResult(false, droppedBatch, droppedMetric);
            }

            queuedBatches++;
            acceptedBatches++;
            return new RumTelemetryEnqueueResult(true, droppedBatch, droppedMetric);
        }
    }

    public void RecordRejectedBatch()
        => Interlocked.Increment(ref rejectedBatches);

    public ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
        => channel.Reader.WaitToReadAsync(cancellationToken);

    public bool TryRead(out RumMetricBatchRequest? request)
    {
        lock (gate)
        {
            if (!channel.Reader.TryRead(out request))
            {
                return false;
            }

            if (queuedBatches > 0)
            {
                queuedBatches--;
            }

            return true;
        }
    }

    public RumTelemetryChannelSnapshot CreateSnapshot()
        => new(
            Volatile.Read(ref acceptedBatches),
            Volatile.Read(ref rejectedBatches),
            Volatile.Read(ref droppedBatches),
            Volatile.Read(ref droppedMetrics),
            Volatile.Read(ref queuedBatches));
}

public sealed class RumTelemetryFlushWorker(
    RumTelemetryChannel channel,
    IServiceScopeFactory scopeFactory,
    ILogger<RumTelemetryFlushWorker> logger) : BackgroundService
{
    private const int MaxRequestsPerFlush = 128;
    private static readonly TimeSpan IdleFlushDelay = TimeSpan.FromMilliseconds(250);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await channel.WaitToReadAsync(stoppingToken))
                {
                    break;
                }

                var requests = new List<RumMetricBatchRequest>(MaxRequestsPerFlush);
                while (requests.Count < MaxRequestsPerFlush && channel.TryRead(out RumMetricBatchRequest? request))
                {
                    if (request is not null)
                    {
                        requests.Add(request);
                    }
                }

                if (requests.Count == 0)
                {
                    continue;
                }

                await FlushAsync(requests, stoppingToken);
                await Task.Delay(IdleFlushDelay, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "rum-telemetry-flush-worker-failed");
            }
        }
    }

    internal async Task FlushAsync(IReadOnlyList<RumMetricBatchRequest> requests, CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string result = "ok";
        int accepted = 0;
        int rejected = 0;
        try
        {
            RumTelemetryBuildResult build = RumTelemetryService.BuildMetricEntities(requests, DateTime.UtcNow);
            accepted = build.Entities.Count;
            rejected = build.RejectedCount;
            if (build.Entities.Count == 0)
            {
                result = "empty";
                return;
            }

            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            await db.Insertable(build.Entities).ExecuteCommandAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            result = "failed";
            logger.LogWarning(ex, "rum-telemetry-flush-failed {RequestCount}", requests.Count);
        }
        finally
        {
            FsusObservability.RecordBackgroundJob(
                "rum_telemetry_flush",
                result,
                FsusObservability.GetElapsed(startedAt),
                accepted,
                rejected,
                (int)Math.Min(int.MaxValue, channel.CreateSnapshot().DroppedBatches));
        }
    }
}

public sealed record RumTelemetryEnqueueResult(bool Accepted, int DroppedCount, int DroppedMetricCount);

public sealed record RumTelemetryChannelSnapshot(
    long AcceptedBatches,
    long RejectedBatches,
    long DroppedBatches,
    long DroppedMetrics,
    int QueuedBatches);

internal sealed record RumTelemetryBuildResult(List<FrontendRumMetric> Entities, int RejectedCount);

internal sealed record RumMetricAuditContext(
    string Name,
    string PageType,
    string AotSource,
    double? Value,
    Dictionary<string, double> Metrics,
    DateTime Timestamp);

[JsonSerializable(typeof(Dictionary<string, double>))]
internal sealed partial class RumTelemetryJsonContext : JsonSerializerContext;

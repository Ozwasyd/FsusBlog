using System.Diagnostics;
using System.Text;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.VisitLog;

/// <summary>
/// A single contribution to bounded read aggregates. This transport deliberately
/// has no IP, route, viewer/proof identifier, exact timestamp, or exact dwell time.
/// </summary>
public readonly record struct VisitLogMessage(
    DateTime AggregateHourUtc,
    string EventType,
    int? ArticleId,
    string DwellBucket);

public static class ReadDwellBuckets
{
    public const string Under10Seconds = "lt_10s";
    public const string From10To30Seconds = "10_30s";
    public const string From30To120Seconds = "30_120s";
    public const string Over120Seconds = "gt_120s";

    public static string Classify(int dwellMs)
        => dwellMs switch
        {
            < 10_000 => Under10Seconds,
            < 30_000 => From10To30Seconds,
            < 120_000 => From30To120Seconds,
            _ => Over120Seconds
        };

    public static bool IsKnown(string? value)
        => value is Under10Seconds or From10To30Seconds or From30To120Seconds or Over120Seconds;
}

public class VisitLogChannel
{
    internal const int Capacity = 50_000;

    private readonly Channel<VisitLogMessage> _channel;
    private long _saturatedWriteCount;

    public VisitLogChannel()
    {
        var options = new BoundedChannelOptions(Capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        };
        _channel = Channel.CreateBounded<VisitLogMessage>(options);
    }

    public bool TryWrite(VisitLogMessage message) => TryWrite(message, out _);

    public bool TryWrite(VisitLogMessage message, out bool wasSaturated)
    {
        wasSaturated = _channel.Reader.Count >= Capacity;
        if (wasSaturated)
        {
            Interlocked.Increment(ref _saturatedWriteCount);
        }

        return _channel.Writer.TryWrite(message);
    }

    public long SaturatedWriteCount => Volatile.Read(ref _saturatedWriteCount);

    public int QueuedCount => _channel.Reader.CanCount ? _channel.Reader.Count : 0;

    public ChannelReader<VisitLogMessage> Reader => _channel.Reader;
}

/// <summary>
/// Compacts accepted read contributions directly into article/hour and
/// dwell/day counters. It never creates an event-level database row.
/// </summary>
public class VisitLogProcessorService : BackgroundService
{
    private const int BatchSize = 500;
    internal static readonly TimeSpan s_flushWindow = TimeSpan.FromMilliseconds(200);
    private static readonly long s_flushWindowStopwatchTicks = Math.Max(1, (long)(s_flushWindow.TotalSeconds * Stopwatch.Frequency));

    private readonly VisitLogChannel _channel;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<VisitLogProcessorService> _logger;
    private IArticleViewProjectionService? _articleViewProjectionService;
    private IHotStatsInvalidationCoalescer? _hotStatsInvalidationCoalescer;

    public VisitLogProcessorService(
        VisitLogChannel channel,
        IServiceProvider serviceProvider,
        ILogger<VisitLogProcessorService> logger)
    {
        _channel = channel;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            _serviceProvider,
            "visit_log_flush");
        ReadAggregateFlushServices flushServices = ResolveFlushServices(scope.ServiceProvider);
        var batch = new List<VisitLogMessage>(BatchSize);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (!await _channel.Reader.WaitToReadAsync(stoppingToken).ConfigureAwait(false))
                {
                    break;
                }

                await DrainBatchWithFlushWindowAsync(batch, stoppingToken).ConfigureAwait(false);
                if (batch.Count > 0)
                {
                    await FlushBatchAsync(flushServices, batch, stoppingToken).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            _logger.LogInformation("阅读聚合处理器收到停机信号，准备刷新剩余计数。");
        }
        finally
        {
            while (batch.Count < BatchSize && _channel.Reader.TryRead(out VisitLogMessage message))
            {
                TryProcessSingleMessage(message, batch);
            }

            if (batch.Count > 0)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try
                {
                    await FlushBatchAsync(flushServices, batch, cts.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "停机刷新阅读聚合计数失败，已丢弃剩余内存计数。");
                }
            }
        }
    }

    private ReadAggregateFlushServices ResolveFlushServices(IServiceProvider scopedServices)
    {
        _articleViewProjectionService ??= scopedServices.GetRequiredService<IArticleViewProjectionService>();
        _hotStatsInvalidationCoalescer ??= scopedServices.GetRequiredService<IHotStatsInvalidationCoalescer>();
        return new ReadAggregateFlushServices(
            scopedServices.GetRequiredService<ISqlSugarClient>(),
            scopedServices.GetRequiredService<IDbConcurrencyGate>(),
            _articleViewProjectionService,
            _hotStatsInvalidationCoalescer);
    }

    private async Task DrainBatchWithFlushWindowAsync(List<VisitLogMessage> batch, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        long flushDeadline = 0;
        while (batch.Count < BatchSize)
        {
            while (batch.Count < BatchSize && _channel.Reader.TryRead(out VisitLogMessage message))
            {
                bool wasEmpty = batch.Count == 0;
                TryProcessSingleMessage(message, batch);
                if (wasEmpty && batch.Count > 0)
                {
                    flushDeadline = CreateFlushDeadline();
                }
            }

            if (batch.Count >= BatchSize || batch.Count == 0)
            {
                return;
            }

            if (flushDeadline == 0)
            {
                flushDeadline = CreateFlushDeadline();
            }

            TimeSpan remaining = ResolveFlushWindowRemaining(flushDeadline);
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            ValueTask<bool> read = _channel.Reader.WaitToReadAsync(token);
            if (read.IsCompletedSuccessfully)
            {
                if (!read.Result)
                {
                    return;
                }

                continue;
            }

            Task<bool> readTask = read.AsTask();
            Task delayTask = Task.Delay(remaining);
            Task completed = await Task.WhenAny(readTask, delayTask).ConfigureAwait(false);
            if (completed == delayTask)
            {
                return;
            }

            if (!await readTask.ConfigureAwait(false))
            {
                return;
            }
        }
    }

    private static long CreateFlushDeadline()
        => Stopwatch.GetTimestamp() + s_flushWindowStopwatchTicks;

    private static TimeSpan ResolveFlushWindowRemaining(long flushDeadline)
    {
        long remainingStopwatchTicks = flushDeadline - Stopwatch.GetTimestamp();
        if (remainingStopwatchTicks <= 0)
        {
            return TimeSpan.Zero;
        }

        long remainingTimeSpanTicks = Math.Max(
            1,
            remainingStopwatchTicks * TimeSpan.TicksPerSecond / Stopwatch.Frequency);
        return TimeSpan.FromTicks(remainingTimeSpanTicks);
    }

    private void TryProcessSingleMessage(VisitLogMessage message, List<VisitLogMessage> batch)
    {
        try
        {
            ProcessSingleMessageCore(message, batch);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "处理单条阅读聚合贡献失败，已跳过该条消息。");
        }
    }

    private static void ProcessSingleMessageCore(VisitLogMessage message, List<VisitLogMessage> batch)
    {
        DateTime hour = message.AggregateHourUtc;
        bool alignedUtcHour = hour.Kind == DateTimeKind.Utc
            && hour.Minute == 0
            && hour.Second == 0
            && hour.Millisecond == 0;
        bool articleRead = string.Equals(message.EventType, HumanReadEventTypes.ArticleRead, StringComparison.Ordinal);
        bool siteRead = string.Equals(message.EventType, HumanReadEventTypes.SiteRead, StringComparison.Ordinal);
        if (!alignedUtcHour
            || !ReadDwellBuckets.IsKnown(message.DwellBucket)
            || !articleRead && !siteRead
            || articleRead && message.ArticleId is not > 0
            || siteRead && message.ArticleId is not null)
        {
            return;
        }

        batch.Add(message);
    }

    private async Task FlushBatchAsync(
        ReadAggregateFlushServices services,
        List<VisitLogMessage> batch,
        CancellationToken token)
    {
        Dictionary<int, int> articleCounts = batch
            .Where(static item => item.EventType == HumanReadEventTypes.ArticleRead && item.ArticleId is > 0)
            .GroupBy(static item => item.ArticleId!.Value)
            .ToDictionary(static group => group.Key, static group => group.Count());
        bool hasArticleRead = articleCounts.Count > 0;

        try
        {
            int persisted = await services.DbGate.ExecuteClassifiedAsync(
                DbWorkloadClass.BackgroundProjection,
                "read-aggregate-flush",
                async gateCt =>
                {
                    await PersistAggregatesAsync(services.Db, batch, gateCt).ConfigureAwait(false);
                    return batch.Count;
                },
                _ => Task.FromResult(0),
                token).ConfigureAwait(false);
            if (persisted <= 0)
            {
                return;
            }

            FsusObservability.RecordReadAggregateFlush(persisted);
            if (hasArticleRead)
            {
                try
                {
                    await services.ArticleViewProjection.ApplyAsync(articleCounts, token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "阅读聚合已落库但 article.views 投影失败。");
                }
            }

            await MarkStatsAfterFlushAsync(services.HotStatsInvalidation, hasArticleRead, token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("阅读聚合写入被取消或数据库后台投影门已离线。");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "后台批量写入阅读聚合失败，已丢弃该批内存计数。");
        }
        finally
        {
            batch.Clear();
        }
    }

    internal static async Task PersistAggregatesAsync(
        ISqlSugarClient db,
        IReadOnlyList<VisitLogMessage> batch,
        CancellationToken cancellationToken)
    {
        if (batch.Count == 0)
        {
            return;
        }

        var sql = new StringBuilder("""
            WITH input(article_id, hour_utc, event_type, dwell_bucket, read_count) AS (
                VALUES
            """);
        var parameters = new List<SugarParameter>(batch.Count * 4);
        for (int i = 0; i < batch.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            sql.Append("(CAST(@ArticleId").Append(i)
                .Append(" AS integer), CAST(@HourUtc").Append(i)
                .Append(" AS timestamp), @EventType").Append(i)
                .Append(", @DwellBucket").Append(i)
                .Append(", 1)");
            VisitLogMessage item = batch[i];
            parameters.Add(new SugarParameter($"@ArticleId{i}", item.ArticleId.HasValue ? item.ArticleId.Value : DBNull.Value));
            parameters.Add(new SugarParameter($"@HourUtc{i}", item.AggregateHourUtc));
            parameters.Add(new SugarParameter($"@EventType{i}", item.EventType));
            parameters.Add(new SugarParameter($"@DwellBucket{i}", item.DwellBucket));
        }

        sql.Append("""
            ),
            daily_upsert AS (
                INSERT INTO daily_read_stats(stat_date, total_reads, human_verified_reads, unique_viewer_estimate, updated_at_utc)
                SELECT hour_utc::date, SUM(read_count), SUM(read_count), 0, now() AT TIME ZONE 'utc'
                FROM input
                GROUP BY hour_utc::date
                ON CONFLICT (stat_date) DO UPDATE
                SET total_reads = daily_read_stats.total_reads + EXCLUDED.total_reads,
                    human_verified_reads = daily_read_stats.human_verified_reads + EXCLUDED.human_verified_reads,
                    unique_viewer_estimate = 0,
                    updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING 1
            ),
            event_upsert AS (
                INSERT INTO event_type_read_stats(event_type, read_count, updated_at_utc)
                SELECT event_type, SUM(read_count), now() AT TIME ZONE 'utc'
                FROM input
                GROUP BY event_type
                ON CONFLICT (event_type) DO UPDATE
                SET read_count = event_type_read_stats.read_count + EXCLUDED.read_count,
                    updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING 1
            ),
            article_upsert AS (
                INSERT INTO article_read_hourly_aggregate(article_id, hour_utc, read_count, updated_at_utc)
                SELECT article_id, hour_utc, SUM(read_count), now() AT TIME ZONE 'utc'
                FROM input
                WHERE event_type = 'article_read' AND article_id IS NOT NULL
                GROUP BY article_id, hour_utc
                ON CONFLICT (article_id, hour_utc) DO UPDATE
                SET read_count = article_read_hourly_aggregate.read_count + EXCLUDED.read_count,
                    updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING 1
            ),
            dwell_upsert AS (
                INSERT INTO read_dwell_daily_aggregate(stat_date, dwell_bucket, read_count, updated_at_utc)
                SELECT hour_utc::date, dwell_bucket, SUM(read_count), now() AT TIME ZONE 'utc'
                FROM input
                GROUP BY hour_utc::date, dwell_bucket
                ON CONFLICT (stat_date, dwell_bucket) DO UPDATE
                SET read_count = read_dwell_daily_aggregate.read_count + EXCLUDED.read_count,
                    updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING 1
            )
            SELECT
                (SELECT COUNT(*) FROM daily_upsert)
              + (SELECT COUNT(*) FROM event_upsert)
              + (SELECT COUNT(*) FROM article_upsert)
              + (SELECT COUNT(*) FROM dwell_upsert);
            """);

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(sql.ToString(), parameters.ToArray()).ConfigureAwait(false);
    }

    private async Task MarkStatsAfterFlushAsync(
        IHotStatsInvalidationCoalescer coalescer,
        bool hasArticleRead,
        CancellationToken token)
    {
        try
        {
            await coalescer.MarkStatsDirtyAsync("read-aggregate-flush", token).ConfigureAwait(false);
            if (hasArticleRead)
            {
                await coalescer.MarkHotArticlesDirtyAsync("article-read-projection", token).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "阅读聚合写入后标记统计缓存失败，结果将在 TTL 后自然刷新。");
        }
    }

    private sealed record ReadAggregateFlushServices(
        ISqlSugarClient Db,
        IDbConcurrencyGate DbGate,
        IArticleViewProjectionService ArticleViewProjection,
        IHotStatsInvalidationCoalescer HotStatsInvalidation);
}

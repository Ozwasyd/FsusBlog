using System.Net;
using System.Threading.Channels;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using IP2Location;
using Microsoft.Extensions.ObjectPool;
using SqlSugar;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Services.VisitLog;

public readonly record struct VisitLogMessage(
    string IP,
    int? UserId,
    DateTime CreateTime,
    string EventType,
    string? RouteKey,
    int? ArticleId,
    string? ViewerKeyHash,
    string? ProofId,
    int DwellMs);

public class VisitLogChannel
{
    private const int Capacity = 50000;

    private readonly Channel<VisitLogMessage> _channel;
    private long _saturatedWriteCount;

    public VisitLogChannel()
    {
        // [审查确认] 性能最大化与防 OOM 背压设计：
        // 限制最大队列数为 50000。采用 DropOldest 策略，当数据库宕机或消费端降级时，
        // TryWrite 永远不会阻塞，而是静默丢弃最老的日志，确保 Kestrel 的核心内存绝对安全。
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

    public ChannelReader<VisitLogMessage> Reader => _channel.Reader;
}

public class VisitLogProcessorService : BackgroundService
{
    private const int BatchSize = 500;
    private const int MaxIpLength = 64;
    internal static readonly TimeSpan FlushWindow = TimeSpan.FromMilliseconds(200);

    private readonly VisitLogChannel _channel;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<VisitLogProcessorService> _logger;
    private readonly ObjectPool<Component> _ipPool;

    public VisitLogProcessorService(
        VisitLogChannel channel,
        IServiceProvider serviceProvider,
        ILogger<VisitLogProcessorService> logger,
        ObjectPool<Component> ipPool)
    {
        _channel = channel;
        _serviceProvider = serviceProvider;
        _logger = logger;
        _ipPool = ipPool;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<VisitLogEntity>(BatchSize);
        await BackgroundTaskExecutor.RunAsync(
            async token =>
            {
                while (!token.IsCancellationRequested)
                {
                    if (await _channel.Reader.WaitToReadAsync(token))
                    {
                        await DrainBatchWithFlushWindowAsync(batch, token);

                        if (batch.Count > 0)
                        {
                            await FlushBatchAsync(batch, token);
                        }
                    }
                }
            },
            _logger,
            "visit-log-processor",
            stoppingToken,
            onCancelled: () =>
            {
                _logger.LogWarning("日志批量处理器收到停机信号，准备执行最后一次数据抢救落盘...");
                return Task.CompletedTask;
            },
            onFinally: async () =>
            {
                int pendingCount = _channel.Reader.Count;
                int processed = 0;

                while (processed < pendingCount && _channel.Reader.TryRead(out var msg))
                {
                    TryProcessSingleMessage(msg, batch);
                    processed++;
                }

                if (batch.Count > 0)
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    int rescuedCount = batch.Count;
                    try
                    {
                        await FlushBatchAsync(batch, cts.Token);
                        _logger.LogInformation("已抢救持久化系统停机前遗留的 {Count} 条访问记录。", rescuedCount);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "停机抢救访问日志时发生未预期异常，已降级忽略剩余批次。");
                    }
                }
            });
    }

    private async Task DrainBatchWithFlushWindowAsync(List<VisitLogEntity> batch, CancellationToken token)
    {
        while (batch.Count < BatchSize)
        {
            while (batch.Count < BatchSize && _channel.Reader.TryRead(out var msg))
            {
                TryProcessSingleMessage(msg, batch);
            }

            if (batch.Count >= BatchSize || batch.Count == 0)
            {
                return;
            }

            using var flushCts = CancellationTokenSource.CreateLinkedTokenSource(token);
            flushCts.CancelAfter(FlushWindow);
            try
            {
                if (!await _channel.Reader.WaitToReadAsync(flushCts.Token))
                {
                    return;
                }
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private void TryProcessSingleMessage(VisitLogMessage msg, List<VisitLogEntity> batch)
    {
        try
        {
            ProcessSingleMessageCore(msg, batch);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "处理单条访问日志消息失败，已跳过该条消息。");
        }
    }

    private void ProcessSingleMessageCore(VisitLogMessage msg, List<VisitLogEntity> batch)
    {
        if (string.IsNullOrWhiteSpace(msg.IP))
        {
            return;
        }

        var ip = msg.IP.Length > MaxIpLength ? msg.IP[..MaxIpLength] : msg.IP;
        if (TryClassifyLocalNetwork(ip, out var localRegion))
        {
            batch.Add(new VisitLogEntity
            {
                IP = ip,
                UserId = msg.UserId,
                Region = localRegion,
                CreateTime = msg.CreateTime,
                EventType = NormalizeEventType(msg.EventType),
                RouteKey = NormalizeOptional(msg.RouteKey, 200),
                ArticleId = msg.ArticleId,
                ViewerKeyHash = NormalizeOptional(msg.ViewerKeyHash, 64),
                ProofId = NormalizeOptional(msg.ProofId, 64),
                DwellMs = Math.Max(0, msg.DwellMs)
            });
            return;
        }

        Component? ipObj = null;
        string region;
        try
        {
            ipObj = _ipPool.Get();
            // 注：IP2Location 的 BIN 内存模式查询耗时在 1 纳秒级，属于纯 CPU 寻址，不会引起 I/O 消费雪崩
            var res = ipObj.IPQuery(ip);
            region = CreateRegionString(res);
        }
        finally
        {
            if (ipObj is not null)
            {
                try
                {
                    _ipPool.Return(ipObj);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "归还 IP2Location 对象到对象池失败。");
                }
            }
        }

        batch.Add(new VisitLogEntity
        {
            IP = ip,
            UserId = msg.UserId,
            Region = region,
            CreateTime = msg.CreateTime,
            EventType = NormalizeEventType(msg.EventType),
            RouteKey = NormalizeOptional(msg.RouteKey, 200),
            ArticleId = msg.ArticleId,
            ViewerKeyHash = NormalizeOptional(msg.ViewerKeyHash, 64),
            ProofId = NormalizeOptional(msg.ProofId, 64),
            DwellMs = Math.Max(0, msg.DwellMs)
        });
    }

    private async Task FlushBatchAsync(List<VisitLogEntity> batch, CancellationToken token)
    {
        try
        {
            await using var scope = _serviceProvider.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            var dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
            int inserted = await dbGate.ExecuteAsync(
                "visit-log-flush",
                gateCt => db.Insertable(batch).ExecuteCommandAsync(gateCt),
                _ => Task.FromResult(0),
                token);
            if (inserted > 0)
            {
                try
                {
                    await ApplyArticleViewProjectionAsync(scope.ServiceProvider, batch, token);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "访问日志已落库但阅读量投影失败，后台 reconciliation worker 将从 visit_log 修复 article.views。");
                }

                await InvalidateStatsAfterFlushAsync(scope.ServiceProvider, batch, token);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("写入被取消或熔断：数据库连接池已离线或写入超时。");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "后台批量写入访问日志失败，已丢弃该批次。");
        }
        finally
        {
            batch.Clear();
        }
    }

    private async Task ApplyArticleViewProjectionAsync(
        IServiceProvider scopedServices,
        List<VisitLogEntity> batch,
        CancellationToken token)
    {
        var projectionService = scopedServices.GetRequiredService<IArticleViewProjectionService>();
        await projectionService.ApplyAsync(batch, token);
    }

    private async Task InvalidateStatsAfterFlushAsync(IServiceProvider scopedServices, List<VisitLogEntity> batch, CancellationToken token)
    {
        try
        {
            var cacheInvalidationDispatcher = scopedServices.GetRequiredService<ICacheInvalidationDispatcher>();
            await cacheInvalidationDispatcher.InvalidateStatsAsync(token);
            if (batch.Any(static item => item.EventType == HumanReadEventTypes.ArticleRead))
            {
                await cacheInvalidationDispatcher.InvalidateHotArticlesAsync(token);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "访问日志批量写入后刷新统计缓存失败，统计结果可能等待 TTL 后自然恢复。");
        }
    }

    private static string NormalizeEventType(string? eventType)
        => string.Equals(eventType, HumanReadEventTypes.ArticleRead, StringComparison.Ordinal)
            ? HumanReadEventTypes.ArticleRead
            : HumanReadEventTypes.SiteRead;

    private static string? NormalizeOptional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    internal static bool TryClassifyLocalNetwork(string ip, out string region)
    {
        region = string.Empty;
        if (!IPAddress.TryParse(ip, out var address))
        {
            return false;
        }

        if (IPAddress.IsLoopback(address))
        {
            region = "本地网络";
            return true;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            if (bytes[0] == 10 ||
                bytes[0] == 127 ||
                bytes[0] == 169 && bytes[1] == 254 ||
                bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31 ||
                bytes[0] == 192 && bytes[1] == 168)
            {
                region = bytes[0] == 127 ? "本地网络" : "内网";
                return true;
            }
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            if (address.IsIPv6LinkLocal ||
                address.IsIPv6SiteLocal ||
                (bytes[0] & 0xFE) == 0xFC)
            {
                region = "内网";
                return true;
            }
        }

        return false;
    }

    private static string CreateRegionString(IPResult? res)
    {
        if (res?.Status != "OK") return "未知地区";

        bool hasCountry = !string.IsNullOrEmpty(res.CountryLong) && res.CountryLong != "-";
        bool hasRegion = !string.IsNullOrEmpty(res.Region) && res.Region != "-";
        bool hasCity = !string.IsNullOrEmpty(res.City) && res.City != "-";

        int length = 0;
        if (hasCountry) length += res.CountryLong!.Length;
        if (hasRegion) length += (length > 0 ? 1 : 0) + res.Region!.Length;
        if (hasCity) length += (length > 0 ? 1 : 0) + res.City!.Length;

        if (length == 0) return "未知地区";

        return string.Create(length, (res, hasCountry, hasRegion, hasCity), (span, state) =>
        {
            int currentPos = 0;
            if (state.hasCountry)
            {
                state.res.CountryLong.AsSpan().CopyTo(span);
                currentPos += state.res.CountryLong.Length;
            }
            if (state.hasRegion)
            {
                if (currentPos > 0) span[currentPos++] = '-';
                state.res.Region.AsSpan().CopyTo(span[currentPos..]);
                currentPos += state.res.Region.Length;
            }
            if (state.hasCity)
            {
                if (currentPos > 0) span[currentPos++] = '-';
                state.res.City.AsSpan().CopyTo(span[currentPos..]);
            }
        });
    }
}

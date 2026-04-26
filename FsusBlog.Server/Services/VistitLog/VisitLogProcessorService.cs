using System.Threading.Channels;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using IP2Location;
using Microsoft.Extensions.ObjectPool;
using SqlSugar;

namespace FsusBlog.Server.Services.VistitLog;

public readonly record struct VisitLogMessage(string IP, int? UserId, DateTime CreateTime);

public class VisitLogChannel
{
    private readonly Channel<VisitLogMessage> _channel;

    public VisitLogChannel()
    {
        // [审查确认] 性能最大化与防 OOM 背压设计：
        // 限制最大队列数为 50000。采用 DropOldest 策略，当数据库宕机或消费端降级时，
        // TryWrite 永远不会阻塞，而是静默丢弃最老的日志，确保 Kestrel 的核心内存绝对安全。
        var options = new BoundedChannelOptions(50000)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        };
        _channel = Channel.CreateBounded<VisitLogMessage>(options);
    }

    public bool TryWrite(VisitLogMessage message) => _channel.Writer.TryWrite(message);
    public ChannelReader<VisitLogMessage> Reader => _channel.Reader;
}

public class VisitLogProcessorService : BackgroundService
{
    private const int BatchSize = 500;
    private const int MaxIpLength = 64;

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
        var batch = new List<VisitLog>(BatchSize);
        await BackgroundTaskExecutor.RunAsync(
            async token =>
            {
                while (!token.IsCancellationRequested)
                {
                    if (await _channel.Reader.WaitToReadAsync(token))
                    {
                        while (batch.Count < BatchSize && _channel.Reader.TryRead(out var msg))
                        {
                            TryProcessSingleMessage(msg, batch);
                        }

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

    private void TryProcessSingleMessage(VisitLogMessage msg, List<VisitLog> batch)
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

    private void ProcessSingleMessageCore(VisitLogMessage msg, List<VisitLog> batch)
    {
        if (string.IsNullOrWhiteSpace(msg.IP))
        {
            return;
        }

        var ip = msg.IP.Length > MaxIpLength ? msg.IP[..MaxIpLength] : msg.IP;
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

        batch.Add(new VisitLog
        {
            IP = ip,
            UserId = msg.UserId,
            Region = region,
            CreateTime = msg.CreateTime
        });
    }

    private async Task FlushBatchAsync(List<VisitLog> batch, CancellationToken token)
    {
        try
        {
            await using var scope = _serviceProvider.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            await db.Insertable(batch).ExecuteCommandAsync(token);
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

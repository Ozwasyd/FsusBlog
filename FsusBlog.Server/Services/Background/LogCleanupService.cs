using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

/// <summary>
/// 访问日志自动清理服务（后台定时任务）
///[修改日期 2026-03-01]
/// 修改理由：采用 .NET 现代的 PeriodicTimer 替换 Task.Delay。
///[架构重构 2026-03-01] 
/// 吸收审查建议：彻底废弃单次全表删除。引入分块删除 (Chunked Deletion) 机制，每次仅剔除 5000 条并微睡眠。
/// 物理真相：防止 PostgreSQL MVCC 机制下引发 WAL 日志暴增与磁盘 I/O 瞬间打满，保障线上读写性能平稳。
/// </summary>
public class LogCleanupService(
    IServiceProvider _serviceProvider,
    ILogger<LogCleanupService> _logger) : BackgroundService
{
    private const int ChunkSize = 5000;
    private const int MaxChunksPerCycle = 200;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("【系统】日志清理任务初始化完成。策略：保留30天内数据。");
        using var timer = new PeriodicTimer(TimeSpan.FromDays(1));
        await BackgroundTaskExecutor.RunLoopAsync(
            async token =>
            {
                await CleanupOnceAsync(token);
                return await timer.WaitForNextTickAsync(token);
            },
            _logger,
            "log-cleanup-worker",
            stoppingToken,
            onCancelled: () =>
            {
                _logger.LogWarning("日志清理任务收到停机指令，正在优雅退出循环...");
                return Task.CompletedTask;
            },
            onFaulted: ex =>
            {
                _logger.LogError(ex, "日志清理任务遭遇严重异常而中断。");
                return Task.CompletedTask;
            },
            onFinally: () =>
            {
                _logger.LogInformation("【系统】日志清理任务已安全离线。");
                return Task.CompletedTask;
            });
    }

    internal async Task CleanupOnceAsync(CancellationToken token)
    {
        await using var scope = _serviceProvider.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        var expireDate = DateTime.UtcNow.AddDays(-30);

        _logger.LogDebug("执行计划启动：寻找 {ExpireDate} 之前的日志...", expireDate);

        int totalDeleted = 0;
        int processedChunks = 0;
        while (!token.IsCancellationRequested && processedChunks < MaxChunksPerCycle)
        {
            var ids = await db.Queryable<VisitLog>()
                .Where(it => it.CreateTime < expireDate)
                .Select(it => it.Id)
                .Take(ChunkSize)
                .ToListAsync(token);

            if (ids.Count == 0) break;

            var deletedCount = await db.Deleteable<VisitLog>()
                .In(ids)
                .ExecuteCommandAsync(token);

            totalDeleted += deletedCount;
            processedChunks++;
            await Task.Delay(50, token);
        }

        if (totalDeleted > 0)
        {
            _logger.LogInformation("日志自动清理成功 | 累计分块删除: {Count} 条", totalDeleted);
        }
    }
}

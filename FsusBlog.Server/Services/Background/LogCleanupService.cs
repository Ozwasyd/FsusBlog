using FsusBlog.Server.Entities;
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
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("【系统】日志清理任务初始化完成。策略：保留30天内数据。");

        // 使用物理级的周期计时器，O(1) 的内存分配
        using var timer = new PeriodicTimer(TimeSpan.FromDays(1));

        try
        {
            // 启动时立即执行一次，随后交由定时器接管
            do
            {
                using var scope = _serviceProvider.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                var expireDate = DateTime.UtcNow.AddDays(-30);

                _logger.LogDebug("执行计划启动：寻找 {ExpireDate} 之前的日志...", expireDate);

                int totalDeleted = 0;
                while (!stoppingToken.IsCancellationRequested)
                {
                    // 1. 分块查出要删除的主键 ID
                    var ids = await db.Queryable<VisitLog>()
                        .Where(it => it.CreateTime < expireDate)
                        .Select(it => it.Id)
                        .Take(5000)
                        .ToListAsync(stoppingToken);

                    if (ids.Count == 0) break; // 已清理完毕

                    // 2. 根据 ID 批量删除
                    var deletedCount = await db.Deleteable<VisitLog>()
                        .In(ids)
                        .ExecuteCommandAsync(stoppingToken);

                    totalDeleted += deletedCount;

                    // 3. 微睡眠让步：给 PostgreSQL 的 Autovacuum 进程清理死元组的时间，防止表膨胀
                    await Task.Delay(50, stoppingToken);
                }

                if (totalDeleted > 0)
                {
                    _logger.LogInformation("日志自动清理成功 | 累计分块删除: {Count} 条", totalDeleted);
                }

            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("日志清理任务收到停机指令，正在优雅退出循环...");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "日志清理任务遭遇严重异常而中断。");
        }

        _logger.LogInformation("【系统】日志清理任务已安全离线。");
    }
}
using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// 访问日志自动清理服务（后台定时任务）
/// </summary>
public class LogCleanupService(
    IServiceProvider _serviceProvider,
    ILogger<LogCleanupService> _logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("【系统】日志清理任务初始化完成。策略：保留30天内数据。");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // 1. 创建独立的作用域。
                // 关键：这保证了 Scoped 的数据库上下文在每轮循环结束后会被 Dispose。
                using (var scope = _serviceProvider.CreateScope())
                {
                    var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    var expireDate = DateTime.UtcNow.AddDays(-30);

                    _logger.LogDebug("执行计划启动：寻找 {ExpireDate} 之前的日志...", expireDate);

                    // 2. 执行删除，并传递取消令牌以支持优雅退出
                    var deletedCount = await db.Deleteable<VisitLog>()
                        .Where(it => it.CreateTime < expireDate)
                        .ExecuteCommandAsync(stoppingToken);

                    if (deletedCount > 0)
                    {
                        _logger.LogInformation("日志自动清理成功 | 删除数量: {Count} | 周期: 24h", deletedCount);
                    }
                    else
                    {
                        _logger.LogDebug("本次清理未发现过期数据。");
                    }
                }

                // 3. 正常延迟：主线程挂起，直到 24 小时后或收到停机信号
                await Task.Delay(TimeSpan.FromDays(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // 正常的系统停机流程，无需记录错误
                _logger.LogWarning("日志清理任务收到停机指令，正在优雅退出循环...");
                break;
            }
            catch (Exception ex)
            {
                // 捕获网络波动或数据库异常，确保服务不会因此彻底崩毁
                _logger.LogError(ex, "日志清理任务执行异常。1分钟后尝试自修复重试。");

                try
                {
                    // 故障缓冲：给数据库 1 分钟的恢复时间
                    await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
                }
                catch (OperationCanceledException) { break; }
            }
        }

        _logger.LogInformation("【系统】日志清理任务已安全离线。");
    }
}

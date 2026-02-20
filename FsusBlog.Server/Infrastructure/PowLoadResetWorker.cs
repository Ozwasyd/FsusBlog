using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// PoW 自适应治理器心跳服务 (The Heartbeat)
/// 核心职责：按秒级驱动 Governor 进行流量窗口重置
/// </summary>
public sealed class PowLoadResetWorker(
    AdaptivePowGovernor governor,
    ILogger<PowLoadResetWorker> logger) : BackgroundService
{
    // AdaptivePowGovernor 依赖 RPS (Requests Per Second) 计算
    // 因此这里必须调整为 1秒 触发一次，配合 Governor 内部的 Environment.TickCount64 检查
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("PoW 自适应治理器心跳已启动，采样周期：{Interval}s", Interval.TotalSeconds);

        // 使用 PeriodicTimer 替代 Task.Delay，防止时间漂移
        using var timer = new PeriodicTimer(Interval);

        try
        {
            // ConfigureAwait(false) 避免捕获同步上下文，对于后台任务是微小的性能优化
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                // 1. 驱动治理器重置 RPS 计数器
                // 这是一个极快的 Interlocked 操作，无锁且安全
                governor.Tick();

                // 2. 调试日志 (仅在 Debug 模式下输出，避免生产环境日志爆炸)
                if (logger.IsEnabled(LogLevel.Debug))
                {
                    logger.LogDebug("治理器心跳跳动 | 当前全局难度：{Diff} | RPS 窗口已重置",
                        governor.CurrentGlobalDifficulty);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 响应 stoppingToken，正常离线，无需处理
        }
        catch (Exception ex)
        {
            // 最后的防线：记录关键错误，防止后台服务静默崩溃
            // 虽然 Tick() 内部极少抛出异常，但为了稳健性保留捕获
            logger.LogCritical(ex, "PoW 治理器心跳发生灾难性故障，请检查单例服务状态。");
        }
        finally
        {
            logger.LogInformation("PoW 自适应治理器心跳已安全离线。");
        }
    }
}
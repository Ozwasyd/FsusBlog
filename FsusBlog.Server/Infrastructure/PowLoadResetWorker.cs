using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// PoW 自适应治理器心跳服务 (The Heartbeat)
/// 修复日期: 2026-02-23 (类声明为 partial，引入 [LoggerMessage] 源生成器彻底消除日志参数的装箱与数组堆分配)
/// 核心职责：按秒级驱动 Governor 进行流量窗口重置
/// </summary>
public sealed partial class PowLoadResetWorker(
    AdaptivePowGovernor governor,
    ILogger<PowLoadResetWorker> logger) : BackgroundService
{
    // AdaptivePowGovernor 依赖 RPS (Requests Per Second) 计算
    // 因此这里必须调整为 1秒 触发一次，配合 Governor 内部的 Environment.TickCount64 检查
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        LogHeartbeatStarted(Interval.TotalSeconds);

        // 使用 PeriodicTimer 替代 Task.Delay，防止时间漂移与多余分配
        using var timer = new PeriodicTimer(Interval);

        try
        {
            // ConfigureAwait(false) 避免捕获同步上下文，对于后台任务是微小的性能优化
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                // 1. 驱动治理器重置 RPS 计数器
                // 这是一个极快的 Interlocked 操作，无锁且安全
                governor.Tick();

                // 2. 调试日志 (源生成器配合 IsEnabled 实现绝对零开销)
                if (logger.IsEnabled(LogLevel.Debug))
                {
                    LogHeartbeatTick(governor.CurrentGlobalDifficulty);
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
            LogHeartbeatError(ex);
        }
        finally
        {
            LogHeartbeatStopped();
        }
    }

    // ====================================================================
    // 🚀 高性能日志源生成器声明区 (彻底消灭装箱与 params object[] 分配)
    // ====================================================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Information,
        Message = "PoW 自适应治理器心跳已启动，采样周期：{Interval}s")]
    private partial void LogHeartbeatStarted(double interval);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Debug,
        Message = "治理器心跳跳动 | 当前全局难度：{Difficulty} | RPS 窗口已重置")]
    private partial void LogHeartbeatTick(int difficulty);

    [LoggerMessage(
        EventId = 3,
        Level = LogLevel.Critical,
        Message = "PoW 治理器心跳发生灾难性故障，请检查单例服务状态。")]
    private partial void LogHeartbeatError(Exception ex);

    [LoggerMessage(
        EventId = 4,
        Level = LogLevel.Information,
        Message = "PoW 自适应治理器心跳已安全离线。")]
    private partial void LogHeartbeatStopped();
}
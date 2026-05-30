using FsusBlog.Server.Infrastructure.Execution;
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
        await BackgroundTaskExecutor.RunAsync(
            async token =>
            {
                using var timer = new PeriodicTimer(Interval);
                while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
                {
                    governor.Tick();
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        LogHeartbeatTick(governor.CurrentGlobalDifficulty);
                    }
                }
            },
            logger,
            "pow-load-reset-worker",
            stoppingToken,
            onFaulted: ex =>
            {
                LogHeartbeatError(ex);
                return Task.CompletedTask;
            },
            onFinally: () =>
            {
                LogHeartbeatStopped();
                return Task.CompletedTask;
            });
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

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// Advances the PoW governor's request-rate window once per second under the background-worker lease.
/// </summary>
public sealed partial class PowLoadResetWorker(
    AdaptivePowGovernor governor,
    ILogger<PowLoadResetWorker> logger,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService
{
    // AdaptivePowGovernor 依赖 RPS (Requests Per Second) 计算
    // 因此这里必须调整为 1秒 触发一次，配合 Governor 内部的 Environment.TickCount64 检查
    private static readonly TimeSpan s_interval = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        LogHeartbeatStarted(s_interval.TotalSeconds);
        await BackgroundTaskExecutor.RunAsync(
            async token =>
            {
                using var timer = new PeriodicTimer(s_interval);
                while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
                {
                    await workerLease.TryRunAsLeaderAsync("pow-load-reset-worker",
                            async leaseToken =>
                            {
                                if (activeReleaseCommitGuard is not null)
                                {
                                    await activeReleaseCommitGuard.EnsureCurrentAsync(leaseToken).ConfigureAwait(false);
                                }
                                governor.Tick();
                                if (logger.IsEnabled(LogLevel.Debug))
                                {
                                    LogHeartbeatTick(governor.CurrentGlobalDifficulty);
                                }
                            },
                            token)
                        .ConfigureAwait(false);
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

    // LoggerMessage source-generates typed logging calls without a params object array.

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

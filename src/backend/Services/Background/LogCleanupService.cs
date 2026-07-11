using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
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
    ILogger<LogCleanupService> _logger,
    IBackgroundWorkerLease workerLease,
    TimeProvider timeProvider,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService
{
    private const int ChunkSize = 5000;
    private const int MaxChunksPerCycle = 200;
    private const int VisitLogRetentionDays = 30;
    private const int RumRetentionDays = 14;
    private const int AuditLogRetentionDays = 365;
    private const int AnonymousCredentialIssuanceAuditRetentionDays = 90;
    private static readonly TimeSpan DelayBetweenChunks = TimeSpan.FromMilliseconds(50);
    private const string CleanupVisitLogsSql = """
        WITH expired AS (
            SELECT id
            FROM sys_visit_log
            WHERE createtime < @ExpireDate
            ORDER BY id
            LIMIT @ChunkSize
        )
        DELETE FROM sys_visit_log target
        USING expired
        WHERE target.id = expired.id;
        """;
    private const string CleanupRumMetricsSql = """
        WITH expired AS (
            SELECT id
            FROM frontend_rum_metric
            WHERE occurred_at_utc < @ExpireDate
            ORDER BY id
            LIMIT @ChunkSize
        )
        DELETE FROM frontend_rum_metric target
        USING expired
        WHERE target.id = expired.id;
        """;
    private const string CleanupAuditLogsSql = """
        WITH expired AS (
            SELECT id
            FROM sys_audit_log
            WHERE occurred_at_utc < @ExpireDate
              AND is_high_value = false
              AND severity <> @CriticalSeverity
            ORDER BY id
            LIMIT @ChunkSize
        )
        DELETE FROM sys_audit_log target
        USING expired
        WHERE target.id = expired.id;
        """;
    private const string CleanupAnonymousCredentialIssuanceAuditSql = """
        WITH expired AS (
            SELECT id
            FROM anonymous_credential_issuance_audit
            WHERE created_at_utc < @ExpireDate
            ORDER BY id
            LIMIT @ChunkSize
        )
        DELETE FROM anonymous_credential_issuance_audit target
        USING expired
        WHERE target.id = expired.id;
        """;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("【系统】日志清理任务初始化完成。策略：访问日志保留 {VisitDays} 天，RUM 保留 {RumDays} 天，普通审计保留 {AuditDays} 天。", VisitLogRetentionDays, RumRetentionDays, AuditLogRetentionDays);
        using var timer = new PeriodicTimer(TimeSpan.FromDays(1), timeProvider);
        await BackgroundTaskExecutor.RunLoopAsync(
            async token =>
            {
                await RunCleanupAsLeaderAsync(token);
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

    internal Task<bool> RunCleanupAsLeaderAsync(CancellationToken token)
        => workerLease.TryRunAsLeaderAsync("log-cleanup-worker", CleanupOnceAsync, token);

    internal async Task CleanupOnceAsync(CancellationToken token)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        DateTime visitExpireDate = now.AddDays(-VisitLogRetentionDays);
        DateTime rumExpireDate = now.AddDays(-RumRetentionDays);
        DateTime auditExpireDate = now.AddDays(-AuditLogRetentionDays);
        DateTime anonymousCredentialAuditExpireDate = now.AddDays(-AnonymousCredentialIssuanceAuditRetentionDays);

        _logger.LogDebug("执行计划启动：寻找过期访问/RUM/普通审计日志...");

        Task<int> visitTask = CleanupWithScopedDbAsync(
            (db, scopedToken) => CleanupWithActiveReleaseGuardAsync(db, CleanupVisitLogsSql, visitExpireDate, scopedToken),
            token);
        Task<int> rumTask = CleanupWithScopedDbAsync(
            (db, scopedToken) => CleanupWithActiveReleaseGuardAsync(db, CleanupRumMetricsSql, rumExpireDate, scopedToken),
            token);
        Task<int> auditTask = CleanupWithScopedDbAsync(
            (db, scopedToken) => CleanupWithActiveReleaseGuardAsync(
                db,
                CleanupAuditLogsSql,
                auditExpireDate,
                scopedToken,
                new SugarParameter("@CriticalSeverity", AuditSeverityCatalog.Critical)),
            token);
        Task<int> anonymousCredentialAuditTask = CleanupWithScopedDbAsync(
            (db, scopedToken) => CleanupWithActiveReleaseGuardAsync(
                db,
                CleanupAnonymousCredentialIssuanceAuditSql,
                anonymousCredentialAuditExpireDate,
                scopedToken),
            token);
        await Task.WhenAll(visitTask, rumTask, auditTask, anonymousCredentialAuditTask);

        int visitDeleted = await visitTask;
        int rumDeleted = await rumTask;
        int auditDeleted = await auditTask;
        int anonymousCredentialAuditDeleted = await anonymousCredentialAuditTask;

        if (visitDeleted > 0 || rumDeleted > 0 || auditDeleted > 0 || anonymousCredentialAuditDeleted > 0)
        {
            _logger.LogInformation(
                "日志自动清理成功 | visit={VisitCount} rum={RumCount} audit={AuditCount} anonymousCredentialAudit={AnonymousCredentialAuditCount}",
                visitDeleted,
                rumDeleted,
                auditDeleted,
                anonymousCredentialAuditDeleted);
        }
    }

    private async Task<int> CleanupWithScopedDbAsync(
        Func<ISqlSugarClient, CancellationToken, Task<int>> cleanup,
        CancellationToken token)
    {
        await using var scope = _serviceProvider.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        return await cleanup(db, token);
    }

    private Task<int> CleanupWithActiveReleaseGuardAsync(
        ISqlSugarClient db,
        string sql,
        DateTime expireDate,
        CancellationToken token,
        params SugarParameter[] extraParameters)
    {
        IActiveReleaseCommitGuard commitGuard = activeReleaseCommitGuard
            ?? throw new InvalidOperationException("Active release commit guard is required for the log cleanup worker commit boundary.");
        return CleanupByServerSideLimitCoreAsync(
            db,
            sql,
            expireDate,
            ChunkSize,
            MaxChunksPerCycle,
            DelayBetweenChunks,
            commitGuard,
            token,
            extraParameters);
    }

    internal static Task<int> CleanupVisitLogsAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        CancellationToken token)
        => CleanupVisitLogsAsync(db, expireDate, ChunkSize, MaxChunksPerCycle, DelayBetweenChunks, token);

    internal static Task<int> CleanupVisitLogsAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupVisitLogsSql,
            expireDate,
            chunkSize,
            maxChunks,
            delayBetweenChunks,
            token);

    internal static Task<int> CleanupRumMetricsAsync(ISqlSugarClient db, DateTime expireDate, CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupRumMetricsSql,
            expireDate,
            ChunkSize,
            MaxChunksPerCycle,
            DelayBetweenChunks,
            token);

    internal static Task<int> CleanupRumMetricsAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupRumMetricsSql,
            expireDate,
            chunkSize,
            maxChunks,
            delayBetweenChunks,
            token);

    internal static Task<int> CleanupAuditLogsAsync(ISqlSugarClient db, DateTime expireDate, CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupAuditLogsSql,
            expireDate,
            ChunkSize,
            MaxChunksPerCycle,
            DelayBetweenChunks,
            token,
            new SugarParameter("@CriticalSeverity", AuditSeverityCatalog.Critical));

    internal static Task<int> CleanupAuditLogsAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupAuditLogsSql,
            expireDate,
            chunkSize,
            maxChunks,
            delayBetweenChunks,
            token,
            new SugarParameter("@CriticalSeverity", AuditSeverityCatalog.Critical));

    internal static async Task<int> CleanupAnonymousCredentialIssuanceAuditAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        CancellationToken token)
    {
        return await CleanupByServerSideLimitAsync(
            db,
            CleanupAnonymousCredentialIssuanceAuditSql,
            expireDate,
            ChunkSize,
            MaxChunksPerCycle,
            DelayBetweenChunks,
            token);
    }

    internal static Task<int> CleanupAnonymousCredentialIssuanceAuditAsync(
        ISqlSugarClient db,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        CancellationToken token)
        => CleanupByServerSideLimitAsync(
            db,
            CleanupAnonymousCredentialIssuanceAuditSql,
            expireDate,
            chunkSize,
            maxChunks,
            delayBetweenChunks,
            token);

    private static async Task<int> CleanupByServerSideLimitAsync(
        ISqlSugarClient db,
        string sql,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        CancellationToken token,
        params SugarParameter[] extraParameters)
        => await CleanupByServerSideLimitCoreAsync(
            db,
            sql,
            expireDate,
            chunkSize,
            maxChunks,
            delayBetweenChunks,
            null,
            token,
            extraParameters).ConfigureAwait(false);

    private static async Task<int> CleanupByServerSideLimitCoreAsync(
        ISqlSugarClient db,
        string sql,
        DateTime expireDate,
        int chunkSize,
        int maxChunks,
        TimeSpan delayBetweenChunks,
        IActiveReleaseCommitGuard? commitGuard,
        CancellationToken token,
        params SugarParameter[] extraParameters)
    {
        ArgumentNullException.ThrowIfNull(db);
        if (chunkSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(chunkSize), "Cleanup chunk size must be positive.");
        }

        if (maxChunks <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxChunks), "Cleanup max chunks must be positive.");
        }

        int totalDeleted = 0;
        int processedChunks = 0;
        SugarParameter[] parameters = BuildCleanupParameters(expireDate, chunkSize, extraParameters);
        while (!token.IsCancellationRequested && processedChunks < maxChunks)
        {
            token.ThrowIfCancellationRequested();
            if (commitGuard is not null)
            {
                await commitGuard.EnsureCurrentAsync(token).ConfigureAwait(false);
            }

            int deletedCount = await db.Ado.ExecuteCommandAsync(sql, parameters)
                .ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (deletedCount == 0)
            {
                break;
            }

            totalDeleted += deletedCount;
            processedChunks++;
            if (delayBetweenChunks > TimeSpan.Zero)
            {
                await Task.Delay(delayBetweenChunks, token);
            }
        }

        return totalDeleted;
    }

    private static SugarParameter[] BuildCleanupParameters(
        DateTime expireDate,
        int chunkSize,
        SugarParameter[] extraParameters)
    {
        var parameters = new SugarParameter[2 + extraParameters.Length];
        parameters[0] = new SugarParameter("@ExpireDate", expireDate);
        parameters[1] = new SugarParameter("@ChunkSize", chunkSize);
        for (int i = 0; i < extraParameters.Length; i++)
        {
            SugarParameter source = extraParameters[i];
            parameters[i + 2] = new SugarParameter(source.ParameterName, source.Value);
        }

        return parameters;
    }
}

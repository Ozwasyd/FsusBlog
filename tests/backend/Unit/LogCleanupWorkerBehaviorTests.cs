using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Background;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LogCleanupWorkerBehaviorTests
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-25T12:00:00Z");

    [Fact]
    public async Task RunCleanupAsLeaderAsync_GrantedLeaseUsesInjectedClockForEveryRetentionTarget()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var cutoffs = new ConcurrentDictionary<string, DateTime>(StringComparer.Ordinal);
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(call =>
            {
                string sql = call.ArgAt<string>(0);
                SugarParameter[] parameters = call.ArgAt<SugarParameter[]>(1);
                DateTime cutoff = Assert.IsType<DateTime>(
                    Assert.Single(parameters, parameter => parameter.ParameterName == "@ExpireDate").Value);
                cutoffs[ResolveTarget(sql)] = cutoff;
                return Task.FromResult(0);
            });

        await using ServiceProvider services = new ServiceCollection()
            .AddScoped(_ => db)
            .BuildServiceProvider();
        var lease = new RecordingLease(allowRun: true);
        var worker = new LogCleanupService(
            services,
            NullLogger<LogCleanupService>.Instance,
            lease,
            new FixedTimeProvider(BaselineNow),
            new AllowCurrentReleaseCommitGuard());

        bool ran = await worker.RunCleanupAsLeaderAsync(CancellationToken.None);

        Assert.True(ran);
        Assert.Equal("log-cleanup-worker", lease.WorkerName);
        Assert.Equal(1, lease.ActionExecutions);
        Assert.Equal(BaselineNow.UtcDateTime.AddDays(-30), cutoffs["visit"]);
        Assert.Equal(BaselineNow.UtcDateTime.AddDays(-14), cutoffs["rum"]);
        Assert.Equal(BaselineNow.UtcDateTime.AddDays(-365), cutoffs["audit"]);
        Assert.Equal(BaselineNow.UtcDateTime.AddDays(-90), cutoffs["anonymous-credential-audit"]);
    }

    [Fact]
    public async Task CleanupVisitLogsAsync_MaxChunksStopsFurtherBatches()
    {
        var db = Substitute.For<ISqlSugarClient>();
        int calls = 0;
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref calls);
                return Task.FromResult(1);
            });

        int deleted = await LogCleanupService.CleanupVisitLogsAsync(
            db,
            BaselineNow.UtcDateTime,
            chunkSize: 1,
            maxChunks: 3,
            delayBetweenChunks: TimeSpan.Zero,
            CancellationToken.None);

        Assert.Equal(3, deleted);
        Assert.Equal(3, calls);
    }

    [Fact]
    public async Task CleanupVisitLogsAsync_MidBatchCancellationPropagates()
    {
        var db = Substitute.For<ISqlSugarClient>();
        using var cancellation = new CancellationTokenSource();
        int calls = 0;
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref calls);
                cancellation.Cancel();
                return Task.FromResult(1);
            });

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            LogCleanupService.CleanupVisitLogsAsync(
                db,
                BaselineNow.UtcDateTime,
                chunkSize: 1,
                maxChunks: 10,
                delayBetweenChunks: TimeSpan.Zero,
                cancellation.Token));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task CleanupVisitLogsAsync_SingleBatchFailurePropagates()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var failure = new InvalidOperationException("database unavailable");
        int calls = 0;
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ =>
            {
                Interlocked.Increment(ref calls);
                return Task.FromException<int>(failure);
            });

        InvalidOperationException thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            LogCleanupService.CleanupVisitLogsAsync(
                db,
                BaselineNow.UtcDateTime,
                chunkSize: 10,
                maxChunks: 10,
                delayBetweenChunks: TimeSpan.Zero,
                CancellationToken.None));

        Assert.Same(failure, thrown);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task RunCleanupAsLeaderAsync_LeaseDeniedSkipsCleanup()
    {
        await using ServiceProvider services = new ServiceCollection().BuildServiceProvider();
        var lease = new RecordingLease(allowRun: false);
        var worker = new LogCleanupService(
            services,
            NullLogger<LogCleanupService>.Instance,
            lease,
            new FixedTimeProvider(BaselineNow));

        bool ran = await worker.RunCleanupAsLeaderAsync(CancellationToken.None);

        Assert.False(ran);
        Assert.Equal("log-cleanup-worker", lease.WorkerName);
        Assert.Equal(0, lease.ActionExecutions);
    }

    private static string ResolveTarget(string sql)
    {
        if (sql.Contains("sys_visit_log", StringComparison.Ordinal)) return "visit";
        if (sql.Contains("frontend_rum_metric", StringComparison.Ordinal)) return "rum";
        if (sql.Contains("sys_audit_log", StringComparison.Ordinal)) return "audit";
        if (sql.Contains("anonymous_credential_issuance_audit", StringComparison.Ordinal)) return "anonymous-credential-audit";
        throw new Xunit.Sdk.XunitException("Unknown cleanup target.");
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class AllowCurrentReleaseCommitGuard : IActiveReleaseCommitGuard
    {
        public Task EnsureCurrentAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task EnsureCurrentAsync(
            ActiveReleaseExecutionTicket ticket,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class RecordingLease(bool allowRun) : IBackgroundWorkerLease
    {
        public string? WorkerName { get; private set; }
        public int ActionExecutions { get; private set; }

        public async Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
        {
            WorkerName = workerName;
            if (!allowRun)
            {
                return false;
            }

            ActionExecutions++;
            await action(cancellationToken);
            return true;
        }
    }
}

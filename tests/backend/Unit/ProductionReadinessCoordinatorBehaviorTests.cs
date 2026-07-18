using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ProductionReadinessCoordinatorBehaviorTests
{
    [Fact]
    public async Task RunAsync_StartsEveryIndependentProbeBeforeWaitingForCompletion()
    {
        int started = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<ProductionReadinessAsyncResults> run = ProductionReadinessAsyncCoordinator.RunAsync(
            ct => ControlledAsync(new ProductionDependencyHealthCheck("ok", 1), ct),
            ct => ControlledAsync(new RedisReadiness(new ProductionDependencyHealthCheck("ok", 2), new RedisConsumeOnceReadiness(true)), ct),
            async (redisTask, ct) =>
            {
                Interlocked.Increment(ref started);
                await release.Task.WaitAsync(ct);
                _ = await redisTask;
                return HealthyRiskControl();
            },
            ct => ControlledAsync(new RuntimeHealthSnapshot("ok", null, 0, 8, null, null, null, null), ct),
            CancellationToken.None);

        await WaitUntilAsync(() => Volatile.Read(ref started) == 4);

        Assert.False(run.IsCompleted);
        release.SetResult();
        ProductionReadinessAsyncResults result = await run;
        Assert.Equal("ok", result.Postgres.Status);
        Assert.Equal("ok", result.Redis.Dependency.Status);
        Assert.Equal("ok", result.RiskControl.Status);
        Assert.Equal("ok", result.Runtime.Status);

        async Task<T> ControlledAsync<T>(T value, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref started);
            await release.Task.WaitAsync(cancellationToken);
            return value;
        }
    }

    [Fact]
    public async Task RunAsync_CancellationReachesAllRunningProbes()
    {
        int started = 0;
        int cancelled = 0;
        using var cancellation = new CancellationTokenSource();
        Task<ProductionReadinessAsyncResults> run = ProductionReadinessAsyncCoordinator.RunAsync(
            ct => WaitForCancellationAsync<ProductionDependencyHealthCheck>(ct),
            ct => WaitForCancellationAsync<RedisReadiness>(ct),
            (redisTask, ct) => WaitForCancellationAsync<ProductionRiskControlHealthCheck>(ct),
            ct => WaitForCancellationAsync<RuntimeHealthSnapshot>(ct),
            cancellation.Token);
        await WaitUntilAsync(() => Volatile.Read(ref started) == 4);

        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        Assert.Equal(4, Volatile.Read(ref cancelled));

        async Task<T> WaitForCancellationAsync<T>(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref started);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new InvalidOperationException("probe unexpectedly completed");
            }
            catch (OperationCanceledException)
            {
                Interlocked.Increment(ref cancelled);
                throw;
            }
        }
    }

    [Fact]
    public async Task RunAsync_ReturnsEveryFailedAndDegradedProbeResult()
    {
        var postgres = new ProductionDependencyHealthCheck("failed", Error: "postgres_unavailable");
        var redis = new RedisReadiness(
            new ProductionDependencyHealthCheck("failed", Error: "redis_unavailable"),
            new RedisConsumeOnceReadiness(false));
        ProductionRiskControlHealthCheck risk = HealthyRiskControl() with
        {
            Status = "failed",
            RedisConsumeOnce = false,
            Error = "risk_control_dependency_unavailable"
        };
        var runtime = new RuntimeHealthSnapshot("degraded", null, 4, 2, null, null, null, null);

        ProductionReadinessAsyncResults result = await ProductionReadinessAsyncCoordinator.RunAsync(
            _ => Task.FromResult(postgres),
            _ => Task.FromResult(redis),
            (_, _) => Task.FromResult(risk),
            _ => Task.FromResult(runtime),
            CancellationToken.None);

        Assert.Equal("postgres_unavailable", result.Postgres.Error);
        Assert.Equal("redis_unavailable", result.Redis.Dependency.Error);
        Assert.False(result.Redis.ConsumeOnce.Ok);
        Assert.Equal("risk_control_dependency_unavailable", result.RiskControl.Error);
        Assert.Equal("degraded", result.Runtime.Status);
    }

    private static ProductionRiskControlHealthCheck HealthyRiskControl()
        => new(
            "ok",
            ActivePolicy: true,
            LastKnownGoodPolicy: true,
            RedisConsumeOnce: true,
            ChallengeProviderRegistry: true,
            PolicyVersion: "test-v1",
            Providers: ["sha256-pow"],
            PerceptionAeadKey: true,
            PerceptionMode: "enforced",
            PerceptionPerformanceBudget: FsusObservability.CreateSecurityChallengeV2PerformanceBudgetSnapshot());

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (int attempt = 0; attempt < 200 && !condition(); attempt++)
        {
            await Task.Yield();
        }

        Assert.True(condition(), "controlled readiness probes did not all start");
    }
}

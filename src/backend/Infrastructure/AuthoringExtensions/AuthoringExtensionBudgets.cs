using System.Collections.Concurrent;
using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringBudgetStatus
{
    Completed = 0,
    Rejected = 1,
    Breached = 2,
    Crashed = 3,
    Cancelled = 4
}

public sealed record AuthoringResourceBudget(
    TimeSpan MaximumCpuTime,
    TimeSpan MaximumWallTime,
    long MaximumMemoryBytes,
    long MaximumInboundBytes,
    long MaximumOutboundBytes,
    int MaximumConcurrency,
    int MaximumQueueDepth,
    int MaximumRestarts,
    long MaximumNetworkBytes,
    long MaximumFileBytes,
    long MaximumStateBytes);

public sealed record AuthoringResourceMeasurement(
    TimeSpan CpuTime,
    long MemoryBytes,
    long InboundBytes,
    long OutboundBytes,
    int Restarts,
    long NetworkBytes,
    long FileBytes,
    long StateBytes);

public sealed record AuthoringBudgetIdentity(
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContributionId,
    string DocumentId,
    string RequestId,
    long LifecycleGeneration,
    string PolicyDigest);

public sealed record AuthoringBudgetTelemetry(
    AuthoringBudgetIdentity Identity,
    AuthoringBudgetStatus Status,
    string StableReason,
    long WallMilliseconds,
    long CpuMilliseconds,
    long PeakMemoryBytes,
    long InboundBytes,
    long OutboundBytes,
    int Restarts,
    long NetworkBytes,
    long FileBytes,
    long StateBytes,
    DateTimeOffset RecordedAt);

public sealed record AuthoringBudgetResult<T>(
    AuthoringBudgetStatus Status,
    T? Value,
    string StableReason,
    AuthoringBudgetTelemetry Telemetry);

public interface IAuthoringResourceMeasurementSource
{
    ValueTask<AuthoringResourceMeasurement> MeasureAsync(
        AuthoringBudgetIdentity identity,
        CancellationToken cancellationToken);
}

public interface IAuthoringBudgetedRuntimeOperation<T>
{
    ValueTask<T> ExecuteAsync(CancellationToken cancellationToken);
}

public interface IAuthoringExtensionContainment
{
    ValueTask QuarantineAsync(
        AuthoringBudgetIdentity identity,
        string reason,
        CancellationToken cancellationToken);
}

public interface IAuthoringBudgetTelemetrySink
{
    ValueTask RecordAsync(AuthoringBudgetTelemetry telemetry, CancellationToken cancellationToken);
}

public interface IAuthoringCoreContinuityProbe
{
    ValueTask<bool> IsCoreAvailableAsync(CancellationToken cancellationToken);
}

public sealed class AuthoringExtensionBudgetSupervisor(
    IAuthoringResourceMeasurementSource measurements,
    IAuthoringExtensionContainment containment,
    IAuthoringBudgetTelemetrySink telemetrySink,
    IAuthoringCoreContinuityProbe coreContinuity,
    TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<string, BudgetGate> _gates = new(StringComparer.Ordinal);

    public async ValueTask<AuthoringBudgetResult<T>> ExecuteAsync<T>(
        AuthoringBudgetIdentity identity,
        AuthoringResourceBudget budget,
        IAuthoringBudgetedRuntimeOperation<T> operation,
        CancellationToken cancellationToken = default)
    {
        Validate(identity, budget);
        BudgetGate gate = _gates.GetOrAdd(identity.RuntimeIdentity, _ => new BudgetGate(budget.MaximumConcurrency));
        if (!gate.TryQueue(budget.MaximumQueueDepth))
        {
            return await CompleteAsync<T>(
                identity,
                AuthoringBudgetStatus.Rejected,
                "queue-budget-exceeded",
                default,
                TimeSpan.Zero,
                new AuthoringResourceMeasurement(default, 0, 0, 0, 0, 0, 0, 0),
                cancellationToken);
        }

        try
        {
            await gate.EnterAsync(cancellationToken);
        }
        catch
        {
            gate.CancelAdmission();
            throw;
        }

        var stopwatch = Stopwatch.StartNew();
        AuthoringResourceMeasurement before = await measurements.MeasureAsync(identity, cancellationToken);
        using var wallLimit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        wallLimit.CancelAfter(budget.MaximumWallTime);
        T? value = default;
        AuthoringBudgetStatus status;
        string reason;
        try
        {
            value = await operation.ExecuteAsync(wallLimit.Token);
            status = AuthoringBudgetStatus.Completed;
            reason = "completed";
        }
        catch (OperationCanceledException) when (wallLimit.IsCancellationRequested)
        {
            status = cancellationToken.IsCancellationRequested
                ? AuthoringBudgetStatus.Cancelled
                : AuthoringBudgetStatus.Breached;
            reason = cancellationToken.IsCancellationRequested ? "cancelled" : "wall-time-budget-exceeded";
        }
        catch
        {
            status = AuthoringBudgetStatus.Crashed;
            reason = "runtime-crashed";
        }
        finally
        {
            stopwatch.Stop();
            gate.Exit();
        }

        AuthoringResourceMeasurement after = await measurements.MeasureAsync(identity, CancellationToken.None);
        if (status == AuthoringBudgetStatus.Completed)
        {
            reason = FindBreach(before, after, stopwatch.Elapsed, budget) ?? reason;
            if (reason != "completed")
            {
                status = AuthoringBudgetStatus.Breached;
                value = default;
            }
        }

        if (status is AuthoringBudgetStatus.Breached or AuthoringBudgetStatus.Crashed)
        {
            await containment.QuarantineAsync(identity, reason, CancellationToken.None);
            if (!await coreContinuity.IsCoreAvailableAsync(CancellationToken.None))
            {
                throw new AuthoringExtensionContractException("Extension failure crossed the core continuity boundary.");
            }
        }

        return await CompleteAsync(
            identity,
            status,
            reason,
            value,
            stopwatch.Elapsed,
            after,
            cancellationToken);
    }

    public static AuthoringResourceBudget FromManifest(
        AuthoringResourceLimits limits,
        TimeSpan maximumCpuTime,
        int maximumRestarts,
        long maximumNetworkBytes,
        long maximumFileBytes,
        long maximumStateBytes) => new(
            maximumCpuTime,
            limits.WallClock,
            limits.MemoryBytes,
            limits.MaximumRequestBytes,
            limits.MaximumResponseBytes,
            limits.MaximumConcurrentCalls,
            limits.MaximumQueueDepth,
            maximumRestarts,
            maximumNetworkBytes,
            maximumFileBytes,
            maximumStateBytes);

    private async ValueTask<AuthoringBudgetResult<T>> CompleteAsync<T>(
        AuthoringBudgetIdentity identity,
        AuthoringBudgetStatus status,
        string reason,
        T? value,
        TimeSpan wall,
        AuthoringResourceMeasurement measurement,
        CancellationToken cancellationToken)
    {
        var telemetry = new AuthoringBudgetTelemetry(
            identity,
            status,
            reason,
            (long)wall.TotalMilliseconds,
            (long)measurement.CpuTime.TotalMilliseconds,
            measurement.MemoryBytes,
            measurement.InboundBytes,
            measurement.OutboundBytes,
            measurement.Restarts,
            measurement.NetworkBytes,
            measurement.FileBytes,
            measurement.StateBytes,
            timeProvider.GetUtcNow());
        await telemetrySink.RecordAsync(telemetry, cancellationToken);
        return new AuthoringBudgetResult<T>(status, value, reason, telemetry);
    }

    private static string? FindBreach(
        AuthoringResourceMeasurement before,
        AuthoringResourceMeasurement after,
        TimeSpan wall,
        AuthoringResourceBudget budget)
    {
        if (after.CpuTime - before.CpuTime > budget.MaximumCpuTime)
            return "cpu-budget-exceeded";
        if (wall > budget.MaximumWallTime)
            return "wall-time-budget-exceeded";
        if (after.MemoryBytes > budget.MaximumMemoryBytes)
            return "memory-budget-exceeded";
        if (after.InboundBytes - before.InboundBytes > budget.MaximumInboundBytes)
            return "inbound-budget-exceeded";
        if (after.OutboundBytes - before.OutboundBytes > budget.MaximumOutboundBytes)
            return "outbound-budget-exceeded";
        if (after.Restarts - before.Restarts > budget.MaximumRestarts)
            return "restart-budget-exceeded";
        if (after.NetworkBytes - before.NetworkBytes > budget.MaximumNetworkBytes)
            return "network-budget-exceeded";
        if (after.FileBytes - before.FileBytes > budget.MaximumFileBytes)
            return "file-budget-exceeded";
        if (after.StateBytes > budget.MaximumStateBytes)
            return "state-budget-exceeded";
        return null;
    }

    private static void Validate(AuthoringBudgetIdentity identity, AuthoringResourceBudget budget)
    {
        if (identity.RuntimeIdentity.Length != 64 || identity.PackageSha256.Length != 64 ||
            identity.PolicyDigest.Length != 64 || string.IsNullOrWhiteSpace(identity.ExtensionId) ||
            string.IsNullOrWhiteSpace(identity.ContributionId) || string.IsNullOrWhiteSpace(identity.RequestId) ||
            identity.LifecycleGeneration < 1 ||
            budget.MaximumCpuTime <= TimeSpan.Zero || budget.MaximumWallTime <= TimeSpan.Zero ||
            budget.MaximumMemoryBytes < 1 || budget.MaximumInboundBytes < 1 || budget.MaximumOutboundBytes < 1 ||
            budget.MaximumConcurrency is < 1 or > 32 || budget.MaximumQueueDepth is < 0 or > 1024 ||
            budget.MaximumRestarts is < 0 or > 16 || budget.MaximumNetworkBytes < 0 ||
            budget.MaximumFileBytes < 0 || budget.MaximumStateBytes < 0)
        {
            throw new AuthoringExtensionContractException("Resource budget or identity is missing, unbounded, or invalid.");
        }
    }

    private sealed class BudgetGate(int maximumConcurrency)
    {
        private readonly Lock _lock = new();
        private readonly SemaphoreSlim _semaphore = new(maximumConcurrency, maximumConcurrency);
        private int _admitted;

        public bool TryQueue(int maximumQueueDepth)
        {
            lock (_lock)
            {
                if (_admitted >= maximumQueueDepth + maximumConcurrency)
                {
                    return false;
                }

                _admitted++;
                return true;
            }
        }

        public ValueTask EnterAsync(CancellationToken cancellationToken) =>
            new(_semaphore.WaitAsync(cancellationToken));

        public void CancelAdmission()
        {
            lock (_lock)
            {
                _admitted--;
            }
        }

        public void Exit()
        {
            _semaphore.Release();
            lock (_lock)
            {
                _admitted--;
            }
        }
    }
}

public sealed class AuthoringLifecycleBudgetContainment(
    AuthoringExtensionLifecycleResources lifecycleResources) : IAuthoringExtensionContainment
{
    public ValueTask QuarantineAsync(
        AuthoringBudgetIdentity identity,
        string reason,
        CancellationToken cancellationToken) =>
        lifecycleResources.QuarantineAsync(
            identity.ExtensionId,
            identity.LifecycleGeneration,
            reason,
            cancellationToken);
}

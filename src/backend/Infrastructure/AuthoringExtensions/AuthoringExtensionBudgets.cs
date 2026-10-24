using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

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

public sealed record AuthoringBudgetTelemetryIdentity(
    string RuntimeIdentity,
    string ExtensionId,
    string ExtensionVersion,
    string PackageSha256,
    string ContributionId,
    string DocumentIdentityDigest,
    string RequestIdentityDigest,
    long LifecycleGeneration,
    string PolicyDigest);

public sealed record AuthoringBudgetTelemetry(
    AuthoringBudgetTelemetryIdentity Identity,
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
        BudgetGate gate = _gates.GetOrAdd(
            identity.RuntimeIdentity,
            _ => new BudgetGate(identity.PolicyDigest, budget.MaximumConcurrency, budget.MaximumQueueDepth));
        gate.RequirePolicy(identity.PolicyDigest, budget.MaximumConcurrency, budget.MaximumQueueDepth);
        if (!gate.TryQueue())
        {
            return await CompleteAsync<T>(
                identity,
                AuthoringBudgetStatus.Rejected,
                "queue-budget-exceeded",
                default,
                TimeSpan.Zero,
                new AuthoringResourceMeasurement(default, 0, 0, 0, 0, 0, 0, 0),
                CancellationToken.None);
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
        AuthoringResourceMeasurement before;
        try
        {
            before = await measurements.MeasureAsync(identity, cancellationToken);
        }
        catch
        {
            stopwatch.Stop();
            gate.Exit();
            await containment.QuarantineAsync(
                identity,
                "measurement-authority-failed",
                CancellationToken.None);
            if (!await coreContinuity.IsCoreAvailableAsync(CancellationToken.None))
            {
                throw new AuthoringExtensionContractException(
                    "Extension failure crossed the core continuity boundary.");
            }

            return await CompleteAsync<T>(
                identity,
                AuthoringBudgetStatus.Breached,
                "measurement-authority-failed",
                default,
                stopwatch.Elapsed,
                new AuthoringResourceMeasurement(default, 0, 0, 0, 0, 0, 0, 0),
                CancellationToken.None);
        }

        string? admissionBreach = FindAdmissionBreach(before, budget);
        if (admissionBreach is not null)
        {
            stopwatch.Stop();
            gate.Exit();
            await containment.QuarantineAsync(identity, admissionBreach, CancellationToken.None);
            if (!await coreContinuity.IsCoreAvailableAsync(CancellationToken.None))
            {
                throw new AuthoringExtensionContractException(
                    "Extension failure crossed the core continuity boundary.");
            }

            return await CompleteAsync<T>(
                identity,
                AuthoringBudgetStatus.Breached,
                admissionBreach,
                default,
                stopwatch.Elapsed,
                before,
                CancellationToken.None);
        }

        using var wallLimit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        wallLimit.CancelAfter(budget.MaximumWallTime);
        using var monitorStop = new CancellationTokenSource();
        Task<(string? Breach, AuthoringResourceMeasurement LastMeasurement)> monitor = MonitorAsync(
            identity,
            before,
            budget,
            stopwatch,
            wallLimit,
            monitorStop.Token);
        T? value = default;
        bool operationReturned = false;
        AuthoringBudgetStatus status;
        string reason;
        try
        {
            value = await operation.ExecuteAsync(wallLimit.Token);
            operationReturned = true;
            wallLimit.Token.ThrowIfCancellationRequested();
            status = AuthoringBudgetStatus.Completed;
            reason = "completed";
        }
        catch (OperationCanceledException) when (wallLimit.IsCancellationRequested)
        {
            status = cancellationToken.IsCancellationRequested
                ? AuthoringBudgetStatus.Cancelled
                : AuthoringBudgetStatus.Breached;
            reason = cancellationToken.IsCancellationRequested ? "cancelled" : "wall-time-budget-exceeded";
            value = default;
        }
        catch
        {
            status = AuthoringBudgetStatus.Crashed;
            reason = "runtime-crashed";
        }
        finally
        {
            monitorStop.Cancel();
            stopwatch.Stop();
            gate.Exit();
        }

        (string? liveBreach, AuthoringResourceMeasurement lastMeasurement) = await monitor;
        AuthoringResourceMeasurement after;
        try
        {
            after = await measurements.MeasureAsync(identity, CancellationToken.None);
        }
        catch
        {
            after = before;
            status = AuthoringBudgetStatus.Breached;
            reason = "measurement-authority-failed";
            value = default;
        }
        string? measurementFailure = FindMeasurementFailure(lastMeasurement, after);
        if (measurementFailure is not null)
        {
            status = AuthoringBudgetStatus.Breached;
            reason = measurementFailure;
            value = default;
        }
        else if (status == AuthoringBudgetStatus.Completed ||
            operationReturned && status == AuthoringBudgetStatus.Cancelled)
        {
            string? measuredBreach = liveBreach ?? FindBreach(before, after, stopwatch.Elapsed, budget);
            if (measuredBreach is not null)
            {
                status = AuthoringBudgetStatus.Breached;
                reason = measuredBreach;
                value = default;
            }
        }
        else if (liveBreach is not null)
        {
            status = AuthoringBudgetStatus.Breached;
            reason = liveBreach;
            value = default;
        }

        if (status == AuthoringBudgetStatus.Completed && cancellationToken.IsCancellationRequested)
        {
            status = AuthoringBudgetStatus.Cancelled;
            reason = "cancelled";
            value = default;
        }

        if (status is AuthoringBudgetStatus.Breached or AuthoringBudgetStatus.Crashed)
        {
            await containment.QuarantineAsync(identity, reason, CancellationToken.None);
            if (!await coreContinuity.IsCoreAvailableAsync(CancellationToken.None))
            {
                throw new AuthoringExtensionContractException("Extension failure crossed the core continuity boundary.");
            }
        }

        AuthoringBudgetResult<T> result = await CompleteAsync(
            identity,
            status,
            reason,
            value,
            stopwatch.Elapsed,
            after,
            CancellationToken.None);
        if (result.Status == AuthoringBudgetStatus.Completed)
        {
            cancellationToken.ThrowIfCancellationRequested();
        }

        return result;
    }

    public static AuthoringResourceBudget FromManifest(AuthoringResourceLimits limits) => new(
        limits.MaximumCpuTime,
        limits.WallClock,
        limits.MemoryBytes,
        limits.MaximumRequestBytes,
        limits.MaximumResponseBytes,
        limits.MaximumConcurrentCalls,
        limits.MaximumQueueDepth,
        limits.MaximumRestarts,
        limits.MaximumNetworkBytes,
        limits.MaximumFileBytes,
        limits.MaximumStateBytes);

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
            new AuthoringBudgetTelemetryIdentity(
                identity.RuntimeIdentity,
                identity.ExtensionId,
                identity.ExtensionVersion,
                identity.PackageSha256,
                identity.ContributionId,
                Digest(identity.DocumentId),
                Digest(identity.RequestId),
                identity.LifecycleGeneration,
                identity.PolicyDigest),
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

    private static string Digest(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string? FindBreach(
        AuthoringResourceMeasurement before,
        AuthoringResourceMeasurement after,
        TimeSpan wall,
        AuthoringResourceBudget budget)
    {
        string? measurementFailure = FindMeasurementFailure(before, after);
        if (measurementFailure is not null)
            return measurementFailure;
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

    private static string? FindAdmissionBreach(
        AuthoringResourceMeasurement measurement,
        AuthoringResourceBudget budget)
    {
        if (!IsValidMeasurement(measurement))
            return "measurement-authority-failed";
        if (measurement.MemoryBytes > budget.MaximumMemoryBytes)
            return "memory-budget-exceeded";
        if (measurement.Restarts > budget.MaximumRestarts)
            return "restart-budget-exceeded";
        if (measurement.NetworkBytes > budget.MaximumNetworkBytes)
            return "network-budget-exceeded";
        if (measurement.FileBytes > budget.MaximumFileBytes)
            return "file-budget-exceeded";
        if (measurement.StateBytes > budget.MaximumStateBytes)
            return "state-budget-exceeded";
        return null;
    }

    private static bool IsValidMeasurement(AuthoringResourceMeasurement measurement) =>
        measurement.CpuTime >= TimeSpan.Zero && measurement.MemoryBytes >= 0 &&
        measurement.InboundBytes >= 0 && measurement.OutboundBytes >= 0 &&
        measurement.Restarts >= 0 && measurement.NetworkBytes >= 0 &&
        measurement.FileBytes >= 0 && measurement.StateBytes >= 0;

    private static string? FindMeasurementFailure(
        AuthoringResourceMeasurement before,
        AuthoringResourceMeasurement after)
    {
        if (!IsValidMeasurement(before) || !IsValidMeasurement(after) ||
            after.CpuTime < before.CpuTime || after.InboundBytes < before.InboundBytes ||
            after.OutboundBytes < before.OutboundBytes || after.Restarts < before.Restarts ||
            after.NetworkBytes < before.NetworkBytes || after.FileBytes < before.FileBytes)
        {
            return "measurement-authority-failed";
        }

        return null;
    }

    private async Task<(string? Breach, AuthoringResourceMeasurement LastMeasurement)> MonitorAsync(
        AuthoringBudgetIdentity identity,
        AuthoringResourceMeasurement before,
        AuthoringResourceBudget budget,
        Stopwatch stopwatch,
        CancellationTokenSource executionCancellation,
        CancellationToken cancellationToken)
    {
        AuthoringResourceMeasurement previous = before;
        try
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(50), timeProvider, cancellationToken);
                AuthoringResourceMeasurement current = await measurements.MeasureAsync(identity, cancellationToken);
                string? reason = FindMeasurementFailure(previous, current);
                if (reason is null)
                {
                    previous = current;
                    reason = FindBreach(before, current, stopwatch.Elapsed, budget);
                }

                if (reason is not null)
                {
                    await executionCancellation.CancelAsync();
                    return (reason, previous);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return (null, previous);
        }
        catch
        {
            await executionCancellation.CancelAsync();
            return ("measurement-authority-failed", previous);
        }
    }

    private static void Validate(AuthoringBudgetIdentity identity, AuthoringResourceBudget budget)
    {
        if (!IsDigest(identity.RuntimeIdentity) || !IsDigest(identity.PackageSha256) ||
            !IsDigest(identity.PolicyDigest) || !IsBounded(identity.ExtensionId) ||
            !IsBounded(identity.ExtensionVersion) || !IsBounded(identity.ContributionId) ||
            !IsBounded(identity.DocumentId) || !IsBounded(identity.RequestId) ||
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

    private static bool IsDigest(string? value) =>
        value is { Length: 64 } && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsBounded(string? value) =>
        value is { Length: > 0 and <= AuthoringExtensionContractValidator.MaximumIdentifierLength } &&
        !string.IsNullOrWhiteSpace(value) &&
        !value.Any(char.IsControl);

    private sealed class BudgetGate(
        string policyDigest,
        int maximumConcurrency,
        int maximumQueueDepth)
    {
        private readonly Lock _lock = new();
        private readonly SemaphoreSlim _semaphore = new(maximumConcurrency, maximumConcurrency);
        private int _admitted;

        public void RequirePolicy(string candidatePolicyDigest, int candidateConcurrency, int candidateQueueDepth)
        {
            if (!string.Equals(policyDigest, candidatePolicyDigest, StringComparison.Ordinal) ||
                maximumConcurrency != candidateConcurrency || maximumQueueDepth != candidateQueueDepth)
            {
                throw new AuthoringExtensionContractException(
                    "Runtime budget gate is already bound to a different policy.");
            }
        }

        public bool TryQueue()
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

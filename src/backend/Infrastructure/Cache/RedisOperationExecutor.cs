using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Testing;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Cache;

public enum RedisOperationFailureKind : byte
{
    ConnectionUnavailable = 0,
    CommandTimeout = 1,
    CircuitOpen = 2,
    RedisFailure = 3
}

public sealed class RedisOperationUnavailableException(
    RedisOperationPortDefinition port,
    RedisOperationBudget budget,
    RedisOperationFailureKind failureKind,
    Exception? innerException = null)
    : Exception($"redis_operation_unavailable:{port.Id}:{budget.FailAction}:{failureKind}", innerException)
{
    public RedisOperationPortDefinition Port { get; } = port;

    public RedisOperationBudget Budget { get; } = budget;

    public RedisOperationFailureKind FailureKind { get; } = failureKind;
}

public interface IRedisConnectionProvider
{
    Task<IConnectionMultiplexer> WaitAsync();
}

public interface IRedisOperationExecutor
{
    Task<T> ExecuteAsync<T>(
        RedisOperationPort port,
        Func<IConnectionMultiplexer, CancellationToken, Task<T>> command,
        CancellationToken cancellationToken);

    Task ExecuteAsync(
        RedisOperationPort port,
        Func<IConnectionMultiplexer, CancellationToken, Task> command,
        CancellationToken cancellationToken);
}

public sealed class RedisOperationExecutor(
    IRedisConnectionProvider connectionProvider,
    RedisOperationBudgetCatalog catalog,
    TimeProvider timeProvider) : IRedisOperationExecutor
{
    private static readonly Meter s_meter = new("FsusBlog.Server.RedisOperations", "1.0.0");
    private static readonly Counter<long> s_commandCount = s_meter.CreateCounter<long>("fsus.redis.command.count");
    private static readonly Histogram<double> s_queueTime = s_meter.CreateHistogram<double>("fsus.redis.queue_time", "ms");
    private static readonly Histogram<double> s_serverTime = s_meter.CreateHistogram<double>("fsus.redis.server_time", "ms");
    private static readonly Histogram<double> s_endToEndTime = s_meter.CreateHistogram<double>("fsus.redis.end_to_end_time", "ms");
    private static readonly Counter<long> s_timeoutCount = s_meter.CreateCounter<long>("fsus.redis.timeout.count");
    private static readonly Counter<long> s_cancelCount = s_meter.CreateCounter<long>("fsus.redis.cancel.count");
    private static readonly Counter<long> s_fallbackCount = s_meter.CreateCounter<long>("fsus.redis.fallback.count");
    private static readonly Histogram<int> s_circuitState = s_meter.CreateHistogram<int>("fsus.redis.circuit.state");

    private readonly int[] _consecutiveFailures = new int[Enum.GetValues<RedisOperationClass>().Length];
    private readonly long[] _openUntilTimestamp = new long[Enum.GetValues<RedisOperationClass>().Length];
    private long _diagnosticIdentity;
    internal long DiagnosticIdentity => Volatile.Read(ref _diagnosticIdentity);
    private readonly SemaphoreSlim[] _operationSlots = Enum.GetValues<RedisOperationClass>()
        .Select(operationClass =>
        {
            int maxConcurrency = catalog.Get(operationClass).MaxConcurrency;
            return new SemaphoreSlim(maxConcurrency, maxConcurrency);
        })
        .ToArray();

    internal static IRedisOperationExecutor ForTestConnection(
        IConnectionMultiplexer connection,
        TimeProvider? timeProvider = null)
        => new RedisOperationExecutor(
            new ImmediateConnectionProvider(connection),
            new RedisOperationBudgetCatalog(),
            timeProvider ?? TimeProvider.System);

    public async Task<T> ExecuteAsync<T>(
        RedisOperationPort port,
        Func<IConnectionMultiplexer, CancellationToken, Task<T>> command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        RedisOperationPortDefinition definition = catalog.Get(port);
        RedisOperationBudget budget = catalog.Get(definition.OperationClass);
        int circuitIndex = (int)definition.OperationClass;
        long startedAt = Stopwatch.GetTimestamp();
        TagList tags = CreateTags(definition, budget);
        RedisOperationDiagnosticCall diagnosticCall = RedisOperationFailureDiagnostics.Begin(ref _diagnosticIdentity, startedAt);

        if (IsCircuitOpen(circuitIndex))
        {
            ObserveFailure(diagnosticCall, definition, budget, RedisOperationDiagnosticStage.CircuitEntry,
                0, RedisOperationFailureKind.CircuitOpen, RedisOperationDiagnosticDisposition.Rejected, null);
            s_circuitState.Record(1, tags);
            s_fallbackCount.Add(1, tags);
            throw CreateUnavailableException(
                definition,
                budget,
                RedisOperationFailureKind.CircuitOpen);
        }

        s_circuitState.Record(0, tags);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(budget.EndToEndDeadline);
        SemaphoreSlim operationSlots = _operationSlots[circuitIndex];
        bool slotAcquired = false;
        long queueStartedAt = Stopwatch.GetTimestamp();

        try
        {
            try
            {
                await operationSlots.WaitAsync(deadline.Token).ConfigureAwait(false);
                slotAcquired = true;
            }
            catch (OperationCanceledException exception) when (cancellationToken.IsCancellationRequested)
            {
                ObserveFailure(diagnosticCall, definition, budget, RedisOperationDiagnosticStage.Queue,
                    0, null, RedisOperationDiagnosticDisposition.CallerCancellation, exception);
                s_cancelCount.Add(1, tags);
                s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                throw;
            }
            catch (OperationCanceledException exception) when (deadline.IsCancellationRequested)
            {
                ObserveFailure(diagnosticCall, definition, budget, RedisOperationDiagnosticStage.Queue,
                    0, RedisOperationFailureKind.CommandTimeout, RedisOperationDiagnosticDisposition.Terminal, exception);
                s_queueTime.Record(Stopwatch.GetElapsedTime(queueStartedAt).TotalMilliseconds, tags);
                s_timeoutCount.Add(1, tags);
                OpenCircuitAfterFailure(circuitIndex, budget);
                s_fallbackCount.Add(1, tags);
                s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                throw CreateUnavailableException(
                    definition,
                    budget,
                    RedisOperationFailureKind.CommandTimeout,
                    exception);
            }

            s_queueTime.Record(Stopwatch.GetElapsedTime(queueStartedAt).TotalMilliseconds, tags);
            if (IsCircuitOpen(circuitIndex))
            {
                ObserveFailure(diagnosticCall, definition, budget, RedisOperationDiagnosticStage.CircuitAfterQueue,
                    0, RedisOperationFailureKind.CircuitOpen, RedisOperationDiagnosticDisposition.Rejected, null);
                s_circuitState.Record(1, tags);
                s_fallbackCount.Add(1, tags);
                throw CreateUnavailableException(
                    definition,
                    budget,
                    RedisOperationFailureKind.CircuitOpen);
            }

            int attempts = definition.Idempotent ? budget.RetryCount + 1 : 1;
            Exception? lastFailure = null;
            for (int attempt = 0; attempt < attempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                RedisOperationDiagnosticStage diagnosticStage = RedisOperationDiagnosticStage.Connection;
                try
                {
                    IConnectionMultiplexer multiplexer = await connectionProvider
                        .WaitAsync()
                        .WaitAsync(budget.ConnectDeadline, deadline.Token)
                        .ConfigureAwait(false);

                    long commandStartedAt = Stopwatch.GetTimestamp();
                    diagnosticStage = RedisOperationDiagnosticStage.Command;
                    s_commandCount.Add(1, tags);
                    Task<T> pending = command(multiplexer, deadline.Token);
                    T result = await pending
                        .WaitAsync(budget.CommandDeadline, deadline.Token)
                        .ConfigureAwait(false);
                    s_serverTime.Record(Stopwatch.GetElapsedTime(commandStartedAt).TotalMilliseconds, tags);
                    s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                    Interlocked.Exchange(ref _consecutiveFailures[circuitIndex], 0);
                    return result;
                }
                catch (OperationCanceledException exception) when (cancellationToken.IsCancellationRequested)
                {
                    ObserveFailure(diagnosticCall, definition, budget, diagnosticStage,
                        attempt + 1, null, RedisOperationDiagnosticDisposition.CallerCancellation, exception);
                    s_cancelCount.Add(1, tags);
                    s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                    throw;
                }
                catch (Exception exception) when (IsOperationFailure(exception, deadline.Token))
                {
                    lastFailure = exception;
                    bool timedOut = exception is TimeoutException
                        || exception is RedisTimeoutException
                        || deadline.IsCancellationRequested;
                    if (timedOut)
                    {
                        s_timeoutCount.Add(1, tags);
                    }

                    if (attempt + 1 < attempts && IsRetryable(exception))
                    {
                        ObserveFailure(diagnosticCall, definition, budget, diagnosticStage,
                            attempt + 1, timedOut ? RedisOperationFailureKind.CommandTimeout : null,
                            RedisOperationDiagnosticDisposition.Retry, exception);
                        continue;
                    }

                    ObserveFailure(diagnosticCall, definition, budget, diagnosticStage,
                        attempt + 1, timedOut ? RedisOperationFailureKind.CommandTimeout : null,
                        RedisOperationDiagnosticDisposition.Terminal, exception);
                    OpenCircuitAfterFailure(circuitIndex, budget);
                    s_fallbackCount.Add(1, tags);
                    s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                    throw CreateUnavailableException(
                        definition,
                        budget,
                        timedOut
                            ? RedisOperationFailureKind.CommandTimeout
                            : IsConnectionProviderFailure(exception)
                                ? RedisOperationFailureKind.ConnectionUnavailable
                                : RedisOperationFailureKind.RedisFailure,
                        exception);
                }
            }

            throw CreateUnavailableException(
                definition,
                budget,
                RedisOperationFailureKind.RedisFailure,
                lastFailure);
        }
        finally
        {
            if (slotAcquired)
            {
                operationSlots.Release();
            }
        }
    }

    public Task ExecuteAsync(
        RedisOperationPort port,
        Func<IConnectionMultiplexer, CancellationToken, Task> command,
        CancellationToken cancellationToken)
        => ExecuteAsync(
            port,
            async (multiplexer, token) =>
            {
                await command(multiplexer, token).ConfigureAwait(false);
                return true;
            },
            cancellationToken);

    private bool IsCircuitOpen(int circuitIndex)
    {
        long openUntil = Volatile.Read(ref _openUntilTimestamp[circuitIndex]);
        if (openUntil == 0)
        {
            return false;
        }

        long now = timeProvider.GetTimestamp();
        if (now < openUntil)
        {
            return true;
        }

        Interlocked.CompareExchange(ref _openUntilTimestamp[circuitIndex], 0, openUntil);
        Interlocked.Exchange(ref _consecutiveFailures[circuitIndex], 0);
        return false;
    }

    private void OpenCircuitAfterFailure(int circuitIndex, RedisOperationBudget budget)
    {
        int failures = Interlocked.Increment(ref _consecutiveFailures[circuitIndex]);
        if (failures < budget.CircuitFailureThreshold)
        {
            return;
        }

        long durationTicks = checked((long)Math.Ceiling(
            budget.CircuitOpenDuration.TotalSeconds * timeProvider.TimestampFrequency));
        long openUntil = checked(timeProvider.GetTimestamp() + durationTicks);
        Interlocked.Exchange(ref _openUntilTimestamp[circuitIndex], openUntil);
    }

    private static bool IsOperationFailure(Exception exception, CancellationToken deadlineToken)
        => exception is TimeoutException
            or RedisException
            || IsConnectionProviderFailure(exception)
            || exception is OperationCanceledException && deadlineToken.IsCancellationRequested;

    private static bool IsConnectionProviderFailure(Exception exception)
        => exception is InvalidOperationException invalidOperation
            && invalidOperation.Message.StartsWith("redis_multiplexer_", StringComparison.Ordinal);

    private static bool IsRetryable(Exception exception)
        => exception is TimeoutException
            or RedisTimeoutException
            or RedisConnectionException
            || exception is RedisServerException serverException
                && (serverException.Message.StartsWith("READONLY", StringComparison.OrdinalIgnoreCase)
                    || serverException.Message.StartsWith("MOVED", StringComparison.OrdinalIgnoreCase));

    private static void ObserveFailure(
        RedisOperationDiagnosticCall call,
        RedisOperationPortDefinition definition,
        RedisOperationBudget budget,
        RedisOperationDiagnosticStage stage,
        int attempt,
        RedisOperationFailureKind? failureKind,
        RedisOperationDiagnosticDisposition disposition,
        Exception? exception)
    {
        // Only closed categories leave this boundary, never exception text or transport identities.
        if (call.CallIdentity == 0 || !RedisOperationFailureDiagnostics.HasSubscribers)
        {
            return;
        }

        if (failureKind is null && disposition != RedisOperationDiagnosticDisposition.CallerCancellation)
        {
            // The original failure filter has already admitted provider InvalidOperationException values.
            failureKind = exception is InvalidOperationException
                ? RedisOperationFailureKind.ConnectionUnavailable : RedisOperationFailureKind.RedisFailure;
        }

        string category = exception switch
        {
            null => "none",
            RedisTimeoutException => "redis-timeout",
            RedisConnectionException => "redis-connection",
            RedisServerException server when server.Message.StartsWith("READONLY", StringComparison.OrdinalIgnoreCase) => "redis-readonly",
            RedisServerException server when server.Message.StartsWith("MOVED", StringComparison.OrdinalIgnoreCase) => "redis-moved",
            RedisServerException => "redis-server",
            TimeoutException => "timeout",
            OperationCanceledException => "cancellation",
            _ when failureKind == RedisOperationFailureKind.ConnectionUnavailable => "connection-provider-unavailable",
            RedisException => "redis-other",
            _ => "other"
        };
        ConnectionFailureType? connectionFailure = exception is RedisConnectionException connection
            && Enum.IsDefined(connection.FailureType) ? connection.FailureType : null;
        RedisOperationFailureDiagnostics.Publish(call, definition, budget, stage, attempt,
            failureKind, disposition, category, connectionFailure);
    }

    private static TagList CreateTags(
        RedisOperationPortDefinition definition,
        RedisOperationBudget budget)
    {
        TagList tags = default;
        tags.Add("fsus.redis.port", definition.Id);
        tags.Add("fsus.redis.class", budget.Id);
        tags.Add("fsus.redis.fail_action", budget.FailAction);
        return tags;
    }

    private static RedisOperationUnavailableException CreateUnavailableException(
        RedisOperationPortDefinition definition,
        RedisOperationBudget budget,
        RedisOperationFailureKind failureKind,
        Exception? innerException = null)
    {
        RuntimeCacheEvidenceObservation.Current?.RecordRedisFailure(
            definition.OperationClass,
            failureKind,
            budget.FailAction);
        return new RedisOperationUnavailableException(definition, budget, failureKind, innerException);
    }

    private sealed class ImmediateConnectionProvider(IConnectionMultiplexer connection) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromResult(connection);
    }
}

internal enum RedisOperationDiagnosticStage : byte
{
    Queue,
    Connection,
    Command,
    CircuitEntry,
    CircuitAfterQueue
}

internal enum RedisOperationDiagnosticDisposition : byte
{
    Retry,
    Terminal,
    CallerCancellation,
    Rejected
}

internal readonly record struct RedisOperationDiagnosticCall(long ExecutorIdentity, long CallIdentity, long StartedTimestamp);

internal sealed record RedisOperationFailureDiagnostic(
    long Sequence,
    long ObservedTimestamp,
    double ElapsedMilliseconds,
    long ExecutorIdentity,
    long CallIdentity,
    RedisOperationPort Port,
    RedisOperationClass OperationClass,
    string FailAction,
    RedisOperationDiagnosticStage Stage,
    int Attempt,
    RedisOperationFailureKind? FailureKind,
    RedisOperationDiagnosticDisposition Disposition,
    string ExceptionCategory,
    ConnectionFailureType? ConnectionFailure);

// Internal diagnostic emission is independent of HTTP observations and cannot change execution decisions.
internal static class RedisOperationFailureDiagnostics
{
    private const int MaximumSubscribers = 8;
    private static readonly object s_gate = new();
    private static Action<RedisOperationFailureDiagnostic>[] s_subscribers = [];
    private static long s_executorIdentity;
    private static long s_callIdentity;
    private static long s_sequence;

    internal static bool HasSubscribers => Volatile.Read(ref s_subscribers).Length != 0;

    internal static RedisOperationDiagnosticCall Begin(ref long executorIdentity, long startedTimestamp)
    {
        if (!HasSubscribers)
        {
            return default;
        }

        if (Volatile.Read(ref executorIdentity) == 0)
        {
            Interlocked.CompareExchange(ref executorIdentity, Interlocked.Increment(ref s_executorIdentity), 0);
        }

        return new(executorIdentity, Interlocked.Increment(ref s_callIdentity), startedTimestamp);
    }

    internal static IDisposable Subscribe(Action<RedisOperationFailureDiagnostic> subscriber)
    {
        ArgumentNullException.ThrowIfNull(subscriber);
        lock (s_gate)
        {
            if (s_subscribers.Length == MaximumSubscribers)
            {
                throw new InvalidOperationException("redis_diagnostic_subscriber_capacity");
            }

            Volatile.Write(ref s_subscribers, [.. s_subscribers, subscriber]);
        }

        return new Subscription(subscriber);
    }

    internal static void Publish(
        RedisOperationDiagnosticCall call,
        RedisOperationPortDefinition definition,
        RedisOperationBudget budget,
        RedisOperationDiagnosticStage stage,
        int attempt,
        RedisOperationFailureKind? failureKind,
        RedisOperationDiagnosticDisposition disposition,
        string category,
        ConnectionFailureType? connectionFailure)
    {
        Action<RedisOperationFailureDiagnostic>[] subscribers = Volatile.Read(ref s_subscribers);
        if (subscribers.Length == 0)
        {
            return;
        }

        long observedTimestamp = Stopwatch.GetTimestamp();
        var observation = new RedisOperationFailureDiagnostic(
            Interlocked.Increment(ref s_sequence), observedTimestamp,
            Stopwatch.GetElapsedTime(call.StartedTimestamp, observedTimestamp).TotalMilliseconds,
            call.ExecutorIdentity, call.CallIdentity, definition.Port, definition.OperationClass,
            budget.FailAction, stage, attempt, failureKind, disposition, category, connectionFailure);
        foreach (Action<RedisOperationFailureDiagnostic> subscriber in subscribers)
        {
            try
            {
                subscriber(observation);
            }
            catch (Exception)
            {
                // A diagnostic subscriber is not a business owner; its failure cannot replace the original result.
            }
        }
    }

    private sealed class Subscription(Action<RedisOperationFailureDiagnostic> subscriber) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            lock (s_gate)
            {
                var remaining = s_subscribers.ToList();
                remaining.Remove(subscriber);
                Volatile.Write(ref s_subscribers, remaining.ToArray());
            }
        }
    }
}

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

        if (IsCircuitOpen(circuitIndex))
        {
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
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                s_cancelCount.Add(1, tags);
                s_endToEndTime.Record(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds, tags);
                throw;
            }
            catch (OperationCanceledException exception) when (deadline.IsCancellationRequested)
            {
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
                try
                {
                    IConnectionMultiplexer multiplexer = await connectionProvider
                        .WaitAsync()
                        .WaitAsync(budget.ConnectDeadline, deadline.Token)
                        .ConfigureAwait(false);

                    long commandStartedAt = Stopwatch.GetTimestamp();
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
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
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
                        continue;
                    }

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

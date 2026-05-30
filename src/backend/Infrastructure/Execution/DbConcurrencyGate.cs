namespace FsusBlog.Server.Infrastructure.Execution;

public readonly record struct DbConcurrencyGateSnapshot(int Limit, int InUse, int Waiting);

public interface IDbConcurrencyGate
{
    Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default);

    DbConcurrencyGateSnapshot GetSnapshot();
}

internal sealed record DbConcurrencyGateOptions(int MaxConcurrency, TimeSpan WaitTimeout)
{
    public static DbConcurrencyGateOptions FromConfiguration(IConfiguration configuration)
    {
        int fallbackMaxConcurrency = Math.Clamp(Environment.ProcessorCount * 4, 8, 32);
        int maxConcurrency = configuration.GetValue<int?>("Database:ConcurrencyGate:MaxConcurrentMisses")
            ?? configuration.GetValue<int?>("Database__ConcurrencyGate__MaxConcurrentMisses")
            ?? fallbackMaxConcurrency;
        int waitTimeoutMs = configuration.GetValue<int?>("Database:ConcurrencyGate:WaitTimeoutMs")
            ?? configuration.GetValue<int?>("Database__ConcurrencyGate__WaitTimeoutMs")
            ?? 1500;
        return new DbConcurrencyGateOptions(
            Math.Max(1, maxConcurrency),
            TimeSpan.FromMilliseconds(Math.Clamp(waitTimeoutMs, 100, 10000)));
    }
}

public sealed class DbConcurrencyGate : IDbConcurrencyGate
{
    private static readonly AsyncLocal<int> ReentrancyDepth = new();

    private readonly SemaphoreSlim _semaphore;
    private readonly ILogger<DbConcurrencyGate> _logger;
    private readonly DbConcurrencyGateOptions _options;
    private int _activeCount;
    private int _waitingCount;

    public DbConcurrencyGate(IConfiguration configuration, ILogger<DbConcurrencyGate> logger)
        : this(DbConcurrencyGateOptions.FromConfiguration(configuration), logger)
    {
    }

    internal DbConcurrencyGate(DbConcurrencyGateOptions options, ILogger<DbConcurrencyGate> logger)
    {
        _options = options;
        _logger = logger;
        _semaphore = new SemaphoreSlim(options.MaxConcurrency, options.MaxConcurrency);
    }

    public async Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
    {
        if (ReentrancyDepth.Value > 0)
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }

        Interlocked.Increment(ref _waitingCount);
        bool acquired = false;
        try
        {
            acquired = await _semaphore.WaitAsync(_options.WaitTimeout, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Decrement(ref _waitingCount);
        }

        if (!acquired)
        {
            DbConcurrencyGateSnapshot snapshot = GetSnapshot();
            RuntimePressureSnapshot pressure = RuntimePressureSnapshot.Capture();
            _logger.LogWarning(
                "db-gate-timeout {Operation} limit={Limit} inUse={InUse} waiting={Waiting} availableWorkers={AvailableWorkers} availableIo={AvailableIo}",
                operation,
                snapshot.Limit,
                snapshot.InUse,
                snapshot.Waiting,
                pressure.AvailableWorkerThreads,
                pressure.AvailableIoThreads);
            return await onTimeout(cancellationToken).ConfigureAwait(false);
        }

        Interlocked.Increment(ref _activeCount);
        ReentrancyDepth.Value++;
        try
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            ReentrancyDepth.Value--;
            Interlocked.Decrement(ref _activeCount);
            _semaphore.Release();
        }
    }

    public DbConcurrencyGateSnapshot GetSnapshot()
        => new(_options.MaxConcurrency, Volatile.Read(ref _activeCount), Volatile.Read(ref _waitingCount));
}

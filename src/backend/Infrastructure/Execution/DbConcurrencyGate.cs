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
    private static readonly AsyncLocal<DbConcurrencyGateReservation?> CurrentReservation = new();
    private static readonly AsyncLocal<int> ReentrantExecutionDepth = new();

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
        if (CurrentReservation.Value is { AcceptsReentrantCalls: true } reservation)
        {
            return await ExecuteReentrantAsync(operation, reservation, action, onTimeout, cancellationToken)
                .ConfigureAwait(false);
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
            LogTimeout(operation);
            return await onTimeout(cancellationToken).ConfigureAwait(false);
        }

        DbConcurrencyGateReservation? previousReservation = CurrentReservation.Value;
        reservation = new DbConcurrencyGateReservation();
        CurrentReservation.Value = reservation;
        Interlocked.Increment(ref _activeCount);
        try
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            await reservation.CompleteAsync().ConfigureAwait(false);
            CurrentReservation.Value = previousReservation;
            Interlocked.Decrement(ref _activeCount);
            _semaphore.Release();
        }
    }

    public DbConcurrencyGateSnapshot GetSnapshot()
        => new(_options.MaxConcurrency, Volatile.Read(ref _activeCount), Volatile.Read(ref _waitingCount));

    private async Task<T> ExecuteReentrantAsync<T>(
        string operation,
        DbConcurrencyGateReservation reservation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken)
    {
        if (ReentrantExecutionDepth.Value > 0)
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }

        Interlocked.Increment(ref _waitingCount);
        try
        {
            await reservation.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Decrement(ref _waitingCount);
        }

        if (!reservation.TryBeginReentrantCall())
        {
            reservation.Release();
            return await ExecuteAsync(operation, action, onTimeout, cancellationToken).ConfigureAwait(false);
        }

        ReentrantExecutionDepth.Value++;
        try
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            ReentrantExecutionDepth.Value--;
            reservation.EndReentrantCall();
            reservation.Release();
        }
    }

    private void LogTimeout(string operation)
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
    }

    private sealed class DbConcurrencyGateReservation
    {
        private readonly object _sync = new();
        private readonly SemaphoreSlim _reentrantSerial = new(1, 1);
        private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private bool _accepting = true;
        private int _inFlightReentrantCalls;

        public bool AcceptsReentrantCalls
        {
            get
            {
                lock (_sync)
                {
                    return _accepting;
                }
            }
        }

        public Task WaitAsync(CancellationToken cancellationToken)
            => _reentrantSerial.WaitAsync(cancellationToken);

        public void Release()
            => _reentrantSerial.Release();

        public bool TryBeginReentrantCall()
        {
            lock (_sync)
            {
                if (!_accepting)
                {
                    return false;
                }

                _inFlightReentrantCalls++;
                return true;
            }
        }

        public void EndReentrantCall()
        {
            lock (_sync)
            {
                _inFlightReentrantCalls--;
                if (!_accepting && _inFlightReentrantCalls == 0)
                {
                    _drained.TrySetResult();
                }
            }
        }

        public Task CompleteAsync()
        {
            lock (_sync)
            {
                _accepting = false;
                if (_inFlightReentrantCalls == 0)
                {
                    return Task.CompletedTask;
                }

                return _drained.Task;
            }
        }
    }
}

using System.Collections.ObjectModel;
using System.Diagnostics;

using Npgsql;

namespace FsusBlog.Server.Infrastructure.Execution;

public readonly record struct DbConcurrencyGateSnapshot(int Limit, int InUse, int Waiting);

public enum DbWorkloadClass
{
    PublicShortRead,
    AdminHeavyRead,
    ForegroundWrite,
    BackgroundProjection
}

public readonly record struct DbWorkloadGateSnapshot(
    int Limit,
    int QueueLimit,
    int InUse,
    int Waiting,
    long Completed,
    long Timeouts,
    long QueueRejected,
    double P99WaitMs,
    double P99ExecutionMs);

public sealed record DbConcurrencyGateDiagnostics(
    int MainPoolCapacity,
    int PublicProjectionPoolCapacity,
    IReadOnlyDictionary<string, DbWorkloadGateSnapshot> Workloads);

public interface IDbConcurrencyGate
{
    Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default);

    DbConcurrencyGateSnapshot GetSnapshot();
}

public interface IClassifiedDbConcurrencyGate : IDbConcurrencyGate
{
    Task<T> ExecuteClassifiedAsync<T>(
        DbWorkloadClass workload,
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default);

    DbConcurrencyGateDiagnostics GetDiagnostics();
}

public static class DbConcurrencyGateExtensions
{
    public static Task<T> ExecuteClassifiedAsync<T>(
        this IDbConcurrencyGate gate,
        DbWorkloadClass workload,
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
        => gate is IClassifiedDbConcurrencyGate classified
            ? classified.ExecuteClassifiedAsync(workload, operation, action, onTimeout, cancellationToken)
            : gate.ExecuteAsync(operation, action, onTimeout, cancellationToken);
}

internal sealed class DbConcurrencyGateOptions
{
    public DbConcurrencyGateOptions(int maxConcurrency, TimeSpan waitTimeout)
    {
        LegacySharedGate = true;
        MainPoolCapacity = Math.Max(1, maxConcurrency);
        PublicProjectionPoolCapacity = Math.Max(1, maxConcurrency);
        Workloads = Enum.GetValues<DbWorkloadClass>().ToDictionary(
            static workload => workload,
            _ => new DbWorkloadGateOptions(Math.Max(1, maxConcurrency), Math.Max(1, maxConcurrency * 4), waitTimeout));
    }

    private DbConcurrencyGateOptions(
        int mainPoolCapacity,
        int publicProjectionPoolCapacity,
        IReadOnlyDictionary<DbWorkloadClass, DbWorkloadGateOptions> workloads)
    {
        MainPoolCapacity = mainPoolCapacity;
        PublicProjectionPoolCapacity = publicProjectionPoolCapacity;
        Workloads = workloads;
    }

    public bool LegacySharedGate
    {
        get;
    }
    public int MainPoolCapacity
    {
        get;
    }
    public int PublicProjectionPoolCapacity
    {
        get;
    }
    public IReadOnlyDictionary<DbWorkloadClass, DbWorkloadGateOptions> Workloads
    {
        get;
    }

    public static DbConcurrencyGateOptions FromConfiguration(IConfiguration configuration)
    {
        int mainPoolCapacity = ReadMainPoolCapacity(configuration);
        if (mainPoolCapacity < 3)
        {
            throw new InvalidOperationException("Database main pool capacity must be at least 3 for isolated admin/read, write, and background gates.");
        }
        int publicPoolCapacity = ReadInt(
            configuration,
            "Database:PublicArticleProjection:MaxPoolSize",
            Math.Clamp(mainPoolCapacity / 4, 2, Math.Max(2, mainPoolCapacity)));
        publicPoolCapacity = Math.Clamp(publicPoolCapacity, 1, mainPoolCapacity);

        int legacyLimit = ReadInt(configuration, "Database:ConcurrencyGate:MaxConcurrentMisses", 0);
        int legacyWaitMs = ReadInt(configuration, "Database:ConcurrencyGate:WaitTimeoutMs", 1500);
        int mainBudget = legacyLimit > 0 ? Math.Min(legacyLimit, mainPoolCapacity) : mainPoolCapacity;

        int foregroundWrite = Math.Max(1, mainBudget / 4);
        int adminRead = Math.Max(1, mainBudget / 3);
        int background = Math.Max(1, mainBudget - foregroundWrite - adminRead);
        if (foregroundWrite + adminRead + background > mainPoolCapacity)
        {
            background = Math.Max(1, mainPoolCapacity - foregroundWrite - adminRead);
        }

        var workloads = new Dictionary<DbWorkloadClass, DbWorkloadGateOptions>
        {
            [DbWorkloadClass.PublicShortRead] = ReadWorkload(
                configuration,
                "PublicShortRead",
                publicPoolCapacity,
                Math.Max(publicPoolCapacity, publicPoolCapacity * 4),
                Math.Min(legacyWaitMs, 750)),
            [DbWorkloadClass.AdminHeavyRead] = ReadWorkload(
                configuration,
                "AdminHeavyRead",
                adminRead,
                Math.Max(adminRead, adminRead * 3),
                legacyWaitMs),
            [DbWorkloadClass.ForegroundWrite] = ReadWorkload(
                configuration,
                "ForegroundWrite",
                foregroundWrite,
                Math.Max(foregroundWrite, foregroundWrite * 4),
                legacyWaitMs),
            [DbWorkloadClass.BackgroundProjection] = ReadWorkload(
                configuration,
                "BackgroundProjection",
                background,
                Math.Max(background, background * 2),
                Math.Max(legacyWaitMs, 2500))
        };

        if (workloads[DbWorkloadClass.PublicShortRead].Limit > publicPoolCapacity)
        {
            throw new InvalidOperationException("PublicShortRead gate limit cannot exceed the public projection pool capacity.");
        }

        int mainGateTotal = workloads[DbWorkloadClass.AdminHeavyRead].Limit
            + workloads[DbWorkloadClass.ForegroundWrite].Limit
            + workloads[DbWorkloadClass.BackgroundProjection].Limit;
        if (mainGateTotal > mainPoolCapacity)
        {
            throw new InvalidOperationException("Admin/read, foreground write, and background gate limits cannot exceed the main database pool capacity in aggregate.");
        }

        return new DbConcurrencyGateOptions(mainPoolCapacity, publicPoolCapacity, workloads);
    }

    private static DbWorkloadGateOptions ReadWorkload(
        IConfiguration configuration,
        string name,
        int defaultLimit,
        int defaultQueueLimit,
        int defaultWaitMs)
    {
        string prefix = $"Database:ConcurrencyGate:{name}";
        int limit = ReadInt(configuration, $"{prefix}:Limit", defaultLimit);
        int queueLimit = ReadInt(configuration, $"{prefix}:QueueLimit", defaultQueueLimit);
        int waitMs = ReadInt(configuration, $"{prefix}:WaitTimeoutMs", defaultWaitMs);
        return new DbWorkloadGateOptions(
            Math.Max(1, limit),
            Math.Max(1, queueLimit),
            TimeSpan.FromMilliseconds(Math.Clamp(waitMs, 50, 30_000)));
    }

    private static int ReadMainPoolCapacity(IConfiguration configuration)
    {
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return new NpgsqlConnectionStringBuilder().MaxPoolSize;
        }

        try
        {
            return Math.Max(1, new NpgsqlConnectionStringBuilder(connectionString).MaxPoolSize);
        }
        catch (ArgumentException)
        {
            return new NpgsqlConnectionStringBuilder().MaxPoolSize;
        }
    }

    private static int ReadInt(IConfiguration configuration, string key, int fallback)
        => configuration.GetValue<int?>(key)
            ?? configuration.GetValue<int?>(key.Replace(":", "__", StringComparison.Ordinal))
            ?? fallback;
}

internal readonly record struct DbWorkloadGateOptions(int Limit, int QueueLimit, TimeSpan WaitTimeout);

public sealed class DbConcurrencyGate : IClassifiedDbConcurrencyGate
{
    private static readonly AsyncLocal<DbConcurrencyGateReservation?> s_currentReservation = new();
    private static readonly AsyncLocal<int> s_reentrantExecutionDepth = new();

    private readonly ILogger<DbConcurrencyGate> _logger;
    private readonly DbConcurrencyGateOptions _options;
    private readonly IReadOnlyDictionary<DbWorkloadClass, WorkloadGate> _workloads;

    public DbConcurrencyGate(IConfiguration configuration, ILogger<DbConcurrencyGate> logger)
        : this(DbConcurrencyGateOptions.FromConfiguration(configuration), logger)
    {
    }

    internal DbConcurrencyGate(DbConcurrencyGateOptions options, ILogger<DbConcurrencyGate> logger)
    {
        _options = options;
        _logger = logger;
        if (options.LegacySharedGate)
        {
            var shared = new WorkloadGate(options.Workloads[DbWorkloadClass.AdminHeavyRead]);
            _workloads = new ReadOnlyDictionary<DbWorkloadClass, WorkloadGate>(
                Enum.GetValues<DbWorkloadClass>().ToDictionary(static workload => workload, _ => shared));
        }
        else
        {
            _workloads = new ReadOnlyDictionary<DbWorkloadClass, WorkloadGate>(
                options.Workloads.ToDictionary(static item => item.Key, static item => new WorkloadGate(item.Value)));
        }
    }

    public Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
        => ExecuteClassifiedAsync(Classify(operation), operation, action, onTimeout, cancellationToken);

    public async Task<T> ExecuteClassifiedAsync<T>(
        DbWorkloadClass workload,
        string operation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken = default)
    {
        if (s_currentReservation.Value is { AcceptsReentrantCalls: true } reservation)
        {
            return await ExecuteReentrantAsync(operation, reservation, action, onTimeout, cancellationToken)
                .ConfigureAwait(false);
        }

        WorkloadGate gate = _workloads[workload];
        if (!gate.TryEnterQueue())
        {
            gate.RecordQueueRejected();
            LogTimeout(operation, workload, "queue-full", gate);
            return await onTimeout(cancellationToken).ConfigureAwait(false);
        }

        long waitStarted = Stopwatch.GetTimestamp();
        bool acquired = false;
        try
        {
            acquired = await gate.Semaphore.WaitAsync(gate.Options.WaitTimeout, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.LeaveQueue();
            gate.RecordWait(Stopwatch.GetElapsedTime(waitStarted));
        }

        if (!acquired)
        {
            gate.RecordTimeout();
            LogTimeout(operation, workload, "timeout", gate);
            return await onTimeout(cancellationToken).ConfigureAwait(false);
        }

        DbConcurrencyGateReservation? previousReservation = s_currentReservation.Value;
        reservation = new DbConcurrencyGateReservation();
        s_currentReservation.Value = reservation;
        gate.EnterActive();
        long executionStarted = Stopwatch.GetTimestamp();
        try
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            await reservation.CompleteAsync().ConfigureAwait(false);
            s_currentReservation.Value = previousReservation;
            gate.LeaveActive(Stopwatch.GetElapsedTime(executionStarted));
            gate.Semaphore.Release();
        }
    }

    public DbConcurrencyGateSnapshot GetSnapshot()
    {
        var uniqueGates = new HashSet<WorkloadGate>(ReferenceEqualityComparer.Instance);
        foreach (WorkloadGate gate in _workloads.Values)
        {
            uniqueGates.Add(gate);
        }

        WorkloadGate[] gates = uniqueGates.ToArray();
        return new DbConcurrencyGateSnapshot(
            gates.Sum(static gate => gate.Options.Limit),
            gates.Sum(static gate => gate.Active),
            gates.Sum(static gate => gate.Waiting));
    }

    public DbConcurrencyGateDiagnostics GetDiagnostics()
    {
        var snapshots = new Dictionary<string, DbWorkloadGateSnapshot>(StringComparer.Ordinal);
        foreach ((DbWorkloadClass workload, WorkloadGate gate) in _workloads)
        {
            snapshots[ToWireName(workload)] = gate.Snapshot();
        }

        return new DbConcurrencyGateDiagnostics(
            _options.MainPoolCapacity,
            _options.PublicProjectionPoolCapacity,
            new ReadOnlyDictionary<string, DbWorkloadGateSnapshot>(snapshots));
    }

    internal static DbWorkloadClass Classify(string operation)
    {
        if (operation.Contains("projection", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("rebuild", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("backfill", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("repair", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("outbox", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("worker", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("delta", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("refresh", StringComparison.OrdinalIgnoreCase))
        {
            return DbWorkloadClass.BackgroundProjection;
        }

        if (operation.Contains("write", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("create", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("update", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("delete", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("mutation", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("publish", StringComparison.OrdinalIgnoreCase))
        {
            return DbWorkloadClass.ForegroundWrite;
        }

        if (operation.Contains("public", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("article-detail", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("article-list", StringComparison.OrdinalIgnoreCase)
            || operation.Contains("article-hot", StringComparison.OrdinalIgnoreCase))
        {
            return DbWorkloadClass.PublicShortRead;
        }

        return DbWorkloadClass.AdminHeavyRead;
    }

    private async Task<T> ExecuteReentrantAsync<T>(
        string operation,
        DbConcurrencyGateReservation reservation,
        Func<CancellationToken, Task<T>> action,
        Func<CancellationToken, Task<T>> onTimeout,
        CancellationToken cancellationToken)
    {
        if (s_reentrantExecutionDepth.Value > 0)
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }

        await reservation.WaitAsync(cancellationToken).ConfigureAwait(false);
        if (!reservation.TryBeginReentrantCall())
        {
            reservation.Release();
            return await ExecuteAsync(operation, action, onTimeout, cancellationToken).ConfigureAwait(false);
        }

        s_reentrantExecutionDepth.Value++;
        try
        {
            return await action(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            s_reentrantExecutionDepth.Value--;
            reservation.EndReentrantCall();
            reservation.Release();
        }
    }

    private void LogTimeout(string operation, DbWorkloadClass workload, string reason, WorkloadGate gate)
    {
        RuntimePressureSnapshot pressure = RuntimePressureSnapshot.Capture();
        _logger.LogWarning(
            "db-gate-rejected {Operation} workload={Workload} reason={Reason} limit={Limit} inUse={InUse} waiting={Waiting} timeouts={Timeouts} availableWorkers={AvailableWorkers} availableIo={AvailableIo}",
            operation,
            ToWireName(workload),
            reason,
            gate.Options.Limit,
            gate.Active,
            gate.Waiting,
            gate.Timeouts,
            pressure.AvailableWorkerThreads,
            pressure.AvailableIoThreads);
    }

    private static string ToWireName(DbWorkloadClass workload)
        => workload switch
        {
            DbWorkloadClass.PublicShortRead => "public-short-read",
            DbWorkloadClass.AdminHeavyRead => "admin-heavy-read",
            DbWorkloadClass.ForegroundWrite => "foreground-write",
            DbWorkloadClass.BackgroundProjection => "background-projection-rebuild",
            _ => workload.ToString()
        };

    private sealed class WorkloadGate(DbWorkloadGateOptions options)
    {
        private const int SampleCapacity = 256;
        private readonly long[] _waitSamples = new long[SampleCapacity];
        private readonly long[] _executionSamples = new long[SampleCapacity];
        private int _waitSampleIndex;
        private int _executionSampleIndex;
        private int _active;
        private int _waiting;
        private long _completed;
        private long _timeouts;
        private long _queueRejected;

        public DbWorkloadGateOptions Options { get; } = options;
        public SemaphoreSlim Semaphore { get; } = new(options.Limit, options.Limit);
        public int Active => Volatile.Read(ref _active);
        public int Waiting => Volatile.Read(ref _waiting);
        public long Timeouts => Interlocked.Read(ref _timeouts);

        public bool TryEnterQueue()
        {
            int waiting = Interlocked.Increment(ref _waiting);
            if (waiting <= Options.QueueLimit)
            {
                return true;
            }

            Interlocked.Decrement(ref _waiting);
            return false;
        }

        public void LeaveQueue() => Interlocked.Decrement(ref _waiting);
        public void EnterActive() => Interlocked.Increment(ref _active);

        public void LeaveActive(TimeSpan elapsed)
        {
            Interlocked.Decrement(ref _active);
            Interlocked.Increment(ref _completed);
            RecordSample(_executionSamples, ref _executionSampleIndex, elapsed);
        }

        public void RecordWait(TimeSpan elapsed) => RecordSample(_waitSamples, ref _waitSampleIndex, elapsed);
        public void RecordTimeout() => Interlocked.Increment(ref _timeouts);
        public void RecordQueueRejected() => Interlocked.Increment(ref _queueRejected);

        public DbWorkloadGateSnapshot Snapshot()
            => new(
                Options.Limit,
                Options.QueueLimit,
                Active,
                Waiting,
                Interlocked.Read(ref _completed),
                Timeouts,
                Interlocked.Read(ref _queueRejected),
                ReadP99Milliseconds(_waitSamples),
                ReadP99Milliseconds(_executionSamples));

        private static void RecordSample(long[] samples, ref int index, TimeSpan elapsed)
        {
            int slot = (Interlocked.Increment(ref index) - 1) & (SampleCapacity - 1);
            Volatile.Write(ref samples[slot], elapsed.Ticks);
        }

        private static double ReadP99Milliseconds(long[] samples)
        {
            long[] populated = new long[samples.Length];
            int count = 0;
            for (int i = 0; i < samples.Length; i++)
            {
                long value = Volatile.Read(ref samples[i]);
                if (value > 0)
                {
                    populated[count++] = value;
                }
            }

            if (count == 0)
            {
                return 0;
            }

            Array.Sort(populated, 0, count);
            int index = Math.Clamp((int)Math.Ceiling(count * 0.99) - 1, 0, count - 1);
            return TimeSpan.FromTicks(populated[index]).TotalMilliseconds;
        }
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

        public Task WaitAsync(CancellationToken cancellationToken) => _reentrantSerial.WaitAsync(cancellationToken);
        public void Release() => _reentrantSerial.Release();

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

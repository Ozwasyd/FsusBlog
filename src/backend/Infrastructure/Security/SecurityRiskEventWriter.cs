using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Security;

internal readonly record struct SecurityRiskEventBatchPersistResult(
    int InsertedRows,
    int FailedBatches,
    int FallbackSingleInserts);

/// <summary>Configures capacity, batching, and flush latency for asynchronous security-risk persistence.</summary>
public sealed class SecurityRiskEventWriterOptions
{
    /// <summary>Gets the configuration section that binds these writer options.</summary>
    public const string SectionName = "Security:RiskEventWriter";

    /// <summary>Gets or sets the maximum number of events retained by the bounded writer queue.</summary>
    /// <value>The configured queue capacity before runtime clamping.</value>
    public int Capacity { get; set; } = 20_000;

    /// <summary>Gets or sets the maximum number of events persisted in one batch.</summary>
    /// <value>The configured batch size before runtime clamping.</value>
    public int BatchSize { get; set; } = 256;

    /// <summary>Gets or sets the maximum batching window in milliseconds.</summary>
    /// <value>The configured flush window before runtime clamping.</value>
    public int FlushWindowMs { get; set; } = 500;
}

/// <summary>Captures queue admission, in-flight, durable and terminal dispositions.</summary>
/// <param name="QueuedCount">The approximate number of events awaiting persistence.</param>
/// <param name="DroppedCount">The cumulative number of rejected admissions, not an acknowledged loss.</param>
/// <param name="ShedCount">Hot-path drops that skipped request-path SQL fallback.</param>
/// <param name="SyncFallbackCount">Admissions that opened request-path SQL; target 0 on Shield/public-hot-read.</param>
public sealed record SecurityRiskEventWriteQueueSnapshot(
    long QueuedCount,
    long DroppedCount,
    long InFlightCount = 0,
    long DurablePendingCount = 0,
    long DurableAcceptedCount = 0,
    long CommittedCount = 0,
    long RequeuedCount = 0,
    long RejectedCount = 0,
    long TerminalFailureCount = 0,
    long Sequence = 0,
    string? LastDisposition = null,
    string? LastFailureReason = null,
    string? LastItemReference = null,
    long ShedCount = 0,
    long SyncFallbackCount = 0)
{
    public long OutstandingCount => Math.Max(0, QueuedCount)
        + Math.Max(0, InFlightCount)
        + Math.Max(0, DurablePendingCount)
        + Math.Max(0, TerminalFailureCount);
}

/// <summary>
/// Bounded Shield/public-hot-read risk persistence: queue, then shed. The client
/// still receives the already-computed hot-path decision; durable SQL is sampled
/// to telemetry when dropped. Request-path sync SQL fallback is not used.
/// </summary>
public static class SecurityRiskHotPathAdmission
{
    public const string ShedDisposition = "shed";
    public const string ShedTelemetryResult = "shed";
    public const string ClientOutcome = "unchanged-hot-path-decision";
    public const string TelemetrySample = "queue-depth,shed-count,sync-fallback-count";
}

/// <summary>Provides single-reader admission and accounting for the bounded security-risk event channel.</summary>
public sealed class SecurityRiskEventWriteQueue
{
    private readonly Channel<SecurityRiskEventWrite> _channel;
    private readonly IServiceScopeFactory? _scopeFactory;
    private readonly ILogger<SecurityRiskEventWriteQueue> _logger;
    private long _queuedCount;
    private long _droppedCount;
    private long _inFlightCount;
    private long _durablePendingCount;
    private long _durableAcceptedCount;
    private long _committedCount;
    private long _requeuedCount;
    private long _rejectedCount;
    private long _terminalFailureCount;
    private long _shedCount;
    private long _syncFallbackCount;
    private long _sequence;
    private string? _lastDisposition;
    private string? _lastFailureReason;
    private string? _lastItemReference;
    private int _completed;

    /// <summary>Creates a bounded event queue using the configured capacity and wait-mode backpressure.</summary>
    /// <param name="options">The writer capacity and batching options.</param>
    /// <param name="logger">The logger used when queue admission fails.</param>
    public SecurityRiskEventWriteQueue(
        IOptions<SecurityRiskEventWriterOptions> options,
        ILogger<SecurityRiskEventWriteQueue> logger,
        IServiceScopeFactory? scopeFactory = null)
    {
        SecurityRiskEventWriterOptions value = options.Value;
        _logger = logger;
        _scopeFactory = scopeFactory;
        _channel = Channel.CreateBounded<SecurityRiskEventWrite>(new BoundedChannelOptions(Math.Clamp(value.Capacity, 1, 1_000_000))
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });
    }

    /// <summary>Gets the channel reader used by the single background persistence worker.</summary>
    /// <value>The reader for admitted security-risk events.</value>
    public ChannelReader<SecurityRiskEventWrite> Reader => _channel.Reader;

    /// <summary>Attempts to admit an event without waiting for queue capacity.</summary>
    /// <param name="write">The bounded event to enqueue.</param>
    /// <returns><see langword="true"/> when the event was admitted; otherwise <see langword="false"/>.</returns>
    public bool TryWrite(SecurityRiskEventWrite write)
    {
        if (Volatile.Read(ref _completed) != 0)
        {
            return RejectAndFallback(write, "closed");
        }

        if (!_channel.Writer.TryWrite(write))
        {
            return RejectAndFallback(write, "queue_full");
        }

        Interlocked.Increment(ref _queuedCount);
        SetDisposition("queued", write.Id);
        RecordAdmission(shedDelta: 0, syncFallbackDelta: 0);
        return true;
    }

    /// <summary>
    /// Admits a request-path Shield/risk event without waiting and without SQL.
    /// A saturated or closed queue sheds: the HTTP decision is unchanged and
    /// the drop is sampled to telemetry.
    /// </summary>
    public bool TryEnqueueOrShed(SecurityRiskEventWrite write)
    {
        if (Volatile.Read(ref _completed) != 0)
        {
            Shed(write, "closed");
            return false;
        }

        if (_channel.Writer.TryWrite(write))
        {
            Interlocked.Increment(ref _queuedCount);
            SetDisposition("queued", write.Id);
            RecordAdmission(shedDelta: 0, syncFallbackDelta: 0);
            return true;
        }

        Shed(write, "queue_full");
        return false;
    }

    /// <summary>Admits a request-path event with queue+shed; never opens request-path SQL.</summary>
    public ValueTask<bool> EnqueueAsync(
        SecurityRiskEventWrite write,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            Shed(write, "cancelled");
            return ValueTask.FromResult(false);
        }

        return ValueTask.FromResult(TryEnqueueOrShed(write));
    }

    /// <summary>Attempts to remove one event and updates the queue-depth accounting on success.</summary>
    /// <param name="write">Receives the dequeued event when one is available.</param>
    /// <returns><see langword="true"/> when an event was read; otherwise <see langword="false"/>.</returns>
    public bool TryRead(out SecurityRiskEventWrite write)
    {
        if (!_channel.Reader.TryRead(out write))
        {
            return false;
        }

        MarkRead();
        Interlocked.Increment(ref _inFlightCount);
        SetDisposition("in-flight", write.Id);
        return true;
    }

    /// <summary>Reads a lock-free snapshot of queue depth and cumulative drops.</summary>
    /// <returns>The current queue accounting snapshot.</returns>
    public SecurityRiskEventWriteQueueSnapshot Snapshot()
        => new(
            Volatile.Read(ref _queuedCount),
            Volatile.Read(ref _droppedCount),
            Volatile.Read(ref _inFlightCount),
            Volatile.Read(ref _durablePendingCount),
            Volatile.Read(ref _durableAcceptedCount),
            Volatile.Read(ref _committedCount),
            Volatile.Read(ref _requeuedCount),
            Volatile.Read(ref _rejectedCount),
            Volatile.Read(ref _terminalFailureCount),
            Volatile.Read(ref _sequence),
            Volatile.Read(ref _lastDisposition),
            Volatile.Read(ref _lastFailureReason),
            Volatile.Read(ref _lastItemReference),
            Volatile.Read(ref _shedCount),
            Volatile.Read(ref _syncFallbackCount));

    public void Complete(Exception? error = null)
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
        {
            return;
        }

        _channel.Writer.TryComplete(error);
        SetDisposition("closed", error?.Message);
    }

    internal void MarkCommitted(int count)
    {
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _committedCount, Math.Max(0, count));
        SetDisposition("committed", null);
    }

    internal void MarkDurablePending(int count)
    {
        Interlocked.Add(ref _durablePendingCount, Math.Max(0, count));
        SetDisposition("durable-pending", null);
    }

    internal void MarkDurableAccepted(int count)
    {
        Decrement(ref _durablePendingCount, count);
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _durableAcceptedCount, Math.Max(0, count));
        SetDisposition("durable-accepted", null);
    }

    internal void MarkRequeued(int count)
    {
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _requeuedCount, Math.Max(0, count));
        SetDisposition("requeued", null);
    }

    internal void MarkTerminalFailure(int count, string? itemReference, string reason)
    {
        if (count <= 0)
        {
            return;
        }

        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _terminalFailureCount, count);
        SetDisposition("terminal-failed", itemReference, reason);
    }

    internal void MarkDurableFailed(int count, string? itemReference, string reason)
    {
        Decrement(ref _durablePendingCount, count);
        MarkTerminalFailure(count, itemReference, reason);
    }

    internal bool TryRequeue(SecurityRiskEventWrite write)
    {
        if (!_channel.Writer.TryWrite(write))
        {
            return false;
        }

        Interlocked.Increment(ref _queuedCount);
        MarkRequeued(1);
        return true;
    }

    private bool RejectAndFallback(SecurityRiskEventWrite write, string reason)
    {
        Interlocked.Increment(ref _droppedCount);
        Interlocked.Increment(ref _rejectedCount);
        _logger.LogWarning(
            "security-risk-event-admission-rejected Source={Source} Reason={Reason} Action={Action} TraceId={TraceId} Disposition=durable-fallback-or-terminal",
            write.Source,
            write.Reason,
            write.Action,
            write.TraceId);
        SetDisposition("rejected", write.Id, reason);

        if (_scopeFactory is null)
        {
            MarkTerminalFailure(1, write.Id, $"{reason}:fallback-unavailable");
            RecordAdmission(shedDelta: 0, syncFallbackDelta: 0);
            return false;
        }

        MarkDurablePending(1);
        Interlocked.Increment(ref _syncFallbackCount);
        RecordAdmission(shedDelta: 0, syncFallbackDelta: 1);
        try
        {
            using IServiceScope scope = _scopeFactory.CreateScope();
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            store.AppendAsync(write, CancellationToken.None).GetAwaiter().GetResult();
            MarkDurableAccepted(1);
        }
        catch (Exception ex)
        {
            MarkDurableFailed(1, write.Id, $"{reason}:fallback-failed:{ex.GetType().Name}");
            _logger.LogError(ex, "security-risk durable admission fallback failed. Id={Id}", write.Id);
        }

        return false;
    }

    private void Shed(SecurityRiskEventWrite write, string reason)
    {
        Interlocked.Increment(ref _droppedCount);
        Interlocked.Increment(ref _shedCount);
        SetDisposition(SecurityRiskHotPathAdmission.ShedDisposition, write.Id, reason);
        _logger.LogWarning(
            "security-risk-event-shed Source={Source} Reason={Reason} Action={Action} TraceId={TraceId} Disposition={Disposition} ClientSees={ClientSees} Sampled={Sampled}",
            write.Source,
            write.Reason,
            write.Action,
            write.TraceId,
            SecurityRiskHotPathAdmission.ShedDisposition,
            SecurityRiskHotPathAdmission.ClientOutcome,
            SecurityRiskHotPathAdmission.TelemetrySample);
        RecordAdmission(shedDelta: 1, syncFallbackDelta: 0);
    }

    private void RecordAdmission(long shedDelta, long syncFallbackDelta)
        => FsusObservability.RecordSecurityRiskQueueAdmission(
            Volatile.Read(ref _queuedCount),
            shedDelta,
            syncFallbackDelta);

    private void MarkRead()
    {
        long current;
        do
        {
            current = Volatile.Read(ref _queuedCount);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref _queuedCount, current - 1, current) != current);
    }

    private static void Decrement(ref long value, long count)
    {
        if (count <= 0)
        {
            return;
        }

        long current;
        do
        {
            current = Volatile.Read(ref value);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref value, Math.Max(0, current - count), current) != current);
    }

    private void SetDisposition(string disposition, string? itemReference, string? failureReason = null)
    {
        Interlocked.Increment(ref _sequence);
        Volatile.Write(ref _lastDisposition, disposition);
        if (itemReference is not null)
        {
            Volatile.Write(ref _lastItemReference, itemReference);
        }

        if (failureReason is not null)
        {
            Volatile.Write(ref _lastFailureReason, failureReason);
        }
    }
}

/// <summary>Drains queued security-risk events into scoped persistence batches with failure isolation.</summary>
/// <param name="queue">The bounded queue that supplies events.</param>
/// <param name="scopeFactory">The scope factory used to resolve the event store.</param>
/// <param name="options">The batch-size and flush-window configuration.</param>
/// <param name="logger">The logger used for recoverable persistence failures.</param>
public sealed class SecurityRiskEventWriterWorker(
    SecurityRiskEventWriteQueue queue,
    IServiceScopeFactory scopeFactory,
    IOptions<SecurityRiskEventWriterOptions> options,
    ILogger<SecurityRiskEventWriterWorker> logger) : BackgroundService
{
    private readonly SecurityRiskEventWriteQueue _queue = queue;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly ILogger<SecurityRiskEventWriterWorker> _logger = logger;
    private readonly int _batchSize = Math.Clamp(options.Value.BatchSize, 1, 10_000);
    private readonly TimeSpan _flushWindow = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.FlushWindowMs, 1, 60_000));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<SecurityRiskEventWrite>(_batchSize);
        bool persistenceStarted = false;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _queue.Reader.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                if (!_queue.TryRead(out SecurityRiskEventWrite first))
                {
                    continue;
                }

                batch.Add(first);
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);
                persistenceStarted = true;
                await PersistSafelyAsync(batch, stoppingToken);
                persistenceStarted = false;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                if (!persistenceStarted)
                {
                    RequeueOrTerminal(batch, "writer-cancelled");
                }
                break;
            }
            catch (Exception ex)
            {
                RequeueOrTerminal(batch, "worker-exception");
                _logger.LogError(ex, "security-risk-event writer loop recovered from an unexpected failure.");
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await DrainRemainingAsync(drainCts.Token);
    }

    /// <summary>Drains and persists at most one configured batch from the queue.</summary>
    /// <param name="cancellationToken">A token that cancels the flush operation.</param>
    /// <returns>The number of events removed from the queue and submitted for persistence.</returns>
    public async Task<int> FlushOnceAsync(CancellationToken cancellationToken)
    {
        var batch = new List<SecurityRiskEventWrite>(_batchSize);
        while (batch.Count < _batchSize && _queue.TryRead(out SecurityRiskEventWrite write))
        {
            batch.Add(write);
        }

        if (batch.Count == 0)
        {
            return 0;
        }

        await PersistSafelyAsync(batch, cancellationToken);
        return batch.Count;
    }

    internal async Task PersistSafelyAsync(IReadOnlyList<SecurityRiskEventWrite> batch, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        int insertedRows = 0;
        int failedBatches = 0;
        int fallbackSingleInserts = 0;
        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                _scopeFactory,
                "security_risk_event_flush");
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            try
            {
                await store.AppendBatchAsync(batch, cancellationToken);
                insertedRows = batch.Count;
                _queue.MarkCommitted(batch.Count);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                RequeueOrTerminal(batch, "persist-cancelled");
                throw;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                SecurityRiskEventBatchPersistResult fallback = await RetryBatchByHalvesAsync(
                    store,
                    batch,
                    cancellationToken).ConfigureAwait(false);
                insertedRows = fallback.InsertedRows;
                failedBatches = fallback.FailedBatches + 1;
                fallbackSingleInserts = fallback.FallbackSingleInserts;
                LogPersistFailure(ex, batch);
                if (insertedRows > 0)
                {
                    _queue.MarkCommitted(insertedRows);
                }

                int unresolved = batch.Count - insertedRows;
                if (unresolved > 0)
                {
                    _queue.MarkTerminalFailure(unresolved, batch[0].Id, "worker-failure:durable-replay-unresolved");
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            RequeueOrTerminal(batch, "persist-cancelled");
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            failedBatches++;
            _queue.MarkTerminalFailure(batch.Count, batch[0].Id, $"worker-failure:{ex.GetType().Name}");
            LogPersistFailure(ex, batch);
        }
        finally
        {
            FsusObservability.RecordSecurityRiskEventBatch(
                batch.Count,
                Stopwatch.GetElapsedTime(started),
                insertedRows,
                failedBatches,
                fallbackSingleInserts);
        }
    }

    private async Task<SecurityRiskEventBatchPersistResult> RetryBatchByHalvesAsync(
        ISecurityRiskEventStore store,
        IReadOnlyList<SecurityRiskEventWrite> batch,
        CancellationToken cancellationToken)
    {
        if (batch.Count == 0)
        {
            return new SecurityRiskEventBatchPersistResult(0, 0, 0);
        }

        if (batch.Count == 1)
        {
            try
            {
                await store.AppendAsync(batch[0], cancellationToken).ConfigureAwait(false);
                return new SecurityRiskEventBatchPersistResult(1, 0, 1);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogPersistFailure(ex, batch);
                return new SecurityRiskEventBatchPersistResult(0, 0, 0);
            }
        }

        int split = batch.Count / 2;
        SecurityRiskEventBatchPersistResult left = await PersistBatchPartOrRetryAsync(
            store,
            batch.Take(split).ToArray(),
            cancellationToken).ConfigureAwait(false);
        SecurityRiskEventBatchPersistResult right = await PersistBatchPartOrRetryAsync(
            store,
            batch.Skip(split).ToArray(),
            cancellationToken).ConfigureAwait(false);
        return new SecurityRiskEventBatchPersistResult(
            left.InsertedRows + right.InsertedRows,
            left.FailedBatches + right.FailedBatches,
            left.FallbackSingleInserts + right.FallbackSingleInserts);
    }

    private async Task<SecurityRiskEventBatchPersistResult> PersistBatchPartOrRetryAsync(
        ISecurityRiskEventStore store,
        IReadOnlyList<SecurityRiskEventWrite> batch,
        CancellationToken cancellationToken)
    {
        try
        {
            await store.AppendBatchAsync(batch, cancellationToken).ConfigureAwait(false);
            return new SecurityRiskEventBatchPersistResult(batch.Count, 0, 0);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            SecurityRiskEventBatchPersistResult fallback = await RetryBatchByHalvesAsync(
                store,
                batch,
                cancellationToken).ConfigureAwait(false);
            LogPersistFailure(ex, batch);
            return fallback with
            {
                FailedBatches = fallback.FailedBatches + 1
            };
        }
    }

    private void LogPersistFailure(Exception ex, IReadOnlyList<SecurityRiskEventWrite> batch)
    {
        SecurityRiskEventWrite first = batch[0];
        _logger.LogWarning(
            ex,
            "security-risk-persist-failed Count={Count} Source={Source} Reason={Reason} Action={Action} TraceId={TraceId}",
            batch.Count,
            first.Source,
            first.Reason,
            first.Action,
            first.TraceId);
    }

    private void RequeueOrTerminal(IReadOnlyList<SecurityRiskEventWrite> batch, string reason)
    {
        foreach (SecurityRiskEventWrite write in batch)
        {
            if (!_queue.TryRequeue(write))
            {
                _queue.MarkTerminalFailure(1, write.Id, reason);
            }
        }
    }

    private async Task FillBatchUntilFlushWindowAsync(List<SecurityRiskEventWrite> batch, CancellationToken stoppingToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        while (batch.Count < _batchSize)
        {
            while (batch.Count < _batchSize && _queue.TryRead(out SecurityRiskEventWrite ready))
            {
                batch.Add(ready);
            }

            if (batch.Count >= _batchSize)
            {
                return;
            }

            TimeSpan remaining = _flushWindow - Stopwatch.GetElapsedTime(startedAt);
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            ValueTask<bool> waitToRead = _queue.Reader.WaitToReadAsync(stoppingToken);
            if (waitToRead.IsCompletedSuccessfully)
            {
                if (!waitToRead.Result)
                {
                    return;
                }

                continue;
            }

            Task delay = Task.Delay(remaining, stoppingToken);
            Task<bool> waitTask = waitToRead.AsTask();
            Task completed = await Task.WhenAny(waitTask, delay);
            if (completed == delay)
            {
                return;
            }

            if (!await waitTask)
            {
                return;
            }
        }
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            int flushed = await FlushOnceAsync(cancellationToken);
            if (flushed == 0)
            {
                return;
            }
        }
    }
}

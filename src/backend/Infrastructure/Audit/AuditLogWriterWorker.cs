using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogWriterWorker(
    AuditLogChannel channel,
    IServiceScopeFactory scopeFactory,
    AuditLogRuntimeState runtimeState,
    IAuditFallbackWriter fallbackWriter,
    ILogger<AuditLogWriterWorker> logger) : BackgroundService
{
    private const int BatchSize = 256;
    private static readonly TimeSpan s_flushWindow = TimeSpan.FromMilliseconds(500);

    private readonly AuditLogChannel _channel = channel;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly AuditLogRuntimeState _runtimeState = runtimeState;
    private readonly IAuditFallbackWriter _fallbackWriter = fallbackWriter;
    private readonly ILogger<AuditLogWriterWorker> _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<AuditRecord>(BatchSize);
        bool persistenceStarted = false;

        if (_fallbackWriter is IAuditFallbackReplayReader replayReader)
        {
            try
            {
                await replayReader.ReplayAsync(
                    async (records, token) => await WriteBatchOnceAsync(records, token).ConfigureAwait(false),
                    stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                using var _ = AuditLogScope.SkipPersistence();
                _logger.LogError(ex, "audit-log durable fallback replay failed; replay file remains pending.");
            }
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _channel.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                batch.Add(await ReadRecordAsync(stoppingToken));
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);

                persistenceStarted = true;
                await PersistSafelyAsync(batch, stoppingToken);
                persistenceStarted = false;
                LogDroppedIfAny();
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
                if (!persistenceStarted)
                {
                    RequeueOrTerminal(batch, "worker-exception");
                }
                using var _ = AuditLogScope.SkipPersistence();
                _logger.LogError(ex, "audit-log writer loop recovered from an unexpected failure.");
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await DrainRemainingAsync(drainCts.Token);
    }

    internal async Task WriteBatchOnceAsync(IReadOnlyList<AuditRecord> batch, CancellationToken cancellationToken)
    {
        if (batch.Count == 0)
        {
            return;
        }

        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            _scopeFactory,
            "audit_flush");
        IAuditLogStore store = scope.ServiceProvider.GetRequiredService<IAuditLogStore>();
        await store.WriteBatchAsync(batch, cancellationToken);
        _runtimeState.RecordWriteSuccess(batch.Count);
        _channel.MarkCommitted(batch.Count);
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        var batch = new List<AuditRecord>(BatchSize);

        while (_channel.TryRead(out AuditRecord? record))
        {
            batch.Add(record);
            if (batch.Count >= BatchSize)
            {
                if (!await TryPersistDrainBatchAsync(batch, cancellationToken))
                {
                    return;
                }

                batch.Clear();
            }
        }

        if (batch.Count > 0)
        {
            _ = await TryPersistDrainBatchAsync(batch, cancellationToken);
        }

        LogDroppedIfAny();
    }

    private async Task<bool> TryPersistDrainBatchAsync(IReadOnlyList<AuditRecord> batch, CancellationToken cancellationToken)
    {
        try
        {
            await PersistSafelyAsync(batch, cancellationToken);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning("audit-log shutdown drain budget expired; remaining records may be dropped. AttemptedCount={Count}", batch.Count);
            return false;
        }
    }

    internal async Task PersistSafelyAsync(IReadOnlyList<AuditRecord> batch, CancellationToken cancellationToken)
    {
        try
        {
            await WriteBatchOnceAsync(batch, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            RequeueOrTerminal(batch, "writer-cancelled");
            throw;
        }
        catch (ObjectDisposedException ex) when (IsDisposedHostServiceProvider(ex))
        {
            using var _ = AuditLogScope.SkipPersistence();
            RequeueOrTerminal(batch, "service-provider-disposed");
            _logger.LogInformation("audit-log shutdown drain skipped because the host service provider was already disposed. Count={Count}", batch.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _runtimeState.RecordWriteFailure(batch.Count);
            bool fallbackSucceeded = await FallbackRequiredRecordsAsync(batch, ex, cancellationToken);
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning(
                ex,
                "audit-log batch write failed; disposition={Disposition} Count={Count}",
                fallbackSucceeded ? "durable-accepted" : "terminal-failed",
                batch.Count);
        }
    }

    private static bool IsDisposedHostServiceProvider(ObjectDisposedException exception)
        => string.Equals(exception.ObjectName, "IServiceProvider", StringComparison.Ordinal);

    private async ValueTask<AuditRecord> ReadRecordAsync(CancellationToken cancellationToken)
    {
        return await _channel.ReadAsync(cancellationToken);
    }

    private async Task FillBatchUntilFlushWindowAsync(List<AuditRecord> batch, CancellationToken stoppingToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        while (batch.Count < BatchSize)
        {
            while (batch.Count < BatchSize && _channel.TryRead(out AuditRecord? ready))
            {
                batch.Add(ready);
            }

            if (batch.Count >= BatchSize)
            {
                return;
            }

            TimeSpan remaining = s_flushWindow - Stopwatch.GetElapsedTime(startedAt);
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            ValueTask<bool> waitToRead = _channel.WaitToReadAsync(stoppingToken);
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

    private async Task<bool> FallbackRequiredRecordsAsync(
        IReadOnlyList<AuditRecord> batch,
        Exception reason,
        CancellationToken cancellationToken)
    {
        // The production channel has a durable fallback provider. Test-only channels
        // without one retain the historical low-value fixture behavior, while the
        // registered required queue persists every admitted record on worker failure.
        AuditRecord[] durableRecords = _channel.HasDurableFallback
            ? [.. batch]
            : [.. batch.Where(static record => record.RequiresDurableWrite)];
        if (durableRecords.Length == 0)
        {
            _channel.MarkTerminalFailure(batch.Count, null, "worker-failure:fallback-unavailable");
            return false;
        }

        _channel.MarkDurablePending(durableRecords.Length);
        try
        {
            await _fallbackWriter.WriteBatchAsync(durableRecords, reason, cancellationToken);
            _channel.MarkDurableAccepted(durableRecords.Length);
            if (durableRecords.Length < batch.Count)
            {
                _channel.MarkTerminalFailure(batch.Count - durableRecords.Length, null, "worker-failure:low-value-fallback-unavailable");
                return false;
            }

            return true;
        }
        catch (Exception fallbackEx) when (fallbackEx is not OperationCanceledException)
        {
            _channel.MarkDurableFailed(batch.Count, null, $"worker-failure:fallback-failed:{fallbackEx.GetType().Name}");
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogError(fallbackEx, "audit-log critical fallback batch write failed. Count={Count}", durableRecords.Length);
            return false;
        }
    }

    private void RequeueOrTerminal(IReadOnlyList<AuditRecord> batch, string reason)
    {
        int requeued = 0;
        foreach (AuditRecord record in batch)
        {
            if (_channel.TryRequeue(record))
            {
                requeued++;
            }
            else
            {
                _channel.MarkTerminalFailure(1, record.RecordHash ?? record.EventInfo, reason);
            }
        }

        if (requeued > 0)
        {
            _logger.LogWarning("audit-log records requeued after {Reason}. Count={Count}", reason, requeued);
        }
    }

    private void LogDroppedIfAny()
    {
        long dropped = _channel.DrainDroppedCount();
        if (dropped <= 0)
        {
            return;
        }

        using var _ = AuditLogScope.SkipPersistence();
        _logger.LogWarning("audit-log admission rejected; durable disposition was recorded. Count={Count}", dropped);
    }
}

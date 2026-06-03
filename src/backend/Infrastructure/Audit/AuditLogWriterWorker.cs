using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogWriterWorker(
    AuditLogChannel channel,
    IServiceScopeFactory scopeFactory,
    AuditLogRuntimeState runtimeState,
    IAuditFallbackWriter fallbackWriter,
    ILogger<AuditLogWriterWorker> logger) : BackgroundService
{
    private const int BatchSize = 256;
    private static readonly TimeSpan FlushWindow = TimeSpan.FromMilliseconds(500);

    private readonly AuditLogChannel _channel = channel;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly AuditLogRuntimeState _runtimeState = runtimeState;
    private readonly IAuditFallbackWriter _fallbackWriter = fallbackWriter;
    private readonly ILogger<AuditLogWriterWorker> _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<AuditRecord>(BatchSize);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _channel.Reader.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                batch.Add(await ReadRecordAsync(stoppingToken));

                using var flushDelay = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                flushDelay.CancelAfter(FlushWindow);
                while (batch.Count < BatchSize)
                {
                    try
                    {
                        AuditRecord next = await ReadRecordAsync(flushDelay.Token);
                        batch.Add(next);
                    }
                    catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                    {
                        break;
                    }
                    catch (ChannelClosedException)
                    {
                        break;
                    }
                }

                await PersistSafelyAsync(batch, stoppingToken);
                LogDroppedIfAny();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
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

        await using AsyncServiceScope scope = _scopeFactory.CreateAsyncScope();
        IAuditLogStore store = scope.ServiceProvider.GetRequiredService<IAuditLogStore>();
        await store.WriteBatchAsync(batch, cancellationToken);
        _runtimeState.RecordWriteSuccess(batch.Count);
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        var batch = new List<AuditRecord>(BatchSize);

        while (_channel.Reader.TryRead(out AuditRecord? record))
        {
            _channel.MarkRead();
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

    private async Task PersistSafelyAsync(IReadOnlyList<AuditRecord> batch, CancellationToken cancellationToken)
    {
        try
        {
            await WriteBatchOnceAsync(batch, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _runtimeState.RecordWriteFailure(batch.Count);
            await FallbackHighValueRecordsAsync(batch, ex, cancellationToken);
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning(ex, "audit-log degraded: batch write failed, records dropped. Count={Count}", batch.Count);
        }
    }

    private async ValueTask<AuditRecord> ReadRecordAsync(CancellationToken cancellationToken)
    {
        AuditRecord record = await _channel.Reader.ReadAsync(cancellationToken);
        _channel.MarkRead();
        return record;
    }

    private async Task FallbackHighValueRecordsAsync(IReadOnlyList<AuditRecord> batch, Exception reason, CancellationToken cancellationToken)
    {
        foreach (AuditRecord record in batch)
        {
            if (!record.RequiresDurableWrite)
            {
                continue;
            }

            try
            {
                await _fallbackWriter.WriteAsync(record, reason, cancellationToken);
            }
            catch (Exception fallbackEx) when (fallbackEx is not OperationCanceledException)
            {
                using var _ = AuditLogScope.SkipPersistence();
                _logger.LogError(fallbackEx, "audit-log critical fallback write failed. Action={Action} TargetType={TargetType} TargetId={TargetId}", record.Action, record.TargetType, record.TargetId);
            }
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
        _logger.LogWarning("audit-log degraded: channel overflow dropped records. Count={Count}", dropped);
    }
}

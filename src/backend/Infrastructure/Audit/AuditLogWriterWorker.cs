using System.Diagnostics;
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
                if (!await _channel.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                batch.Add(await ReadRecordAsync(stoppingToken));
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);

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
        catch (ObjectDisposedException ex) when (IsDisposedHostServiceProvider(ex))
        {
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogInformation("audit-log shutdown drain skipped because the host service provider was already disposed. Count={Count}", batch.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _runtimeState.RecordWriteFailure(batch.Count);
            await FallbackHighValueRecordsAsync(batch, ex, cancellationToken);
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning(ex, "audit-log degraded: batch write failed, records dropped. Count={Count}", batch.Count);
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

            TimeSpan remaining = FlushWindow - Stopwatch.GetElapsedTime(startedAt);
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

    private async Task FallbackHighValueRecordsAsync(IReadOnlyList<AuditRecord> batch, Exception reason, CancellationToken cancellationToken)
    {
        AuditRecord[] durableRecords = [.. batch.Where(static record => record.RequiresDurableWrite)];
        if (durableRecords.Length == 0)
        {
            return;
        }

        try
        {
            await _fallbackWriter.WriteBatchAsync(durableRecords, reason, cancellationToken);
        }
        catch (Exception fallbackEx) when (fallbackEx is not OperationCanceledException)
        {
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogError(fallbackEx, "audit-log critical fallback batch write failed. Count={Count}", durableRecords.Length);
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

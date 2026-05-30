using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogWriterWorker(
    AuditLogChannel channel,
    IServiceScopeFactory scopeFactory,
    ILogger<AuditLogWriterWorker> logger) : BackgroundService
{
    private const int BatchSize = 256;
    private static readonly TimeSpan FlushWindow = TimeSpan.FromMilliseconds(500);

    private readonly AuditLogChannel _channel = channel;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
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
                batch.Add(await _channel.Reader.ReadAsync(stoppingToken));

                using var flushDelay = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                flushDelay.CancelAfter(FlushWindow);
                while (batch.Count < BatchSize)
                {
                    try
                    {
                        AuditRecord next = await _channel.Reader.ReadAsync(flushDelay.Token);
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
        }

        await DrainRemainingAsync(stoppingToken);
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
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        var batch = new List<AuditRecord>(BatchSize);

        while (_channel.Reader.TryRead(out AuditRecord? record))
        {
            batch.Add(record);
            if (batch.Count >= BatchSize)
            {
                await PersistSafelyAsync(batch, cancellationToken);
                batch.Clear();
            }
        }

        if (batch.Count > 0)
        {
            await PersistSafelyAsync(batch, cancellationToken);
        }

        LogDroppedIfAny();
    }

    private async Task PersistSafelyAsync(IReadOnlyList<AuditRecord> batch, CancellationToken cancellationToken)
    {
        try
        {
            await WriteBatchOnceAsync(batch, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            using var _ = AuditLogScope.SkipPersistence();
            _logger.LogWarning(ex, "audit-log degraded: batch write failed, records dropped. Count={Count}", batch.Count);
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

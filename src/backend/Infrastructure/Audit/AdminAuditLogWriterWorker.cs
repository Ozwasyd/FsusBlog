using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AdminAuditLogWriterWorker(
    AdminAuditLogChannel channel,
    IServiceScopeFactory scopeFactory,
    ILogger<AdminAuditLogWriterWorker> logger) : BackgroundService
{
    private const int BatchSize = 128;
    private static readonly TimeSpan s_flushWindow = TimeSpan.FromMilliseconds(250);

    private readonly AdminAuditLogChannel _channel = channel;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly ILogger<AdminAuditLogWriterWorker> _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<AdminAuditLog>(BatchSize);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _channel.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                batch.Add(await _channel.ReadAsync(stoppingToken));
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);
                await FlushPendingAsync(batch, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "admin-audit writer loop recovered from an unexpected failure.");
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await DrainRemainingAsync(drainCts.Token);
    }

    internal async Task FlushPendingAsync(IReadOnlyList<AdminAuditLog> batch, CancellationToken cancellationToken)
    {
        if (batch.Count == 0)
        {
            return;
        }

        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                _scopeFactory,
                "admin_audit_flush");
            IAdminAuditLogStore store = scope.ServiceProvider.GetRequiredService<IAdminAuditLogStore>();
            await store.WriteBatchAsync(batch, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "admin-audit batch write failed; falling back to direct write. Count={Count}", batch.Count);
            await _channel.WriteFallbackAsync(batch, cancellationToken);
        }
    }

    private async Task FillBatchUntilFlushWindowAsync(List<AdminAuditLog> batch, CancellationToken cancellationToken)
    {
        using var flushCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        flushCts.CancelAfter(s_flushWindow);

        while (batch.Count < BatchSize)
        {
            while (batch.Count < BatchSize && _channel.TryRead(out AdminAuditLog? ready))
            {
                batch.Add(ready);
            }

            if (batch.Count >= BatchSize || flushCts.IsCancellationRequested)
            {
                return;
            }

            try
            {
                if (!await _channel.WaitToReadAsync(flushCts.Token))
                {
                    return;
                }
            }
            catch (OperationCanceledException) when (flushCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        var batch = new List<AdminAuditLog>(BatchSize);
        while (_channel.TryRead(out AdminAuditLog? audit))
        {
            batch.Add(audit);
            if (batch.Count >= BatchSize)
            {
                await FlushPendingAsync(batch, cancellationToken);
                batch.Clear();
            }
        }

        if (batch.Count > 0)
        {
            await FlushPendingAsync(batch, cancellationToken);
        }
    }
}

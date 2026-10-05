using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AdminAuditLogWriterWorker : BackgroundService
{
    private static readonly TimeSpan s_replayWindow = TimeSpan.FromMilliseconds(250);
    private readonly AdminAuditLogChannel _channel;
    private readonly ILogger<AdminAuditLogWriterWorker> _logger;

    public AdminAuditLogWriterWorker(
        AdminAuditLogChannel channel, IServiceScopeFactory scopeFactory,
        ILogger<AdminAuditLogWriterWorker> logger)
    {
        ArgumentNullException.ThrowIfNull(scopeFactory);
        _channel = channel;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Startup and every later iteration observe the durable source,
                // including events whose bounded wake hints did not survive restart.
                await _channel.ReplayAsync(stoppingToken).ConfigureAwait(false);
                using var wake = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                wake.CancelAfter(s_replayWindow);
                try
                {
                    if (!await _channel.WaitToReadAsync(wake.Token).ConfigureAwait(false))
                    {
                        break;
                    }
                }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                {
                    // The polling window is for disk-pending records without hints.
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError("admin-audit replay remains pending. FailureCategory={Category}", ex.GetType().Name);
                try
                {
                    await Task.Delay(s_replayWindow, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }

        using var drain = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try
        {
            await _channel.ReplayAsync(drain.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (drain.IsCancellationRequested)
        {
            // Incomplete shutdown is still represented by the owned durable source.
        }
        catch (Exception ex)
        {
            _logger.LogError("admin-audit shutdown replay remains pending. FailureCategory={Category}", ex.GetType().Name);
        }
    }

    internal async Task FlushPendingAsync(IReadOnlyList<AdminAuditLog> batch, CancellationToken cancellationToken)
    {
        if (batch.Count == 0)
        {
            return;
        }
        await _channel.EnsureAdmittedAsync(batch).ConfigureAwait(false);
        try
        {
            await _channel.ReplayAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning("admin-audit batch write failed; retrying the same durable source. FailureCategory={Category}",
                ex.GetType().Name);
            await _channel.WriteFallbackAsync(batch, cancellationToken).ConfigureAwait(false);
        }
    }
}

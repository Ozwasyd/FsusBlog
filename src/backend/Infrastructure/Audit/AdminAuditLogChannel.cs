using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAdminAuditLogChannel
{
    ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default);

    ValueTask EnqueueManyAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken = default);
}

public sealed class AdminAuditLogChannel(
    IServiceScopeFactory scopeFactory,
    ILogger<AdminAuditLogChannel> logger) : IAdminAuditLogChannel
{
    internal const int DefaultCapacity = 4_096;

    private readonly Channel<AdminAuditLog> _channel = Channel.CreateBounded<AdminAuditLog>(
        new BoundedChannelOptions(DefaultCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly ILogger<AdminAuditLogChannel> _logger = logger;
    private long _queuedCount;

    internal ChannelReader<AdminAuditLog> Reader => _channel.Reader;

    public async ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_channel.Writer.TryWrite(audit))
        {
            long queued = Interlocked.Increment(ref _queuedCount);
            FsusObservability.RecordAdminAuditQueue(
                adminAuditQueuedCount: 1,
                adminAuditDroppedCount: 0,
                adminAuditFallbackWriteCount: 0,
                queueDepth: queued);
            return;
        }

        await WriteFallbackAsync([audit], cancellationToken);
    }

    public async ValueTask EnqueueManyAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (AdminAuditLog audit in audits)
        {
            await EnqueueAsync(audit, cancellationToken);
        }
    }

    internal bool TryRead([NotNullWhen(true)] out AdminAuditLog? audit)
    {
        if (!_channel.Reader.TryRead(out audit))
        {
            return false;
        }

        DecrementQueuedCount();
        return true;
    }

    internal async ValueTask<AdminAuditLog> ReadAsync(CancellationToken cancellationToken)
    {
        AdminAuditLog audit = await _channel.Reader.ReadAsync(cancellationToken);
        DecrementQueuedCount();
        return audit;
    }

    internal ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
        => _channel.Reader.WaitToReadAsync(cancellationToken);

    internal async Task WriteFallbackAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
    {
        if (audits.Count == 0)
        {
            return;
        }

        try
        {
            await using AsyncServiceScope scope = _scopeFactory.CreateAsyncScope();
            IAdminAuditLogStore store = scope.ServiceProvider.GetRequiredService<IAdminAuditLogStore>();
            await store.WriteBatchAsync(audits, cancellationToken);
            FsusObservability.RecordAdminAuditQueue(
                adminAuditQueuedCount: 0,
                adminAuditDroppedCount: 0,
                adminAuditFallbackWriteCount: audits.Count,
                queueDepth: Volatile.Read(ref _queuedCount));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            FsusObservability.RecordAdminAuditQueue(
                adminAuditQueuedCount: 0,
                adminAuditDroppedCount: audits.Count,
                adminAuditFallbackWriteCount: 0,
                queueDepth: Volatile.Read(ref _queuedCount));
            _logger.LogError(ex, "admin-audit fallback write failed. Count={Count}", audits.Count);
            throw;
        }
    }

    private void DecrementQueuedCount()
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
}

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
    private long _inFlightCount;
    private long _durablePendingCount;
    private long _durableAcceptedCount;
    private long _committedCount;
    private long _requeuedCount;
    private long _rejectedCount;
    private long _terminalFailureCount;
    private long _sequence;
    private string? _lastDisposition;
    private string? _lastFailureReason;
    private string? _lastItemReference;
    private int _completed;

    internal ChannelReader<AdminAuditLog> Reader => _channel.Reader;

    public long QueuedCount => Math.Max(0, Volatile.Read(ref _queuedCount));

    public async ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            await WriteFallbackAsync([audit], CancellationToken.None);
            return;
        }

        if (_channel.Writer.TryWrite(audit))
        {
            long queued = Interlocked.Increment(ref _queuedCount);
            SetDisposition("queued", ItemReference(audit));
            FsusObservability.RecordAdminAuditQueue(
                adminAuditQueuedCount: 1,
                adminAuditDroppedCount: 0,
                adminAuditFallbackWriteCount: 0,
                queueDepth: queued);
            return;
        }

        Interlocked.Increment(ref _rejectedCount);
        await WriteFallbackAsync([audit], CancellationToken.None);
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
        Interlocked.Increment(ref _inFlightCount);
        SetDisposition("in-flight", ItemReference(audit));
        return true;
    }

    internal async ValueTask<AdminAuditLog> ReadAsync(CancellationToken cancellationToken)
    {
        AdminAuditLog audit = await _channel.Reader.ReadAsync(cancellationToken);
        DecrementQueuedCount();
        Interlocked.Increment(ref _inFlightCount);
        SetDisposition("in-flight", ItemReference(audit));
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

        MarkDurablePending(audits.Count);
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
            MarkDurableAccepted(audits.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            FsusObservability.RecordAdminAuditQueue(
                adminAuditQueuedCount: 0,
                adminAuditDroppedCount: audits.Count,
                adminAuditFallbackWriteCount: 0,
                queueDepth: Volatile.Read(ref _queuedCount));
            _logger.LogError(ex, "admin-audit fallback write failed. Count={Count}", audits.Count);
            MarkDurableFailed(audits.Count, ItemReference(audits[0]), $"fallback-failed:{ex.GetType().Name}");
            throw;
        }
        catch (OperationCanceledException)
        {
            MarkDurableFailed(audits.Count, ItemReference(audits[0]), "fallback-cancelled");
            throw;
        }
    }

    public void Complete(Exception? error = null)
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
        {
            return;
        }

        _channel.Writer.TryComplete(error);
        SetDisposition("closed", error?.Message);
    }

    public AdminAuditLogChannelSnapshot Snapshot()
        => new(
            QueuedCount,
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
            Volatile.Read(ref _lastItemReference));

    internal void MarkCommitted(int count)
    {
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _committedCount, Math.Max(0, count));
        SetDisposition("committed", null);
    }

    internal bool TryRequeue(AdminAuditLog audit)
    {
        if (!_channel.Writer.TryWrite(audit))
        {
            return false;
        }

        Interlocked.Increment(ref _queuedCount);
        Decrement(ref _inFlightCount, 1);
        Interlocked.Increment(ref _requeuedCount);
        SetDisposition("requeued", ItemReference(audit));
        return true;
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

    private void MarkDurablePending(int count)
    {
        Interlocked.Add(ref _durablePendingCount, Math.Max(0, count));
        SetDisposition("durable-pending", null);
    }

    private void MarkDurableAccepted(int count)
    {
        Decrement(ref _durablePendingCount, count);
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _durableAcceptedCount, Math.Max(0, count));
        SetDisposition("durable-accepted", null);
    }

    private static string ItemReference(AdminAuditLog audit)
        => audit.Id > 0
            ? audit.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : $"{audit.AdminPrincipalId}:{audit.Action}:{audit.OccurredAtUtc.Ticks}:{audit.TargetId}";

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

public sealed record AdminAuditLogChannelSnapshot(
    long QueuedCount,
    long InFlightCount,
    long DurablePendingCount,
    long DurableAcceptedCount,
    long CommittedCount,
    long RequeuedCount,
    long RejectedCount,
    long TerminalFailureCount,
    long Sequence,
    string? LastDisposition,
    string? LastFailureReason,
    string? LastItemReference)
{
    public long OutstandingCount => Math.Max(0, QueuedCount)
        + Math.Max(0, InFlightCount)
        + Math.Max(0, DurablePendingCount)
        + Math.Max(0, TerminalFailureCount);
}

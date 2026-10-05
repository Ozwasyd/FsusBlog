using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogChannel
{
    private readonly Channel<AuditRecord> _bestEffortChannel;
    private readonly Lazy<IAuditDurableJournal>? _durableJournal;
    private readonly object _queueGate = new();
    private readonly IServiceScopeFactory? _scopeFactory;
    private readonly ILogger<AuditLogChannel>? _logger;
    private readonly ConcurrentDictionary<string, long> _droppedBySourceType = new(StringComparer.Ordinal);
    private long _droppedCount;
    private long _rejectedCount;
    private long _queuedCount;
    private long _inFlightCount;
    private long _durablePendingCount;
    private long _durableAcceptedCount;
    private long _committedCount;
    private long _requeuedCount;
    private long _terminalFailureCount;
    private long _sequence;
    private string? _lastDisposition;
    private string? _lastFailureReason;
    private string? _lastItemReference;
    private int _completed;

    public AuditLogChannel()
        : this(new BoundedChannelOptions(20_000)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        }, null, null)
    {
    }

    public AuditLogChannel(IServiceScopeFactory scopeFactory, ILogger<AuditLogChannel> logger)
        : this(new BoundedChannelOptions(20_000)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        }, scopeFactory, logger)
    {
    }

    internal AuditLogChannel(BoundedChannelOptions options)
        : this(options, null, null)
    {
    }

    internal AuditLogChannel(
        BoundedChannelOptions options,
        IServiceScopeFactory? scopeFactory,
        ILogger<AuditLogChannel>? logger)
    {
        _bestEffortChannel = Channel.CreateBounded<AuditRecord>(options);
        _scopeFactory = scopeFactory;
        _logger = logger;
        if (scopeFactory is not null)
        {
            _durableJournal = new Lazy<IAuditDurableJournal>(() =>
            {
                using IServiceScope scope = scopeFactory.CreateScope();
                return scope.ServiceProvider.GetRequiredService<IAuditFallbackWriter>() as IAuditDurableJournal
                    ?? throw new InvalidOperationException("audit_durable_journal_required");
            });
        }
    }

    public ChannelReader<AuditRecord> Reader => _bestEffortChannel.Reader;

    internal bool HasDurableFallback => _scopeFactory is not null;

    internal IAuditDurableJournal? DurableJournal => _durableJournal?.Value;

    public bool TryWrite(AuditRecord record)
    {
        if (_durableJournal is not null)
        {
            // All production admissions are required by the catalog, not only
            // Critical/HighValue records. No successful return depends on RAM.
            using var _ = AuditLogScope.SkipPersistence();
            try
            {
                _durableJournal.Value.AdmitAsync(record, CancellationToken.None).GetAwaiter().GetResult();
                lock (_queueGate)
                {
                    bool open = Volatile.Read(ref _completed) == 0;
                    if (!open)
                    {
                        Interlocked.Increment(ref _rejectedCount);
                    }
                    SetDisposition("durable-accepted", ItemReference(record), open ? null : "closed:durable-accepted");
                    return open;
                }
            }
            catch (Exception ex)
            {
                lock (_queueGate)
                {
                    Interlocked.Increment(ref _rejectedCount);
                    MarkTerminalFailure(1, ItemReference(record), $"admission-failed:{ex.GetType().Name}");
                }
                _logger?.LogError("audit-log durable admission failed. FailureCategory={Category}", ex.GetType().Name);
                return false;
            }
        }
        if (record.RequiresDurableWrite)
        {
            // A missing production owner cannot silently restore the old in-memory
            // required lane. Parameterless fixtures retain only best-effort traffic.
            return RejectAndFallback(record, "durable-owner-unavailable");
        }
        if (Volatile.Read(ref _completed) != 0)
        {
            return RejectAndFallback(record, "closed");
        }

        lock (_queueGate)
        {
            ChannelWriter<AuditRecord> writer = _bestEffortChannel.Writer;
            bool written = writer.TryWrite(record);
            if (!written)
            {
                return RejectAndFallback(record, "queue_full");
            }
            Interlocked.Increment(ref _queuedCount);
            SetDisposition("queued", ItemReference(record));
            return true;
        }
    }

    /// <summary>
    /// Closes the bounded lane. A subsequent admission is treated as a durable fallback
    /// rather than as a successful write or a warning-only drop.
    /// </summary>
    public void Complete(Exception? error = null)
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
        {
            return;
        }

        _bestEffortChannel.Writer.TryComplete(error);
        SetDisposition("closed", error?.Message);
    }

    public long DrainDroppedCount()
        => Interlocked.Exchange(ref _droppedCount, 0);

    public AuditLogChannelSnapshot Snapshot()
    {
        lock (_queueGate)
        {
            return SnapshotCore();
        }
    }

    private AuditLogChannelSnapshot SnapshotCore()
    {
        AuditDurableJournalSnapshot? journal = null;
        try
        {
            journal = DurableJournal?.Snapshot();
        }
        catch (Exception ex)
        {
            // Unknown persistent state must block qualification, never read as zero.
            Interlocked.CompareExchange(ref _terminalFailureCount, 1, 0);
            SetDisposition("terminal-failed", null, $"journal-state-unavailable:{ex.GetType().Name}");
        }
        return new(
            Volatile.Read(ref _queuedCount),
            Volatile.Read(ref _droppedCount),
            _droppedBySourceType.ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value,
                StringComparer.Ordinal),
            Volatile.Read(ref _inFlightCount) + (journal?.InFlightCount ?? 0),
            Volatile.Read(ref _durablePendingCount) + (journal?.PendingCount ?? 0),
            Volatile.Read(ref _durableAcceptedCount) + (journal?.AcceptedCount ?? 0),
            Volatile.Read(ref _committedCount) + (journal?.CommittedCount ?? 0),
            Volatile.Read(ref _requeuedCount),
            Volatile.Read(ref _rejectedCount),
            Volatile.Read(ref _terminalFailureCount) + (journal?.TerminalFailureCount ?? 0),
            Volatile.Read(ref _sequence) + (journal?.Sequence ?? 0),
            Volatile.Read(ref _terminalFailureCount) + (journal?.TerminalFailureCount ?? 0) > 0 ? "terminal-failed"
                : journal?.InFlightCount > 0 ? "in-flight" : journal?.PendingCount > 0 ? "durable-pending"
                : journal?.CommittedCount > 0 ? "committed" : Volatile.Read(ref _lastDisposition),
            Volatile.Read(ref _terminalFailureCount) > 0 ? Volatile.Read(ref _lastFailureReason)
                : journal?.LastFailureReason ?? Volatile.Read(ref _lastFailureReason),
            Volatile.Read(ref _terminalFailureCount) > 0 ? Volatile.Read(ref _lastItemReference)
                : journal?.LastItemReference ?? Volatile.Read(ref _lastItemReference));
    }

    internal async ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        return await _bestEffortChannel.Reader.WaitToReadAsync(cancellationToken);
    }

    internal async ValueTask<AuditRecord> ReadAsync(CancellationToken cancellationToken)
    {
        AuditRecord record = await _bestEffortChannel.Reader.ReadAsync(cancellationToken);
        lock (_queueGate)
        {
            MarkRead();
        }
        return record;
    }

    internal bool TryRead([NotNullWhen(true)] out AuditRecord? record)
    {
        lock (_queueGate)
        {
            if (_bestEffortChannel.Reader.TryRead(out record))
            {
                MarkRead();
                return true;
            }
            return false;
        }
    }

    internal void MarkRead()
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
        Interlocked.Increment(ref _inFlightCount);
        SetDisposition("in-flight", null);
    }

    internal void MarkCommitted(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _committedCount, count);
        SetDisposition("committed", null);
    }

    internal void MarkDurablePending(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Interlocked.Add(ref _durablePendingCount, count);
        SetDisposition("durable-pending", null);
    }

    internal void MarkDurableAccepted(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Decrement(ref _durablePendingCount, count);
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _durableAcceptedCount, count);
        SetDisposition("durable-accepted", null);
    }

    internal void MarkRequeued(int count)
    {
        if (count <= 0)
        {
            return;
        }

        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _requeuedCount, count);
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

    internal bool TryRequeue(AuditRecord record)
    {
        lock (_queueGate)
        {
            if (!_bestEffortChannel.Writer.TryWrite(record))
            {
                return false;
            }
            Interlocked.Increment(ref _queuedCount);
            MarkRequeued(1);
            return true;
        }
    }

    private bool RejectAndFallback(AuditRecord record, string reason)
    {
        Interlocked.Increment(ref _droppedCount);
        Interlocked.Increment(ref _rejectedCount);
        _droppedBySourceType.AddOrUpdate(
            $"{record.Source}:{record.Type}",
            1,
            static (_, current) => current + 1);
        SetDisposition("rejected", ItemReference(record), reason);

        if (_scopeFactory is null)
        {
            SetDisposition("terminal-failed", ItemReference(record), $"{reason}:fallback-unavailable");
            Interlocked.Increment(ref _terminalFailureCount);
            return false;
        }

        MarkDurablePending(1);
        try
        {
            using IServiceScope scope = _scopeFactory.CreateScope();
            IAuditFallbackWriter fallback = scope.ServiceProvider.GetRequiredService<IAuditFallbackWriter>();
            fallback.WriteAsync(
                    record,
                    new InvalidOperationException($"audit-log admission {reason}"),
                    CancellationToken.None)
                .GetAwaiter()
                .GetResult();
            MarkDurableAccepted(1);
            return false;
        }
        catch (Exception ex)
        {
            MarkDurableFailed(1, ItemReference(record), $"{reason}:fallback-failed:{ex.GetType().Name}");
            _logger?.LogError(ex, "audit-log durable admission fallback failed. Source={Source} Type={Type}", record.Source, record.Type);
            return false;
        }
    }

    private static string ItemReference(AuditRecord record)
        => record.DurableDeliveryId ?? record.RecordHash
            ?? AuditTamperEvidence.Sign(record with
            {
                RecordHash = null,
                RecordMac = null,
                PrevHash = null
            }, key: null).RecordHash;

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

public sealed record AuditLogChannelSnapshot(
    long QueuedCount,
    long DroppedCount,
    IReadOnlyDictionary<string, long> DroppedBySourceType,
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
    string? LastItemReference = null)
{
    public long OutstandingCount => Math.Max(0, QueuedCount)
        + Math.Max(0, InFlightCount)
        + Math.Max(0, DurablePendingCount)
        + Math.Max(0, TerminalFailureCount);
}

using System.Threading.Channels;

using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public sealed class NotificationStreamConnection
{
    private readonly Channel<SharedNotificationStreamFrame> _queue;
    private readonly HashSet<string> _groups;
    private readonly int _queueCapacity;
    private readonly long _queueByteCapacity;
    private readonly TimeSpan _queueMaximumAge;
    private readonly ILogger<NotificationStreamConnectionManager>? _logger;
    private readonly object _queueAccountingGate = new();
    private readonly Queue<NotificationStreamQueuedFrameAccounting> _queueAccounting = new();
    private readonly NotificationStreamDeliveryAccounting _delivery = new();
    private readonly NotificationStreamDeliveryAccounting? _aggregateDelivery;
    private int _inFlightWrites;
    private long _inFlightBytes;
    private int _queuedFrames;
    private long _queuedBytes;
    private long _coalescedCount;
    private long _droppedCount;
    private long _resyncCount;
    private long _lastCursor;
    private int _closed;
    private long _lastActivityUnixMs;
    private NotificationStreamCloseInstruction? _closeInstruction;

    internal NotificationStreamConnection(
        string connectionId,
        string? userId,
        IReadOnlyCollection<string> groups,
        int queueCapacity,
        string ipQuotaKey = "unknown-ip",
        string accountQuotaKey = "anonymous:unknown-ip",
        long queueByteCapacity = 2L * 1024 * 1024,
        TimeSpan? queueMaximumAge = null,
        ILogger<NotificationStreamConnectionManager>? logger = null,
        NotificationStreamDeliveryAccounting? delivery = null)
    {
        ConnectionId = connectionId;
        UserId = userId;
        IpQuotaKey = ipQuotaKey;
        AccountQuotaKey = accountQuotaKey;
        _groups = new HashSet<string>(groups, StringComparer.Ordinal);
        _queueCapacity = queueCapacity;
        _queueByteCapacity = Math.Max(1, queueByteCapacity);
        _queueMaximumAge = queueMaximumAge ?? TimeSpan.FromSeconds(30);
        _logger = logger;
        _aggregateDelivery = delivery;
        _queue = Channel.CreateBounded<SharedNotificationStreamFrame>(new BoundedChannelOptions(queueCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false
        });

        Touch();
    }

    public string ConnectionId
    {
        get;
    }

    public string? UserId
    {
        get;
    }

    internal string IpQuotaKey
    {
        get;
    }

    internal string AccountQuotaKey
    {
        get;
    }

    public IReadOnlySet<string> Groups => _groups;

    public ChannelReader<SharedNotificationStreamFrame> Reader => _queue.Reader;

    public bool IsClosed => Volatile.Read(ref _closed) == 1;

    public int QueuedFrameCount => Volatile.Read(ref _queuedFrames);

    internal int InFlightWriteCount => Volatile.Read(ref _inFlightWrites);

    internal NotificationStreamDeliverySnapshot DeliverySnapshot => _delivery.Snapshot();

    public long QueuedBytes => Volatile.Read(ref _queuedBytes);

    public long CoalescedCount => Volatile.Read(ref _coalescedCount);

    public long DroppedCount => Volatile.Read(ref _droppedCount);

    public long ResyncCount => Volatile.Read(ref _resyncCount);

    public long LastCursor => Volatile.Read(ref _lastCursor);

    public NotificationStreamCloseInstruction CloseInstruction
        => Volatile.Read(ref _closeInstruction)
            ?? NotificationStreamRestartProtocol.Resolve(replayMissed: false, serviceRestartRequested: false);

    public TimeSpan OldestQueuedAge
    {
        get
        {
            lock (_queueAccountingGate)
            {
                return _queueAccounting.TryPeek(out NotificationStreamQueuedFrameAccounting oldest)
                    ? TimeProvider.System.GetUtcNow() - oldest.EnqueuedAtUtc
                    : TimeSpan.Zero;
            }
        }
    }

    public bool IsIdle(TimeSpan idleWindow)
        => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Volatile.Read(ref _lastActivityUnixMs) >= (long)idleWindow.TotalMilliseconds;

    public void MarkWriteActivity() => Touch();

    public bool TryEnqueue(SharedNotificationStreamFrame frame)
        => TryEnqueue(
            frame,
            NotificationStreamDeliveryPolicyCatalog.GetRequired(NotificationStreamEventType.NoticeReceived),
            eventId: 0,
            coalescedOccurrences: 0);

    public bool TryEnqueue(
        SharedNotificationStreamFrame frame,
        NotificationStreamDeliveryPolicy policy,
        long eventId,
        long coalescedOccurrences = 0)
        => TryEnqueue(frame, policy, eventId, coalescedOccurrences, null, null);

    internal bool TryEnqueue(
        SharedNotificationStreamFrame frame,
        NotificationStreamDeliveryPolicy policy,
        long eventId,
        long coalescedOccurrences,
        NotificationStreamBacklogAcceptance? acceptance,
        NotificationStreamTarget? target)
    {
        bool durableBacklogAccepted = target is not null && acceptance?.Matches(eventId, target) == true;
        // Consumes one caller-transferred retain on every path:
        // success queues it for the writer, failure releases it here.
        if (Volatile.Read(ref _closed) == 1)
        {
            RecordUndelivered(policy, "connection-closed", durableBacklogAccepted);
            frame.Release();
            return false;
        }

        int depth;
        long bytes;
        TimeSpan oldestAge;
        bool queued;
        lock (_queueAccountingGate)
        {
            DateTimeOffset now = TimeProvider.System.GetUtcNow();
            TimeSpan maximumAge = ResolveMaximumQueueAge(now, out oldestAge);
            depth = _queuedFrames + 1;
            bytes = _queuedBytes + frame.Length;
            if (depth + _inFlightWrites > _queueCapacity || bytes + _inFlightBytes > _queueByteCapacity || oldestAge > maximumAge)
            {
                RejectForBudget(frame, policy, eventId, depth + _inFlightWrites, bytes + _inFlightBytes, oldestAge, durableBacklogAccepted);
                return false;
            }

            _queueAccounting.Enqueue(new NotificationStreamQueuedFrameAccounting(frame.Length, now, policy, eventId, durableBacklogAccepted));
            Volatile.Write(ref _queuedFrames, depth);
            Volatile.Write(ref _queuedBytes, bytes);
            queued = _queue.Writer.TryWrite(frame);
            if (!queued)
            {
                RollBackLastAccountingUnderLock();
            }
            else
            {
                RecordDelivery(queued: 1);
            }
        }

        return queued
            ? AcceptQueued(policy, eventId, coalescedOccurrences, depth, bytes, oldestAge)
            : RejectChannelWrite(frame, policy, eventId, durableBacklogAccepted);
    }

    public void AcknowledgeDequeuedFrame(bool written = true)
    {
        lock (_queueAccountingGate)
        {
            if (_queueAccounting.TryDequeue(out NotificationStreamQueuedFrameAccounting accounting))
            {
                _queuedFrames = Math.Max(0, _queuedFrames - 1);
                _queuedBytes = Math.Max(0, _queuedBytes - accounting.Length);
                RecordDelivery(queued: -1, completed: written ? 1 : 0);
                if (!written)
                {
                    RecordUndelivered(accounting.Policy, "pipe-write-failed", accounting.DurableBacklogAccepted);
                    RequireRecovery(accounting.Policy, "pipe-write-failed", accounting.EventId);
                }
            }
        }

        Touch();
    }

    internal async ValueTask<NotificationStreamWriteLease> ReadForWriteAsync(CancellationToken cancellationToken)
    {
        while (await _queue.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
        {
            lock (_queueAccountingGate)
            {
                if (!_queue.Reader.TryRead(out SharedNotificationStreamFrame? frame))
                {
                    continue;
                }

                NotificationStreamQueuedFrameAccounting accounting = _queueAccounting.Dequeue();
                _queuedFrames--;
                _queuedBytes -= accounting.Length;
                _inFlightWrites++;
                _inFlightBytes += accounting.Length;
                RecordDelivery(queued: -1, inFlight: 1);
                return new NotificationStreamWriteLease(this, frame, accounting);
            }
        }

        throw new ChannelClosedException();
    }

    internal void CompleteWrite(NotificationStreamWriteLease lease, bool written, string reason)
    {
        if (!ReferenceEquals(lease.Owner, this) || !lease.TryComplete())
        {
            RecordDelivery(terminal: 1, reason: "write-lease-identity-or-duplicate");
            throw new InvalidOperationException("notification write lease identity or disposition conflict");
        }

        lock (_queueAccountingGate)
        {
            if (!written)
            {
                RecordUndelivered(lease.Accounting.Policy, reason, lease.Accounting.DurableBacklogAccepted);
                RequireRecovery(lease.Accounting.Policy, reason, lease.Accounting.EventId);
            }

            _inFlightWrites--;
            _inFlightBytes -= lease.Accounting.Length;
            RecordDelivery(inFlight: -1, completed: written ? 1 : 0);
        }
    }

    public void Complete()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }

        _queue.Writer.TryComplete();
    }

    public void Drain()
    {
        lock (_queueAccountingGate)
        {
            while (_queue.Reader.TryRead(out SharedNotificationStreamFrame? frame))
            {
                NotificationStreamQueuedFrameAccounting accounting = _queueAccounting.Dequeue();
                RecordUndelivered(accounting.Policy, "connection-disconnected-before-write", accounting.DurableBacklogAccepted);
                _queuedFrames--;
                _queuedBytes -= accounting.Length;
                RecordDelivery(queued: -1);
                frame.Release();
            }
        }
    }

    public void RequireRecovery(NotificationStreamDeliveryPolicy policy, string reason, long eventId)
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }

        Volatile.Write(
            ref _closeInstruction,
            policy.RecoveryAction == NotificationStreamRecoveryAction.FullResync
                ? NotificationStreamRestartProtocol.FullResyncRequired(reason)
                : NotificationStreamRestartProtocol.ReplayRequired(reason));
        Interlocked.Increment(ref _resyncCount);
        NotificationStreamMetrics.RecordSlowDisconnect(reason, LastCursor, eventId);
        _logger?.LogWarning(
            "notification-stream-connection-replay-required {Reason} {ConnectionId} {LastCursor} {FailedEventId}",
            reason,
            ConnectionId,
            LastCursor,
            eventId);
        _queue.Writer.TryComplete();
    }

    public void RecordSendLatency(TimeSpan latency)
        => NotificationStreamMetrics.RecordConnectionSendLatency(latency);

    private TimeSpan ResolveMaximumQueueAge(DateTimeOffset now, out TimeSpan oldestAge)
    {
        if (!_queueAccounting.TryPeek(out NotificationStreamQueuedFrameAccounting oldest))
        {
            oldestAge = TimeSpan.Zero;
            return _queueMaximumAge;
        }

        oldestAge = now - oldest.EnqueuedAtUtc;
        return oldest.Policy.MaximumUsefulAge < _queueMaximumAge
            ? oldest.Policy.MaximumUsefulAge
            : _queueMaximumAge;
    }

    private void RejectForBudget(
        SharedNotificationStreamFrame frame,
        NotificationStreamDeliveryPolicy policy,
        long eventId,
        int depth,
        long bytes,
        TimeSpan oldestAge,
        bool durableBacklogAccepted)
    {
        RecordUndelivered(policy, "connection-budget-rejected", durableBacklogAccepted);
        Interlocked.Increment(ref _droppedCount);
        if (policy.LossPolicy != NotificationStreamLossPolicy.DiagnosticDrop)
        {
            RequireRecovery(policy, ResolveBudgetReason(depth, bytes), eventId);
        }

        frame.Release();
        NotificationStreamMetrics.RecordConnectionBackpressure(policy, depth, bytes, oldestAge);
    }

    private string ResolveBudgetReason(int depth, long bytes)
        => depth > _queueCapacity
            ? "connection_frame_budget"
            : bytes > _queueByteCapacity
                ? "connection_byte_budget"
                : "connection_age_budget";

    private bool AcceptQueued(
        NotificationStreamDeliveryPolicy policy,
        long eventId,
        long coalescedOccurrences,
        int depth,
        long bytes,
        TimeSpan oldestAge)
    {
        if (eventId > 0)
        {
            InterlockedExtensions.Max(ref _lastCursor, eventId);
        }
        if (coalescedOccurrences > 0)
        {
            Interlocked.Add(ref _coalescedCount, coalescedOccurrences);
        }
        Touch();
        NotificationStreamMetrics.RecordQueueDepth(depth);
        NotificationStreamMetrics.RecordConnectionQueue(policy, depth, bytes, oldestAge);
        return true;
    }

    private bool RejectChannelWrite(
        SharedNotificationStreamFrame frame,
        NotificationStreamDeliveryPolicy policy,
        long eventId,
        bool durableBacklogAccepted)
    {
        RecordUndelivered(policy, "connection-channel-rejected", durableBacklogAccepted);
        frame.Release();
        RequireRecovery(policy, "connection_channel_rejected", eventId);
        return false;
    }

    private void RollBackLastAccountingUnderLock()
    {
        if (_queueAccounting.Count == 0)
        {
            return;
        }

        NotificationStreamQueuedFrameAccounting[] entries = _queueAccounting.ToArray();
        NotificationStreamQueuedFrameAccounting removed = entries[^1];
        _queueAccounting.Clear();
        for (int i = 0; i < entries.Length - 1; i++)
        {
            _queueAccounting.Enqueue(entries[i]);
        }

        _queuedFrames = Math.Max(0, _queuedFrames - 1);
        _queuedBytes = Math.Max(0, _queuedBytes - removed.Length);
    }

    private void Touch() => Volatile.Write(ref _lastActivityUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    private void RecordUndelivered(NotificationStreamDeliveryPolicy policy, string reason, bool durableBacklogAccepted)
        => RecordDelivery(
            replay: policy.LossPolicy == NotificationStreamLossPolicy.DiagnosticDrop || durableBacklogAccepted ? 0 : 1,
            transferred: policy.LossPolicy != NotificationStreamLossPolicy.DiagnosticDrop && durableBacklogAccepted ? 1 : 0,
            dropped: policy.LossPolicy == NotificationStreamLossPolicy.DiagnosticDrop ? 1 : 0,
            reason: reason);

    private void RecordDelivery(long queued = 0, long inFlight = 0, long completed = 0,
        long replay = 0, long transferred = 0, long dropped = 0, long terminal = 0, string? reason = null)
    {
        _aggregateDelivery?.Transition(queued, inFlight, completed, replay, transferred, dropped, terminal, reason);
        _delivery.Transition(queued, inFlight, completed, replay, transferred, dropped, terminal, reason);
    }
}

internal sealed class NotificationStreamWriteLease(
    NotificationStreamConnection owner,
    SharedNotificationStreamFrame frame,
    NotificationStreamQueuedFrameAccounting accounting)
{
    internal NotificationStreamConnection Owner { get; } = owner;
    internal SharedNotificationStreamFrame Frame { get; } = frame;
    internal NotificationStreamQueuedFrameAccounting Accounting { get; } = accounting;
    private int _completed;

    internal bool TryComplete() => Interlocked.Exchange(ref _completed, 1) == 0;
}

internal readonly record struct NotificationStreamQueuedFrameAccounting(
    int Length,
    DateTimeOffset EnqueuedAtUtc,
    NotificationStreamDeliveryPolicy Policy,
    long EventId,
    bool DurableBacklogAccepted);

internal static class InterlockedExtensions
{
    public static void Max(ref long location, long value)
    {
        long current = Volatile.Read(ref location);
        while (value > current)
        {
            long observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }
}

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
        ILogger<NotificationStreamConnectionManager>? logger = null)
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
    {
        // Consumes one caller-transferred retain on every path:
        // success queues it for the writer, failure releases it here.
        if (Volatile.Read(ref _closed) == 1)
        {
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
            if (depth > _queueCapacity || bytes > _queueByteCapacity || oldestAge > maximumAge)
            {
                RejectForBudget(frame, policy, eventId, depth, bytes, oldestAge);
                return false;
            }

            _queueAccounting.Enqueue(new NotificationStreamQueuedFrameAccounting(frame.Length, now, policy, eventId));
            Volatile.Write(ref _queuedFrames, depth);
            Volatile.Write(ref _queuedBytes, bytes);
            queued = _queue.Writer.TryWrite(frame);
            if (!queued)
            {
                RollBackLastAccountingUnderLock();
            }
        }

        return queued
            ? AcceptQueued(policy, eventId, coalescedOccurrences, depth, bytes, oldestAge)
            : RejectChannelWrite(frame, policy, eventId);
    }

    public void AcknowledgeDequeuedFrame()
    {
        lock (_queueAccountingGate)
        {
            if (_queueAccounting.TryDequeue(out NotificationStreamQueuedFrameAccounting accounting))
            {
                _queuedFrames = Math.Max(0, _queuedFrames - 1);
                _queuedBytes = Math.Max(0, _queuedBytes - accounting.Length);
            }
        }

        Touch();
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
        while (_queue.Reader.TryRead(out SharedNotificationStreamFrame? frame))
        {
            AcknowledgeDequeuedFrame();
            frame.Release();
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
        TimeSpan oldestAge)
    {
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
        long eventId)
    {
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
}

internal readonly record struct NotificationStreamQueuedFrameAccounting(
    int Length,
    DateTimeOffset EnqueuedAtUtc,
    NotificationStreamDeliveryPolicy Policy,
    long EventId);

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

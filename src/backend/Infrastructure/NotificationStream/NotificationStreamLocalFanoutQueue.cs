using System.Threading.Channels;

using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal readonly record struct NotificationStreamFanoutLaneSnapshot(
    int LosslessQueued,
    int StateQueued,
    int LowQueued,
    long CoalescedCount,
    long DroppedCount,
    long Sequence);

public enum NotificationStreamFanoutEnqueueStatus
{
    Enqueued,
    Coalesced,
    ReplayRequired,
    DiagnosticDropped
}

public readonly record struct NotificationStreamFanoutEnqueueResult(
    NotificationStreamFanoutEnqueueStatus Status,
    string Reason)
{
    public bool Accepted => Status is NotificationStreamFanoutEnqueueStatus.Enqueued or NotificationStreamFanoutEnqueueStatus.Coalesced;

    internal NotificationStreamFanoutInputIdentity Input
    {
        get; init;
    }

    internal NotificationStreamFanoutInputIdentity? RetainedPending
    {
        get; init;
    }

    internal NotificationStreamFanoutInputIdentity? SupersededPending
    {
        get; init;
    }

    internal NotificationStreamFanoutInputDisposition InputDisposition
    {
        get; init;
    }
}

internal readonly record struct NotificationStreamFanoutInputIdentity(
    Guid QueueId,
    long InputId,
    long EventId,
    NotificationStreamTarget Target,
    NotificationStreamDeliveryPolicy Policy,
    string CoalescingKey);

internal enum NotificationStreamFanoutInputDisposition
{
    Pending,
    DuplicateOfPending,
    DurableBacklogTransferred,
    NotAdmitted,
    DiagnosticDropped
}

public sealed class NotificationStreamLocalFanoutQueue
{
    private readonly Guid _queueId = Guid.NewGuid();
    private long _nextInputId;
    private readonly Channel<NotificationStreamLocalFanoutWorkItem> _lossless;
    private readonly Channel<string> _stateKeys;
    private readonly Channel<string> _lowKeys;
    private readonly object _stateGate = new();
    private readonly object _lowGate = new();
    private readonly Dictionary<string, NotificationStreamLocalFanoutWorkItem> _stateLatest = new(StringComparer.Ordinal);
    private readonly Dictionary<string, NotificationStreamLocalFanoutWorkItem> _lowLatest = new(StringComparer.Ordinal);
    private readonly int _losslessCapacity;
    private readonly int _stateCapacity;
    private readonly int _lowCapacity;
    private readonly long _losslessByteBudget;
    private readonly long _stateByteBudget;
    private readonly long _lowByteBudget;
    private long _losslessBytes;
    private long _stateBytes;
    private long _lowBytes;
    private long _coalescedCount;
    private long _droppedCount;
    private int _nextLane;
    private readonly object _deliveryGate = new();
    private readonly NotificationStreamDeliveryAccounting _delivery = new();

    internal NotificationStreamDeliverySnapshot DeliverySnapshot => _delivery.Snapshot();

    internal NotificationStreamFanoutLaneSnapshot LaneSnapshot()
        => new(
            _lossless.Reader.CanCount ? _lossless.Reader.Count : 0,
            _stateKeys.Reader.CanCount ? _stateKeys.Reader.Count : 0,
            _lowKeys.Reader.CanCount ? _lowKeys.Reader.Count : 0,
            Volatile.Read(ref _coalescedCount),
            Volatile.Read(ref _droppedCount),
            DeliverySnapshot.Sequence);

    public NotificationStreamLocalFanoutQueue(IConfiguration configuration)
    {
        int legacyCapacity = Math.Clamp(configuration.GetValue<int?>("NotificationStream:LocalFanoutQueueCapacity") ?? 4096, 12, 65_536);
        _losslessCapacity = NormalizeCapacity(configuration.GetValue<int?>("NotificationStream:Fanout:LosslessFrameCapacity"), legacyCapacity / 2);
        _stateCapacity = NormalizeCapacity(configuration.GetValue<int?>("NotificationStream:Fanout:StateFrameCapacity"), legacyCapacity / 3);
        _lowCapacity = NormalizeCapacity(configuration.GetValue<int?>("NotificationStream:Fanout:LowFrameCapacity"), legacyCapacity / 6);
        _losslessByteBudget = NormalizeByteBudget(configuration.GetValue<long?>("NotificationStream:Fanout:LosslessByteBudget"), 4L * 1024 * 1024);
        _stateByteBudget = NormalizeByteBudget(configuration.GetValue<long?>("NotificationStream:Fanout:StateByteBudget"), 2L * 1024 * 1024);
        _lowByteBudget = NormalizeByteBudget(configuration.GetValue<long?>("NotificationStream:Fanout:LowByteBudget"), 512L * 1024);
        _lossless = CreateWorkChannel(_losslessCapacity);
        _stateKeys = CreateKeyChannel(_stateCapacity);
        _lowKeys = CreateKeyChannel(_lowCapacity);
    }

    public NotificationStreamFanoutEnqueueResult TryEnqueue(
        SharedNotificationStreamFrame frame,
        NotificationStreamTarget target,
        NotificationStreamDeliveryPolicy policy,
        string coalescingKey,
        long eventId,
        TimeProvider? timeProvider = null)
        => TryEnqueue(frame, target, policy, coalescingKey, eventId, null, timeProvider);

    internal NotificationStreamFanoutEnqueueResult TryEnqueue(
        SharedNotificationStreamFrame frame,
        NotificationStreamTarget target,
        NotificationStreamDeliveryPolicy policy,
        string coalescingKey,
        long eventId,
        NotificationStreamBacklogAcceptance? acceptance,
        TimeProvider? timeProvider = null)
    {
        DateTimeOffset now = (timeProvider ?? TimeProvider.System).GetUtcNow();
        lock (_deliveryGate)
        {
            var identity = new NotificationStreamFanoutInputIdentity(
                _queueId,
                checked(++_nextInputId),
                eventId,
                target,
                policy,
                coalescingKey);
            var item = new NotificationStreamLocalFanoutWorkItem(frame, target, policy, coalescingKey,
                eventId, now, Acceptance: acceptance, Identity: identity);
            NotificationStreamFanoutEnqueueResult result = policy.Priority switch
            {
                NotificationStreamPriorityClass.Lossless => TryEnqueueLossless(item),
                NotificationStreamPriorityClass.State => TryEnqueueLatest(item, _stateLatest, _stateKeys, _stateGate, _stateCapacity, _stateByteBudget, ref _stateBytes),
                NotificationStreamPriorityClass.Low => TryEnqueueLatest(item, _lowLatest, _lowKeys, _lowGate, _lowCapacity, _lowByteBudget, ref _lowBytes),
                _ => throw new InvalidOperationException($"Unknown notification stream priority: {policy.Priority}.")
            };
            if (result.Status == NotificationStreamFanoutEnqueueStatus.Enqueued)
            {
                _delivery.Transition(queued: 1);
                result = result with { RetainedPending = identity };
            }
            else if (!result.Accepted)
            {
                RecordUndelivered(item, result.Reason);
                result = result with
                {
                    InputDisposition = item.Policy.LossPolicy == NotificationStreamLossPolicy.DiagnosticDrop
                        ? NotificationStreamFanoutInputDisposition.DiagnosticDropped
                        : item.Acceptance?.Matches(item.EventId, item.Target) == true
                            ? NotificationStreamFanoutInputDisposition.DurableBacklogTransferred
                            : NotificationStreamFanoutInputDisposition.NotAdmitted
                };
            }

            return result with { Input = identity };
        }
    }

    public long CoalescedCount => Volatile.Read(ref _coalescedCount);

    public long DroppedCount => Volatile.Read(ref _droppedCount);

    internal async ValueTask<NotificationStreamLocalFanoutWorkItem> DequeueAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            int start = Interlocked.Increment(ref _nextLane);
            for (int offset = 0; offset < 3; offset++)
            {
                int lane = (start + offset) % 3;
                lock (_deliveryGate)
                {
                    if (TryDequeueLane(lane, out NotificationStreamLocalFanoutWorkItem item))
                    {
                        _delivery.Transition(queued: -1, inFlight: 1);
                        return item;
                    }
                }
            }

            Task<bool> losslessReady = _lossless.Reader.WaitToReadAsync(cancellationToken).AsTask();
            Task<bool> stateReady = _stateKeys.Reader.WaitToReadAsync(cancellationToken).AsTask();
            Task<bool> lowReady = _lowKeys.Reader.WaitToReadAsync(cancellationToken).AsTask();
            await Task.WhenAny(losslessReady, stateReady, lowReady).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }
    }

    private NotificationStreamFanoutEnqueueResult TryEnqueueLossless(NotificationStreamLocalFanoutWorkItem item)
    {
        long bytes = Interlocked.Add(ref _losslessBytes, item.Frame.Length);
        if (bytes > _losslessByteBudget)
        {
            Interlocked.Add(ref _losslessBytes, -item.Frame.Length);
            return Reject(item.Policy, "lossless-byte-budget");
        }

        item.Frame.Retain();
        if (_lossless.Writer.TryWrite(item))
        {
            NotificationStreamMetrics.RecordFanoutLaneDepth(NotificationStreamPriorityClass.Lossless, _lossless.Reader.Count, bytes, TimeSpan.Zero);
            return new NotificationStreamFanoutEnqueueResult(NotificationStreamFanoutEnqueueStatus.Enqueued, "enqueued");
        }

        item.Frame.Release();
        Interlocked.Add(ref _losslessBytes, -item.Frame.Length);
        return Reject(item.Policy, "lossless-frame-budget");
    }

    internal void CompleteDelivery(NotificationStreamLocalFanoutWorkItem item, bool dispatched, bool terminal, string reason)
    {
        if (!dispatched)
        {
            RecordUndelivered(item, reason);
        }

        _delivery.Transition(inFlight: -1, fanoutExpanded: dispatched ? 1 : 0, terminal: terminal ? 1 : 0);
    }

    private void RecordUndelivered(NotificationStreamLocalFanoutWorkItem item, string reason)
    {
        bool diagnostic = item.Policy.LossPolicy == NotificationStreamLossPolicy.DiagnosticDrop;
        bool accepted = item.Acceptance?.Matches(item.EventId, item.Target) == true;
        _delivery.Transition(
            replay: !diagnostic && !accepted ? 1 : 0,
            transferred: !diagnostic && accepted ? 1 : 0,
            dropped: diagnostic ? 1 : 0,
            reason: reason);
    }

    private NotificationStreamFanoutEnqueueResult TryEnqueueLatest(
        NotificationStreamLocalFanoutWorkItem item,
        Dictionary<string, NotificationStreamLocalFanoutWorkItem> latest,
        Channel<string> keys,
        object gate,
        int capacity,
        long byteBudget,
        ref long queuedBytes)
    {
        lock (gate)
        {
            if (latest.TryGetValue(item.CoalescingKey, out NotificationStreamLocalFanoutWorkItem existing))
            {
                NotificationStreamFanoutEnqueueResult RejectPending(string reason)
                    => Reject(item.Policy, reason) with
                    {
                        RetainedPending = existing.Identity
                    };

                if (item.Target != existing.Target || item.Policy != existing.Policy)
                {
                    return RejectPending("coalescing-identity-conflict");
                }

                if (item.EventId <= 0 || existing.EventId <= 0)
                {
                    return RejectPending("coalescing-cursor-unavailable");
                }

                // The publisher appends to the scoped Redis backlog before admission.
                // Compare transport cursors only within this pending identity.
                if (item.EventId <= existing.EventId)
                {
                    if (item.EventId == existing.EventId
                        && !item.Frame.Memory.Span.SequenceEqual(existing.Frame.Memory.Span))
                    {
                        return RejectPending("coalescing-cursor-content-conflict");
                    }

                    bool duplicate = item.EventId == existing.EventId;
                    if (!duplicate && item.Acceptance?.Matches(item.EventId, item.Target) != true)
                    {
                        return RejectPending("stale-input-backlog-unproven");
                    }
                    if (!duplicate)
                    {
                        RecordUndelivered(item, "stale-input-durable-backlog");
                    }
                    latest[item.CoalescingKey] = existing with
                    {
                        CoalescedOccurrences = existing.CoalescedOccurrences + 1
                    };
                    Interlocked.Increment(ref _coalescedCount);
                    NotificationStreamMetrics.RecordFanoutCoalesced(item.Policy);
                    return new NotificationStreamFanoutEnqueueResult(
                        NotificationStreamFanoutEnqueueStatus.Coalesced, "latest-cursor-retained")
                    {
                        RetainedPending = existing.Identity,
                        InputDisposition = duplicate
                            ? NotificationStreamFanoutInputDisposition.DuplicateOfPending
                            : NotificationStreamFanoutInputDisposition.DurableBacklogTransferred
                    };
                }

                // A newer input's proof cannot retire this independently owned pending item.
                if (existing.Acceptance?.Matches(existing.EventId, existing.Target) != true)
                {
                    return RejectPending("pending-backlog-unproven");
                }
                long nextBytes = queuedBytes - existing.Frame.Length + item.Frame.Length;
                if (nextBytes > byteBudget)
                {
                    return RejectPending("coalesced-byte-budget");
                }

                item = item with
                {
                    CoalescedOccurrences = existing.CoalescedOccurrences + 1
                };
                item.Frame.Retain();
                latest[item.CoalescingKey] = item;
                queuedBytes = nextBytes;
                RecordUndelivered(existing, "superseded-pending-durable-backlog");
                existing.Frame.Release();
                Interlocked.Increment(ref _coalescedCount);
                NotificationStreamMetrics.RecordFanoutCoalesced(item.Policy);
                return new NotificationStreamFanoutEnqueueResult(NotificationStreamFanoutEnqueueStatus.Coalesced, "latest-state-replaced")
                {
                    RetainedPending = item.Identity,
                    SupersededPending = existing.Identity
                };
            }

            if (latest.Count >= capacity || queuedBytes + item.Frame.Length > byteBudget)
            {
                return Reject(item.Policy, latest.Count >= capacity ? "lane-frame-budget" : "lane-byte-budget");
            }

            item.Frame.Retain();
            latest.Add(item.CoalescingKey, item);
            queuedBytes += item.Frame.Length;
            if (keys.Writer.TryWrite(item.CoalescingKey))
            {
                NotificationStreamMetrics.RecordFanoutLaneDepth(item.Policy.Priority, latest.Count, queuedBytes, TimeSpan.Zero);
                return new NotificationStreamFanoutEnqueueResult(NotificationStreamFanoutEnqueueStatus.Enqueued, "enqueued");
            }

            latest.Remove(item.CoalescingKey);
            queuedBytes -= item.Frame.Length;
            item.Frame.Release();
            return Reject(item.Policy, "lane-frame-budget");
        }
    }

    private bool TryDequeueLane(int lane, out NotificationStreamLocalFanoutWorkItem item)
    {
        if (lane == 0 && _lossless.Reader.TryRead(out item))
        {
            Interlocked.Add(ref _losslessBytes, -item.Frame.Length);
            return true;
        }

        if (lane == 1 && TryDequeueLatest(_stateLatest, _stateKeys, _stateGate, ref _stateBytes, out item))
        {
            return true;
        }

        if (lane == 2 && TryDequeueLatest(_lowLatest, _lowKeys, _lowGate, ref _lowBytes, out item))
        {
            return true;
        }

        item = default;
        return false;
    }

    private static bool TryDequeueLatest(
        Dictionary<string, NotificationStreamLocalFanoutWorkItem> latest,
        Channel<string> keys,
        object gate,
        ref long queuedBytes,
        out NotificationStreamLocalFanoutWorkItem item)
    {
        while (keys.Reader.TryRead(out string? key))
        {
            lock (gate)
            {
                if (!latest.Remove(key, out item))
                {
                    continue;
                }

                queuedBytes -= item.Frame.Length;
                return true;
            }
        }

        item = default;
        return false;
    }

    private NotificationStreamFanoutEnqueueResult Reject(NotificationStreamDeliveryPolicy policy, string reason)
    {
        Interlocked.Increment(ref _droppedCount);
        bool diagnostic = policy.LossPolicy == NotificationStreamLossPolicy.DiagnosticDrop;
        NotificationStreamMetrics.RecordFanoutDropped(policy, reason);
        return new NotificationStreamFanoutEnqueueResult(
            diagnostic ? NotificationStreamFanoutEnqueueStatus.DiagnosticDropped : NotificationStreamFanoutEnqueueStatus.ReplayRequired,
            reason);
    }

    private static Channel<NotificationStreamLocalFanoutWorkItem> CreateWorkChannel(int capacity)
        => Channel.CreateBounded<NotificationStreamLocalFanoutWorkItem>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false
        });

    private static Channel<string> CreateKeyChannel(int capacity)
        => Channel.CreateBounded<string>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false
        });

    private static int NormalizeCapacity(int? configured, int fallback)
        => Math.Clamp(configured.GetValueOrDefault(Math.Max(4, fallback)), 4, 65_536);

    private static long NormalizeByteBudget(long? configured, long fallback)
        => Math.Clamp(configured.GetValueOrDefault(fallback), 4 * 1024, 256L * 1024 * 1024);
}

internal readonly record struct NotificationStreamLocalFanoutWorkItem(
    SharedNotificationStreamFrame Frame,
    NotificationStreamTarget Target,
    NotificationStreamDeliveryPolicy Policy,
    string CoalescingKey,
    long EventId,
    DateTimeOffset EnqueuedAtUtc,
    long CoalescedOccurrences = 0,
    NotificationStreamBacklogAcceptance? Acceptance = null,
    NotificationStreamFanoutInputIdentity Identity = default);

public sealed class NotificationStreamLocalFanoutWorker(
    NotificationStreamLocalFanoutQueue queue,
    NotificationStreamConnectionManager connectionManager,
    ILogger<NotificationStreamLocalFanoutWorker> logger,
    TimeProvider timeProvider) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await ProcessOnceAsync(stoppingToken).ConfigureAwait(false);
        }
    }

    internal async Task ProcessOnceAsync(CancellationToken stoppingToken)
    {
        NotificationStreamLocalFanoutWorkItem item = await queue.DequeueAsync(stoppingToken).ConfigureAwait(false);
        bool dispatched = false;
        bool terminal = false;
        string reason = "local-fanout-incomplete";
        try
        {
            stoppingToken.ThrowIfCancellationRequested();
            TimeSpan age = timeProvider.GetUtcNow() - item.EnqueuedAtUtc;
            if (age > item.Policy.MaximumUsefulAge)
            {
                connectionManager.RequireRecovery(
                    item.Target,
                    item.Policy,
                    item.EventId,
                    "local_fanout_max_age");
                NotificationStreamMetrics.RecordFanoutExpired(item.Policy, age);
                reason = "local_fanout_max_age";
                return;
            }

            NotificationStreamMetrics.RecordFanoutLatency(age, item.Target);
            NotificationStreamFanoutDispatchResult delivered = connectionManager.Publish(
                item.Frame,
                item.Target,
                item.Policy,
                item.EventId,
                item.CoalescedOccurrences,
                item.Acceptance);
            dispatched = delivered.Rejected == 0;
            reason = dispatched ? "local-fanout-dispatched" : "local-fanout-admission-rejected";
            logger.LogDebug("notification-stream-local-fanout-delivered {Delivered} {Priority}", delivered.Accepted, item.Policy.Priority);
        }
        catch (Exception ex)
        {
            reason = stoppingToken.IsCancellationRequested ? "local-fanout-cancelled" : "local-fanout-failed";
            try
            {
                connectionManager.RequireRecovery(item.Target, item.Policy, item.EventId, reason);
            }
            catch (Exception recoveryException)
            {
                terminal = true;
                logger.LogError(recoveryException, "notification-stream-local-fanout-recovery-failed");
            }
            logger.LogWarning(ex, "notification-stream-local-fanout-failed");
        }
        finally
        {
            try
            {
                queue.CompleteDelivery(item, dispatched, terminal, reason);
            }
            finally
            {
                item.Frame.Release();
            }
        }
    }
}

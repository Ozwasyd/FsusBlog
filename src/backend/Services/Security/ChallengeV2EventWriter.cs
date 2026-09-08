using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Security;

public sealed class ChallengeV2EventWriterOptions
{
    public const string SectionName = "Security:ChallengeV2EventWriter";

    public int Capacity { get; set; } = 20_000;

    public int HighValueCapacity { get; set; } = 1_024;

    public int BatchSize { get; set; } = 256;

    public int FlushWindowMs { get; set; } = 500;
}

public readonly record struct ChallengeV2EventKind(string Value, bool IsHighValue)
{
    public static ChallengeV2EventKind Success { get; } = new("success", false);
    public static ChallengeV2EventKind Failure { get; } = new("failure", false);
    public static ChallengeV2EventKind Replay { get; } = new("replay", true);
    public static ChallengeV2EventKind AttemptExceeded { get; } = new("attempt_exceeded", true);
    public static ChallengeV2EventKind Expired { get; } = new("expired", true);
    public static ChallengeV2EventKind PolicyBlock { get; } = new("policy_block", true);
    public static ChallengeV2EventKind Admin { get; } = new("admin", true);

    public static ChallengeV2EventKind FromAttempt(string outcome, string? reason, string? action)
    {
        string normalizedOutcome = Normalize(outcome);
        string normalizedReason = Normalize(reason);
        string normalizedAction = Normalize(action);

        if (normalizedAction.StartsWith("admin.", StringComparison.Ordinal) ||
            normalizedAction.Contains(":admin", StringComparison.Ordinal) ||
            normalizedAction.Contains("/admin", StringComparison.Ordinal))
        {
            return Admin;
        }

        if (string.Equals(normalizedOutcome, SecurityChallengeAttemptOutcomes.Verified, StringComparison.Ordinal))
        {
            return Success;
        }

        if (string.Equals(normalizedOutcome, SecurityChallengeAttemptOutcomes.Replayed, StringComparison.Ordinal) ||
            normalizedReason.Contains("replay", StringComparison.Ordinal))
        {
            return Replay;
        }

        if (string.Equals(normalizedOutcome, SecurityChallengeAttemptOutcomes.Expired, StringComparison.Ordinal) ||
            normalizedReason.Contains("expired", StringComparison.Ordinal))
        {
            return Expired;
        }

        if (normalizedReason.Contains("attempt_exceeded", StringComparison.Ordinal) ||
            normalizedReason.Contains("attempt-exceeded", StringComparison.Ordinal))
        {
            return AttemptExceeded;
        }

        if (normalizedReason.Contains("policy_block", StringComparison.Ordinal) ||
            normalizedReason.Contains("policy-block", StringComparison.Ordinal) ||
            normalizedReason.Contains("blocked", StringComparison.Ordinal))
        {
            return PolicyBlock;
        }

        return Failure;
    }

    private static string Normalize(string? value)
        => TextHelpers.LowerTrimmed(value) ?? string.Empty;
}

public sealed record ChallengeV2AuditEvent(
    SecurityChallengeAttemptRequest Attempt,
    ChallengeV2EventKind EventKind,
    string ChallengeKind,
    string Action,
    bool IsHighValue)
{
    public static ChallengeV2AuditEvent FromAttempt(
        SecurityChallengeAttemptRequest attempt,
        ChallengeV2EventKind eventKind,
        string challengeKind,
        string action)
        => new(
            EnsureAttemptId(attempt),
            eventKind,
            Normalize(challengeKind, 64),
            Normalize(action, 96),
            eventKind.IsHighValue);

    private static string Normalize(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static SecurityChallengeAttemptRequest EnsureAttemptId(SecurityChallengeAttemptRequest attempt)
        => !string.IsNullOrWhiteSpace(attempt.AttemptId)
            ? attempt
            : attempt with
            {
                AttemptId = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(
                    '\0',
                    attempt.ChallengeId,
                    attempt.Outcome,
                    attempt.Reason,
                    attempt.PayloadHash,
                    attempt.ClientIpHash,
                    attempt.DeviceFpHash,
                    attempt.TraceId,
                    attempt.Traceparent,
                    attempt.AttemptedAtUtc?.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture))))).AsSpan(0, 32).ToString()
            };
}

public sealed record ChallengeV2AuditEventQueueSnapshot(
    long NormalQueuedCount,
    long HighValueQueuedCount,
    long DroppedLowValueCount,
    long DroppedHighValueCount,
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
    public long OutstandingCount => Math.Max(0, NormalQueuedCount)
        + Math.Max(0, HighValueQueuedCount)
        + Math.Max(0, InFlightCount)
        + Math.Max(0, DurablePendingCount)
        + Math.Max(0, TerminalFailureCount);
}

public interface IChallengeV2AuditEventWriter
{
    ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default);
}

public sealed class ChallengeV2AuditEventQueue : IChallengeV2AuditEventWriter
{
    private readonly Channel<ChallengeV2AuditEvent> _normal;
    private readonly Channel<ChallengeV2AuditEvent> _highValue;
    private readonly IServiceScopeFactory? _scopeFactory;
    private readonly ILogger<ChallengeV2AuditEventQueue> _logger;
    private long _normalQueuedCount;
    private long _highValueQueuedCount;
    private long _droppedLowValueCount;
    private long _droppedHighValueCount;
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

    public ChallengeV2AuditEventQueue(
        IOptions<ChallengeV2EventWriterOptions> options,
        ILogger<ChallengeV2AuditEventQueue> logger,
        IServiceScopeFactory? scopeFactory = null)
    {
        ChallengeV2EventWriterOptions value = options.Value;
        _logger = logger;
        _scopeFactory = scopeFactory;
        _normal = CreateChannel(Math.Clamp(value.Capacity, 1, 1_000_000));
        _highValue = CreateChannel(Math.Clamp(value.HighValueCapacity, 1, 1_000_000));
    }

    public ChannelReader<ChallengeV2AuditEvent> NormalReader => _normal.Reader;

    public ChannelReader<ChallengeV2AuditEvent> HighValueReader => _highValue.Reader;

    public async ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            await WriteFallbackAsync(auditEvent, CancellationToken.None).ConfigureAwait(false);
            return;
        }

        Channel<ChallengeV2AuditEvent> channel = auditEvent.IsHighValue ? _highValue : _normal;
        if (Volatile.Read(ref _completed) == 0 && channel.Writer.TryWrite(auditEvent))
        {
            if (auditEvent.IsHighValue)
            {
                Interlocked.Increment(ref _highValueQueuedCount);
            }
            else
            {
                Interlocked.Increment(ref _normalQueuedCount);
            }

            SetDisposition("queued", ItemReference(auditEvent));

            return;
        }

        Interlocked.Increment(ref _rejectedCount);
        if (_scopeFactory is not null)
        {
            await WriteFallbackAsync(auditEvent, CancellationToken.None).ConfigureAwait(false);
            return;
        }

        if (auditEvent.IsHighValue)
        {
            Interlocked.Increment(ref _droppedHighValueCount);
            _logger.LogError(
                "challenge-v2-audit-event-fallback ChallengeId={ChallengeId} Kind={Kind} Action={Action} EventKind={EventKind} Reason={Reason}",
                auditEvent.Attempt.ChallengeId,
                auditEvent.ChallengeKind,
                auditEvent.Action,
                auditEvent.EventKind.Value,
                auditEvent.Attempt.Reason);
        }
        else
        {
            Interlocked.Increment(ref _droppedLowValueCount);
            _logger.LogWarning(
                "challenge-v2-audit-event-dropped ChallengeId={ChallengeId} Kind={Kind} Action={Action} EventKind={EventKind} Reason={Reason}",
                auditEvent.Attempt.ChallengeId,
                auditEvent.ChallengeKind,
                auditEvent.Action,
                auditEvent.EventKind.Value,
                auditEvent.Attempt.Reason);
        }

        MarkTerminalFailure(1, ItemReference(auditEvent), "admission-rejected:fallback-unavailable");

        return;
    }

    public bool TryRead(out ChallengeV2AuditEvent? auditEvent)
    {
        if (_highValue.Reader.TryRead(out ChallengeV2AuditEvent? high))
        {
            MarkRead(ref _highValueQueuedCount);
            Interlocked.Increment(ref _inFlightCount);
            SetDisposition("in-flight", ItemReference(high));
            auditEvent = high;
            return true;
        }

        if (_normal.Reader.TryRead(out ChallengeV2AuditEvent? normal))
        {
            MarkRead(ref _normalQueuedCount);
            Interlocked.Increment(ref _inFlightCount);
            SetDisposition("in-flight", ItemReference(normal));
            auditEvent = normal;
            return true;
        }

        auditEvent = null;
        return false;
    }

    public async ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        if (_highValue.Reader.TryPeek(out _) || _normal.Reader.TryPeek(out _))
        {
            return true;
        }

        Task<bool> highTask = _highValue.Reader.WaitToReadAsync(cancellationToken).AsTask();
        Task<bool> normalTask = _normal.Reader.WaitToReadAsync(cancellationToken).AsTask();
        Task completed = await Task.WhenAny(highTask, normalTask);
        return await (Task<bool>)completed;
    }

    public ChallengeV2AuditEventQueueSnapshot Snapshot()
        => new(
            Volatile.Read(ref _normalQueuedCount),
            Volatile.Read(ref _highValueQueuedCount),
            Volatile.Read(ref _droppedLowValueCount),
            Volatile.Read(ref _droppedHighValueCount),
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

    public void Complete(Exception? error = null)
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
        {
            return;
        }

        _highValue.Writer.TryComplete(error);
        _normal.Writer.TryComplete(error);
        SetDisposition("closed", error?.Message);
    }

    internal void MarkCommitted(int count)
    {
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _committedCount, Math.Max(0, count));
        SetDisposition("committed", null);
    }

    internal void MarkDurablePending(int count)
    {
        Interlocked.Add(ref _durablePendingCount, Math.Max(0, count));
        SetDisposition("durable-pending", null);
    }

    internal void MarkDurableAccepted(int count)
    {
        Decrement(ref _durablePendingCount, count);
        Decrement(ref _inFlightCount, count);
        Interlocked.Add(ref _durableAcceptedCount, Math.Max(0, count));
        SetDisposition("durable-accepted", null);
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

    internal bool TryRequeue(ChallengeV2AuditEvent auditEvent)
    {
        Channel<ChallengeV2AuditEvent> channel = auditEvent.IsHighValue ? _highValue : _normal;
        if (!channel.Writer.TryWrite(auditEvent))
        {
            return false;
        }

        if (auditEvent.IsHighValue)
        {
            Interlocked.Increment(ref _highValueQueuedCount);
        }
        else
        {
            Interlocked.Increment(ref _normalQueuedCount);
        }

        Decrement(ref _inFlightCount, 1);
        Interlocked.Increment(ref _requeuedCount);
        SetDisposition("requeued", ItemReference(auditEvent));
        return true;
    }

    internal async Task WriteFallbackAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken)
    {
        MarkDurablePending(1);
        try
        {
            await using AsyncServiceScope scope = _scopeFactory is null
                ? throw new InvalidOperationException("challenge-v2 durable fallback unavailable")
                : _scopeFactory.CreateAsyncScope();
            ISecurityChallengePersistenceService persistence = scope.ServiceProvider.GetRequiredService<ISecurityChallengePersistenceService>();
            await persistence.RecordAttemptAsync(auditEvent.Attempt, cancellationToken).ConfigureAwait(false);
            MarkDurableAccepted(1);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            MarkDurableFailed(1, ItemReference(auditEvent), $"fallback-failed:{ex.GetType().Name}");
            _logger.LogError(ex, "challenge-v2 durable admission fallback failed. ChallengeId={ChallengeId}", auditEvent.Attempt.ChallengeId);
            throw new InvalidOperationException($"challenge-v2 durable fallback failed for {auditEvent.Attempt.ChallengeId}", ex);
        }
        catch (OperationCanceledException)
        {
            MarkDurableFailed(1, ItemReference(auditEvent), "fallback-cancelled");
            throw;
        }
    }

    private static string ItemReference(ChallengeV2AuditEvent auditEvent)
        => auditEvent.Attempt.AttemptId ?? auditEvent.Attempt.ChallengeId;

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

    private static Channel<ChallengeV2AuditEvent> CreateChannel(int capacity)
        => Channel.CreateBounded<ChallengeV2AuditEvent>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

    private static void MarkRead(ref long counter)
    {
        long current;
        do
        {
            current = Volatile.Read(ref counter);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref counter, current - 1, current) != current);
    }
}

public sealed class DirectChallengeV2AuditEventWriter(ISecurityChallengePersistenceService persistence) : IChallengeV2AuditEventWriter
{
    public async ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
        => await persistence.RecordAttemptAsync(auditEvent.Attempt, cancellationToken);
}

public sealed class ChallengeV2AuditEventWriterWorker(
    ChallengeV2AuditEventQueue queue,
    IServiceScopeFactory scopeFactory,
    IOptions<ChallengeV2EventWriterOptions> options,
    ILogger<ChallengeV2AuditEventWriterWorker> logger) : BackgroundService
{
    private readonly ChallengeV2AuditEventQueue _queue = queue;
    private readonly IServiceScopeFactory _scopeFactory = scopeFactory;
    private readonly ILogger<ChallengeV2AuditEventWriterWorker> _logger = logger;
    private readonly int _batchSize = Math.Clamp(options.Value.BatchSize, 1, 10_000);
    private readonly TimeSpan _flushWindow = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.FlushWindowMs, 1, 60_000));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var batch = new List<ChallengeV2AuditEvent>(_batchSize);
        bool persistenceStarted = false;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await _queue.WaitToReadAsync(stoppingToken))
                {
                    continue;
                }

                batch.Clear();
                if (!_queue.TryRead(out ChallengeV2AuditEvent? first) || first is null)
                {
                    continue;
                }

                batch.Add(first);
                await FillBatchUntilFlushWindowAsync(batch, stoppingToken);
                persistenceStarted = true;
                await PersistSafelyAsync(batch, stoppingToken);
                persistenceStarted = false;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                if (!persistenceStarted)
                {
                    RequeueOrTerminal(batch, "writer-cancelled");
                }
                break;
            }
            catch (Exception ex)
            {
                RequeueOrTerminal(batch, "worker-exception");
                _logger.LogError(ex, "challenge-v2-audit writer loop recovered from an unexpected failure.");
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await DrainRemainingAsync(drainCts.Token);
    }

    public async Task<int> FlushOnceAsync(CancellationToken cancellationToken)
    {
        var batch = new List<ChallengeV2AuditEvent>(_batchSize);
        while (batch.Count < _batchSize && _queue.TryRead(out ChallengeV2AuditEvent? auditEvent) && auditEvent is not null)
        {
            batch.Add(auditEvent);
        }

        if (batch.Count == 0)
        {
            return 0;
        }

        await PersistSafelyAsync(batch, cancellationToken);
        return batch.Count;
    }

    internal async Task PersistSafelyAsync(IReadOnlyList<ChallengeV2AuditEvent> batch, CancellationToken cancellationToken)
    {
        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                _scopeFactory,
                "challenge_v2_audit_flush");
            ISecurityChallengePersistenceService persistence = scope.ServiceProvider.GetRequiredService<ISecurityChallengePersistenceService>();
            for (int i = 0; i < batch.Count; i++)
            {
                ChallengeV2AuditEvent item = batch[i];
                try
                {
                    await persistence.RecordAttemptAsync(item.Attempt, cancellationToken);
                    _queue.MarkCommitted(1);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    RequeueOrTerminal(batch.Skip(i), "persist-cancelled");
                    throw;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    if (!_queue.TryRequeue(item))
                    {
                        _queue.MarkTerminalFailure(1, item.Attempt.AttemptId, $"worker-failure:{ex.GetType().Name}");
                    }

                    _logger.LogWarning(
                        ex,
                        "challenge-v2-audit-event-persist-failed ChallengeId={ChallengeId} AttemptId={AttemptId} EventKind={EventKind}",
                        item.Attempt.ChallengeId,
                        item.Attempt.AttemptId,
                        item.EventKind.Value);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RequeueOrTerminal(batch, "worker-failure");
            ChallengeV2AuditEvent first = batch[0];
            _logger.LogWarning(
                ex,
                "challenge-v2-audit-event-persist-failed Count={Count} ChallengeId={ChallengeId} Kind={Kind} Action={Action} EventKind={EventKind} Reason={Reason}",
                batch.Count,
                first.Attempt.ChallengeId,
                first.ChallengeKind,
                first.Action,
                first.EventKind.Value,
                first.Attempt.Reason);
        }
    }

    private void RequeueOrTerminal(IEnumerable<ChallengeV2AuditEvent> events, string reason)
    {
        foreach (ChallengeV2AuditEvent item in events)
        {
            if (!_queue.TryRequeue(item))
            {
                _queue.MarkTerminalFailure(1, item.Attempt.AttemptId, reason);
            }
        }
    }

    private async Task FillBatchUntilFlushWindowAsync(List<ChallengeV2AuditEvent> batch, CancellationToken stoppingToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        while (batch.Count < _batchSize)
        {
            while (batch.Count < _batchSize && _queue.TryRead(out ChallengeV2AuditEvent? ready) && ready is not null)
            {
                batch.Add(ready);
            }

            if (batch.Count >= _batchSize)
            {
                return;
            }

            TimeSpan remaining = _flushWindow - Stopwatch.GetElapsedTime(startedAt);
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            ValueTask<bool> waitToRead = _queue.WaitToReadAsync(stoppingToken);
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

    private async Task DrainRemainingAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            int flushed = await FlushOnceAsync(cancellationToken);
            if (flushed == 0)
            {
                return;
            }
        }
    }
}

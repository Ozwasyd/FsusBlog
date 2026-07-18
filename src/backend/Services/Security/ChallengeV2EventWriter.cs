using System.Diagnostics;
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
            attempt,
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
}

public sealed record ChallengeV2AuditEventQueueSnapshot(
    long NormalQueuedCount,
    long HighValueQueuedCount,
    long DroppedLowValueCount,
    long DroppedHighValueCount);

public interface IChallengeV2AuditEventWriter
{
    ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default);
}

public sealed class ChallengeV2AuditEventQueue : IChallengeV2AuditEventWriter
{
    private readonly Channel<ChallengeV2AuditEvent> _normal;
    private readonly Channel<ChallengeV2AuditEvent> _highValue;
    private readonly ILogger<ChallengeV2AuditEventQueue> _logger;
    private long _normalQueuedCount;
    private long _highValueQueuedCount;
    private long _droppedLowValueCount;
    private long _droppedHighValueCount;

    public ChallengeV2AuditEventQueue(
        IOptions<ChallengeV2EventWriterOptions> options,
        ILogger<ChallengeV2AuditEventQueue> logger)
    {
        ChallengeV2EventWriterOptions value = options.Value;
        _logger = logger;
        _normal = CreateChannel(Math.Clamp(value.Capacity, 1, 1_000_000));
        _highValue = CreateChannel(Math.Clamp(value.HighValueCapacity, 1, 1_000_000));
    }

    public ChannelReader<ChallengeV2AuditEvent> NormalReader => _normal.Reader;

    public ChannelReader<ChallengeV2AuditEvent> HighValueReader => _highValue.Reader;

    public ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Channel<ChallengeV2AuditEvent> channel = auditEvent.IsHighValue ? _highValue : _normal;
        if (channel.Writer.TryWrite(auditEvent))
        {
            if (auditEvent.IsHighValue)
            {
                Interlocked.Increment(ref _highValueQueuedCount);
            }
            else
            {
                Interlocked.Increment(ref _normalQueuedCount);
            }

            return ValueTask.CompletedTask;
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

        return ValueTask.CompletedTask;
    }

    public bool TryRead(out ChallengeV2AuditEvent? auditEvent)
    {
        if (_highValue.Reader.TryRead(out ChallengeV2AuditEvent? high))
        {
            MarkRead(ref _highValueQueuedCount);
            auditEvent = high;
            return true;
        }

        if (_normal.Reader.TryRead(out ChallengeV2AuditEvent? normal))
        {
            MarkRead(ref _normalQueuedCount);
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
            Volatile.Read(ref _droppedHighValueCount));

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
                await PersistSafelyAsync(batch, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
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
            foreach (ChallengeV2AuditEvent item in batch)
            {
                await persistence.RecordAttemptAsync(item.Attempt, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
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

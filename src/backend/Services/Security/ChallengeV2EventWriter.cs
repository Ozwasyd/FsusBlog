using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
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
            ChallengeV2DurableDelivery.Prepare(attempt),
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

public sealed class ChallengeV2AuditEventQueue : IChallengeV2AuditEventWriter, IDisposable
{
    private readonly Channel<ChallengeV2AuditEvent> _normal;
    private readonly Channel<ChallengeV2AuditEvent> _highValue;
    private readonly ChallengeV2FallbackWriter _journal;
    private readonly ILogger<ChallengeV2AuditEventQueue> _logger;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _ready = new(0, 1);
    private bool _completed;

    public ChallengeV2AuditEventQueue(
        IOptions<ChallengeV2EventWriterOptions> options,
        ILogger<ChallengeV2AuditEventQueue> logger,
        IServiceScopeFactory? scopeFactory = null,
        IConfiguration? configuration = null,
        IAuditRetentionEpochKeyStore? keys = null)
        : this(options, logger, CreateJournal(configuration, keys))
    {
    }

    internal ChallengeV2AuditEventQueue(IOptions<ChallengeV2EventWriterOptions> options,
        ILogger<ChallengeV2AuditEventQueue> logger, ChallengeV2FallbackWriter journal)
    {
        _journal = journal;
        _logger = logger;
        _normal = CreateChannel(Math.Clamp(options.Value.Capacity, 1, 1_000_000));
        _highValue = CreateChannel(Math.Clamp(options.Value.HighValueCapacity, 1, 1_000_000));
    }

    public ChannelReader<ChallengeV2AuditEvent> NormalReader => _normal.Reader;
    public ChannelReader<ChallengeV2AuditEvent> HighValueReader => _highValue.Reader;

    public async ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        // Request cancellation rejects only RAM scheduling, not a required event.
        // Admission is local protected I/O: no request-path SQL or HTTP decision.
        try
        {
            auditEvent = await WriteFallbackAsync(auditEvent).ConfigureAwait(false);
        }
        catch (Exception)
        {
            _logger.LogError("challenge-v2-audit-admission-failed QueueId={QueueId} Reason={Reason}",
                auditEvent.IsHighValue ? "challenge-audit-high-value" : "challenge-audit-normal", "admission-failed");
            throw;
        }
        lock (_gate)
        {
            if (_completed || cancellationToken.IsCancellationRequested)
            {
                _journal.MarkRejected(auditEvent);
            }
            else if (_journal.MarkQueued(auditEvent))
            {
                Channel<ChallengeV2AuditEvent> channel = auditEvent.IsHighValue ? _highValue : _normal;
                if (!channel.Writer.TryWrite(auditEvent))
                {
                    _journal.MarkRejected(auditEvent, removeQueued: true);
                }
            }
            Signal();
        }
    }

    public bool TryRead(out ChallengeV2AuditEvent? auditEvent)
    {
        lock (_gate)
        {
            if (!_journal.TryLeaseNext(out auditEvent, out bool queued))
            {
                return false;
            }
            if (queued)
            {
                ChallengeV2AuditEvent? scheduled;
                bool consumed = auditEvent!.IsHighValue
                    ? _highValue.Reader.TryRead(out scheduled) : _normal.Reader.TryRead(out scheduled);
                if (!consumed || scheduled is null
                    || scheduled.Attempt.AttemptId != auditEvent.Attempt.AttemptId)
                {
                    _journal.Return(auditEvent, "journal-invalid");
                    throw new InvalidDataException("challenge_audit_schedule_order_mismatch");
                }
            }
            return true;
        }
    }

    public async ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            lock (_gate)
            {
                if (_journal.HasAvailable)
                {
                    return true;
                }
                if (_completed)
                {
                    return false;
                }
            }
            await _ready.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    internal ChallengeV2LaneSnapshot LaneSnapshot(bool high) => _journal.Snapshot(high);

    public ChallengeV2AuditEventQueueSnapshot Snapshot()
    {
        ChallengeV2LaneSnapshot normal = _journal.Snapshot(false);
        ChallengeV2LaneSnapshot high = _journal.Snapshot(true);
        ChallengeV2LaneSnapshot last = high.TerminalFailureCount > 0 ? high
            : normal.TerminalFailureCount > 0 ? normal : high.Sequence >= normal.Sequence ? high : normal;
        return new(normal.QueuedCount, high.QueuedCount, 0, 0,
            normal.InFlightCount + high.InFlightCount, normal.DurablePendingCount + high.DurablePendingCount,
            normal.DurableAcceptedCount + high.DurableAcceptedCount, normal.CommittedCount + high.CommittedCount,
            normal.RequeuedCount + high.RequeuedCount, normal.RejectedCount + high.RejectedCount,
            normal.TerminalFailureCount + high.TerminalFailureCount, normal.Sequence + high.Sequence,
            last.LastDisposition, last.LastFailureReason, last.LastItemReference);
    }

    public void Complete(Exception? error = null)
    {
        lock (_gate)
        {
            _completed = true;
            _normal.Writer.TryComplete(error);
            _highValue.Writer.TryComplete(error);
            Signal();
        }
    }

    internal async Task MarkCommittedAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken)
    {
        await _journal.CommitAsync(auditEvent, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            Signal();
        }
    }

    internal Task<ChallengeV2AuditEvent> WriteFallbackAsync(ChallengeV2AuditEvent auditEvent)
        => _journal.AdmitAsync(auditEvent);

    internal bool TryRequeue(ChallengeV2AuditEvent auditEvent, string? failure = null)
    {
        lock (_gate)
        {
            bool returned = _journal.Return(auditEvent, failure);
            Signal();
            return returned;
        }
    }

    private void Signal()
    {
        if (_ready.CurrentCount == 0)
        {
            _ready.Release();
        }
    }

    private static ChallengeV2FallbackWriter CreateJournal(IConfiguration? configuration, IAuditRetentionEpochKeyStore? keys)
    {
        configuration ??= new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DATA_ROOT"] = Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
        }).Build();
        _ = ChallengeV2FallbackWriter.ValidateConfiguration(configuration);
        return new(configuration, keys ?? new LocalAuditRetentionEpochKeyStore(configuration));
    }

    private static Channel<ChallengeV2AuditEvent> CreateChannel(int capacity)
        => Channel.CreateBounded<ChallengeV2AuditEvent>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

    public void Dispose()
    {
        _journal.Dispose();
        _ready.Dispose();
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
                    break;
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
                if (_queue.Snapshot().TerminalFailureCount > 0)
                {
                    await Task.Delay(_flushWindow, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                if (!persistenceStarted)
                {
                    RequeueOrTerminal(batch, null);
                }
                break;
            }
            catch (Exception)
            {
                RequeueOrTerminal(batch, "journal-invalid");
                _logger.LogError("challenge-v2-audit writer failure. Reason={Reason}", "journal-invalid");
                await Task.Delay(_flushWindow, stoppingToken).ConfigureAwait(false);
            }
        }

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try
        {
            await DrainRemainingAsync(drainCts.Token);
        }
        catch (OperationCanceledException) when (drainCts.IsCancellationRequested)
        {
            // The original journal remains available for the next process.
        }
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

        return await PersistSafelyAsync(batch, cancellationToken).ConfigureAwait(false);
    }

    internal async Task<int> PersistSafelyAsync(IReadOnlyList<ChallengeV2AuditEvent> batch, CancellationToken cancellationToken)
    {
        int committed = 0;
        string failure = "scope-unavailable";
        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                _scopeFactory, "challenge_v2_audit_flush");
            ISecurityChallengePersistenceService persistence = scope.ServiceProvider.GetRequiredService<ISecurityChallengePersistenceService>();
            failure = "persist-failed";
            foreach (ChallengeV2AuditEvent item in batch)
            {
                cancellationToken.ThrowIfCancellationRequested();
                SecurityChallengeAttempt stored = await persistence.RecordAttemptAsync(item.Attempt, cancellationToken).ConfigureAwait(false);
                if (!ChallengeV2DurableDelivery.MatchesStored(ChallengeV2DurableDelivery.GetRequired(item.Attempt), stored))
                {
                    throw new InvalidDataException("challenge_audit_commit_postcondition_mismatch");
                }
                await _queue.MarkCommittedAsync(item, cancellationToken).ConfigureAwait(false);
                committed++;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            RequeueOrTerminal(batch.Skip(committed), null);
            throw;
        }
        catch (Exception)
        {
            RequeueOrTerminal(batch.Skip(committed), failure);
        }
        return committed;
    }

    private void RequeueOrTerminal(IEnumerable<ChallengeV2AuditEvent> events, string? failure)
    {
        bool first = true;
        foreach (ChallengeV2AuditEvent item in events)
        {
            string? itemFailure = first ? failure : null;
            if (_queue.TryRequeue(item, itemFailure) && itemFailure is not null)
            {
                _logger.LogWarning(
                    "challenge-v2-audit-persist-failed QueueId={QueueId} ItemReference={ItemReference} Reason={Reason}",
                    item.IsHighValue ? "challenge-audit-high-value" : "challenge-audit-normal",
                    ChallengeV2DurableDelivery.Reference(item.Attempt.AttemptId!), itemFailure);
            }
            first = false;
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
            TimeSpan remaining = _flushWindow - Stopwatch.GetElapsedTime(startedAt);
            if (batch.Count >= _batchSize || remaining <= TimeSpan.Zero)
            {
                return;
            }
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            wait.CancelAfter(remaining);
            try
            {
                if (!await _queue.WaitToReadAsync(wait.Token).ConfigureAwait(false))
                {
                    return;
                }
            }
            catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
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

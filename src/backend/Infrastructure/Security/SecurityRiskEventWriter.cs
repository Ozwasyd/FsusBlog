using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Configures bounded scheduling hints, persistence batches and flush latency.</summary>
public sealed class SecurityRiskEventWriterOptions
{
    public const string SectionName = "Security:RiskEventWriter";
    public int Capacity { get; set; } = 20_000;
    public int BatchSize { get; set; } = 256;
    public int FlushWindowMs { get; set; } = 500;
}

/// <summary>Known items have disjoint dispositions; opaque failure-budget guards are not exact item counts. Counters are historical.</summary>
public sealed record SecurityRiskEventWriteQueueSnapshot(
    long QueuedCount, long DroppedCount, long InFlightCount = 0, long DurablePendingCount = 0,
    long DurableAcceptedCount = 0, long CommittedCount = 0, long RequeuedCount = 0, long RejectedCount = 0,
    long TerminalFailureCount = 0, long Sequence = 0, string? LastDisposition = null,
    string? LastFailureReason = null, string? LastItemReference = null, long ShedCount = 0, long SyncFallbackCount = 0)
{
    public long OutstandingCount => Math.Max(0, QueuedCount) + Math.Max(0, InFlightCount)
        + Math.Max(0, DurablePendingCount) + Math.Max(0, TerminalFailureCount);
}

/// <summary>Compatibility symbols for the old shed API; no required event is shed.</summary>
public static class SecurityRiskHotPathAdmission
{
    public const string ShedDisposition = "durable-pending";
    public const string ShedTelemetryResult = "durable-pending";
    public const string ClientOutcome = "unchanged-hot-path-decision";
    public const string TelemetrySample = "queue-depth,shed-count,sync-fallback-count";
}

/// <summary>The protected journal owns admission. Bounded hints never substitute for durable event bytes.</summary>
public sealed class SecurityRiskEventWriteQueue : IDisposable
{
    private readonly Channel<SecurityRiskEventWrite> _channel;
    private readonly Lazy<SecurityRiskFallbackWriter> _journal;
    private readonly ILogger<SecurityRiskEventWriteQueue> _logger;
    private readonly SemaphoreSlim _admissionDisposition = new(1, 1);
    private readonly object _failureGate = new();
    private readonly Dictionary<string, (string Reason, string? Reference)> _unretainedFailures = new(StringComparer.Ordinal);
    private readonly int _failureBudget;
    private long _rejected;
    private long _requeued;
    private long _sequence;
    private (string Reason, string? Reference)? _unrepresentedFailure;
    private string? _lastReference;
    private string? _lastDisposition;

    public SecurityRiskEventWriteQueue(
        IOptions<SecurityRiskEventWriterOptions> options,
        ILogger<SecurityRiskEventWriteQueue> logger,
        IServiceScopeFactory? scopeFactory = null,
        IConfiguration? configuration = null,
        IAuditRetentionEpochKeyStore? keys = null)
    {
        _logger = logger;
        SecurityRiskEventWriterOptions value = options.Value;
        _failureBudget = Math.Clamp(Math.Max(value.Capacity, value.BatchSize), 1, 1_000_000);
        _channel = Channel.CreateBounded<SecurityRiskEventWrite>(new BoundedChannelOptions(Math.Clamp(value.Capacity, 1, 1_000_000))
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });
        _journal = new Lazy<SecurityRiskFallbackWriter>(() =>
        {
            IConfiguration? authority = configuration;
            IAuditRetentionEpochKeyStore? keyAuthority = keys;
            if (scopeFactory is not null)
            {
                using IServiceScope scope = scopeFactory.CreateScope();
                authority ??= scope.ServiceProvider.GetService<IConfiguration>();
                keyAuthority ??= scope.ServiceProvider.GetService<IAuditRetentionEpochKeyStore>();
            }
            if (authority is null)
            {
                throw new InvalidDataException("security_risk_data_root_required");
            }
            return new SecurityRiskFallbackWriter(authority, keyAuthority, Math.Clamp(value.BatchSize, 1, 10_000));
        });
    }

    /// <summary>Scheduling hints only; store consumers must use TryRead.</summary>
    public ChannelReader<SecurityRiskEventWrite> Reader => _channel.Reader;

    /// <summary>Waits synchronously for local protected admission, never SQL.</summary>
    public bool TryWrite(SecurityRiskEventWrite write) => EnqueueAsync(write).AsTask().GetAwaiter().GetResult();

    /// <summary>Retained call compatibility; full/closed admits durably instead of shedding.</summary>
    public bool TryEnqueueOrShed(SecurityRiskEventWrite write) => TryWrite(write);

    /// <summary>Caller cancellation cannot erase a required event or interrupt its protected publication.</summary>
    public async ValueTask<bool> EnqueueAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
    {
        // Preserve failure/admission disposition order for concurrent retries.
        await _admissionDisposition.WaitAsync().ConfigureAwait(false);
        string? identity = null;
        try
        {
            SecurityRiskEventWrite safe = SecurityRiskDurableDelivery.Normalize(write);
            identity = SecurityRiskDurableDelivery.PayloadIdentity(safe);
            await _journal.Value.AdmitAsync(safe).ConfigureAwait(false);
            lock (_failureGate)
            {
                // Only this exact normalized payload obtaining durable admission
                // resolves its rejection; unrelated successes cannot clear it.
                _unretainedFailures.Remove(identity);
            }
            bool hinted = !cancellationToken.IsCancellationRequested && _channel.Writer.TryWrite(safe);
            SetDisposition(hinted ? "durable-accepted" : "durable-pending", SecurityRiskDurableDelivery.Reference(safe.Id));
            FsusObservability.RecordSecurityRiskQueueAdmission(_channel.Reader.Count, 0, 0);
            return true;
        }
        catch (Exception)
        {
            Interlocked.Increment(ref _rejected);
            RecordTerminal("security-risk:admission-failed", Reference(write), identity);
            return false;
        }
        finally
        {
            _admissionDisposition.Release();
        }
    }

    public bool TryRead(out SecurityRiskEventWrite write)
    {
        try
        {
            if (!_journal.Value.TryLease(out write))
            {
                return false;
            }
            _ = _channel.Reader.TryRead(out _);
            SetDisposition("in-flight", SecurityRiskDurableDelivery.Reference(write.Id));
            return true;
        }
        catch (Exception)
        {
            write = default;
            if (!_journal.IsValueCreated)
            {
                RecordTerminal("security-risk:journal-unavailable", null);
            }
            throw;
        }
    }

    public SecurityRiskEventWriteQueueSnapshot Snapshot()
    {
        (long failures, string? failureReason, string? failureReference) = AdmissionFailureSnapshot();
        try
        {
            SecurityRiskJournalSnapshot journal = _journal.Value.Snapshot();
            long queued = Math.Min(_channel.Reader.Count, journal.Pending);
            bool terminal = journal.Terminal > 0 || failures > 0;
            return new(queued, 0, journal.InFlight, journal.Pending - queued, journal.Accepted,
                journal.Committed, Volatile.Read(ref _requeued), Volatile.Read(ref _rejected),
                journal.Terminal + failures, journal.Sequence + Volatile.Read(ref _sequence),
                terminal ? "terminal-failed" : _lastDisposition, failureReason ?? journal.Reason,
                failures > 0 ? failureReference : journal.Terminal > 0 ? journal.Reference : journal.Reference ?? _lastReference);
        }
        catch (Exception)
        {
            return new(0, 0, RejectedCount: Volatile.Read(ref _rejected), TerminalFailureCount: Math.Max(1, failures),
                Sequence: Volatile.Read(ref _sequence), LastDisposition: "terminal-failed",
                LastFailureReason: failureReason ?? "security-risk:journal-unavailable", LastItemReference: failureReference);
        }
    }

    public void Complete(Exception? error = null)
    {
        _channel.Writer.TryComplete(error);
        SetDisposition("closed", null);
    }

    internal async Task CleanupAcknowledgedAsync() => await _journal.Value.CleanupAcknowledgedAsync().ConfigureAwait(false);

    internal async Task MarkCommittedAsync(IReadOnlyList<SecurityRiskEventWrite> writes)
    {
        foreach (SecurityRiskEventWrite write in writes)
        {
            await _journal.Value.AcknowledgeAsync(write).ConfigureAwait(false);
            SetDisposition("committed", SecurityRiskDurableDelivery.Reference(write.Id));
        }
    }

    internal bool TryRequeue(SecurityRiskEventWrite write)
    {
        if (!_journal.Value.ReturnPending(write, terminal: false))
        {
            return false;
        }
        Interlocked.Increment(ref _requeued);
        SetDisposition("durable-pending", SecurityRiskDurableDelivery.Reference(write.Id));
        return true;
    }

    internal void MarkTerminalFailure(SecurityRiskEventWrite write)
    {
        if (_journal.Value.ReturnPending(write, terminal: true))
        {
            SetDisposition("terminal-failed", SecurityRiskDurableDelivery.Reference(write.Id));
        }
    }

    internal void MarkPreparationFailed() => RecordTerminal("security-risk:signal-preparation-failed", null);

    private void RecordTerminal(string reason, string? reference, string? identity = null)
    {
        lock (_failureGate)
        {
            if (identity is null || _unretainedFailures.Count >= _failureBudget && !_unretainedFailures.ContainsKey(identity))
            {
                // No exact event identity, or exhausted bounded bookkeeping:
                // an unresolved admission loss must not be guessed resolved.
                _unrepresentedFailure = (reason, reference);
            }
            else
            {
                _unretainedFailures.TryAdd(identity, (reason, reference));
            }
        }
        SetDisposition("terminal-failed", reference);
        _logger.LogWarning("security-risk-delivery-failed Item={Item} Reason={Reason}", reference ?? "unknown", reason);
    }

    private (long Count, string? Reason, string? Reference) AdmissionFailureSnapshot()
    {
        lock (_failureGate)
        {
            (string Reason, string? Reference)? current = _unrepresentedFailure;
            if (current is null && _unretainedFailures.Count > 0)
            {
                current = _unretainedFailures.First().Value;
            }
            return (_unretainedFailures.Count + (_unrepresentedFailure is null ? 0 : 1), current?.Reason, current?.Reference);
        }
    }

    private static string? Reference(SecurityRiskEventWrite write)
        => write.Id is { Length: > 0 and <= 64 } ? SecurityRiskDurableDelivery.Reference(write.Id) : null;

    private void SetDisposition(string disposition, string? reference)
    {
        Volatile.Write(ref _lastDisposition, disposition);
        if (reference is not null)
        {
            Volatile.Write(ref _lastReference, reference);
        }
        Interlocked.Increment(ref _sequence);
    }

    public void Dispose()
    {
        if (_journal.IsValueCreated)
        {
            _journal.Value.Dispose();
        }
    }
}

/// <summary>Persists exact leased journal deliveries; only confirmed commits are ACKed.</summary>
public sealed class SecurityRiskEventWriterWorker(
    SecurityRiskEventWriteQueue queue,
    IServiceScopeFactory scopeFactory,
    IOptions<SecurityRiskEventWriterOptions> options,
    ILogger<SecurityRiskEventWriterWorker> logger) : BackgroundService
{
    private readonly int _batchSize = Math.Clamp(options.Value.BatchSize, 1, 10_000);
    private readonly TimeSpan _flushWindow = TimeSpan.FromMilliseconds(Math.Clamp(options.Value.FlushWindowMs, 1, 60_000));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _ = await FlushOnceAsync(stoppingToken).ConfigureAwait(false);
                await Task.Delay(_flushWindow, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // PersistSafely owns cancellation disposition exactly once.
            }
            catch (Exception)
            {
                logger.LogWarning("security-risk-delivery-failed Reason=security-risk:replay-failed");
                await Task.Delay(_flushWindow, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    public async Task<int> FlushOnceAsync(CancellationToken cancellationToken)
    {
        await queue.CleanupAcknowledgedAsync().ConfigureAwait(false);
        var batch = new List<SecurityRiskEventWrite>(_batchSize);
        try
        {
            while (batch.Count < _batchSize && queue.TryRead(out SecurityRiskEventWrite write))
            {
                batch.Add(write);
            }
        }
        catch
        {
            foreach (SecurityRiskEventWrite write in batch)
            {
                _ = queue.TryRequeue(write);
            }
            throw;
        }
        if (batch.Count > 0)
        {
            await PersistSafelyAsync(batch, cancellationToken).ConfigureAwait(false);
        }
        return batch.Count;
    }

    internal async Task PersistSafelyAsync(IReadOnlyList<SecurityRiskEventWrite> batch, CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        int inserted = 0;
        int failed = 0;
        int singles = 0;
        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                scopeFactory, "security_risk_event_flush");
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            await PersistPartAsync(batch).ConfigureAwait(false);

            async Task PersistPartAsync(IReadOnlyList<SecurityRiskEventWrite> part)
            {
                try
                {
                    await store.AppendBatchAsync(part, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    failed++;
                    if (part.Count > 1)
                    {
                        int split = part.Count / 2;
                        await PersistPartAsync(part.Take(split).ToArray()).ConfigureAwait(false);
                        await PersistPartAsync(part.Skip(split).ToArray()).ConfigureAwait(false);
                        return;
                    }
                    try
                    {
                        singles++;
                        await store.AppendAsync(part[0], cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception singleFailure) when (singleFailure is not OperationCanceledException)
                    {
                        queue.MarkTerminalFailure(part[0]);
                        LogFailure(part[0]);
                        return;
                    }
                }
                await queue.MarkCommittedAsync(part).ConfigureAwait(false);
                inserted += part.Count;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            foreach (SecurityRiskEventWrite write in batch)
            {
                _ = queue.TryRequeue(write);
            }
            throw;
        }
        catch (Exception)
        {
            failed++;
            foreach (SecurityRiskEventWrite write in batch)
            {
                queue.MarkTerminalFailure(write);
                LogFailure(write);
            }
        }
        finally
        {
            FsusObservability.RecordSecurityRiskEventBatch(batch.Count, Stopwatch.GetElapsedTime(started), inserted, failed, singles);
        }
    }

    private void LogFailure(SecurityRiskEventWrite write)
        => logger.LogWarning("security-risk-persist-failed Item={Item} Reason=security-risk:replay-failed",
            SecurityRiskDurableDelivery.Reference(write.Id));
}

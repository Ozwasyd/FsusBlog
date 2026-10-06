using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAdminAuditLogChannel
{
    ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default);

    ValueTask EnqueueManyAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken = default);
}

public sealed class AdminAuditLogChannel : IAdminAuditLogChannel
{
    internal const int DefaultCapacity = 4_096;
    private readonly Channel<AdminAuditLog> _channel;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<AdminAuditLogChannel> _logger;
    private readonly AdminAuditFallbackWriter _journal;
    private readonly object _queueGate = new();
    private readonly Dictionary<Guid, bool> _live = [];
    private long _requeuedCount;
    private long _rejectedCount;
    private long _terminalFailureCount;
    private long _sequence;
    private string? _lastDisposition;
    private string? _lastFailureReason;
    private string? _lastItemReference;
    private int _completed;

    public AdminAuditLogChannel(
        IServiceScopeFactory scopeFactory, ILogger<AdminAuditLogChannel> logger,
        IConfiguration? configuration = null, IAuditRetentionEpochKeyStore? keys = null)
        : this(new BoundedChannelOptions(DefaultCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        }, scopeFactory, logger, configuration ?? new ConfigurationBuilder().Build(), keys)
    {
    }

    internal AdminAuditLogChannel(
        BoundedChannelOptions options, IServiceScopeFactory scopeFactory,
        ILogger<AdminAuditLogChannel> logger, IConfiguration configuration,
        IAuditRetentionEpochKeyStore? keys = null)
    {
        if (options.FullMode != BoundedChannelFullMode.Wait)
        {
            throw new ArgumentException("admin_audit_requires_explicit_overflow", nameof(options));
        }
        _channel = Channel.CreateBounded<AdminAuditLog>(options);
        _scopeFactory = scopeFactory;
        _logger = logger;
        _journal = new AdminAuditFallbackWriter(configuration, keys ?? new LocalAuditRetentionEpochKeyStore(configuration));
    }

    internal ChannelReader<AdminAuditLog> Reader => _channel.Reader;

    public long QueuedCount
    {
        get
        {
            lock (_queueGate)
            {
                return _live.LongCount(static pair => !pair.Value);
            }
        }
    }

    public async ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default)
    {
        AdminAuditLog delivery;
        try
        {
            // Request cancellation cannot revoke a required audit event. Publish
            // independently before either bounded admission or direct fallback.
            delivery = await _journal.AdmitAsync(audit).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            MarkTerminalFailure(1, ex.Data["AdminAuditDeliveryId"] as string,
                $"admin-audit:admission-failed:{ex.GetType().Name}");
            throw;
        }
        if (!cancellationToken.IsCancellationRequested)
        {
            lock (_queueGate)
            {
                if (_channel.Writer.TryWrite(delivery))
                {
                    _live.Add(Identity(delivery), false);
                    SetDisposition("durable-accepted", Identity(delivery).ToString("N"));
                    FsusObservability.RecordAdminAuditQueue(1, 0, 0, _live.Count);
                    return;
                }
            }
        }
        Interlocked.Increment(ref _rejectedCount);
        lock (_queueGate)
        {
            string reason = Volatile.Read(ref _completed) != 0 ? "closed:durable-accepted"
                : cancellationToken.IsCancellationRequested ? "cancelled:durable-accepted"
                : "queue-full:durable-accepted";
            SetDisposition("durable-pending", Identity(delivery).ToString("N"), reason);
        }
        // Preserve the catalog's direct fallback call boundary with the bound
        // immutable delivery, never the caller's mutable object.
        audit = delivery;
        await WriteFallbackAsync([audit], CancellationToken.None).ConfigureAwait(false);
    }

    public async ValueTask EnqueueManyAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (AdminAuditLog audit in audits)
        {
            await EnqueueAsync(audit, cancellationToken).ConfigureAwait(false);
        }
    }

    internal bool TryRead([NotNullWhen(true)] out AdminAuditLog? audit)
    {
        lock (_queueGate)
        {
            while (_channel.Reader.TryRead(out audit))
            {
                Guid id = Identity(audit);
                if (_live.ContainsKey(id))
                {
                    _live[id] = true;
                    SetDisposition("in-flight", id.ToString("N"));
                    return true;
                }
            }
        }
        audit = null;
        return false;
    }

    internal async ValueTask<AdminAuditLog> ReadAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            AdminAuditLog audit = await _channel.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            lock (_queueGate)
            {
                Guid id = Identity(audit);
                if (_live.ContainsKey(id))
                {
                    _live[id] = true;
                    SetDisposition("in-flight", id.ToString("N"));
                    return audit;
                }
            }
        }
    }

    internal ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
        => _channel.Reader.WaitToReadAsync(cancellationToken);

    internal async Task EnsureAdmittedAsync(IReadOnlyList<AdminAuditLog> audits)
    {
        for (int index = 0; index < audits.Count; index++)
        {
            if (!AdminAuditDurableDelivery.IsBound(audits[index]))
            {
                // Manual worker entry points still pass through the same owner.
                AdminAuditLog delivery = await _journal.AdmitAsync(audits[index]).ConfigureAwait(false);
                AdminAuditDurableDelivery.BindSource(audits[index], delivery);
            }
            else
            {
                _ = AdminAuditDurableDelivery.GetRequired(audits[index]);
            }
        }
    }

    internal async Task ReplayAsync(CancellationToken replayCancellationToken)
    {
        await _journal.ReplayAsync(async (audits, cancellationToken) =>
        {
            lock (_queueGate)
            {
                foreach (AdminAuditLog record in audits)
                {
                    _live[Identity(record)] = true;
                }
                SetDisposition("in-flight", Identity(audits[0]).ToString("N"));
            }
            try
            {
                await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                    _scopeFactory, "admin_audit_flush");
                IAdminAuditLogStore store = scope.ServiceProvider.GetRequiredService<IAdminAuditLogStore>();
                await store.WriteBatchAsync(audits, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                lock (_queueGate)
                {
                    foreach (AdminAuditLog record in audits)
                    {
                        _live.Remove(Identity(record));
                    }
                    SetDisposition("durable-pending", Identity(audits[0]).ToString("N"));
                }
            }
        }, replayCancellationToken).ConfigureAwait(false);
        lock (_queueGate)
        {
            // Committed wake hints may still occupy physical bounded slots.
            while (_channel.Reader.TryRead(out AdminAuditLog? hint))
            {
                _live.Remove(Identity(hint));
            }
            SetDisposition("committed", null);
        }
    }

    internal async Task WriteFallbackAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
    {
        await EnsureAdmittedAsync(audits).ConfigureAwait(false);
        try
        {
            await ReplayAsync(cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordAdminAuditQueue(0, 0, audits.Count, QueuedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError("admin-audit durable fallback remains pending. FailureCategory={Category}", ex.GetType().Name);
            throw;
        }
    }

    public void Complete(Exception? error = null)
    {
        if (Interlocked.Exchange(ref _completed, 1) == 0)
        {
            _channel.Writer.TryComplete(error);
            lock (_queueGate)
            {
                SetDisposition("closed", error?.Message);
            }
        }
    }

    public AdminAuditLogChannelSnapshot Snapshot()
    {
        lock (_queueGate)
        {
            AdminAuditJournalSnapshot journal;
            try
            {
                journal = _journal.Snapshot();
            }
            catch (Exception ex)
            {
                Interlocked.CompareExchange(ref _terminalFailureCount, 1, 0);
                SetDisposition("terminal-failed", null, $"admin-audit:journal-state-unavailable:{ex.GetType().Name}");
                journal = new(0, 0, 0, 0, 0, null, null);
            }
            long queued = _live.LongCount(static pair => !pair.Value);
            long inFlight = _live.LongCount(static pair => pair.Value);
            long terminal = journal.TerminalFailures + _terminalFailureCount;
            long pending = Math.Max(0, journal.Pending - queued - inFlight);
            return new(queued, inFlight, pending, journal.Accepted, journal.Committed,
                _requeuedCount, _rejectedCount, terminal, _sequence + journal.Sequence,
                terminal > 0 ? "terminal-failed" : inFlight > 0 ? "in-flight"
                    : queued > 0 ? "durable-accepted" : pending > 0 ? "durable-pending" : _lastDisposition,
                _terminalFailureCount > 0 ? _lastFailureReason : journal.LastFailure ?? _lastFailureReason,
                _terminalFailureCount > 0 ? _lastItemReference : journal.LastReference ?? _lastItemReference);
        }
    }

    internal bool TryRequeue(AdminAuditLog audit)
    {
        lock (_queueGate)
        {
            if (!_channel.Writer.TryWrite(audit))
            {
                return false; // The published journal remains the disposition.
            }
            _live[Identity(audit)] = false;
            _requeuedCount++;
            SetDisposition("requeued", Identity(audit).ToString("N"));
            return true;
        }
    }

    internal void MarkTerminalFailure(int count, string? itemReference, string reason)
    {
        lock (_queueGate)
        {
            _terminalFailureCount += Math.Max(0, count);
            SetDisposition("terminal-failed", itemReference, reason);
        }
    }

    private static Guid Identity(AdminAuditLog audit)
        => AdminAuditDurableDelivery.GetRequired(audit).Entry.DeliveryId;

    private void SetDisposition(string disposition, string? itemReference, string? failureReason = null)
    {
        _sequence++;
        _lastDisposition = disposition;
        _lastItemReference = itemReference ?? _lastItemReference;
        _lastFailureReason = failureReason ?? _lastFailureReason;
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

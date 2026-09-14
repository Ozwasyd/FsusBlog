using System.Data.Common;
using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Security;

public sealed record AdminSessionProjectionRuntimeOptions(
    AdminSessionProjectionLimits ProjectionLimits,
    int ColdStartBatchSize,
    int TouchQueueCapacity,
    int MaxTouchTrackingEntries,
    TimeSpan TouchMinInterval,
    TimeSpan RecoveryRetryDelay,
    TimeSpan ShutdownFlushTimeout)
{
    public const string SectionName = "Security:AdminSessionProjection";

    public static AdminSessionProjectionRuntimeOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        return new AdminSessionProjectionRuntimeOptions(
            new AdminSessionProjectionLimits(
                Math.Clamp(section.GetValue("MaxSessionEntries", 16_384), 1, 1_000_000),
                Math.Clamp(section.GetValue("MaxPrincipalEntries", 4_096), 1, 100_000),
                Math.Clamp(section.GetValue("MaxResidentBytes", 8L * 1024 * 1024), 1024, 512L * 1024 * 1024)),
            Math.Clamp(section.GetValue("ColdStartBatchSize", 256), 1, 4096),
            Math.Clamp(section.GetValue("TouchQueueCapacity", 4096), 1, 65_536),
            Math.Clamp(section.GetValue("MaxTouchTrackingEntries", 16_384), 1, 1_000_000),
            TimeSpan.FromSeconds(45),
            TimeSpan.FromMilliseconds(Math.Clamp(section.GetValue("RecoveryRetryMilliseconds", 1000), 25, 30_000)),
            TimeSpan.FromMilliseconds(Math.Clamp(section.GetValue("ShutdownFlushMilliseconds", 5000), 100, 30_000)));
    }
}

public readonly record struct AdminSessionTouchRequest(
    string SessionId,
    long SessionVersion,
    ReadOnlyMemory<byte> AccessTokenHash,
    DateTimeOffset IdleExpiresAtUtc,
    DateTimeOffset AbsoluteExpiresAtUtc);

public readonly record struct AdminSessionTouchRuntimeSnapshot(
    int QueueEntries,
    int InFlightCount,
    int QueueCapacity,
    int TrackingEntries,
    int MaxTrackingEntries,
    long TrackingBytes,
    long EnqueuedCount,
    long DebouncedCount,
    long RejectedCount,
    long DbCommandCount,
    long ConflictCount,
    long FailureCount,
    long AuthorityRefreshCount);

public interface IAdminSessionTouchScheduler
{
    bool TrySchedule(AdminSessionTouchRequest request);

    AdminSessionTouchRuntimeSnapshot Snapshot();
}

public sealed class AdminSessionTouchScheduler : BackgroundService, IAdminSessionTouchScheduler
{
    private const int TrackingFixedBytes = 160;
    private readonly object _gate = new();
    private readonly Dictionary<string, TouchTrackingEntry> _tracking = new(StringComparer.Ordinal);
    private readonly Channel<AdminSessionTouchRequest> _queue;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly AdminSessionProjectionRuntimeOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<AdminSessionTouchScheduler> _logger;
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _queueEntries;
    private int _inFlightCount;
    private long _trackingBytes;
    private long _enqueuedCount;
    private long _debouncedCount;
    private long _rejectedCount;
    private long _dbCommandCount;
    private long _conflictCount;
    private long _failureCount;
    private long _authorityRefreshCount;

    public AdminSessionTouchScheduler(
        IServiceScopeFactory scopeFactory,
        AdminSessionProjectionRuntimeOptions options,
        TimeProvider timeProvider,
        ILogger<AdminSessionTouchScheduler> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options;
        _timeProvider = timeProvider;
        _logger = logger;
        _queue = Channel.CreateBounded<AdminSessionTouchRequest>(new BoundedChannelOptions(options.TouchQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });
    }

    public bool TrySchedule(AdminSessionTouchRequest request)
    {
        DateTimeOffset now = _timeProvider.GetUtcNow();
        if (string.IsNullOrWhiteSpace(request.SessionId)
            || request.SessionVersion <= 0
            || request.AccessTokenHash.Length != 32
            || request.IdleExpiresAtUtc <= now
            || request.AbsoluteExpiresAtUtc <= now)
        {
            Interlocked.Increment(ref _rejectedCount);
            return false;
        }

        lock (_gate)
        {
            PruneTrackingLocked(now);
            if (_tracking.TryGetValue(request.SessionId, out TouchTrackingEntry? current))
            {
                if (current.Pending || current.NextEligibleAtUtc > now)
                {
                    Interlocked.Increment(ref _debouncedCount);
                    return false;
                }
            }
            else if (_tracking.Count >= _options.MaxTouchTrackingEntries)
            {
                Interlocked.Increment(ref _rejectedCount);
                return false;
            }

            byte[] tokenHash = request.AccessTokenHash.ToArray();
            var queued = request with
            {
                AccessTokenHash = tokenHash
            };
            bool added = !_tracking.ContainsKey(request.SessionId);
            _tracking[request.SessionId] = new TouchTrackingEntry(
                now + _options.TouchMinInterval,
                request.AbsoluteExpiresAtUtc < request.IdleExpiresAtUtc
                    ? request.AbsoluteExpiresAtUtc
                    : request.IdleExpiresAtUtc,
                Pending: true);
            if (added)
            {
                _trackingBytes += TrackingBytes(request.SessionId);
            }

            if (_queue.Writer.TryWrite(queued))
            {
                Interlocked.Increment(ref _queueEntries);
                Interlocked.Increment(ref _enqueuedCount);
                return true;
            }

            RemoveTrackingLocked(request.SessionId);
            Interlocked.Increment(ref _rejectedCount);
            return false;
        }
    }

    public AdminSessionTouchRuntimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            PruneTrackingLocked(_timeProvider.GetUtcNow());
            return new AdminSessionTouchRuntimeSnapshot(
                Volatile.Read(ref _queueEntries),
                Volatile.Read(ref _inFlightCount),
                _options.TouchQueueCapacity,
                _tracking.Count,
                _options.MaxTouchTrackingEntries,
                _trackingBytes,
                Interlocked.Read(ref _enqueuedCount),
                Interlocked.Read(ref _debouncedCount),
                Interlocked.Read(ref _rejectedCount),
                Interlocked.Read(ref _dbCommandCount),
                Interlocked.Read(ref _conflictCount),
                Interlocked.Read(ref _failureCount),
                Interlocked.Read(ref _authorityRefreshCount));
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (AdminSessionTouchRequest request in _queue.Reader.ReadAllAsync(stoppingToken).ConfigureAwait(false))
            {
                Interlocked.Decrement(ref _queueEntries);
                Interlocked.Increment(ref _inFlightCount);
                try
                {
                    await ProcessAsync(request, stoppingToken).ConfigureAwait(false);
                    lock (_gate)
                    {
                        if (_tracking.TryGetValue(request.SessionId, out TouchTrackingEntry? current))
                        {
                            _tracking[request.SessionId] = current with
                            {
                                Pending = false
                            };
                        }
                        PruneTrackingLocked(_timeProvider.GetUtcNow());
                    }
                }
                finally
                {
                    Interlocked.Decrement(ref _inFlightCount);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            _drained.TrySetResult();
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _queue.Writer.TryComplete();
        using var flushCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        flushCts.CancelAfter(_options.ShutdownFlushTimeout);
        try
        {
            await _drained.Task.WaitAsync(flushCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning(
                "admin-session touch shutdown flush timed out with {QueueEntries} queued entries",
                Volatile.Read(ref _queueEntries));
        }
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task ProcessAsync(AdminSessionTouchRequest request, CancellationToken cancellationToken)
    {
        DateTimeOffset observedAt = _timeProvider.GetUtcNow();
        if (request.IdleExpiresAtUtc <= observedAt || request.AbsoluteExpiresAtUtc <= observedAt)
        {
            return;
        }

        Exception? failure = null;
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                await using AsyncServiceScope scope = _scopeFactory.CreateAsyncScope();
                ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
                long startedAt = Stopwatch.GetTimestamp();
                int updated = await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE admin_session
                    SET lastseenatutc = @LastSeenAtUtc
                    WHERE sessionid = @SessionId
                      AND validationversion = @ValidationVersion
                      AND revokedatutc IS NULL
                      AND accesstokenhash = @AccessTokenHash
                      AND idleexpiresatutc = @IdleExpiresAtUtc
                      AND absoluteexpiresatutc = @AbsoluteExpiresAtUtc;
                    """,
                    new SugarParameter("@SessionId", request.SessionId),
                    new SugarParameter("@ValidationVersion", request.SessionVersion),
                    new SugarParameter("@LastSeenAtUtc", now),
                    new SugarParameter("@AccessTokenHash", Convert.ToHexString(request.AccessTokenHash.Span)),
                    new SugarParameter("@IdleExpiresAtUtc", request.IdleExpiresAtUtc.UtcDateTime),
                    new SugarParameter("@AbsoluteExpiresAtUtc", request.AbsoluteExpiresAtUtc.UtcDateTime));
                Interlocked.Increment(ref _dbCommandCount);
                FsusObservability.RecordAdminSessionTouch(updated == 1, Stopwatch.GetElapsedTime(startedAt));
                if (updated == 0)
                {
                    Interlocked.Increment(ref _conflictCount);
                    IAdminSessionProjectionAuthorityReader authority =
                        scope.ServiceProvider.GetRequiredService<IAdminSessionProjectionAuthorityReader>();
                    Interlocked.Increment(ref _authorityRefreshCount);
                    await authority.RefreshSessionAsync(request.SessionId, cancellationToken).ConfigureAwait(false);
                }
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (attempt < 3)
            {
                failure = ex;
                await Task.Delay(_options.RecoveryRetryDelay, _timeProvider, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        }

        Interlocked.Increment(ref _failureCount);
        _logger.LogWarning(failure, "admin-session touch failed for {SessionId}", request.SessionId);
    }

    private void PruneTrackingLocked(DateTimeOffset now)
    {
        List<string>? expired = null;
        foreach ((string sessionId, TouchTrackingEntry entry) in _tracking)
        {
            if (entry.RetireAtUtc <= now)
            {
                (expired ??= []).Add(sessionId);
            }
        }
        if (expired is null)
        {
            return;
        }
        foreach (string sessionId in expired)
        {
            RemoveTrackingLocked(sessionId);
        }
    }

    private void RemoveTrackingLocked(string sessionId)
    {
        if (_tracking.Remove(sessionId))
        {
            _trackingBytes = Math.Max(0, _trackingBytes - TrackingBytes(sessionId));
        }
    }

    private static long TrackingBytes(string sessionId)
        => TrackingFixedBytes + checked(sessionId.Length * sizeof(char));

    private sealed record TouchTrackingEntry(
        DateTimeOffset NextEligibleAtUtc,
        DateTimeOffset RetireAtUtc,
        bool Pending);
}

public interface IAdminSessionProjectionAuthorityReader
{
    Task<long> LoadColdStartAsync(CancellationToken cancellationToken = default);

    Task<AdminSessionProjectionSessionUpdate?> ReadSessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default);

    Task<AdminSessionProjectionPrincipalUpdate?> ReadPrincipalAsync(
        long principalId,
        CancellationToken cancellationToken = default);

    Task<bool> RefreshSessionAsync(string sessionId, CancellationToken cancellationToken = default);
}

public sealed class AdminSessionProjectionAuthorityReader(
    ISqlSugarClient db,
    AdminSessionProjection projection,
    AdminSessionProjectionRuntimeOptions options,
    TimeProvider timeProvider) : IAdminSessionProjectionAuthorityReader
{
    public async Task<long> LoadColdStartAsync(CancellationToken cancellationToken = default)
    {
        string cursor = string.Empty;
        long generation = 0;
        while (true)
        {
            IReadOnlyList<AdminSessionProjectionSessionUpdate> batch = await ReadBatchAsync(
                cursor,
                options.ColdStartBatchSize,
                cancellationToken).ConfigureAwait(false);
            if (batch.Count == 0)
            {
                return generation;
            }
            foreach (AdminSessionProjectionSessionUpdate update in batch)
            {
                AdminSessionProjectionApplyResult applied = projection.Apply(update);
                if (!applied.Accepted)
                {
                    throw new InvalidOperationException($"admin_session_projection_cold_start_{applied.Status}");
                }
                generation = Math.Max(generation, update.Generation);
                cursor = update.SessionId;
            }
            if (batch.Count < options.ColdStartBatchSize)
            {
                return generation;
            }
        }
    }

    public async Task<bool> RefreshSessionAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        AdminSessionProjectionSessionUpdate? row = await ReadSessionAsync(sessionId, cancellationToken).ConfigureAwait(false);
        if (!row.HasValue)
        {
            projection.MarkNotReady("authority-refresh-session-missing");
            return false;
        }
        return projection.Apply(row.Value).Accepted;
    }

    public async Task<AdminSessionProjectionSessionUpdate?> ReadSessionAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<AdminSessionProjectionSessionUpdate> rows = await ReadBatchAsync(
            string.Empty,
            1,
            cancellationToken,
            sessionId).ConfigureAwait(false);
        return rows.Count == 0 ? null : rows[0];
    }

    public async Task<AdminSessionProjectionPrincipalUpdate?> ReadPrincipalAsync(
        long principalId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, status, validationversion
            FROM admin_principal
            WHERE id = @PrincipalId;
            """,
            new SugarParameter("@PrincipalId", principalId));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        long version = reader.ReadInt64("validationversion");
        return new AdminSessionProjectionPrincipalUpdate(
            reader.ReadInt64("id"),
            string.Equals(reader.ReadString("status"), AdminPrincipalStatus.Active, StringComparison.Ordinal)
                ? AdminSessionProjectionPrincipalStatus.Active
                : AdminSessionProjectionPrincipalStatus.Disabled,
            version,
            version);
    }

    private async Task<IReadOnlyList<AdminSessionProjectionSessionUpdate>> ReadBatchAsync(
        string cursor,
        int limit,
        CancellationToken cancellationToken,
        string? exactSessionId = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        string predicate = exactSessionId is null
            ? "s.sessionid > @Cursor"
            : "s.sessionid = @SessionId";
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT s.sessionid,
                   s.adminprincipalid,
                   s.accesstokenhash,
                   s.revokedatutc,
                   s.idleexpiresatutc,
                   s.absoluteexpiresatutc,
                   s.validationversion AS session_version,
                   ap.status AS principal_status,
                   ap.validationversion AS principal_version
            FROM admin_session s
            JOIN admin_principal ap ON ap.id = s.adminprincipalid
            WHERE {predicate}
              AND s.idleexpiresatutc > @NowUtc
              AND s.absoluteexpiresatutc > @NowUtc
            ORDER BY s.sessionid
            LIMIT @Limit;
            """,
            new SugarParameter("@Cursor", cursor),
            new SugarParameter("@SessionId", exactSessionId ?? string.Empty),
            new SugarParameter("@NowUtc", now),
            new SugarParameter("@Limit", limit));
        var rows = new List<AdminSessionProjectionSessionUpdate>(limit);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            long sessionVersion = reader.ReadInt64("session_version");
            long principalVersion = reader.ReadInt64("principal_version");
            long generation = Math.Max(sessionVersion, principalVersion);
            rows.Add(new AdminSessionProjectionSessionUpdate(
                reader.ReadString("sessionid"),
                reader.ReadInt64("adminprincipalid"),
                Convert.FromHexString(reader.ReadString("accesstokenhash")),
                reader.IsNull("revokedatutc") ? null : AsUtc(reader.ReadDateTime("revokedatutc")),
                AsUtc(reader.ReadDateTime("idleexpiresatutc")),
                AsUtc(reader.ReadDateTime("absoluteexpiresatutc")),
                sessionVersion,
                generation,
                new AdminSessionProjectionPrincipalUpdate(
                    reader.ReadInt64("adminprincipalid"),
                    string.Equals(reader.ReadString("principal_status"), AdminPrincipalStatus.Active, StringComparison.Ordinal)
                        ? AdminSessionProjectionPrincipalStatus.Active
                        : AdminSessionProjectionPrincipalStatus.Disabled,
                    principalVersion,
                    principalVersion)));
        }
        return rows;
    }

    internal static DateTimeOffset AsUtc(DateTime value)
        => new(value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        });
}

public sealed class AdminSessionProjectionColdStartWorker(
    IServiceScopeFactory scopeFactory,
    AdminSessionProjection projection,
    AdminSessionProjectionRuntimeOptions options,
    TimeProvider timeProvider,
    ILogger<AdminSessionProjectionColdStartWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        projection.MarkNotReady("cold-start");
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                IAdminSessionProjectionAuthorityReader authority =
                    scope.ServiceProvider.GetRequiredService<IAdminSessionProjectionAuthorityReader>();
                long generation = await authority.LoadColdStartAsync(stoppingToken).ConfigureAwait(false);
                if (!projection.MarkReady(generation))
                {
                    throw new InvalidOperationException("admin_session_projection_generation_lag");
                }
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                projection.MarkNotReady("cold-start-failed");
                logger.LogWarning(ex, "admin-session projection cold-start recovery failed");
                await Task.Delay(options.RecoveryRetryDelay, timeProvider, stoppingToken).ConfigureAwait(false);
            }
        }
    }
}

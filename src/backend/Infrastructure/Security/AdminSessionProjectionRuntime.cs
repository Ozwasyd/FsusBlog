using System.Data.Common;
using System.Diagnostics;
using System.Threading.Channels;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Defines local projection, touch admission, cold-start and bounded shutdown settings.</summary>
/// <param name="ProjectionLimits">Entry and accounted-byte limits used by the local projection, not a total heap quota.</param>
/// <param name="ColdStartBatchSize">Maximum session facts requested in each cold-start keyset batch.</param>
/// <param name="TouchQueueCapacity">Capacity of the single-reader touch queue.</param>
/// <param name="MaxTouchTrackingEntries">Maximum distinct sessions retained for pending/debounce tracking.</param>
/// <param name="TouchMinInterval">Interval before a tracked session becomes eligible for another touch.</param>
/// <param name="RecoveryRetryDelay">Delay between touch attempts or failed cold-start recovery attempts.</param>
/// <param name="ShutdownFlushTimeout">Maximum wait for the touch reader to drain before normal host stop.</param>
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

    /// <summary>Reads the admin-session projection section, clamps configured bounds and fixes debounce to 45 seconds.</summary>
    /// <param name="configuration">Configuration containing the optional projection section and numeric settings.</param>
    /// <returns>A settings snapshot using the defined defaults for absent values; it does not subscribe to reloads.</returns>
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

/// <summary>Captures the session facts used to conditionally update last-seen time, not to authorize a request.</summary>
/// <param name="SessionId">Identity of the authority session row to touch.</param>
/// <param name="SessionVersion">Positive validation version required by the SQL compare-and-set.</param>
/// <param name="AccessTokenHash">The 32-byte hash compared by the touch operation; admission copies it for queue ownership.</param>
/// <param name="IdleExpiresAtUtc">Observed idle expiry that must be unexpired at admission and processing.</param>
/// <param name="AbsoluteExpiresAtUtc">Observed absolute expiry that must be unexpired at admission and processing.</param>
public readonly record struct AdminSessionTouchRequest(
    string SessionId,
    long SessionVersion,
    ReadOnlyMemory<byte> AccessTokenHash,
    DateTimeOffset IdleExpiresAtUtc,
    DateTimeOffset AbsoluteExpiresAtUtc);

/// <summary>Reports local touch admission and processing diagnostics, not an atomic authority or heap snapshot.</summary>
/// <param name="QueueEntries">Observed requests waiting for the queue reader.</param>
/// <param name="InFlightCount">Observed requests currently handled by the reader.</param>
/// <param name="QueueCapacity">Configured touch queue capacity.</param>
/// <param name="TrackingEntries">Pending or debounced sessions retained after expiry pruning.</param>
/// <param name="MaxTrackingEntries">Configured tracking entry limit.</param>
/// <param name="TrackingBytes">Estimated fixed-entry and session-ID storage, excluding total queue and managed-heap usage.</param>
/// <param name="EnqueuedCount">Cumulative successful queue admissions.</param>
/// <param name="DebouncedCount">Cumulative admissions skipped for pending or not-yet-eligible tracked sessions.</param>
/// <param name="RejectedCount">Cumulative invalid, expired or capacity-rejected admissions.</param>
/// <param name="DbCommandCount">Cumulative touch SQL commands that completed without throwing.</param>
/// <param name="ConflictCount">Cumulative completed touch commands affecting no row.</param>
/// <param name="FailureCount">Cumulative requests that exhausted their processing attempts.</param>
/// <param name="AuthorityRefreshCount">Cumulative authority refresh attempts triggered by touch conflicts.</param>
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

/// <summary>Offers nonblocking touch admission and local diagnostics without a synchronous last-seen authority write.</summary>
/// <remarks>Admission success is queue ownership, not acknowledgement that the SQL touch has completed.</remarks>
public interface IAdminSessionTouchScheduler
{
    bool TrySchedule(AdminSessionTouchRequest request);

    AdminSessionTouchRuntimeSnapshot Snapshot();
}

/// <summary>Coalesces last-seen writes through a bounded single-reader queue and a locked pending/debounce table.</summary>
/// <remarks>
/// Processing skips expired facts and retries failures up to three attempts. A zero-row touch requests an authority
/// refresh; refresh failures may retry with the touch.
/// Stop closes queue admission and waits for draining only within the configured timeout before stopping the worker;
/// a timeout or exhausted retry does not acknowledge a persisted touch.
/// </remarks>
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

    /// <summary>Creates a bounded multi-writer, single-reader queue with synchronous continuations disabled.</summary>
    /// <param name="scopeFactory">Factory providing isolated scoped database and authority-reader dependencies per attempt.</param>
    /// <param name="options">Queue, tracking, debounce, retry and shutdown bounds for this scheduler.</param>
    /// <param name="timeProvider">Clock used for admission, expiry checks and retry delays.</param>
    /// <param name="logger">Logger for exhausted processing attempts and shutdown flush timeouts.</param>
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

    /// <summary>Attempts to enqueue valid, unexpired facts while respecting pending, debounce and capacity limits.</summary>
    /// <param name="request">Session/version/hash and expiry facts; the hash is copied only for queue admission.</param>
    /// <returns>
    /// True when the queue accepts ownership; false for invalid or expired facts, pending/debounced sessions,
    /// exhausted tracking capacity, or a full/closed queue. True does not certify a later authority write.
    /// </returns>
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

    /// <summary>Prunes expired tracking under the lock and samples local queue, processing and cumulative counters.</summary>
    /// <returns>Diagnostics whose tracking bytes are estimates and whose processing counters may change concurrently.</returns>
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

/// <summary>Reads session/principal authority facts, populates cold-start batches and refreshes a local session.</summary>
/// <remarks>Missing facts may return null; cancellation and database/decoding failures propagate rather than grant access.</remarks>
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

/// <summary>Reads joined database authority facts and applies them through the existing local projection boundary.</summary>
/// <param name="db">Database client owning the session and principal authority reads.</param>
/// <param name="projection">Local recipient of cold-start and explicit session refresh updates.</param>
/// <param name="options">Batch-size settings for cold-start loading.</param>
/// <param name="timeProvider">Clock used to exclude idle- or absolute-expired sessions from reads.</param>
public sealed class AdminSessionProjectionAuthorityReader(
    ISqlSugarClient db,
    AdminSessionProjection projection,
    AdminSessionProjectionRuntimeOptions options,
    TimeProvider timeProvider) : IAdminSessionProjectionAuthorityReader
{
    /// <summary>Loads unexpired joined session facts in session-ID keyset batches and applies each to the projection.</summary>
    /// <param name="cancellationToken">Cancellation for each authority batch and reader operation.</param>
    /// <returns>The maximum generation encountered, or zero for no rows; readiness is owned by the cold-start worker.</returns>
    /// <exception cref="InvalidOperationException">The projection rejects a loaded update.</exception>
    /// <remarks>Earlier accepted updates remain applied if a later read or apply fails; loading is not an atomic snapshot.</remarks>
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

    /// <summary>Reads and applies one unexpired session fact, marking the projection not ready if no fact is returned.</summary>
    /// <param name="sessionId">The exact authority session identity to refresh.</param>
    /// <param name="cancellationToken">Cancellation for the joined authority read.</param>
    /// <returns>False for a missing/expired row or rejected update; true only when the local apply is accepted.</returns>
    /// <remarks>A missing row changes readiness; it does not synthesize a deletion tombstone. Read failures propagate.</remarks>
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

    /// <summary>Reads an exact session joined with its principal, excluding idle- or absolute-expired rows.</summary>
    /// <param name="sessionId">The exact authority session identity to query.</param>
    /// <param name="cancellationToken">Cancellation for the database reader.</param>
    /// <returns>The hash, revocation, expiry and version facts, or null when the joined unexpired row is absent.</returns>
    /// <remarks>This read does not apply the result or grant access; database and stored-hash decoding failures propagate.</remarks>
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

    /// <summary>Reads a principal's status and validation version without applying the returned fact.</summary>
    /// <param name="principalId">The exact authority principal identity to query.</param>
    /// <param name="cancellationToken">Cancellation checked before and during the database read.</param>
    /// <returns>
    /// Null for a missing row; otherwise an update using validation version as its version and generation,
    /// with exact active status mapped to Active and all other stored statuses mapped to Disabled.
    /// </returns>
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

/// <summary>Keeps session validation not ready until authority loading and the projection readiness check succeed.</summary>
/// <param name="scopeFactory">Factory providing the scoped authority reader for each recovery attempt.</param>
/// <param name="projection">Projection marked not ready before loading and after failed attempts.</param>
/// <param name="options">Retry-delay settings used between failed cold-start attempts.</param>
/// <param name="timeProvider">Clock used by the cancellable recovery delay.</param>
/// <param name="logger">Logger for failed cold-start recovery attempts.</param>
/// <remarks>Failures retain fail-closed readiness and retry; successful readiness or host cancellation ends the worker.</remarks>
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

using System.Globalization;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Contains the bounded, pseudonymized fields queued for one persisted security-risk event.</summary>
/// <param name="Id">The stable event identifier.</param><param name="OccurredAtUtc">The UTC time at which the event occurred.</param>
/// <param name="Source">The subsystem that produced the event.</param><param name="Reason">The normalized risk reason.</param>
/// <param name="Action">The protected action associated with the event.</param><param name="ScoreDelta">The score contributed by the event.</param>
/// <param name="TotalScore">The hot-path score observed when the event was created.</param><param name="TtlSeconds">The lifetime of the score contribution in seconds.</param>
/// <param name="ExpiresAtUtc">The UTC time after which the contribution is inactive.</param><param name="SubjectHash">An optional pseudonymized account subject.</param>
/// <param name="RouteKey">An optional stable route or action key.</param><param name="ClientIpHash">An optional pseudonymized client network identity.</param>
/// <param name="DeviceFpHash">An optional pseudonymized device fingerprint.</param><param name="Path">An optional bounded request path.</param>
/// <param name="Method">An optional HTTP method.</param><param name="UserAgent">An optional bounded user-agent value.</param>
/// <param name="Detail">Optional bounded diagnostic detail.</param><param name="TraceId">An optional request trace identifier.</param>
/// <param name="PseudonymEpoch">The key epoch used for stored identity pseudonyms.</param>
public readonly record struct SecurityRiskEventWrite(
    string Id,
    DateTimeOffset OccurredAtUtc,
    string Source,
    string Reason,
    string Action,
    int ScoreDelta,
    int TotalScore,
    int TtlSeconds,
    DateTimeOffset ExpiresAtUtc,
    string? SubjectHash,
    string? RouteKey,
    string? ClientIpHash,
    string? DeviceFpHash,
    string? Path,
    string? Method,
    string? UserAgent,
    string? Detail,
    string? TraceId,
    int PseudonymEpoch = 1);

/// <summary>Represents a persisted security-risk event returned to scoring or administrative queries.</summary>
/// <param name="Id">The stable event identifier.</param><param name="OccurredAtUtc">The UTC time at which the event occurred.</param>
/// <param name="Source">The subsystem that produced the event.</param><param name="Reason">The normalized risk reason.</param>
/// <param name="Action">The protected action associated with the event.</param><param name="ScoreDelta">The score contributed by the event.</param>
/// <param name="TotalScore">The hot-path score observed when the event was created.</param><param name="TtlSeconds">The lifetime of the score contribution in seconds.</param>
/// <param name="ExpiresAtUtc">The UTC time after which the contribution is inactive.</param><param name="SubjectHash">An optional pseudonymized account subject.</param>
/// <param name="RouteKey">An optional stable route or action key.</param><param name="ClientIpHash">An optional pseudonymized client network identity.</param>
/// <param name="DeviceFpHash">An optional pseudonymized device fingerprint.</param><param name="Path">An optional bounded request path.</param>
/// <param name="Method">An optional HTTP method.</param><param name="UserAgent">An optional bounded user-agent value.</param>
/// <param name="Detail">Optional bounded diagnostic detail.</param><param name="TraceId">An optional request trace identifier.</param>
/// <param name="PseudonymEpoch">The key epoch used for stored identity pseudonyms.</param>
public readonly record struct SecurityRiskEventRecord(
    string Id,
    DateTimeOffset OccurredAtUtc,
    string Source,
    string Reason,
    string Action,
    int ScoreDelta,
    int TotalScore,
    int TtlSeconds,
    DateTimeOffset ExpiresAtUtc,
    string? SubjectHash,
    string? RouteKey,
    string? ClientIpHash,
    string? DeviceFpHash,
    string? Path,
    string? Method,
    string? UserAgent,
    string? Detail,
    string? TraceId,
    int PseudonymEpoch = 1);

/// <summary>Defines bounded filters for reading recent persisted security-risk events.</summary>
/// <param name="Source">An optional subsystem filter.</param>
/// <param name="Reason">An optional risk-reason filter.</param>
/// <param name="Action">An optional protected-action filter.</param>
/// <param name="SubjectHash">An optional pseudonymized subject filter.</param>
/// <param name="Limit">The requested maximum result count before store-side clamping.</param>
public readonly record struct SecurityRiskEventQuery(
    string? Source = null,
    string? Reason = null,
    string? Action = null,
    string? SubjectHash = null,
    int Limit = 100);

/// <summary>Defines the pseudonymized identity dimensions used to aggregate active risk events.</summary>
/// <param name="SubjectHash">An optional pseudonymized account subject.</param>
/// <param name="Action">An optional protected-action filter.</param>
/// <param name="RouteKey">An optional stable route or action key.</param>
/// <param name="ClientIpHash">An optional pseudonymized client network identity.</param>
/// <param name="DeviceFpHash">An optional pseudonymized device fingerprint.</param>
/// <param name="PseudonymEpoch">An optional key epoch used to isolate pseudonym generations.</param>
public readonly record struct SecurityRiskScoreQuery(
    string? SubjectHash,
    string? Action,
    string? RouteKey,
    string? ClientIpHash,
    string? DeviceFpHash,
    int? PseudonymEpoch = null);

/// <summary>Returns an aggregated active risk score and the latest contributing expiry.</summary>
/// <param name="Score">The non-negative decayed score.</param>
/// <param name="ExpiresAtUtc">The latest UTC expiry among active contributions, when present.</param>
public readonly record struct SecurityRiskScoreResult(int Score, DateTimeOffset? ExpiresAtUtc);

/// <summary>Stable event reason used to persist an authoritative risk reset tombstone.</summary>
public static class SecurityRiskEventReasons
{
    public const string RiskReset = "risk_reset";
}

/// <summary>Persists and queries pseudonymized security-risk events.</summary>
public interface ISecurityRiskEventStore
{
    /// <summary>Appends one security-risk event.</summary>
    /// <param name="write">The bounded event to persist.</param>
    /// <param name="cancellationToken">A token that cancels the write.</param>
    /// <returns>A task that completes when the event has been persisted.</returns>
    Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default);

    /// <summary>Appends a batch of security-risk events in one store operation.</summary>
    /// <param name="writes">The bounded events to persist.</param>
    /// <param name="cancellationToken">A token that cancels the write.</param>
    /// <returns>A task that completes when the batch has been persisted.</returns>
    Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default);

    /// <summary>Reads recent events matching administrative query filters.</summary>
    /// <param name="query">The bounded event filters and result limit.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The matching events in reverse occurrence order.</returns>
    Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default);

    /// <summary>Reads unexpired events that contribute to an aggregate score.</summary>
    /// <param name="query">The pseudonymized identity dimensions to match.</param>
    /// <param name="now">The current UTC instant used to exclude expired rows.</param>
    /// <param name="limit">The requested maximum result count before store-side clamping.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The matching active events in reverse occurrence order.</returns>
    Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
        SecurityRiskScoreQuery query,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default);
}

/// <summary>Aggregates persisted active events into a decayed security-risk score.</summary>
public interface IRiskScoreEngine
{
    /// <summary>Computes the active score for the supplied pseudonymized dimensions.</summary>
    /// <param name="query">The identity and action dimensions to aggregate.</param>
    /// <param name="cancellationToken">A token that cancels the aggregation.</param>
    /// <returns>The decayed score and latest contributing expiry.</returns>
    Task<SecurityRiskScoreResult> ComputeScoreAsync(SecurityRiskScoreQuery query, CancellationToken cancellationToken = default);
}

/// <summary>Stores normalized security-risk events through the application database abstraction.</summary>
/// <param name="db">The database client used for event persistence and queries.</param>
public sealed class SecurityRiskEventStore(ISqlSugarClient db) : ISecurityRiskEventStore
{
    /// <summary>Normalizes and persists one security-risk event.</summary>
    /// <param name="write">The bounded event to persist.</param>
    /// <param name="cancellationToken">A token that cancels the write.</param>
    /// <returns>A task that completes when the event has been persisted.</returns>
    public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
        => WithCancellationAsync(() => AppendSingleCoreAsync(write, cancellationToken), cancellationToken);

    private async Task AppendSingleCoreAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityRiskEvent entity = ToEntity(write);
        try
        {
            await db.Insertable(entity).ExecuteCommandAsync();
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            if (!await IsExactlyPersistedAsync(entity, cancellationToken).ConfigureAwait(false))
            {
                throw;
            }
        }
        // A stable ID alone cannot prove a commit of this payload. Both ordinary
        // delivery and commit-before-ACK replay require the normalized exact row.
        if (!await IsExactlyPersistedAsync(entity, cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidDataException("security_risk_commit_postcondition_failed");
        }
    }

    /// <summary>Normalizes and persists a non-empty batch of security-risk events.</summary>
    /// <param name="writes">The bounded events to persist.</param>
    /// <param name="cancellationToken">A token that cancels the write.</param>
    /// <returns>A task that completes when the batch has been persisted.</returns>
    public Task AppendBatchAsync(
        IReadOnlyList<SecurityRiskEventWrite> writes,
        CancellationToken cancellationToken = default)
        => WithCancellationAsync(() => AppendBatchCoreAsync(writes, cancellationToken), cancellationToken);

    private async Task AppendBatchCoreAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (writes.Count == 0)
        {
            return;
        }

        var entities = new List<SecurityRiskEvent>(writes.Count);
        foreach (SecurityRiskEventWrite write in writes)
        {
            cancellationToken.ThrowIfCancellationRequested();
            entities.Add(ToEntity(write));
        }

        try
        {
            await db.Insertable(entities).ExecuteCommandAsync();
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // A partial batch commit or a duplicate event must be reduced to
            // per-event idempotent writes before the worker records disposition.
            foreach (SecurityRiskEventWrite write in writes)
            {
                await AppendAsync(write, cancellationToken).ConfigureAwait(false);
            }
        }
        foreach (SecurityRiskEvent entity in entities)
        {
            if (!await IsExactlyPersistedAsync(entity, cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidDataException("security_risk_commit_postcondition_failed");
            }
        }
    }

    private async Task<bool> IsExactlyPersistedAsync(SecurityRiskEvent expected, CancellationToken cancellationToken)
    {
        List<SecurityRiskEvent> rows = await db.Queryable<SecurityRiskEvent>()
            .Where(item => item.Id == expected.Id).ToListAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count == 0)
        {
            return false;
        }
        if (rows.Count != 1 || !SecurityRiskDurableDelivery.Matches(expected, rows[0]))
        {
            throw new InvalidDataException("security_risk_commit_payload_mismatch");
        }
        return true;
    }

    private async Task WithCancellationAsync(Func<Task> operation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CancellationToken? previous = db.Ado.CancellationToken;
        db.Ado.CancellationToken = cancellationToken;
        try
        {
            await operation().ConfigureAwait(false);
        }
        finally
        {
            db.Ado.CancellationToken = previous;
        }
    }

    /// <summary>Queries recent persisted events using bounded administrative filters.</summary>
    /// <param name="query">The event filters and requested result limit.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The matching events in reverse occurrence order.</returns>
    public async Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(
        SecurityRiskEventQuery query,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int limit = Math.Clamp(query.Limit, 1, 500);
        ISugarQueryable<SecurityRiskEvent> dbQuery = db.Queryable<SecurityRiskEvent>();
        if (!string.IsNullOrWhiteSpace(query.Source))
        {
            string source = query.Source;
            dbQuery = dbQuery.Where(item => item.Source == source);
        }

        if (!string.IsNullOrWhiteSpace(query.Reason))
        {
            string reason = query.Reason;
            dbQuery = dbQuery.Where(item => item.Reason == reason);
        }

        if (!string.IsNullOrWhiteSpace(query.Action))
        {
            string action = query.Action;
            dbQuery = dbQuery.Where(item => item.Action == action);
        }

        if (!string.IsNullOrWhiteSpace(query.SubjectHash))
        {
            string subjectHash = query.SubjectHash;
            dbQuery = dbQuery.Where(item => item.SubjectHash == subjectHash);
        }

        List<SecurityRiskEvent> rows = await dbQuery
            .OrderBy(item => item.OccurredAtUtc, OrderByType.Desc)
            .Take(limit)
            .ToListAsync();
        return rows.Select(ToRecord).ToArray();
    }

    /// <summary>Queries unexpired events that match the supplied pseudonymized score dimensions.</summary>
    /// <param name="query">The pseudonymized identity dimensions to match.</param>
    /// <param name="now">The current UTC instant used to exclude expired rows.</param>
    /// <param name="limit">The requested maximum result count before store-side clamping.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The matching active events in reverse occurrence order.</returns>
    public async Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
        SecurityRiskScoreQuery query,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // PublicHotRead durable replay uses the projection's explicit 100k
        // entry budget. Other callers still pass much smaller limits; keeping
        // this upper bound finite prevents an unbounded restart query.
        int clampedLimit = Math.Clamp(limit, 1, 100_000);
        DateTime nowUtc = now.UtcDateTime;
        ISugarQueryable<SecurityRiskEvent> dbQuery = db.Queryable<SecurityRiskEvent>()
            .Where(item => item.ExpiresAtUtc > nowUtc);
        if (!string.IsNullOrWhiteSpace(query.SubjectHash))
        {
            string subjectHash = query.SubjectHash;
            dbQuery = dbQuery.Where(item => item.SubjectHash == subjectHash);
        }

        if (!string.IsNullOrWhiteSpace(query.Action))
        {
            string action = query.Action;
            dbQuery = dbQuery.Where(item => item.Action == action);
        }

        if (!string.IsNullOrWhiteSpace(query.RouteKey))
        {
            string routeKey = query.RouteKey;
            dbQuery = dbQuery.Where(item => item.RouteKey == routeKey);
        }

        if (!string.IsNullOrWhiteSpace(query.ClientIpHash))
        {
            string clientIpHash = query.ClientIpHash;
            dbQuery = dbQuery.Where(item => item.ClientIpHash == clientIpHash);
        }

        if (!string.IsNullOrWhiteSpace(query.DeviceFpHash))
        {
            string deviceFpHash = query.DeviceFpHash;
            dbQuery = dbQuery.Where(item => item.DeviceFpHash == deviceFpHash);
        }

        if (query.PseudonymEpoch is { } pseudonymEpoch)
        {
            dbQuery = dbQuery.Where(item => item.PseudonymEpoch == pseudonymEpoch);
        }

        List<SecurityRiskEvent> rows = await dbQuery
            .OrderBy(item => item.OccurredAtUtc, OrderByType.Desc)
            .Take(clampedLimit)
            .ToListAsync();
        return rows.Select(ToRecord).ToArray();
    }

    private static SecurityRiskEventRecord ToRecord(SecurityRiskEvent item)
        => new(
            item.Id,
            new DateTimeOffset(DateTime.SpecifyKind(item.OccurredAtUtc, DateTimeKind.Utc)),
            item.Source,
            item.Reason,
            item.Action,
            item.ScoreDelta,
            item.TotalScore,
            item.TtlSeconds,
            new DateTimeOffset(DateTime.SpecifyKind(item.ExpiresAtUtc, DateTimeKind.Utc)),
            item.SubjectHash,
            item.RouteKey,
            item.ClientIpHash,
            item.DeviceFpHash,
            item.Path,
            item.Method,
            item.UserAgent,
            item.Detail,
            item.TraceId,
            item.PseudonymEpoch);

    internal static SecurityRiskEvent ToEntity(SecurityRiskEventWrite write)
    {
        bool hasPseudonym = write.SubjectHash is not null
            || write.ClientIpHash is not null
            || write.DeviceFpHash is not null;
        if (hasPseudonym && write.PseudonymEpoch <= 0)
        {
            throw new InvalidOperationException("Security risk identity pseudonyms require a positive epoch.");
        }

        return new()
        {
            Id = Normalize(write.Id, 64) ?? Guid.NewGuid().ToString("N"),
            OccurredAtUtc = write.OccurredAtUtc.UtcDateTime,
            Source = Normalize(write.Source, 64) ?? SecurityRiskSources.RiskControl,
            Reason = Normalize(write.Reason, 64) ?? nameof(SecurityRiskReason.SecurityChallengeRejected),
            Action = Normalize(write.Action, 96) ?? "security_risk",
            ScoreDelta = write.ScoreDelta,
            TotalScore = write.TotalScore,
            TtlSeconds = Math.Max(0, write.TtlSeconds),
            ExpiresAtUtc = write.ExpiresAtUtc.UtcDateTime,
            SubjectHash = NormalizeHash(write.SubjectHash),
            RouteKey = Normalize(write.RouteKey, 160),
            ClientIpHash = NormalizeHash(write.ClientIpHash),
            DeviceFpHash = NormalizeHash(write.DeviceFpHash),
            Path = null,
            Method = Normalize(write.Method, 16),
            UserAgent = null,
            Detail = Normalize(write.Detail, 256),
            TraceId = Normalize(write.TraceId, 64),
            PseudonymEpoch = Math.Max(0, write.PseudonymEpoch)
        };
    }

    private static string? Normalize(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeHash(string? value)
    {
        string? normalized = Normalize(value, 64);
        return normalized is { Length: 64 } ? normalized.ToLowerInvariant() : null;
    }
}

/// <summary>Calculates time-decayed risk scores from persisted active events.</summary>
/// <param name="store">The event store that supplies active score contributions.</param>
/// <param name="timeProvider">The clock used to evaluate expiry and decay.</param>
public sealed class RiskScoreEngine(ISecurityRiskEventStore store, TimeProvider timeProvider) : IRiskScoreEngine
{
    /// <summary>Computes a non-negative time-decayed score for the supplied identity dimensions.</summary>
    /// <param name="query">The pseudonymized identity dimensions to aggregate.</param>
    /// <param name="cancellationToken">A token that cancels the aggregation.</param>
    /// <returns>The decayed score and latest contributing expiry.</returns>
    public async Task<SecurityRiskScoreResult> ComputeScoreAsync(
        SecurityRiskScoreQuery query,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        IReadOnlyList<SecurityRiskEventRecord> events = await store.ListActiveForScoreAsync(query, now, 1000, cancellationToken);
        int total = 0;
        DateTimeOffset? expiresAt = null;
        bool resetBarrierSeen = false;
        foreach (SecurityRiskEventRecord item in events)
        {
            TimeSpan remaining = item.ExpiresAtUtc - now;
            if (remaining <= TimeSpan.Zero)
            {
                continue;
            }

            if (string.Equals(item.Reason, SecurityRiskEventReasons.RiskReset, StringComparison.Ordinal))
            {
                // Events are read newest-first. A reset is an authoritative
                // barrier: retain newer observations already accumulated, but
                // never resurrect older positive contributions after an admin
                // reset or a restart/fallback read.
                resetBarrierSeen = true;
                continue;
            }

            if (resetBarrierSeen)
            {
                continue;
            }

            double decayFactor = item.TtlSeconds <= 0
                ? 1d
                : Math.Clamp(remaining.TotalSeconds / item.TtlSeconds, 0d, 1d);
            int decayed = (int)Math.Round(item.ScoreDelta * decayFactor, MidpointRounding.AwayFromZero);
            total += decayed;
            if (expiresAt is null || item.ExpiresAtUtc > expiresAt.Value)
            {
                expiresAt = item.ExpiresAtUtc;
            }
        }

        return new SecurityRiskScoreResult(Math.Max(0, total), expiresAt);
    }
}

/// <summary>Updates hot-path risk state and queues privacy-bounded events for durable scoring.</summary>
/// <param name="hotPath">The in-memory and distributed hot-path risk service.</param>
/// <param name="cache">The unified cache used to read and warm active scores.</param>
/// <param name="policy">The current administrative security policy provider.</param>
/// <param name="pseudonymizer">The service that derives epoch-bound identity pseudonyms.</param>
/// <param name="eventQueue">The bounded queue used for best-effort event persistence.</param>
/// <param name="scopeFactory">The scope factory used to resolve fallback score engines.</param>
/// <param name="logger">The logger used for persistence and aggregation failures.</param>
/// <param name="timeProvider">The clock used for event occurrence and expiry times.</param>
public sealed class SecurityRiskEventSink(
    CrawlerRiskService hotPath,
    ICacheStringReader cacheReader,
    ICacheStringWriter cacheWriter,
    ISecurityAdminPolicyService policy,
    ISecurityRiskPseudonymizer pseudonymizer,
    SecurityRiskEventWriteQueue eventQueue,
    IServiceScopeFactory scopeFactory,
    ILogger<SecurityRiskEventSink> logger,
    TimeProvider timeProvider,
    IPublicHotReadRiskProjection? publicHotReadRiskProjection = null,
    IPublicHotReadRiskProjectionPublisher? publicHotReadRiskProjectionPublisher = null) : ISecurityRiskSignalSink, ISecurityRiskScoreReader
{
    /// <summary>Applies an observation to hot-path risk state and queues its bounded persisted representation.</summary>
    /// <param name="signal">The security observation to process.</param>
    /// <param name="cancellationToken">A token that cancels asynchronous processing.</param>
    /// <returns>A value task that completes after hot-path processing and queue admission.</returns>
    public async ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
    {
        FsusObservability.RecordSecurityRiskEvent(signal.Source, signal.Reason.ToString(), signal.Action, "received");
        int totalScore = await hotPath.AddRiskAndGetScoreAsync(signal, cancellationToken).ConfigureAwait(false);
        if (ShouldSkipPersistence(signal))
        {
            return;
        }

        try
        {
            SecurityRiskEventWrite write = BuildWrite(signal, totalScore);
            ApplyPublicHotReadProjection(write, publicHotReadRiskProjection, publicHotReadRiskProjectionPublisher, logger);
            if (!await eventQueue.EnqueueAsync(write, cancellationToken).ConfigureAwait(false))
            {
                FsusObservability.RecordSecurityRiskEvent(
                    signal.Source,
                    signal.Reason.ToString(),
                    signal.Action,
                    "durable_admission_rejected");
            }
        }
        catch (Exception)
        {
            eventQueue.MarkPreparationFailed();
            FsusObservability.RecordSecurityEvent("security_risk", signal.Reason, "persist_failed");
            FsusObservability.RecordSecurityRiskEvent(signal.Source, signal.Reason.ToString(), signal.Action, "persist_failed");
            logger.LogWarning("security-risk-persist-failed Reason=signal-preparation-failed");
        }
    }

    private static void ApplyPublicHotReadProjection(
        SecurityRiskEventWrite write,
        IPublicHotReadRiskProjection? projection,
        IPublicHotReadRiskProjectionPublisher? publisher,
        ILogger<SecurityRiskEventSink> logger)
    {
        if (projection is null || write.ClientIpHash is null)
        {
            return;
        }

        PublicHotReadRiskProjectionUpdate update = new(
            write.ClientIpHash,
            Math.Max(1, write.PseudonymEpoch),
            write.TotalScore,
            write.OccurredAtUtc,
            write.ExpiresAtUtc,
            write.Id);
        projection.Apply(update);
        if (publisher is null)
        {
            return;
        }

        _ = PublishProjectionAsync(publisher, update, logger);
    }

    private static async Task PublishProjectionAsync(
        IPublicHotReadRiskProjectionPublisher publisher,
        PublicHotReadRiskProjectionUpdate update,
        ILogger<SecurityRiskEventSink> logger)
    {
        try
        {
            await publisher.PublishAsync(update, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // PostgreSQL event persistence is the durable replay source. A
            // transient Pub/Sub failure must never make a risk signal fail.
            logger.LogWarning(ex, "public-hot-risk-projection-async-publish-failed");
        }
    }

    /// <summary>Gets the active score for the client represented by a request, using persisted fallback when needed.</summary>
    /// <param name="context">The request context from which the client identity is resolved.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The non-negative active risk score.</returns>
    public async Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
    {
        string ip = context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return 0;
        }

        int hotScore = await TryReadHotCacheAsync(ip, cancellationToken);
        if (hotScore > 0)
        {
            return hotScore;
        }

        SecurityRiskScoreResult fallback = await ComputeFallbackForPseudonymsAsync(
            pseudonymizer.PseudonymizeForRead(SecurityRiskIdentityDomain.ClientIp, ip),
            static pseudonym => new SecurityRiskScoreQuery(
                null,
                null,
                null,
                pseudonym.Hash,
                null,
                pseudonym.Epoch),
            cancellationToken);
        if (fallback.Score <= 0)
        {
            return 0;
        }

        await WarmHotCacheAsync(ip, fallback, cancellationToken);
        return fallback.Score;
    }

    /// <summary>Gets the active score for an explicit subject, using persisted fallback when needed.</summary>
    /// <param name="subject">The subject whose score is requested.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The non-negative active risk score.</returns>
    public async Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return 0;
        }

        int hotScore = await TryReadHotCacheAsync(subject.Identity, cancellationToken);
        if (hotScore > 0)
        {
            return hotScore;
        }

        SecurityRiskScoreResult fallback = await ComputeFallbackForPseudonymsAsync(
            pseudonymizer.PseudonymizeForRead(SecurityRiskIdentityDomain.ClientIp, subject.Identity),
            static pseudonym => new SecurityRiskScoreQuery(
                null,
                null,
                null,
                pseudonym.Hash,
                null,
                pseudonym.Epoch),
            cancellationToken);
        if (fallback.Score <= 0)
        {
            return 0;
        }

        await WarmHotCacheAsync(subject.Identity, fallback, cancellationToken);
        return fallback.Score;
    }

    /// <summary>Clears hot-path risk state for an explicit subject.</summary>
    /// <param name="subject">The subject whose score is reset.</param>
    /// <param name="cancellationToken">A token that cancels the reset operation.</param>
    /// <returns>A task that completes when the reset has finished.</returns>
    public async Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return;
        }

        await hotPath.ResetRiskAsync(subject, cancellationToken).ConfigureAwait(false);
        if (publicHotReadRiskProjection is null)
        {
            return;
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        // Keep the durable tombstone active for the maximum accepted event TTL.
        // The local projection still clamps each resident entry to its own bound,
        // while replay can refresh the zero barrier before older events expire.
        DateTimeOffset expiresAt = now.AddDays(1);
        IReadOnlyList<SecurityRiskPseudonym> pseudonyms = pseudonymizer.PseudonymizeForRead(
            SecurityRiskIdentityDomain.ClientIp,
            subject.Identity);
        var updates = new List<(PublicHotReadRiskProjectionUpdate Update, SecurityRiskEventWrite Write)>(pseudonyms.Count);
        foreach ((SecurityRiskPseudonym pseudonym, int index) in pseudonyms.Select(static (value, index) => (value, index)))
        {
            string eventId = $"risk-reset-{now.ToUnixTimeMilliseconds():x}-{index}-{Guid.NewGuid():N}";
            PublicHotReadRiskProjectionUpdate update = new(
                pseudonym.Hash,
                pseudonym.Epoch,
                0,
                now,
                expiresAt,
                eventId,
                IsAuthoritativeZero: true);
            updates.Add((
                update,
                new SecurityRiskEventWrite(
                    eventId,
                    now,
                    SecurityRiskSources.RiskControl,
                    SecurityRiskEventReasons.RiskReset,
                    RiskActionNames.PublicRead,
                    0,
                    0,
                    (int)(expiresAt - now).TotalSeconds,
                    expiresAt,
                    null,
                    "security.risk.reset",
                    pseudonym.Hash,
                    null,
                    null,
                    HttpMethods.Post,
                    null,
                    "authoritative_public_hot_read_reset",
                    null,
                    pseudonym.Epoch)));
        }

        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            await store.AppendBatchAsync(updates.Select(static item => item.Write).ToArray(), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Do not clear a resident positive or publish a non-durable zero. A
            // failed reset remains fail-closed and is surfaced to the caller.
            logger.LogWarning(ex, "public-hot-risk-projection-reset-persist-failed");
            throw;
        }

        foreach ((PublicHotReadRiskProjectionUpdate update, _) in updates)
        {
            publicHotReadRiskProjection.Apply(update);
            if (publicHotReadRiskProjectionPublisher is not null)
            {
                _ = PublishProjectionAsync(publicHotReadRiskProjectionPublisher, update, logger);
            }
        }
    }

    private async Task<SecurityRiskScoreResult> ComputeFallbackAsync(
        SecurityRiskScoreQuery query,
        CancellationToken cancellationToken)
    {
        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            IRiskScoreEngine engine = scope.ServiceProvider.GetRequiredService<IRiskScoreEngine>();
            return await engine.ComputeScoreAsync(query, cancellationToken);
        }
        catch (Exception ex)
        {
            FsusObservability.RecordSecurityEvent("security_risk", "aggregate", "fallback_failed");
            logger.LogWarning(ex, "security-risk-aggregation-failed");
            return new SecurityRiskScoreResult(0, null);
        }
    }

    private async Task<SecurityRiskScoreResult> ComputeFallbackForPseudonymsAsync(
        IReadOnlyList<SecurityRiskPseudonym> pseudonyms,
        Func<SecurityRiskPseudonym, SecurityRiskScoreQuery> buildQuery,
        CancellationToken cancellationToken)
    {
        int total = 0;
        DateTimeOffset? expiresAt = null;
        foreach (SecurityRiskPseudonym pseudonym in pseudonyms)
        {
            SecurityRiskScoreResult result = await ComputeFallbackAsync(
                buildQuery(pseudonym),
                cancellationToken);
            total = checked(total + result.Score);
            if (result.ExpiresAtUtc is { } candidate
                && (expiresAt is null || candidate > expiresAt.Value))
            {
                expiresAt = candidate;
            }
        }

        return new SecurityRiskScoreResult(total, expiresAt);
    }

    private async Task WarmHotCacheAsync(
        string identity,
        SecurityRiskScoreResult fallback,
        CancellationToken cancellationToken)
    {
        TimeSpan ttl = fallback.ExpiresAtUtc is { } expiresAt
            ? expiresAt - timeProvider.GetUtcNow()
            : TimeSpan.FromSeconds(policy.Current.Options.DefaultRiskTtlSeconds);
        if (ttl <= TimeSpan.Zero)
        {
            return;
        }

        await cacheWriter.SetStringAsync(
            CachePolicyId.SecurityPowRisk,
            identity,
            fallback.Score.ToString(CultureInfo.InvariantCulture),
            ttl,
            cancellationToken);
    }

    private async Task<int> TryReadHotCacheAsync(string identity, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(identity))
        {
            return 0;
        }

        string? existing = await cacheReader.GetStringAsync(CachePolicyId.SecurityPowRisk, identity, cancellationToken);
        return int.TryParse(existing, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? Math.Clamp(value, 0, policy.CurrentRiskPolicy.MaxRiskScore)
            : 0;
    }

    private bool ShouldSkipPersistence(SecurityRiskSignal signal)
        => string.Equals(signal.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase)
            && string.Equals(SecuritySystemModes.Normalize(policy.CurrentRiskPolicy.SubsystemModes[SecurityRiskSources.AntiCrawler]), SecuritySystemModes.Disabled, StringComparison.Ordinal);

    private SecurityRiskEventWrite BuildWrite(SecurityRiskSignal signal, int totalScore)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        TimeSpan ttl = signal.Ttl <= TimeSpan.Zero
            ? TimeSpan.FromSeconds(policy.Current.Options.DefaultRiskTtlSeconds)
            : signal.Ttl;
        string reason = signal.Reason.ToString();
        SecurityRiskPseudonym? clientIp = ResolveClientIpPseudonym(signal);
        SecurityRiskPseudonym? subject = ResolveSubjectPseudonym(signal);
        string? routeKey = Normalize(signal.RouteKey, 160)
            ?? Normalize(signal.Context.GetEndpoint()?.Metadata.GetMetadata<RiskActionEndpointMetadata>()?.RouteKey, 160)
            ?? Normalize(signal.Action, 96);
        SecurityRiskPseudonym? device = ResolveDevicePseudonym(signal);
        return new SecurityRiskEventWrite(
            Guid.NewGuid().ToString("N"),
            now,
            Normalize(signal.Source, 64) ?? SecurityRiskSources.RiskControl,
            reason,
            Normalize(signal.Action, 96) ?? "security_risk",
            signal.Score,
            totalScore,
            (int)Math.Clamp(ttl.TotalSeconds, 0, int.MaxValue),
            now.Add(ttl),
            subject?.Hash,
            routeKey,
            clientIp?.Hash,
            device?.Hash,
            null,
            Normalize(signal.Context.Request.Method, 16),
            null,
            Normalize(signal.Detail, 256),
            Normalize(signal.Context.TraceIdentifier, 64),
            clientIp?.Epoch ?? subject?.Epoch ?? device?.Epoch ?? pseudonymizer.CurrentEpoch);
    }

    private SecurityRiskPseudonym? ResolveClientIpPseudonym(SecurityRiskSignal signal)
    {
        string value = signal.Context.GetClientIp();
        if (string.IsNullOrWhiteSpace(value))
        {
            value = NormalizeHash(signal.ClientIpHash) ?? string.Empty;
        }

        return value.Length == 0
            ? null
            : pseudonymizer.PseudonymizeCurrent(SecurityRiskIdentityDomain.ClientIp, value);
    }

    private SecurityRiskPseudonym? ResolveSubjectPseudonym(SecurityRiskSignal signal)
    {
        HttpContext context = signal.Context;
        string? identityKind = Normalize(context.User.FindFirstValue("identity_kind"), 64);
        string? accountSubjectHash = NormalizeHash(
            context.User.FindFirstValue(AnonymousIdentityRuntime.AccountSubjectHashClaim));
        string? value = identityKind is not null && accountSubjectHash is not null
            ? string.Join('\0', identityKind, accountSubjectHash)
            : NormalizeHash(signal.SubjectHash);
        return value is null
            ? null
            : pseudonymizer.PseudonymizeCurrent(SecurityRiskIdentityDomain.AccountSubject, value);
    }

    private SecurityRiskPseudonym? ResolveDevicePseudonym(SecurityRiskSignal signal)
    {
        string value = signal.Context.Request.Headers["X-Fsus-Device-Fp"].ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            value = NormalizeHash(signal.DeviceFpHash) ?? string.Empty;
        }

        return value.Length == 0
            ? null
            : pseudonymizer.PseudonymizeCurrent(SecurityRiskIdentityDomain.DeviceFingerprint, value);
    }

    private static string? NormalizeHash(string? value)
    {
        string? normalized = Normalize(value, 64);
        return normalized is { Length: 64 } ? normalized.ToLowerInvariant() : null;
    }

    private static string? Normalize(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }
}

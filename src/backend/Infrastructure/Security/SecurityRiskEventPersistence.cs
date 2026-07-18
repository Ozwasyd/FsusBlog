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

public readonly record struct SecurityRiskEventQuery(
    string? Source = null,
    string? Reason = null,
    string? Action = null,
    string? SubjectHash = null,
    int Limit = 100);

public readonly record struct SecurityRiskScoreQuery(
    string? SubjectHash,
    string? Action,
    string? RouteKey,
    string? ClientIpHash,
    string? DeviceFpHash,
    int? PseudonymEpoch = null);

public readonly record struct SecurityRiskScoreResult(int Score, DateTimeOffset? ExpiresAtUtc);

public interface ISecurityRiskEventStore
{
    Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default);

    Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(SecurityRiskEventQuery query, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
        SecurityRiskScoreQuery query,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default);
}

public interface IRiskScoreEngine
{
    Task<SecurityRiskScoreResult> ComputeScoreAsync(SecurityRiskScoreQuery query, CancellationToken cancellationToken = default);
}

public sealed class SecurityRiskEventStore(ISqlSugarClient db) : ISecurityRiskEventStore
{
    public async Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Insertable(ToEntity(write)).ExecuteCommandAsync();
    }

    public async Task AppendBatchAsync(
        IReadOnlyList<SecurityRiskEventWrite> writes,
        CancellationToken cancellationToken = default)
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

        await db.Insertable(entities).ExecuteCommandAsync();
    }

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

    public async Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
        SecurityRiskScoreQuery query,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int clampedLimit = Math.Clamp(limit, 1, 2000);
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

    private static SecurityRiskEvent ToEntity(SecurityRiskEventWrite write)
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

public sealed class RiskScoreEngine(ISecurityRiskEventStore store, TimeProvider timeProvider) : IRiskScoreEngine
{
    public async Task<SecurityRiskScoreResult> ComputeScoreAsync(
        SecurityRiskScoreQuery query,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        IReadOnlyList<SecurityRiskEventRecord> events = await store.ListActiveForScoreAsync(query, now, 1000, cancellationToken);
        int total = 0;
        DateTimeOffset? expiresAt = null;
        foreach (SecurityRiskEventRecord item in events)
        {
            TimeSpan remaining = item.ExpiresAtUtc - now;
            if (remaining <= TimeSpan.Zero)
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

public sealed class SecurityRiskEventSink(
    CrawlerRiskService hotPath,
    IUnifiedCache cache,
    ISecurityAdminPolicyService policy,
    ISecurityRiskPseudonymizer pseudonymizer,
    SecurityRiskEventWriteQueue eventQueue,
    IServiceScopeFactory scopeFactory,
    ILogger<SecurityRiskEventSink> logger,
    TimeProvider timeProvider) : ISecurityRiskSignalSink, ISecurityRiskScoreReader
{
    public async ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
    {
        FsusObservability.RecordSecurityRiskEvent(signal.Source, signal.Reason.ToString(), signal.Action, "received");
        await hotPath.AddRiskAsync(signal, cancellationToken);
        if (ShouldSkipPersistence(signal))
        {
            return;
        }

        try
        {
            int totalScore = await TryReadHotCacheAsync(signal.Context.GetClientIp(), cancellationToken);
            SecurityRiskEventWrite write = BuildWrite(signal, totalScore);
            if (!eventQueue.TryWrite(write))
            {
                FsusObservability.RecordSecurityRiskEvent(signal.Source, signal.Reason.ToString(), signal.Action, "queue_full");
            }
        }
        catch (Exception ex)
        {
            FsusObservability.RecordSecurityEvent("security_risk", signal.Reason, "persist_failed");
            FsusObservability.RecordSecurityRiskEvent(signal.Source, signal.Reason.ToString(), signal.Action, "persist_failed");
            logger.LogWarning(
                ex,
                "security-risk-persist-failed {Source} {Reason} {Action}",
                signal.Source,
                signal.Reason.ToString(),
                signal.Action);
        }
    }

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

    public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
        => hotPath.ResetRiskAsync(subject, cancellationToken);

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

        await cache.SetStringAsync(
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

        string? existing = await cache.GetStringAsync(CachePolicyId.SecurityPowRisk, identity, cancellationToken);
        return int.TryParse(existing, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? Math.Clamp(value, 0, policy.Current.Options.MaxRiskScore)
            : 0;
    }

    private bool ShouldSkipPersistence(SecurityRiskSignal signal)
        => string.Equals(signal.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase)
            && string.Equals(SecuritySystemModes.Normalize(policy.Current.Options.Mode), SecuritySystemModes.Disabled, StringComparison.Ordinal);

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

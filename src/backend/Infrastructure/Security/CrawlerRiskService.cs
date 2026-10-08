using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

// Compatibility alias kept for existing callers while new code moves to SecurityRiskReason.
/// <summary>
/// Identifies legacy crawler-risk causes that are translated into the unified security-risk taxonomy.
/// </summary>
public enum CrawlerRiskReason
{
    FakeCrawler,
    UnknownBot,
    BlockedUserAgent,
    UserAgentMissing,
    RateLimited,
    PowInvalid,
    PowReplay,
    ReadProofRejected,
    PublicReadPowRequired,
    PublicReadBlocked
}

/// <summary>
/// Maintains the low-latency crawler risk score while honoring runtime anti-crawler policy modes.
/// </summary>
/// <param name="cache">Unified cache used for atomic, expiring risk-score updates.</param>
/// <param name="securityPolicy">Runtime policy and administrative risk-event projection.</param>
/// <param name="logger">Logger for privacy-safe risk-score transitions.</param>
public sealed class CrawlerRiskService(
    ICacheCounterStore counters,
    ICacheStringReader cacheReader,
    ICacheStringWriter cacheWriter,
    ICacheInvalidationStore invalidation,
    ISecurityAdminPolicyService securityPolicy,
    ILogger<CrawlerRiskService> logger) : ICrawlerRiskService, ISecurityRiskSignalSink, ISecurityRiskScoreReader
{
    public const int RequirePowScore = 50;
    public const int BlockScore = 100;

    /// <summary>
    /// Translates a legacy crawler signal and applies it to the unified risk-score path.
    /// </summary>
    /// <param name="context">Request associated with the risk signal.</param>
    /// <param name="reason">Legacy crawler-risk reason to translate.</param>
    /// <param name="score">Signed score delta to apply.</param>
    /// <param name="ttl">Lifetime of the score contribution.</param>
    /// <param name="cancellationToken">Token that cancels cache access.</param>
    /// <returns>A task that completes after the risk update and policy projection are processed.</returns>
    public async Task AddRiskAsync(
        HttpContext context,
        CrawlerRiskReason reason,
        int score,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
        => await AddRiskAsync(
            new SecurityRiskSignal(
                context,
                ToSecurityRiskReason(reason),
                score,
                ttl,
                InferLegacySource(reason),
                "risk_added",
                reason.ToString()),
            cancellationToken);

    /// <summary>
    /// Applies a unified risk signal to the hot score, policy projection, and observability stream.
    /// </summary>
    /// <param name="signal">Normalized signal containing request, source, reason, score, and expiry data.</param>
    /// <param name="cancellationToken">Token that cancels cache access.</param>
    /// <returns>A value task that completes when the signal has been applied or intentionally ignored by policy.</returns>
    public async ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
    {
        _ = await AddRiskAndGetScoreAsync(signal, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Applies a signal and returns the exact post-atomic-update score. The event
    /// sink uses this value to update the public projection without a second
    /// Redis read or a stale read-modify-write race.
    /// </summary>
    public async Task<int> AddRiskAndGetScoreAsync(
        SecurityRiskSignal signal,
        CancellationToken cancellationToken = default)
    {
        AntiCrawlerPolicyOptions antiCrawlerOptions = securityPolicy.Current.Options;
        SecurityRiskPolicy riskPolicy = securityPolicy.CurrentRiskPolicy;
        string antiCrawlerMode = riskPolicy.SubsystemModes[SecurityRiskSources.AntiCrawler];
        bool isAntiCrawlerSignal = string.Equals(signal.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase);
        if (isAntiCrawlerSignal && string.Equals(SecuritySystemModes.Normalize(antiCrawlerMode), SecuritySystemModes.Disabled, StringComparison.Ordinal))
        {
            return 0;
        }

        string ip = signal.Context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return 0;
        }

        int scoreDelta = signal.Score;
        if (scoreDelta > 0 && isAntiCrawlerSignal && !antiCrawlerOptions.RiskScoringEnabled)
        {
            scoreDelta = 0;
        }

        if (string.Equals(SecuritySystemModes.Normalize(antiCrawlerMode), SecuritySystemModes.Observe, StringComparison.Ordinal)
            && isAntiCrawlerSignal)
        {
            scoreDelta = 0;
        }

        int current = 0;
        int next = 0;
        TimeSpan effectiveTtl = signal.Ttl <= TimeSpan.Zero
            ? TimeSpan.FromSeconds(antiCrawlerOptions.DefaultRiskTtlSeconds)
            : signal.Ttl;
        if (scoreDelta > 0)
        {
            long startedAt = Stopwatch.GetTimestamp();
            long updated = await counters.IncrementClampedWithExpiryAsync(
                CachePolicyId.SecurityPowRisk,
                ip,
                scoreDelta,
                riskPolicy.MaxRiskScore,
                effectiveTtl,
                cancellationToken);
            next = (int)Math.Clamp(updated, 0, riskPolicy.MaxRiskScore);
            FsusObservability.RecordRiskScoreAtomicUpdate(
                FsusObservability.GetElapsed(startedAt),
                riskScoreRedisRoundTrips: 1,
                riskScoreConflictAvoided: 1);
        }
        else if (scoreDelta < 0)
        {
            current = await GetRiskScoreForIpAsync(ip, cancellationToken);
            next = Math.Clamp(current + scoreDelta, 0, riskPolicy.MaxRiskScore);
            if (next > 0)
            {
                await cacheWriter.SetStringAsync(CachePolicyId.SecurityPowRisk, ip, next.ToString(System.Globalization.CultureInfo.InvariantCulture), effectiveTtl, cancellationToken);
            }
            else
            {
                await invalidation.RemoveAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
            }
        }

        string ipHash = HashForLog(ip);
        string userAgentHash = HashForLog(signal.Context.GetUserAgent());
        var riskEvent = new AntiCrawlerRiskEventResponse(
            Guid.NewGuid().ToString("N"),
            DateTimeOffset.UtcNow,
            signal.Source,
            signal.Reason.ToString(),
            signal.Action,
            scoreDelta,
            next,
            ipHash,
            signal.Action,
            signal.Context.Request.Method,
            userAgentHash,
            signal.Detail);
        securityPolicy.RecordRiskEvent(riskEvent);
        if (scoreDelta > 0 || current > 0)
        {
            securityPolicy.UpsertRiskSnapshot(new SecurityRiskSnapshotResponse(
                ip,
                next,
                signal.Reason.ToString(),
                signal.Source,
                DateTimeOffset.UtcNow,
                DateTimeOffset.UtcNow.Add(effectiveTtl)));
        }

        string reasonName = signal.Reason.ToString();
        FsusObservability.RecordSecurityEvent("security_risk", signal.Reason, signal.Action);
        logger.LogInformation(
            "security-risk-added {Source} {Reason} {Score} {TotalScore} {TtlSeconds}s",
            signal.Source,
            reasonName,
            scoreDelta,
            next,
            (int)effectiveTtl.TotalSeconds);

        return next;
    }

    /// <summary>
    /// Reads the current hot risk score for the client IP resolved from a request.
    /// </summary>
    /// <param name="context">Request whose client identity is queried.</param>
    /// <param name="cancellationToken">Token that cancels cache access.</param>
    /// <returns>The bounded score, or zero when the request has no usable client identity.</returns>
    public async Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
    {
        string ip = context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return 0;
        }

        return await GetRiskScoreForIpAsync(ip, cancellationToken);
    }

    private static string HashForLog(string? value)
    {
        byte[] hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value ?? string.Empty));
        return Convert.ToHexStringLower(hash.AsSpan(0, 8));
    }

    /// <summary>
    /// Reads the current hot risk score for an explicit risk subject.
    /// </summary>
    /// <param name="subject">Logical subject whose identity is used as the cache key.</param>
    /// <param name="cancellationToken">Token that cancels cache access.</param>
    /// <returns>The bounded score, or zero for a blank or unscored identity.</returns>
    public async Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return 0;
        }

        return await GetRiskScoreForIpAsync(subject.Identity, cancellationToken);
    }

    /// <summary>
    /// Determines whether a request has reached the current policy's challenge threshold.
    /// </summary>
    /// <param name="context">Request whose client risk is evaluated.</param>
    /// <param name="cancellationToken">Token that cancels score lookup.</param>
    /// <returns><see langword="true"/> when the current score requires a challenge; otherwise <see langword="false"/>.</returns>
    public async Task<bool> IsHighRiskAsync(HttpContext context, CancellationToken cancellationToken = default)
        => await GetRiskScoreAsync(context, cancellationToken) >= securityPolicy.CurrentRiskPolicy.ResolveActionPolicy(RiskActionNames.PublicRead).Thresholds.ChallengeScore;

    /// <summary>
    /// Clears the hot risk score associated with a client IP identity.
    /// </summary>
    /// <param name="ip">Client IP identity to clear.</param>
    /// <param name="cancellationToken">Token that cancels cache removal.</param>
    /// <returns>A task that completes after the reset is projected.</returns>
    public async Task ResetRiskAsync(string ip, CancellationToken cancellationToken = default)
        => await ResetRiskAsync(new SecurityRiskSubject(ip), cancellationToken);

    /// <summary>
    /// Clears the hot risk score for an explicit subject and records an administrative reset snapshot.
    /// </summary>
    /// <param name="subject">Logical subject whose score is removed.</param>
    /// <param name="cancellationToken">Token that cancels cache removal.</param>
    /// <returns>A task that completes after cache and policy state are updated.</returns>
    public async Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return;
        }

        await invalidation.RemoveAsync(CachePolicyId.SecurityPowRisk, subject.Identity, cancellationToken);
        securityPolicy.UpsertRiskSnapshot(new SecurityRiskSnapshotResponse(
            subject.Identity,
            0,
            "reset",
            "admin",
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow));
    }

    private async Task<int> GetRiskScoreForIpAsync(string ip, CancellationToken cancellationToken)
    {
        string? existing = await cacheReader.GetStringAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
        int current = 0;
        if (!string.IsNullOrWhiteSpace(existing) && int.TryParse(existing, out int value))
        {
            current = Math.Clamp(value, 0, securityPolicy.CurrentRiskPolicy.MaxRiskScore);
            if (current > 0)
            {
                return current;
            }
        }

        return 0;
    }

    private static SecurityRiskReason ToSecurityRiskReason(CrawlerRiskReason reason)
        => reason switch
        {
            CrawlerRiskReason.FakeCrawler => SecurityRiskReason.FakeCrawler,
            CrawlerRiskReason.UnknownBot => SecurityRiskReason.UnknownBot,
            CrawlerRiskReason.BlockedUserAgent => SecurityRiskReason.BlockedUserAgent,
            CrawlerRiskReason.UserAgentMissing => SecurityRiskReason.UserAgentMissing,
            CrawlerRiskReason.RateLimited => SecurityRiskReason.RateLimited,
            CrawlerRiskReason.PowInvalid => SecurityRiskReason.PowInvalid,
            CrawlerRiskReason.PowReplay => SecurityRiskReason.PowReplay,
            CrawlerRiskReason.ReadProofRejected => SecurityRiskReason.ReadProofRejected,
            CrawlerRiskReason.PublicReadPowRequired => SecurityRiskReason.PublicReadChallengeRequired,
            CrawlerRiskReason.PublicReadBlocked => SecurityRiskReason.PublicReadBlocked,
            _ => SecurityRiskReason.UnknownBot
        };

    private static string InferLegacySource(CrawlerRiskReason reason)
        => reason switch
        {
            CrawlerRiskReason.RateLimited => SecurityRiskSources.RateLimiter,
            CrawlerRiskReason.PowInvalid or CrawlerRiskReason.PowReplay => SecurityRiskSources.Pow,
            CrawlerRiskReason.ReadProofRejected => SecurityRiskSources.HumanReadProof,
            CrawlerRiskReason.PublicReadPowRequired or CrawlerRiskReason.PublicReadBlocked => SecurityRiskSources.PublicRead,
            _ => SecurityRiskSources.AntiCrawler
        };
}

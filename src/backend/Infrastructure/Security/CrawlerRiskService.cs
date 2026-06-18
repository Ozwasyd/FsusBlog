using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Infrastructure.Security;

// Compatibility alias kept for existing callers while new code moves to SecurityRiskReason.
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

public sealed class CrawlerRiskService(
    IUnifiedCache cache,
    IMemoryCache zeroRiskCache,
    ISecurityAdminPolicyService securityPolicy,
    ILogger<CrawlerRiskService> logger) : ICrawlerRiskService, ISecurityRiskSignalSink, ISecurityRiskScoreReader
{
    public const int RequirePowScore = 50;
    public const int BlockScore = 100;

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

    public async ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
    {
        AntiCrawlerPolicyOptions antiCrawlerOptions = securityPolicy.Current.Options;
        bool isAntiCrawlerSignal = string.Equals(signal.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase);
        if (isAntiCrawlerSignal && string.Equals(SecuritySystemModes.Normalize(antiCrawlerOptions.Mode), SecuritySystemModes.Disabled, StringComparison.Ordinal))
        {
            return;
        }

        string ip = signal.Context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return;
        }

        int scoreDelta = signal.Score;
        if (scoreDelta > 0 && isAntiCrawlerSignal && !antiCrawlerOptions.RiskScoringEnabled)
        {
            scoreDelta = 0;
        }

        if (string.Equals(SecuritySystemModes.Normalize(antiCrawlerOptions.Mode), SecuritySystemModes.Observe, StringComparison.Ordinal)
            && isAntiCrawlerSignal)
        {
            scoreDelta = 0;
        }

        int current = await GetRiskScoreForIpAsync(ip, cancellationToken);
        int next = current;
        TimeSpan effectiveTtl = signal.Ttl <= TimeSpan.Zero
            ? TimeSpan.FromSeconds(antiCrawlerOptions.DefaultRiskTtlSeconds)
            : signal.Ttl;
        if (scoreDelta != 0)
        {
            next = Math.Clamp(current + scoreDelta, 0, antiCrawlerOptions.MaxRiskScore);
            if (next > 0)
            {
                zeroRiskCache.Remove(ZeroRiskCacheKey(ip));
                await cache.SetStringAsync(CachePolicyId.SecurityPowRisk, ip, next.ToString(System.Globalization.CultureInfo.InvariantCulture), effectiveTtl, cancellationToken);
            }
            else
            {
                await cache.RemoveAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
                zeroRiskCache.Set(ZeroRiskCacheKey(ip), (byte)1, TimeSpan.FromSeconds(antiCrawlerOptions.ZeroRiskCacheTtlSeconds));
            }
        }

        var riskEvent = new AntiCrawlerRiskEventResponse(
            Guid.NewGuid().ToString("N"),
            DateTimeOffset.UtcNow,
            signal.Source,
            signal.Reason.ToString(),
            signal.Action,
            scoreDelta,
            next,
            ip,
            signal.Context.Request.Path.Value ?? "/",
            signal.Context.Request.Method,
            signal.Context.GetUserAgent(),
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
        FsusObservability.RecordSecurityEvent("security_risk", reasonName, signal.Action);
        logger.LogInformation(
            "security-risk-added {Source} {Reason} {Score} {TotalScore} {TtlSeconds}s",
            signal.Source,
            reasonName,
            scoreDelta,
            next,
            (int)effectiveTtl.TotalSeconds);
    }

    public async Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
    {
        string ip = context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return 0;
        }

        return await GetRiskScoreForIpAsync(ip, cancellationToken);
    }

    public async Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return 0;
        }

        return await GetRiskScoreForIpAsync(subject.Identity, cancellationToken);
    }

    public async Task<bool> IsHighRiskAsync(HttpContext context, CancellationToken cancellationToken = default)
        => await GetRiskScoreAsync(context, cancellationToken) >= securityPolicy.Current.Options.RequireChallengeScore;

    public async Task ResetRiskAsync(string ip, CancellationToken cancellationToken = default)
        => await ResetRiskAsync(new SecurityRiskSubject(ip), cancellationToken);

    public async Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(subject.Identity))
        {
            return;
        }

        zeroRiskCache.Remove(ZeroRiskCacheKey(subject.Identity));
        await cache.RemoveAsync(CachePolicyId.SecurityPowRisk, subject.Identity, cancellationToken);
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
        string zeroRiskKey = ZeroRiskCacheKey(ip);
        if (zeroRiskCache.TryGetValue(zeroRiskKey, out byte _))
        {
            return 0;
        }

        string? existing = await cache.GetStringAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
        int current = 0;
        if (!string.IsNullOrWhiteSpace(existing) && int.TryParse(existing, out int value))
        {
            current = Math.Clamp(value, 0, securityPolicy.Current.Options.MaxRiskScore);
            if (current > 0)
            {
                return current;
            }
        }

        zeroRiskCache.Set(zeroRiskKey, (byte)1, TimeSpan.FromSeconds(securityPolicy.Current.Options.ZeroRiskCacheTtlSeconds));
        return 0;
    }

    private static string ZeroRiskCacheKey(string ip)
        => string.Concat("crawler-risk:zero:", ip);

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

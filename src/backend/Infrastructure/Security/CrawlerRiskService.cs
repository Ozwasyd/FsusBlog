using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Infrastructure.Security;

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
    ILogger<CrawlerRiskService> logger) : ICrawlerRiskService
{
    public const int RequirePowScore = 50;
    public const int BlockScore = 100;
    private const int MaxRiskScore = 200;
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromMinutes(10);

    public async Task AddRiskAsync(
        HttpContext context,
        CrawlerRiskReason reason,
        int score,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        if (score <= 0)
        {
            return;
        }

        string ip = context.GetClientIp();
        if (string.IsNullOrWhiteSpace(ip))
        {
            return;
        }

        string? existing = await cache.GetStringAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
        int current = 0;
        if (!string.IsNullOrWhiteSpace(existing))
        {
            _ = int.TryParse(existing, out current);
        }

        int next = Math.Clamp(current + score, 0, MaxRiskScore);
        TimeSpan effectiveTtl = ttl <= TimeSpan.Zero ? DefaultTtl : ttl;
        await cache.SetStringAsync(CachePolicyId.SecurityPowRisk, ip, next.ToString(System.Globalization.CultureInfo.InvariantCulture), effectiveTtl, cancellationToken);

        string reasonName = reason.ToString();
        FsusObservability.RecordSecurityEvent("crawler_risk", reasonName, "added");
        logger.LogWarning(
            "crawler-risk-added {Reason} {Score} {TotalScore} {TtlSeconds}s",
            reasonName,
            score,
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

        string? existing = await cache.GetStringAsync(CachePolicyId.SecurityPowRisk, ip, cancellationToken);
        return !string.IsNullOrWhiteSpace(existing) && int.TryParse(existing, out int value)
            ? Math.Clamp(value, 0, MaxRiskScore)
            : 0;
    }

    public async Task<bool> IsHighRiskAsync(HttpContext context, CancellationToken cancellationToken = default)
        => await GetRiskScoreAsync(context, cancellationToken) >= RequirePowScore;
}

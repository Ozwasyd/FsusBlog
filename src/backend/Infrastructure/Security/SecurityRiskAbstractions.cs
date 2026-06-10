using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

public enum SecurityRiskReason
{
    FakeCrawler,
    UnknownBot,
    BlockedUserAgent,
    UserAgentMissing,
    RateLimited,
    PowInvalid,
    PowReplay,
    ReadProofRejected,
    PublicReadChallengeRequired,
    PublicReadBlocked
}

public static class SecurityRiskSources
{
    public const string AntiCrawler = "anti-crawler";
    public const string RateLimiter = "rate-limiter";
    public const string Pow = "pow";
    public const string HumanReadProof = "human-read-proof";
    public const string PublicRead = "public-read";
}

public sealed record SecurityRiskSignal(
    HttpContext Context,
    SecurityRiskReason Reason,
    int Score,
    TimeSpan Ttl,
    string Source,
    string Action,
    string? Detail = null);

public sealed record SecurityRiskSubject(string Identity);

public interface ISecurityRiskSignalSink
{
    ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default);
}

public interface ISecurityRiskScoreReader
{
    Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default);

    Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default);

    Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default);
}

public interface ISecurityRiskPolicyProvider
{
    SecurityRiskPolicySnapshot CurrentRiskPolicy { get; }
}


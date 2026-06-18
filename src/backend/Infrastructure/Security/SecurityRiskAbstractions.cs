using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

public enum SecurityRiskReason
{
    VerifiedCrawler,
    FakeCrawler,
    UnknownBot,
    BlockedUserAgent,
    UserAgentMissing,
    RateLimited,
    PowInvalid,
    PowReplay,
    ReadProofAccepted,
    ReadProofRejected,
    PublicReadChallengeRequired,
    CaptchaChallengeRequired,
    PublicReadBlocked,
    SecurityChallengeRejected,
    AuthLoginFailed,
    PasskeyAssertionFailed,
    PasskeyAssertionAccepted
}

public static class SecurityRiskSources
{
    public const string AntiCrawler = "anti-crawler";
    public const string Auth = "auth";
    public const string RateLimiter = "rate-limiter";
    public const string Pow = "pow";
    public const string HumanReadProof = "human-read-proof";
    public const string Passkey = "passkey";
    public const string PublicRead = "public-read";
    public const string PoSpace = "pospace";
    public const string RiskControl = "risk-control";
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

    SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 { get; }
}

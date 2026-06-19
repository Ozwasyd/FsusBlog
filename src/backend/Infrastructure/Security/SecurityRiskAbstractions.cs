using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

public enum SecurityRiskReason
{
    VerifiedCrawler = 0,
    FakeCrawler = 1,
    UnknownBot = 2,
    BlockedUserAgent = 3,
    UserAgentMissing = 4,
    RateLimited = 5,
    PowInvalid = 6,
    PowReplay = 7,
    ReadProofAccepted = 8,
    ReadProofRejected = 9,
    PublicReadChallengeRequired = 10,
    CaptchaChallengeRequired = 11,
    PublicReadBlocked = 12,
    SecurityChallengeRejected = 13,
    AuthLoginFailed = 14,
    PasskeyAssertionFailed = 15,
    PasskeyAssertionAccepted = 16,
    CommentRegionCompliance = 17,
    CommentSpamPattern = 18,
    CommentNullifierAbuse = 19,
    CaptchaInvalid = 20,
    CaptchaReplay = 21,
    CaptchaSolveTooFast = 22,
    DeviceFingerprintMissing = 23,
    DeviceFingerprintChanged = 24,
    RegionPolicyHit = 25,
    CommentSpamPatternHit = 26,
    AnonymousNullifierAbuse = 27,
    AuthFailureBurst = 28,
    PasskeyAssertionFailure = 29,
    AdminStepUpRequired = 30,
    AdminStepUpFailed = 31,
    ChallengeExpired = 32,
    ChallengeKindMismatch = 33,
    ChallengeSignatureInvalid = 34
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
    public const string Captcha = "captcha";
    public const string DeviceFingerprint = "device-fingerprint";
    public const string RegionPolicy = "region-policy";
    public const string CommentGovernance = "comment-governance";
    public const string AdminStepUp = "admin-step-up";
    public const string PerceptionTextTask = "perception-text-task";
    public const string PerceptionLocalization = "perception-localization";
    public const string PerceptionMicroInteraction = "perception-micro-interaction";
}

public sealed record SecurityRiskSignal(
    HttpContext Context,
    SecurityRiskReason Reason,
    int Score,
    TimeSpan Ttl,
    string Source,
    string Action,
    string? Detail = null,
    string? SubjectHash = null,
    string? RouteKey = null,
    string? ClientIpHash = null,
    string? DeviceFpHash = null);

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

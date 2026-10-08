using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Identifies the security condition that contributed to a request's risk score or challenge decision.</summary>
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
    PublicReadBlocked = 12,
    SecurityChallengeRejected = 13,
    AuthLoginFailed = 14,
    PasskeyAssertionFailed = 15,
    PasskeyAssertionAccepted = 16,
    CommentRegionCompliance = 17,
    CommentSpamPattern = 18,
    CommentNullifierAbuse = 19,
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

/// <summary>Provides stable subsystem identifiers for security-risk telemetry, persistence, and policy routing.</summary>
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
    public const string DeviceFingerprint = "device-fingerprint";
    public const string RegionPolicy = "region-policy";
    public const string CommentGovernance = "comment-governance";
    public const string AdminStepUp = "admin-step-up";
    public const string PerceptionLocalization = "perception-localization";
    public const string PerceptionMicroInteraction = "perception-micro-interaction";
}

/// <summary>Describes one security observation to score, retain, and expose through risk telemetry.</summary>
/// <param name="Context">The request context in which the observation occurred.</param>
/// <param name="Reason">The classified reason for the observation.</param>
/// <param name="Score">The score delta contributed by the observation.</param>
/// <param name="Ttl">The period for which the score contribution remains active.</param>
/// <param name="Source">The subsystem that produced the observation.</param>
/// <param name="Action">The protected action associated with the observation.</param>
/// <param name="Detail">Optional bounded diagnostic detail that does not contain raw identity data.</param>
/// <param name="SubjectHash">An optional pre-hashed account subject identifier.</param>
/// <param name="RouteKey">An optional stable route or action key.</param>
/// <param name="ClientIpHash">An optional pre-hashed client network identifier.</param>
/// <param name="DeviceFpHash">An optional pre-hashed device fingerprint.</param>
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

/// <summary>Identifies the subject whose current hot-path risk score is being queried or reset.</summary>
/// <param name="Identity">The internal identity value used by the hot-path score cache.</param>
public sealed record SecurityRiskSubject(string Identity);

/// <summary>Accepts security-risk observations for scoring and best-effort persistence.</summary>
public interface ISecurityRiskSignalSink
{
    /// <summary>Adds an observation to the active risk state.</summary>
    /// <param name="signal">The security observation to process.</param>
    /// <param name="cancellationToken">A token that cancels asynchronous processing.</param>
    /// <returns>A value task that completes when hot-path processing has finished.</returns>
    ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default);
}

/// <summary>Reads and resets active risk scores through the supported subject boundaries.</summary>
public interface ISecurityRiskScoreReader
{
    /// <summary>Gets the active score for an explicit risk subject.</summary>
    /// <param name="subject">The subject whose score is requested.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The non-negative active risk score.</returns>
    Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default);

    /// <summary>Gets the active score associated with the client represented by a request.</summary>
    /// <param name="context">The request context from which the client identity is resolved.</param>
    /// <param name="cancellationToken">A token that cancels the query.</param>
    /// <returns>The non-negative active risk score.</returns>
    Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default);

    /// <summary>Clears hot-path risk state for an explicit subject.</summary>
    /// <param name="subject">The subject whose score is reset.</param>
    /// <param name="cancellationToken">A token that cancels the reset operation.</param>
    /// <returns>A task that completes when the reset has finished.</returns>
    Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default);
}

/// <summary>Exposes the immutable canonical security-risk policy.</summary>
public interface ISecurityRiskPolicyProvider
{
    /// <summary>Gets the canonical action and subsystem policy used by current risk decisions.</summary>
    SecurityRiskPolicy CurrentRiskPolicy
    {
        get;
    }
}

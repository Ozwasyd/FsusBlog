namespace FsusBlog.Server.Models.Moderation;

public static class AntiSpamModerationContract
{
    public const string DefaultVersion = "fsusblog-moderation-provider-v1";

    public static readonly string[] ForbiddenFinalActionFields =
    [
        "allow",
        "reject_submit",
        "geo_block",
        "publish",
        "hide",
        "legal_in_region",
        "illegal_in_region",
        "blocked_regions",
        "submit_action",
        "display_action",
        "action"
    ];
}

public static class AntiSpamModerationProviders
{
    public const string None = "none";
    public const string Mock = "mock";
    public const string HttpJson = "http-json";
    public const string FsusCli = "fsus-cli";
}

public static class AntiSpamModerationStatuses
{
    public const string Ok = "ok";
    public const string Timeout = "timeout";
    public const string Unavailable = "unavailable";
    public const string Error = "error";
    public const string ContractInvalid = "contract_invalid";
}

public sealed record AntiSpamModerationRequest(
    string RequestId,
    string Content,
    string ContentType,
    string Locale,
    DateTime SubmittedAtUtc,
    string? RegionHint,
    string? ThresholdProfile,
    IReadOnlyDictionary<string, string> Metadata);

public sealed record AntiSpamModerationCategorySignal(
    string Id,
    double Confidence,
    string Severity,
    string EvidencePolicy);

public sealed record AntiSpamModerationEvidence(
    string Category,
    string Policy,
    string? Value);

public sealed record AntiSpamModerationResult(
    bool Available,
    string Provider,
    string Model,
    string ContractVersion,
    string Label,
    double Confidence,
    string Severity,
    string? PrimaryReason,
    bool NeedsSecondRound,
    IReadOnlyList<AntiSpamModerationCategorySignal> Categories,
    IReadOnlyList<AntiSpamModerationEvidence> Evidence,
    string? RawReason,
    TimeSpan Latency,
    string Status,
    string? ErrorCode,
    string? ThresholdProfile,
    IReadOnlyDictionary<string, string> Metadata);

public sealed record AntiSpamCommentModerationContext(
    long CommentId,
    int ArticleId,
    int? UserId,
    string? AuthorMode,
    string? AnonymousDisplayLanguage,
    string? ModerationSubjectHash,
    string? AnonymousNullifierHash,
    string? AnonymousScope,
    string? CredentialLevel,
    string? ReputationBucket,
    string? AccountAgeBucket,
    bool? AnonymousCommentsEnabled,
    bool? ZkAnonymousEnabled,
    string Content,
    long? ParentCommentId,
    string? SubmitIpHash,
    string? RegionHint,
    string? RegionPolicyVersion,
    DateTime SubmittedAtUtc);

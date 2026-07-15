using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Models.CommentIdentity;

public static class CommentAuthorModes
{
    public const string Anonymous = "anonymous";
    public const string Public = "public";
    public const string ZkAnonymous = "zk_anonymous";
}

public sealed record AnonymousCommentPolicySnapshot(
    bool AnonymousCommentsEnabled,
    bool PublicCommentsEnabled,
    bool ZkAnonymousEnabled,
    string DefaultAuthorMode,
    IReadOnlyList<string> SupportedDisplayLanguages,
    int CommentMaxChars = CommentLimits.DefaultContentMaxChars,
    int CommentMaxUtf8Bytes = CommentLimits.DefaultContentMaxUtf8Bytes)
{
    public string SnapshotHash { get; init; } = string.Empty;
    public string ChangedBy { get; init; } = "configuration";
    public string? Reason { get; init; }
    public DateTime UpdatedAtUtc { get; init; } = DateTime.UtcNow;

    public static readonly IReadOnlyList<string> DefaultDisplayLanguages = ["zh-CN", "en"];

    public static AnonymousCommentPolicySnapshot Default { get; } = new(
        AnonymousCommentsEnabled: true,
        PublicCommentsEnabled: true,
        ZkAnonymousEnabled: false,
        DefaultAuthorMode: CommentAuthorModes.Anonymous,
        SupportedDisplayLanguages: DefaultDisplayLanguages);
}

public sealed record AnonymousCommentPolicyUpdateRequest(
    bool? AnonymousCommentsEnabled,
    bool? PublicCommentsEnabled,
    bool? ZkAnonymousEnabled,
    string? DefaultAuthorMode,
    IReadOnlyList<string>? SupportedDisplayLanguages,
    int? CommentMaxChars = null,
    int? CommentMaxUtf8Bytes = null,
    string? Reason = null);

public sealed record CommentAuthorModeDecision(
    bool Allowed,
    string EffectiveAuthorMode,
    string Status,
    string Message)
{
    public static CommentAuthorModeDecision Allow(string mode)
        => new(true, mode, "allowed", "Author mode is allowed");

    public static CommentAuthorModeDecision Reject(string mode, string status, string message)
        => new(false, mode, status, message);
}

public sealed record ZkAnonymousPolicySnapshot(
    bool Enabled,
    bool VerifierConfigured,
    string ActionContext,
    IReadOnlyList<string> ExpectedPublicInputs);

public sealed record ZkProofVerificationRequest(
    string ActionContext,
    string Scope,
    string CircuitId,
    string VerifyingKeyHash,
    ushort PublicInputLayoutVersion,
    long CredentialEpoch,
    string NullifierHash,
    string CredentialRoot,
    string CredentialLevel,
    string ReputationBucket,
    string PolicyHash,
    byte[] Proof,
    string RevocationRoot = "",
    string IssuerPublicKeyHash = "")
{
    public bool HasRequiredCommentInputs =>
        !string.IsNullOrWhiteSpace(ActionContext) &&
        !string.IsNullOrWhiteSpace(Scope) &&
        !string.IsNullOrWhiteSpace(CircuitId) &&
        !string.IsNullOrWhiteSpace(VerifyingKeyHash) &&
        PublicInputLayoutVersion > 0 &&
        CredentialEpoch > 0 &&
        !string.IsNullOrWhiteSpace(NullifierHash) &&
        !string.IsNullOrWhiteSpace(CredentialRoot) &&
        !string.IsNullOrWhiteSpace(CredentialLevel) &&
        !string.IsNullOrWhiteSpace(ReputationBucket) &&
        !string.IsNullOrWhiteSpace(PolicyHash) &&
        !string.IsNullOrWhiteSpace(RevocationRoot) &&
        !string.IsNullOrWhiteSpace(IssuerPublicKeyHash) &&
        Proof.Length > 0;
}

public sealed record ZkProofVerificationResult(
    bool Verified,
    string Status,
    string Message)
{
    public static ZkProofVerificationResult Success()
        => new(true, ZkProofVerificationStatuses.Verified, "ZK proof verified");

    public static ZkProofVerificationResult Disabled()
        => new(false, ZkProofVerificationStatuses.Disabled, "ZK anonymous comments are disabled");

    public static ZkProofVerificationResult VerifierUnavailable()
        => new(false, ZkProofVerificationStatuses.VerifierUnavailable, "ZK verifier is not configured");

    public static ZkProofVerificationResult MissingProof()
        => new(false, ZkProofVerificationStatuses.MissingProof, "ZK proof or public inputs are missing");

    public static ZkProofVerificationResult InvalidProof(string? message = null)
        => new(false, ZkProofVerificationStatuses.InvalidProof, string.IsNullOrWhiteSpace(message) ? "ZK proof is invalid" : message);
}

public static class ZkProofVerificationStatuses
{
    public const string Verified = "verified";
    public const string Disabled = "disabled";
    public const string VerifierUnavailable = "verifier_unavailable";
    public const string MissingProof = "missing_proof";
    public const string InvalidProof = "invalid_proof";
}

public sealed record CommentActor(
    int? UserId,
    string AuthorMode,
    string? PublicHandle,
    string? AnonymousHandle,
    string DisplayName,
    string DisplayLanguage,
    string? AnonymousNullifierHash,
    string? AnonymousScope,
    string ModerationSubjectHash,
    string CredentialLevel,
    string ReputationBucket,
    string AccountAgeBucket);

public sealed record CommentActorResolveRequest(
    int? UserId,
    int ArticleId,
    string? AuthorMode,
    bool PublicSendExplicitlySelected,
    string? AnonymousScope,
    string? DisplayLanguage,
    string? ProofToken,
    byte[]? ZkProof,
    string? SubmitRegion,
    string? NullifierHash = null,
    string? CredentialRoot = null,
    long CredentialEpoch = 0,
    string? CircuitId = null,
    string? VerifyingKeyHash = null,
    ushort PublicInputLayoutVersion = 0,
    string? ReputationBucket = null,
    string? RevocationRoot = null,
    string? IssuerPublicKeyHash = null);

public sealed record CommentActorResolveResult(
    bool Allowed,
    CommentActor? Actor,
    string Status,
    string Message)
{
    public static CommentActorResolveResult Allow(CommentActor actor)
        => new(true, actor, "allowed", "Comment actor resolved");

    public static CommentActorResolveResult Reject(string status, string message)
        => new(false, null, status, message);
}

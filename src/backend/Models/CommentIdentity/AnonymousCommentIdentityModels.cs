namespace FsusBlog.Server.Models.CommentIdentity;

public static class CommentAuthorModes
{
    public const string Anonymous = "anonymous";
    public const string Pseudonymous = "pseudonymous";
    public const string Public = "public";
    public const string ZkAnonymous = "zk_anonymous";
}

public sealed record AnonymousCommentPolicySnapshot(
    bool AnonymousCommentsEnabled,
    bool PublicCommentsEnabled,
    bool ZkAnonymousEnabled,
    string DefaultAuthorMode,
    IReadOnlyList<string> SupportedDisplayLanguages)
{
    public static readonly IReadOnlyList<string> DefaultDisplayLanguages = ["zh-CN", "en"];

    public static AnonymousCommentPolicySnapshot Default { get; } = new(
        AnonymousCommentsEnabled: true,
        PublicCommentsEnabled: true,
        ZkAnonymousEnabled: false,
        DefaultAuthorMode: CommentAuthorModes.Anonymous,
        SupportedDisplayLanguages: DefaultDisplayLanguages);
}

public sealed record ZkAnonymousPolicySnapshot(
    bool Enabled,
    bool VerifierConfigured,
    string ActionContext,
    IReadOnlyList<string> ExpectedPublicInputs);

public sealed record ZkProofVerificationRequest(
    string ActionContext,
    string Scope,
    string NullifierHash,
    string CredentialCommitment,
    string CredentialRoot,
    string? ReputationBucket,
    byte[] Proof)
{
    public bool HasRequiredCommentInputs =>
        !string.IsNullOrWhiteSpace(ActionContext) &&
        !string.IsNullOrWhiteSpace(Scope) &&
        !string.IsNullOrWhiteSpace(NullifierHash) &&
        !string.IsNullOrWhiteSpace(CredentialCommitment) &&
        !string.IsNullOrWhiteSpace(CredentialRoot) &&
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

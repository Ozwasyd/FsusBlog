using FsusBlog.Server.Models.CommentIdentity;

namespace FsusBlog.Server.Services.Security;

public interface IZkProofVerifier
{
    bool IsConfigured { get; }

    Task<ZkProofVerificationResult> VerifyAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IZkAnonymousProofService
{
    AnonymousCommentPolicySnapshot CurrentCommentPolicy { get; }

    ZkAnonymousPolicySnapshot CurrentZkPolicy { get; }

    Task<ZkProofVerificationResult> VerifyCommentProofAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class DisabledZkProofVerifier : IZkProofVerifier
{
    public bool IsConfigured => false;

    public Task<ZkProofVerificationResult> VerifyAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default)
        => Task.FromResult(ZkProofVerificationResult.VerifierUnavailable());
}

public sealed class ZkAnonymousProofService(
    IConfiguration configuration,
    IZkProofVerifier verifier) : IZkAnonymousProofService
{
    private const string CommentActionContext = "comment.create";

    private static readonly IReadOnlyList<string> ExpectedPublicInputs =
    [
        "action_context",
        "article_or_comment_scope",
        "nullifier_hash",
        "credential_commitment",
        "credential_root",
        "reputation_bucket"
    ];

    public AnonymousCommentPolicySnapshot CurrentCommentPolicy
    {
        get
        {
            bool anonymousEnabled = configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true);
            bool publicEnabled = configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true);
            bool zkEnabled = configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false);
            return new AnonymousCommentPolicySnapshot(
                anonymousEnabled,
                publicEnabled,
                zkEnabled,
                CommentAuthorModes.Anonymous,
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages);
        }
    }

    public ZkAnonymousPolicySnapshot CurrentZkPolicy
        => new(
            CurrentCommentPolicy.ZkAnonymousEnabled,
            verifier.IsConfigured,
            CommentActionContext,
            ExpectedPublicInputs);

    public async Task<ZkProofVerificationResult> VerifyCommentProofAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!CurrentCommentPolicy.ZkAnonymousEnabled)
        {
            return ZkProofVerificationResult.Disabled();
        }

        if (!verifier.IsConfigured)
        {
            return ZkProofVerificationResult.VerifierUnavailable();
        }

        if (!request.HasRequiredCommentInputs ||
            !string.Equals(request.ActionContext, CommentActionContext, StringComparison.Ordinal))
        {
            return ZkProofVerificationResult.MissingProof();
        }

        ZkProofVerificationResult result = await verifier.VerifyAsync(request, cancellationToken);
        return result.Verified ? result : ZkProofVerificationResult.InvalidProof(result.Message);
    }
}

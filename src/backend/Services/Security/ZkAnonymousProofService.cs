using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;


namespace FsusBlog.Server.Services.Security;

public interface IZkProofVerifier
{
    bool IsConfigured
    {
        get;
    }

    Task<ZkProofVerificationResult> VerifyAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IZkAnonymousProofService
{
    AnonymousCommentPolicySnapshot CurrentCommentPolicy
    {
        get;
    }

    ZkAnonymousPolicySnapshot CurrentZkPolicy
    {
        get;
    }

    ZkCommentPolicySnapshot CurrentZkCommentPolicy
    {
        get;
    }

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

public sealed class ZkAnonymousProofService : IZkAnonymousProofService
{
    private const string CommentActionContext = "comment.create";

    private static readonly IReadOnlyList<string> s_expectedPublicInputs =
    [
        "action_context",
        "article_or_comment_scope",
        "circuit_id",
        "verifying_key_hash",
        "public_input_layout_version",
        "nullifier_hash",
        "credential_root",
        "revocation_root",
        "issuer_public_key_hash",
        "policy_hash",
        "is_eligible",
        "may_comment",
        "rate_class",
        "requires_moderation"
    ];

    private readonly AnonymousCommentPolicySnapshot _commentPolicy;
    private readonly ZkAnonymousPolicySnapshot _zkPolicy;
    private readonly IZkProofVerifier _verifier;
    private readonly IZkCommentPolicyAuthority _policyAuthority;
    private ZkCommentPolicyOptions? _lastOptions;
    private readonly IZkVerifierReadiness _verifierReadiness;
    private ZkCommentRuntimeReadiness _lastReadiness;
    private ZkCommentPolicySnapshot? _currentPolicy;
    private readonly IAnonymousCredentialRootReader? _rootReader;
    private readonly IRfc9474BlindCredentialSigner? _credentialSigner;
    private readonly IBlindCredentialRuntimeGate? _credentialGate;

    public ZkAnonymousProofService(IConfiguration configuration, IZkProofVerifier verifier)
        : this(
            configuration,
            verifier,
            new ZkCommentPolicyAuthority(configuration),
            new ZkVerifierReadiness(ZkVerifierOptions.FromConfiguration(configuration), verifier),
            null,
            null,
            null)
    {
    }

    public ZkAnonymousProofService(
        IConfiguration configuration,
        IZkProofVerifier verifier,
        IZkCommentPolicyAuthority policyAuthority,
        IZkVerifierReadiness verifierReadiness,
        IAnonymousCredentialRootReader? rootReader = null,
        IRfc9474BlindCredentialSigner? credentialSigner = null,
        IBlindCredentialRuntimeGate? credentialGate = null)
    {
        var commentPolicy = new AnonymousCommentPolicySnapshot(
            configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true),
            configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false),
            CommentAuthorModes.ZkAnonymous,
            AnonymousCommentPolicySnapshot.DefaultDisplayLanguages);
        _commentPolicy = commentPolicy with { SnapshotHash = AnonymousCommentPolicySnapshotHash.Compute(commentPolicy) };
        _zkPolicy = new ZkAnonymousPolicySnapshot(_commentPolicy.ZkAnonymousEnabled, verifier.IsConfigured,
            CommentActionContext, s_expectedPublicInputs);
        _verifier = verifier;
        _policyAuthority = policyAuthority;
        _verifierReadiness = verifierReadiness;
        _rootReader = rootReader;
        _credentialSigner = credentialSigner;
        _credentialGate = credentialGate;
    }

    public AnonymousCommentPolicySnapshot CurrentCommentPolicy => _commentPolicy;

    public ZkAnonymousPolicySnapshot CurrentZkPolicy => _zkPolicy;

    public ZkCommentPolicySnapshot CurrentZkCommentPolicy
    {
        get
        {
            ZkCommentPolicyOptions options = _policyAuthority.Current;
            ZkVerifierReadinessSnapshot verifier = _verifierReadiness.Current;
            var readiness = new ZkCommentRuntimeReadiness(
                verifier.NativeVerifierConfigured,
                HasReadyCredentialRoot(),
                _credentialSigner?.IsConfigured == true && _credentialGate?.IsEnabled == true,
                verifier.TrustedSetupVerified,
                verifier.NativeBackendConfigured);
            if (_currentPolicy is null || readiness != _lastReadiness || !ReferenceEquals(options, _lastOptions))
            {
                _currentPolicy = ZkCommentPolicySnapshotFactory.Create(options, readiness);
                _lastReadiness = readiness;
                _lastOptions = options;
            }

            return _currentPolicy;
        }
    }

    public async Task<ZkProofVerificationResult> VerifyCommentProofAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!CurrentCommentPolicy.ZkAnonymousEnabled)
        {
            return ZkProofVerificationResult.Disabled();
        }

        if (!_verifier.IsConfigured)
        {
            return ZkProofVerificationResult.VerifierUnavailable();
        }

        if (!request.HasRequiredCommentInputs ||
            !string.Equals(request.ActionContext, CommentActionContext, StringComparison.Ordinal))
        {
            return ZkProofVerificationResult.MissingProof();
        }

        ZkProofVerificationResult result = await _verifier.VerifyAsync(request, cancellationToken);
        return result.Verified ? result : ZkProofVerificationResult.InvalidProof();
    }

    private bool HasReadyCredentialRoot()
    {
        if (_rootReader is null)
        {
            return false;
        }

        DateTimeOffset now = DateTimeOffset.UtcNow;
        var roots = _rootReader.CurrentSnapshot.AcceptedRoots;
        for (int index = 0; index < roots.Count; index++)
        {
            var root = roots[index];
            if (root.GraceExpiresAtUtc > now && !string.IsNullOrWhiteSpace(root.RootHash) &&
                !string.IsNullOrWhiteSpace(root.RevocationRootHash) && !string.IsNullOrWhiteSpace(root.IssuerPublicKeyHash) &&
                (string.Equals(root.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
                 string.Equals(root.Status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal)))
            {
                return true;
            }
        }

        return false;
    }
}

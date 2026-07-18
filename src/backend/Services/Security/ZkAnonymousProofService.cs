using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using Microsoft.Extensions.Options;

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

    ZkProdPolicySnapshot CurrentZkProdPolicy
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

    private static readonly IReadOnlyList<string> ExpectedPublicInputs =
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

    private readonly IConfiguration _configuration;
    private readonly IZkProofVerifier _verifier;
    private readonly IOptionsMonitor<ZkProdOptions> _zkProdOptions;
    private readonly IAnonymousCredentialRootReader? _rootReader;
    private readonly ICircuitNativeCredentialIssuer? _credentialIssuer;

    public ZkAnonymousProofService(IConfiguration configuration, IZkProofVerifier verifier)
        : this(
            configuration,
            verifier,
            new StaticOptionsMonitor<ZkProdOptions>(ZkProdOptions.FromConfiguration(configuration)),
            null,
            null)
    {
    }

    public ZkAnonymousProofService(
        IConfiguration configuration,
        IZkProofVerifier verifier,
        IOptionsMonitor<ZkProdOptions> zkProdOptions,
        IAnonymousCredentialRootReader? rootReader = null,
        ICircuitNativeCredentialIssuer? credentialIssuer = null)
    {
        _configuration = configuration;
        _verifier = verifier;
        _zkProdOptions = zkProdOptions;
        _rootReader = rootReader;
        _credentialIssuer = credentialIssuer;
    }

    public AnonymousCommentPolicySnapshot CurrentCommentPolicy
    {
        get
        {
            bool anonymousEnabled = _configuration.GetValue("AnonymousIdentity:AnonymousCommentsEnabled", true);
            bool publicEnabled = _configuration.GetValue("AnonymousIdentity:PublicCommentsEnabled", true);
            bool zkEnabled = _configuration.GetValue("AnonymousIdentity:ZkAnonymousCommentsEnabled", false);
            var snapshot = new AnonymousCommentPolicySnapshot(
                anonymousEnabled,
                publicEnabled,
                zkEnabled,
                CommentAuthorModes.ZkAnonymous,
                AnonymousCommentPolicySnapshot.DefaultDisplayLanguages);
            return snapshot with
            {
                SnapshotHash = AnonymousCommentPolicySnapshotHash.Compute(snapshot)
            };
        }
    }

    public ZkAnonymousPolicySnapshot CurrentZkPolicy
        => new(
            CurrentCommentPolicy.ZkAnonymousEnabled,
            _verifier.IsConfigured,
            CommentActionContext,
            ExpectedPublicInputs);

    public ZkProdPolicySnapshot CurrentZkProdPolicy
        => ZkProdPolicySnapshotFactory.Create(
            _zkProdOptions.CurrentValue,
            new ZkProdRuntimeReadiness(
                _verifier.IsConfigured,
                HasReadyCredentialRoot(),
                _credentialIssuer?.IsConfigured == true),
            _configuration);

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
        return _rootReader.CurrentSnapshot.AcceptedRoots.Any(root =>
            root.GraceExpiresAtUtc > now &&
            !string.IsNullOrWhiteSpace(root.RootHash) &&
            (string.Equals(root.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
             string.Equals(root.Status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal)));
    }

    private sealed class StaticOptionsMonitor<TOptions>(TOptions value) : IOptionsMonitor<TOptions>
    {
        public TOptions CurrentValue { get; } = value;

        public TOptions Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<TOptions, string?> listener) => null;
    }
}

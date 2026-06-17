using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ZkAnonymousProofVerifierContractTests
{
    [Fact]
    public void CommentAuthorModes_RetainZkAnonymousAsFirstClassMode()
    {
        Assert.Equal("anonymous", CommentAuthorModes.Anonymous);
        Assert.Equal("pseudonymous", CommentAuthorModes.Pseudonymous);
        Assert.Equal("public", CommentAuthorModes.Public);
        Assert.Equal("zk_anonymous", CommentAuthorModes.ZkAnonymous);
    }

    [Fact]
    public void CommentPolicy_DefaultsAnonymousAndZkDisabled()
    {
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default;

        Assert.True(policy.AnonymousCommentsEnabled);
        Assert.True(policy.PublicCommentsEnabled);
        Assert.False(policy.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.Anonymous, policy.DefaultAuthorMode);
        Assert.Contains("zh-CN", policy.SupportedDisplayLanguages);
        Assert.Contains("en", policy.SupportedDisplayLanguages);
    }

    [Fact]
    public async Task ZkAnonymousProofService_DisabledByDefaultFailsClosed()
    {
        var verifier = new RecordingZkVerifier(configured: true, ZkProofVerificationResult.Success());
        var service = new ZkAnonymousProofService(BuildConfiguration([]), verifier);

        ZkProofVerificationResult result = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.Disabled, result.Status);
        Assert.Equal(0, verifier.CallCount);
        Assert.False(service.CurrentZkPolicy.Enabled);
        Assert.True(service.CurrentZkPolicy.VerifierConfigured);
    }

    [Fact]
    public async Task ZkAnonymousProofService_EnabledWithoutVerifierFailsClosed()
    {
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            }),
            new DisabledZkProofVerifier());

        ZkProofVerificationResult result = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.VerifierUnavailable, result.Status);
        Assert.True(service.CurrentZkPolicy.Enabled);
        Assert.False(service.CurrentZkPolicy.VerifierConfigured);
    }

    [Fact]
    public async Task ZkAnonymousProofService_RejectsMissingAndInvalidProof()
    {
        var verifier = new RecordingZkVerifier(configured: true, ZkProofVerificationResult.InvalidProof("bad proof"));
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            }),
            verifier);

        ZkProofVerificationResult missing = await service.VerifyCommentProofAsync(ValidRequest() with { Proof = [] });
        ZkProofVerificationResult invalid = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(missing.Verified);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missing.Status);
        Assert.False(invalid.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, invalid.Status);
        Assert.Equal(1, verifier.CallCount);
    }

    [Fact]
    public void NormalLoginAndAdminLogin_DoNotDependOnZkVerifier()
    {
        string userService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string passkeyService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");
        string adminPrincipalService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");

        Assert.DoesNotContain("IZkProofVerifier", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkProofVerifier", passkeyService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", passkeyService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkProofVerifier", adminPrincipalService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", adminPrincipalService, StringComparison.Ordinal);
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static ZkProofVerificationRequest ValidRequest()
        => new(
            "comment.create",
            "article:42",
            "nullifier-hash",
            "credential-commitment",
            "credential-root",
            "trusted",
            [1, 2, 3]);

    private sealed class RecordingZkVerifier(bool configured, ZkProofVerificationResult result) : IZkProofVerifier
    {
        public int CallCount { get; private set; }

        public bool IsConfigured { get; } = configured;

        public Task<ZkProofVerificationResult> VerifyAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(result);
        }
    }
}

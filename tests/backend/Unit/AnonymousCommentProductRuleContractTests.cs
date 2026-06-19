using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentProductRuleContractTests
{
    [Fact]
    public void PublicCommentPolicyBinaryEndpoint_ExposesServerPolicyForComposerControls()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");

        Assert.Contains("group.MapGet(\"/comment/policy\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCommentPolicyService", endpoints, StringComparison.Ordinal);
        Assert.Contains("ToCommentPolicyCore", endpoints, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.CommentPolicySnapshot", endpoints, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteCommentPolicySnapshot", endpoints, StringComparison.Ordinal);
        Assert.Contains(".AllowAnonymous()", endpoints, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"public_read\")", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentPolicy_EnforcesAnonymousDefaultPublicOptInAndAdminDisabledState()
    {
        var enabled = new AnonymousCommentPolicyService(BuildConfiguration([]));

        CommentAuthorModeDecision implicitDefault = enabled.EvaluateAuthorMode(null, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision publicWithoutOptIn = enabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision publicWithOptIn = enabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true);

        Assert.True(implicitDefault.Allowed);
        Assert.Equal(CommentAuthorModes.Anonymous, implicitDefault.EffectiveAuthorMode);
        Assert.False(publicWithoutOptIn.Allowed);
        Assert.Equal("public_opt_in_required", publicWithoutOptIn.Status);
        Assert.True(publicWithOptIn.Allowed);

        var disabled = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:PublicCommentsEnabled"] = "true",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
        }));

        Assert.False(disabled.EvaluateAuthorMode(CommentAuthorModes.Anonymous, publicSendExplicitlySelected: false).Allowed);
        Assert.False(disabled.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, publicSendExplicitlySelected: false).Allowed);
        Assert.True(disabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true).Allowed);
    }

    [Fact]
    public void AnonymousDisplayNames_AreCuratedLocalizedStableAndDoNotLeakIdentityTokens()
    {
        var generator = new CommentAnonymousDisplayNameGenerator();
        var zh = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));
        var zhAgain = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));
        var en = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "en",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));

        Assert.Equal(zh, zhAgain);
        Assert.Equal("zh-CN", zh.DisplayLanguage);
        Assert.Equal("en", en.DisplayLanguage);
        Assert.StartsWith("匿名用户", zh.DisplayName, StringComparison.Ordinal);
        Assert.StartsWith("Anonymous User ", en.DisplayName, StringComparison.Ordinal);

        foreach (string leakedToken in new[] { "100", "alice", "AliceChen", "cred-1", "abc123", "credential", "nullifier", "public" })
        {
            Assert.DoesNotContain(leakedToken, zh.DisplayName, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(leakedToken, en.DisplayName, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}

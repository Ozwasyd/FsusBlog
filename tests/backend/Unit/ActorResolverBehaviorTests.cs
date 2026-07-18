using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ActorResolverBehaviorTests
{
    [Fact]
    public async Task CommentActorResolver_RetiredAnonymousModeFailsBeforeAccountLookup()
    {
        var accountReader = Substitute.For<IUserAccountReader>();
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(BuildConfiguration([])));

        CommentActorResolveResult result = await resolver.ResolveAsync(new CommentActorResolveRequest(
            UserId: 42,
            ArticleId: 7,
            AuthorMode: CommentAuthorModes.RetiredAnonymous,
            PublicSendExplicitlySelected: false,
            AnonymousScope: "article:7",
            DisplayLanguage: "en",
            ProofToken: "proof-token",
            ZkProof: null,
            SubmitRegion: "US"));

        Assert.False(result.Allowed);
        Assert.Null(result.Actor);
        Assert.Equal("anonymous_author_mode_retired", result.Status);
        Assert.Empty(accountReader.ReceivedCalls());
    }

    [Fact]
    public async Task CommentActorResolver_PublicModeKeepsRequestUserId()
    {
        var accountReader = Substitute.For<IUserAccountReader>();
        accountReader.GetAccountByIdAsync(42)
            .Returns(Task.FromResult<UserAccountSnapshot?>(CreateAccountSnapshot(42, publicHandle: "PublicHandle")));
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(BuildConfiguration([])));

        CommentActorResolveResult result = await resolver.ResolveAsync(new CommentActorResolveRequest(
            UserId: 42,
            ArticleId: 7,
            AuthorMode: CommentAuthorModes.Public,
            PublicSendExplicitlySelected: true,
            AnonymousScope: null,
            DisplayLanguage: "en",
            ProofToken: null,
            ZkProof: null,
            SubmitRegion: "US"));

        Assert.True(result.Allowed, result.Message);
        Assert.NotNull(result.Actor);
        Assert.Equal(42, result.Actor.UserId);
        Assert.Equal(CommentAuthorModes.Public, result.Actor.AuthorMode);
        Assert.Equal("PublicHandle", result.Actor.PublicHandle);
        Assert.Null(result.Actor.AnonymousHandle);
    }

    [Fact]
    public async Task CommentActorResolver_PublicModeWithoutPersistedHandleFailsClosed()
    {
        var accountReader = Substitute.For<IUserAccountReader>();
        accountReader.GetAccountByIdAsync(42)
            .Returns(Task.FromResult<UserAccountSnapshot?>(CreateAccountSnapshot(42, publicHandle: null)));
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(BuildConfiguration([])));

        CommentActorResolveResult result = await resolver.ResolveAsync(new CommentActorResolveRequest(
            UserId: 42,
            ArticleId: 7,
            AuthorMode: CommentAuthorModes.Public,
            PublicSendExplicitlySelected: true,
            AnonymousScope: null,
            DisplayLanguage: "en",
            ProofToken: null,
            ZkProof: null,
            SubmitRegion: "US"));

        Assert.False(result.Allowed);
        Assert.Null(result.Actor);
        Assert.Equal("public_handle_required", result.Status);
    }

    private static UserAccountSnapshot CreateAccountSnapshot(
        int id,
        string? publicHandle = "public-handle",
        string? credentialLevel = AnonymousCredentialLevels.Basic)
        => new(
            Id: id,
            Status: 0,
            BanReason: null,
            MfaEnabled: false,
            DeletedAt: null,
            PublicHandle: publicHandle,
            AnonymousCredentialLevel: credentialLevel);

    [Fact]
    public void AnonymousDisplayNameGenerator_LocalizesStablyWithoutIdentityLeakage()
    {
        var generator = new CommentAnonymousDisplayNameGenerator();
        var zh = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|nullifier:abc123"));
        var zhAgain = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|nullifier:abc123"));
        var en = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "en",
            "article:42",
            "account:100|username:alice|public:AliceChen|nullifier:abc123"));

        Assert.Equal("zh-CN", zh.DisplayLanguage);
        Assert.StartsWith("匿名用户", zh.DisplayName, StringComparison.Ordinal);
        Assert.Equal(zh, zhAgain);
        Assert.Equal("en", en.DisplayLanguage);
        Assert.StartsWith("Anonymous User", en.DisplayName, StringComparison.Ordinal);

        foreach (string leakedToken in new[] { "100", "alice", "AliceChen", "abc123", "nullifier", "account", "public" })
        {
            Assert.DoesNotContain(leakedToken, zh.DisplayName, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(leakedToken, en.DisplayName, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
    {
        var merged = new Dictionary<string, string?>(values, StringComparer.OrdinalIgnoreCase)
        {
            ["Moderation:Pepper"] = "unit-test-moderation-pepper-32-bytes-minimum",
            ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum"
        };
        return new ConfigurationBuilder()
            .AddInMemoryCollection(merged)
            .Build();
    }
}

using System.Linq.Expressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentActorContractTests
{
    [Fact]
    public void CommentEntityAndMigration_ModelAnonymousActorColumns()
    {
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/Comment.cs");
        string migration = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("public int? UserId { get; set; }", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("SugarIndex(\"idx_comment_user_id_desc\"", entity, StringComparison.Ordinal);
        Assert.Contains("idx_comment_attributable_public_user_id_desc", migration, StringComparison.Ordinal);
        Assert.Contains("author_mode = 'public' AND user_id IS NOT NULL", migration, StringComparison.Ordinal);
        foreach (string requiredColumn in new[]
        {
            "author_mode",
            "public_handle",
            "anonymous_handle",
            "anonymous_display_name",
            "anonymous_display_language",
            "anonymous_nullifier_hash",
            "anonymous_scope",
            "moderation_subject_hash",
            "credential_level",
            "reputation_bucket",
            "account_age_bucket"
        })
        {
            Assert.Contains(requiredColumn, entity, StringComparison.Ordinal);
            Assert.Contains(requiredColumn, migration, StringComparison.Ordinal);
        }

        Assert.Contains("BuildCommentActorMigration()", migration, StringComparison.Ordinal);
        Assert.Contains("ALTER TABLE comment ALTER COLUMN user_id DROP NOT NULL", migration, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentCreatePath_AcceptsV2AndPersistsResolvedActor()
    {
        string endpoint = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string endpointInterface = BackendTestPaths.ReadAllTextFromRoot("src/backend/Interfaces/ICommentEndpointService.cs");
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("AedsFrameType.CommentCreateV2Request", endpoint, StringComparison.Ordinal);
        Assert.Contains("[AedsFrameType.CommentCreateV2Request]", endpoint, StringComparison.Ordinal);
        Assert.Contains("TryDecodeCommentCreateV2Request", endpoint, StringComparison.Ordinal);
        Assert.Contains("CreateAttributablePublicCommentAsync", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("AedsFrameType.CommentCreate" + "Request", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("TryDecodeCommentCreate" + "Request", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentAsync(userId", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentV2Async", endpoint, StringComparison.Ordinal);

        Assert.Contains("ICommentActorResolver", service, StringComparison.Ordinal);
        Assert.Contains("ResolveAsync", service, StringComparison.Ordinal);
        Assert.Contains("AuthorMode = actor.AuthorMode", service, StringComparison.Ordinal);
        Assert.Contains("UserId = actor.UserId", service, StringComparison.Ordinal);
        Assert.Contains("AnonymousDisplayName = actor.DisplayName", service, StringComparison.Ordinal);
        Assert.Contains("ModerationSubjectHash = actor.ModerationSubjectHash", service, StringComparison.Ordinal);
        Assert.Contains("CreateAttributablePublicCommentAsync", service, StringComparison.Ordinal);
        Assert.Contains("request.PublicSendExplicitlySelected", service, StringComparison.Ordinal);
        Assert.Contains("CommentAuthorModes.Public", service, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentV2Async", service, StringComparison.Ordinal);

        Assert.Contains("CreateStrongAnonymousCommentAsync", endpointInterface, StringComparison.Ordinal);
        Assert.Contains("CreateAttributablePublicCommentAsync", endpointInterface, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentV2Async", endpointInterface, StringComparison.Ordinal);

        Assert.Contains("ICommentActorResolver", services, StringComparison.Ordinal);
        Assert.Contains("CommentActorResolver", services, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousDisplayNameGenerator", services, StringComparison.Ordinal);
    }

    [Fact]
    public void StrongAnonymousCommentCreate_DoesNotPersistReplyToUserId()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string createBlock = ExtractBetween(
            service,
            "private async Task<bool> CreateResolvedCommentAsync",
            "var comment = new Comment");
        string repliesBlock = ExtractBetween(
            service,
            "private async Task<List<ReplyRow>> QueryThreadRepliesAsync",
            "return rows;");
        string previewMapBlock = ExtractBetween(
            service,
            "private async Task<Dictionary<long, List<CommentReplyPreviewItemDto>>> QueryThreadRepliesPreviewMapAsync",
            "return map;");

        Assert.Contains("replyToUserId = actor.UserId.HasValue ? parent.UserId : null", createBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("replyToUserId = parent.UserId", createBlock, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", repliesBlock, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", previewMapBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("LEFT JOIN sys_user ru ON c.reply_to_user_id = ru.id", repliesBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("LEFT JOIN sys_user ru ON c.reply_to_user_id = ru.id", previewMapBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void AttributableCommentRecordsAndDeletion_DoNotUseAnonymousUserIdBinding()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string serviceInterface = BackendTestPaths.ReadAllTextFromRoot("src/backend/Interfaces/ICommentService.cs");
        string gateway = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/CoreBridge/Gateways/CommentCoreGateway.cs");
        string recordsBlock = ExtractBetween(
            service,
            "public async Task<CursorResponse<UserCommentResponse>> GetAttributableCommentsAsync",
            "public Task<bool> DeleteCommentAsync");
        string deleteBlock = ExtractBetween(
            service,
            "public Task<bool> DeleteCommentAsync",
            "private async Task<List<ThreadRootRow>> QueryThreadRootsAsync");

        Assert.Contains("GetAttributableCommentsAsync", serviceInterface, StringComparison.Ordinal);
        Assert.Contains("GetAttributableCommentsAsync", gateway, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserCommentsAsync", serviceInterface, StringComparison.Ordinal);
        Assert.Contains("c.AuthorMode == CommentAuthorModes.Public", recordsBlock, StringComparison.Ordinal);
        Assert.Contains("c.UserId == userId", recordsBlock, StringComparison.Ordinal);
        Assert.Contains("c.ReplyToCommentId == pc.Id", recordsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("c.ReplyToUserId == ru.Id", recordsBlock, StringComparison.Ordinal);

        Assert.Contains("IsAttributableUserComment(row.AuthorMode, row.UserId)", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("AccountId: isAttributableUserComment ? row.UserId : null", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("UserCommentsChanged: isAttributableUserComment", deleteBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("row.UserId != currentUserId && !isAdmin", deleteBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("if (isAdmin && row.UserId.HasValue", deleteBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicCommentActor_RequiresPersistedPublicHandleWithoutUsernameFallback()
    {
        string resolver = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentActorResolver.cs");
        string observability = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Observability/FsusObservability.cs");

        Assert.Contains("IUserAccountReader", resolver, StringComparison.Ordinal);
        Assert.Contains("GetAccountByIdAsync", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("ISqlSugarClient", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("IAnonymousCredentialService", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain(".Queryable<User>()", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(u => u.PublicHandle)", resolver, StringComparison.Ordinal);
        Assert.Contains("fsus.comment.actor_resolver.public_handle_cache.hit_ratio", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.comment.actor_resolver.credential_level_cache.hit_ratio", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.comment.actor_resolver.db_round_trips", observability, StringComparison.Ordinal);
        Assert.Contains("public_handle_required", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(u => u.Username)", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("NormalizeToken(username", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("$\"user-{request.UserId.Value}\"", resolver, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CommentActorResolver_AnonymousModeDropsRequestUserId()
    {
        var accountReader = Substitute.For<IUserAccountReader>();
        accountReader.GetAccountByIdAsync(42)
            .Returns(Task.FromResult<UserAccountSnapshot?>(CreateAccountSnapshot(42, credentialLevel: AnonymousCredentialLevels.Trusted)));
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(BuildConfiguration([])),
            new CommentAnonymousDisplayNameGenerator(),
            Substitute.For<IZkAnonymousProofService>(),
            BuildConfiguration([]));

        CommentActorResolveResult result = await resolver.ResolveAsync(new CommentActorResolveRequest(
            UserId: 42,
            ArticleId: 7,
            AuthorMode: CommentAuthorModes.Anonymous,
            PublicSendExplicitlySelected: false,
            AnonymousScope: "article:7",
            DisplayLanguage: "en",
            ProofToken: "proof-token",
            ZkProof: null,
            SubmitRegion: "US"));

        Assert.True(result.Allowed, result.Message);
        Assert.NotNull(result.Actor);
        Assert.Null(result.Actor.UserId);
        Assert.Equal(CommentAuthorModes.Anonymous, result.Actor.AuthorMode);
        Assert.Null(result.Actor.PublicHandle);
        Assert.NotNull(result.Actor.AnonymousHandle);
        Assert.Equal(AnonymousCredentialLevels.Trusted, result.Actor.CredentialLevel);
    }

    [Fact]
    public async Task CommentActorResolver_PublicModeKeepsRequestUserId()
    {
        var accountReader = Substitute.For<IUserAccountReader>();
        accountReader.GetAccountByIdAsync(42)
            .Returns(Task.FromResult<UserAccountSnapshot?>(CreateAccountSnapshot(42, publicHandle: "PublicHandle")));
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(BuildConfiguration([])),
            new CommentAnonymousDisplayNameGenerator(),
            Substitute.For<IZkAnonymousProofService>(),
            BuildConfiguration([]));

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

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
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

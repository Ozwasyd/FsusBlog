using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentActorContractTests
{
    [Fact]
    public void CommentEntityAndMigration_ModelAnonymousActorColumns()
    {
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/Comment.cs");
        string migration = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("public int? UserId { get; set; }", entity, StringComparison.Ordinal);
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
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("AedsFrameType.CommentCreateV2Request", endpoint, StringComparison.Ordinal);
        Assert.Contains("[AedsFrameType.CommentCreateV2Request]", endpoint, StringComparison.Ordinal);
        Assert.Contains("TryDecodeCommentCreateV2Request", endpoint, StringComparison.Ordinal);
        Assert.Contains("CreateCommentV2Async", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("AedsFrameType.CommentCreate" + "Request", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("TryDecodeCommentCreate" + "Request", endpoint, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentAsync(userId", endpoint, StringComparison.Ordinal);

        Assert.Contains("ICommentActorResolver", service, StringComparison.Ordinal);
        Assert.Contains("ResolveAsync", service, StringComparison.Ordinal);
        Assert.Contains("AuthorMode = actor.AuthorMode", service, StringComparison.Ordinal);
        Assert.Contains("UserId = actor.UserId", service, StringComparison.Ordinal);
        Assert.Contains("AnonymousDisplayName = actor.DisplayName", service, StringComparison.Ordinal);
        Assert.Contains("ModerationSubjectHash = actor.ModerationSubjectHash", service, StringComparison.Ordinal);

        Assert.Contains("ICommentActorResolver", services, StringComparison.Ordinal);
        Assert.Contains("CommentActorResolver", services, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousDisplayNameGenerator", services, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicCommentActor_RequiresPersistedPublicHandleWithoutUsernameFallback()
    {
        string resolver = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentActorResolver.cs");

        Assert.Contains(".Select(u => u.PublicHandle)", resolver, StringComparison.Ordinal);
        Assert.Contains("public_handle_required", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(u => u.Username)", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("NormalizeToken(username", resolver, StringComparison.Ordinal);
        Assert.DoesNotContain("$\"user-{request.UserId.Value}\"", resolver, StringComparison.Ordinal);
    }

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
}

using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AntiSpamModerationServiceTests
{
    [Theory]
    [InlineData("userId")]
    [InlineData("username")]
    [InlineData("email")]
    [InlineData("ip")]
    [InlineData("authorId")]
    [InlineData("replyToUserId")]
    public void ValidateModelRequestJson_RejectsLegacyIdentityFields(string forbiddenField)
    {
        string json = $$"""
            {
              "request_id": "comment:1",
              "content_type": "comment",
              "text": "normal comment",
              "metadata": {
                "source": "fsusblog",
                "{{forbiddenField}}": "legacy-value"
              }
            }
            """;

        var ex = Assert.Throws<InvalidOperationException>(() =>
            AntiSpamModerationService.ValidateModelRequestJson(json));
        Assert.Contains(forbiddenField, ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AntiSpamModerationContract_ForbidsFinalActionFields()
    {
        Assert.Contains("reject_submit", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("geo_block", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("blocked_regions", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("submit_action", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("display_action", AntiSpamModerationContract.ForbiddenFinalActionFields);
    }

    [Fact]
    public void AntiSpamModerationContract_DocumentsAnonymousSignalBoundary()
    {
        Assert.Contains("userId", AntiSpamModerationContract.ForbiddenIdentityFields);
        Assert.Contains("replyToUserId", AntiSpamModerationContract.ForbiddenIdentityFields);
        Assert.Contains("anonymous_nullifier_hash", AntiSpamModerationContract.AllowedRequestMetadataFields);
        Assert.Contains("zk_anonymous_enabled", AntiSpamModerationContract.AllowedRequestMetadataFields);
    }

    [Fact]
    public void SchemaMigrationRegistry_CreatesCommentModerationSignalTableAndIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("comment_moderation_signal", source);
        Assert.Contains("idx_comment_moderation_signal_comment_id", source);
        Assert.Contains("idx_comment_moderation_signal_label_confidence", source);
        Assert.Contains("idx_comment_moderation_signal_second_round", source);
        Assert.Contains("BuildCommentModerationSignalMigration()", source);
    }
}

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Shared.Contracts.Governance;

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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void AntiSpamModerationContract_ForbidsFinalActionFields()
    {
        Assert.Contains("reject_submit", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("geo_block", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("blocked_regions", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("submit_action", AntiSpamModerationContract.ForbiddenFinalActionFields);
        Assert.Contains("display_action", AntiSpamModerationContract.ForbiddenFinalActionFields);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void AntiSpamModerationContract_DocumentsAnonymousSignalBoundary()
    {
        Assert.Contains("userId", AntiSpamModerationContract.ForbiddenIdentityFields);
        Assert.Contains("replyToUserId", AntiSpamModerationContract.ForbiddenIdentityFields);
        Assert.Contains("anonymous_nullifier_hash", AntiSpamModerationContract.AllowedRequestMetadataFields);
        Assert.Contains("zk_anonymous_enabled", AntiSpamModerationContract.AllowedRequestMetadataFields);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void SchemaMigrationRegistry_CreatesCommentModerationSignalTableAndIndexes()
    {
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260610-post-comment-moderation-signal");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("comment_moderation_signal", fingerprint);
        Assert.Contains("idx_comment_moderation_signal_comment_id", fingerprint);
        Assert.Contains("idx_comment_moderation_signal_label_confidence", fingerprint);
        Assert.Contains("idx_comment_moderation_signal_second_round", fingerprint);
    }
}

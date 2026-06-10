using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentSecurityHardeningTests
{
    [Fact]
    public void CommentCreateEndpoint_CapsPayloadAndChecksLengthBeforeContentFilter()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");

        Assert.Contains("CommentLimits.CreatePayloadMaxBytes", source);
        Assert.Contains("IsCommentContentWithinLimit(content)", source);
        Assert.Contains("contentFilterService.ValidateContent(content)", source);
        Assert.True(
            source.IndexOf("IsCommentContentWithinLimit(content)", StringComparison.Ordinal) <
            source.IndexOf("contentFilterService.ValidateContent(content)", StringComparison.Ordinal));
        Assert.DoesNotContain("ValidateContent(request.Content", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentCreateService_RequiresPublicArticleAndVisibleReplyAncestors()
    {
        string source = ReadRepoFile("src/backend/Services/CommentService.cs");

        Assert.Contains("a.Status == ArticleStatus.Published", source);
        Assert.Contains("a.PublishedAt == null || a.PublishedAt <= now", source);
        Assert.Contains("a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now", source);
        Assert.Contains("c.ModerationStatus == CommentModerationStatus.Approved", source);
        Assert.Contains("&& !c.IsDeleted", source);
        Assert.Contains("rootIsVisible", source);
        Assert.Contains("RootId: comment.RootId ?? comment.Id", source);
        Assert.Equal(CommentLimits.ContentMaxChars, 1000);
        Assert.Equal(CommentLimits.ContentMaxUtf8Bytes, 4096);
    }

    [Fact]
    public void CommentRegionCompliance_AppliesSubmitAndViewerRegionPolicy()
    {
        string endpointSource = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string serviceSource = ReadRepoFile("src/backend/Services/CommentService.cs");
        string authoringSource = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");

        Assert.Contains("IClientRegionResolver regionResolver", endpointSource);
        Assert.Contains("regionLegalModerationService.EvaluateOnSubmit", endpointSource);
        Assert.Contains("RegionDecision = regionDecision", endpointSource);
        Assert.Contains(":region:{NormalizeCommentFrameRegion(viewerRegion)}", endpointSource);

        Assert.Contains("CommentRegionCompliance", serviceSource);
        Assert.Contains("BlockedRegions = RegionLegalModerationService.SerializeRegions", serviceSource);
        Assert.Contains("RegionLegalModerationService.SerializeRegions([normalizedViewerRegion])", serviceSource);
        Assert.Contains("comment_region_compliance crc", serviceSource);

        Assert.Contains("IsRegionApprovalAllowed", authoringSource);
        Assert.Contains("RegionCanPublish", authoringSource);
        Assert.Contains("RegionLegalModerationService.DeserializeRegions", authoringSource);
    }

    [Fact]
    public void CommentModerationEndpoints_RequireRateLimitAndAdminSensitiveMfaProof()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");

        Assert.Contains("RequireAdminSensitiveStepUpAsync", source);
        Assert.Contains("ValidateAndConsumeProofTokenAsync(userId, AdminSensitiveAction, proofToken)", source);
        Assert.Contains("StatusCodes.Status428PreconditionRequired", source);
        Assert.Contains("MFA_PROOF_REQUIRED", source);
        Assert.True(CountOccurrences(source, ".RequireRateLimiting(\"fixed_ip\")") >= 3);
    }

    [Fact]
    public void CommentModerationService_UsesCasStateMachineAndRealtimePush()
    {
        string source = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");

        Assert.Contains("IsAllowedModerationTransition", source);
        Assert.Contains("it.ModerationStatus == current.Status", source);
        Assert.Contains("it.ModerationStatus == row.Status", source);
        Assert.Contains("PushCommentAddAsync", source);
        Assert.Contains("PushCommentRemoveAsync", source);
        Assert.Contains("CommentCacheInvalidationScope", source);
        Assert.Contains("SendUserTransactionalNoticeAsync", source);
    }

    [Fact]
    public void CommentCacheInvalidation_RemovesScopedPrefixesWithoutGlobalCommentOutputTag()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs");

        Assert.Contains("article:{scope.ArticleId.Value}:", source);
        Assert.Contains("article:{scope.ArticleId.Value}:root:{scope.RootId.Value}:", source);
        Assert.Contains("user:{scope.UserId.Value}:", source);
        Assert.DoesNotContain("CacheTag.Comment", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveByPrefixAsync(CachePolicyId.CommentCursor, string.Empty", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaMigrationRegistry_ContainsPublicCommentHotPathIndexes()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("idx_comment_public_roots", source);
        Assert.Contains("idx_comment_public_replies", source);
        Assert.Contains("idx_comment_public_reply_count", source);
        Assert.Contains("idx_comment_public_create_time_desc", source);
        Assert.Contains("idx_comment_region_compliance_comment", source);
        Assert.Contains("idx_comment_region_compliance_submit_region", source);
        Assert.Contains("WHERE parent_id IS NULL AND moderation_status = 1 AND is_deleted = false", source);
        Assert.Contains("WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false", source);
    }

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = source.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}

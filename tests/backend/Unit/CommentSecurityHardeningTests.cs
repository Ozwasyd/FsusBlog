using System.Runtime.CompilerServices;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Tests.TestInfrastructure;

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
        Assert.Contains("CreateAttributablePublicCommentAsync(userId, request, regionDecision)", endpointSource);
        Assert.Contains(":region:{NormalizeCommentFrameRegion(viewerRegion)}", endpointSource);

        Assert.Contains("CommentRegionCompliance", serviceSource);
        Assert.Contains("RegionDecision = regionDecision", serviceSource);
        Assert.Contains("BlockedRegions = RegionLegalModerationService.SerializeRegions", serviceSource);
        Assert.Contains("RegionLegalModerationService.SerializeRegions([normalizedViewerRegion])", serviceSource);
        Assert.Contains("comment_region_compliance crc", serviceSource);

        Assert.Contains("IsRegionApprovalAllowed", authoringSource);
        Assert.Contains("RegionCanPublish", authoringSource);
        Assert.Contains("RegionLegalModerationService.DeserializeRegions", authoringSource);
    }

    [Fact]
    public void CommentRegionCompliance_PublicReadFiltersAvoidUnsupportedSqlSugarStringComparison()
    {
        string serviceSource = ReadRepoFile("src/backend/Services/CommentService.cs");

        Assert.DoesNotContain("rc.BlockedRegions != string.Empty", serviceSource, StringComparison.Ordinal);
        Assert.Contains("comment_region_compliance crc", serviceSource, StringComparison.Ordinal);
        Assert.Contains("crc.blocked_regions <> ''", serviceSource, StringComparison.Ordinal);
        Assert.Contains("position(@BlockedToken in crc.blocked_regions) > 0", serviceSource, StringComparison.Ordinal);
    }

    [Fact]
    public void UserCommentHistory_ExposesModerationStatusWithoutInternalReasons()
    {
        string serviceSource = ReadRepoFile("src/backend/Services/CommentService.cs");
        string projectionSource = ReadRepoFile("src/backend/Infrastructure/Projections/CommentProjection.cs");
        string responseSource = ReadRepoFile("src/shared/Contracts/Outputs/ServerResponseContracts.cs");

        string userCommentsBlock = serviceSource[
            serviceSource.IndexOf("public async Task<CursorResponse<UserCommentResponse>> GetAttributableCommentsAsync", StringComparison.Ordinal)..
            serviceSource.IndexOf("public async Task<bool> DeleteCommentAsync", StringComparison.Ordinal)];

        Assert.Contains("ModerationStatus = c.ModerationStatus", userCommentsBlock, StringComparison.Ordinal);
        Assert.Contains("HasBlockedRegions", userCommentsBlock, StringComparison.Ordinal);
        Assert.Contains("c.AuthorMode == CommentAuthorModes.Public", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerationReason", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("DecisionReason", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("RuleHitsJson", userCommentsBlock, StringComparison.Ordinal);

        Assert.Contains("ModerationStatusLabel", projectionSource, StringComparison.Ordinal);
        Assert.Contains("VisibilityReasonCode", projectionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerationReason", responseSource, StringComparison.Ordinal);
        Assert.DoesNotContain("DecisionReason", responseSource, StringComparison.Ordinal);
        Assert.DoesNotContain("RuleHitsJson", responseSource, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationEndpoints_RequireRateLimitAndAdminSensitiveAdminStepUpProof()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");

        Assert.Contains("RequireAdminSensitiveStepUpAsync", source);
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", source);
        Assert.Contains("AedsJsonResults.PreconditionRequired", source);
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
        Assert.Contains("SendAccountTransactionalNoticeAsync", source);
    }

    [Fact]
    public void CommentCacheInvalidation_RemovesScopedPrefixesWithoutGlobalCommentOutputTag()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs");

        Assert.Contains("article:{scope.ArticleId.Value}:", source);
        Assert.Contains("article:{scope.ArticleId.Value}:root:{scope.RootId.Value}:", source);
        Assert.Contains("account:{scope.AccountId.Value}:", source);
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
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);
}

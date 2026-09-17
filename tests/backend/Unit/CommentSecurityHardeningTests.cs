using System.Diagnostics;
using System.Net;
using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

using NSubstitute;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentSecurityHardeningTests
{
    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentCreateEndpoint_CapsPayloadAndChecksLengthBeforeContentFilter()
    {
        Assert.Equal(16 * 1024, CommentLimits.CreatePayloadMaxBytes);
        IReadOnlyList<IReadOnlyList<string>> handlers = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(BinaryEndpoints),
                "IsCommentContentWithinLimit",
                "CommentMarkdownPolicy.ValidateForSubmit",
                "IContentFilterService.ValidateContent");
        Assert.True(handlers.Count >= 2);
        foreach (IReadOnlyList<string> handler in handlers)
        {
            int lengthCheck = FindReference(handler, "IsCommentContentWithinLimit");
            int markdownReview = FindReference(handler, "CommentMarkdownPolicy.ValidateForSubmit");
            int reviewText = FindReference(handler, "CommentMarkdownPolicyResult.get_ReviewText");
            int contentFilter = FindReference(handler, "IContentFilterService.ValidateContent");
            Assert.True(lengthCheck < markdownReview);
            Assert.True(markdownReview < reviewText);
            Assert.True(reviewText < contentFilter);
        }
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentCreateEndpoint_UsesMarkdownReviewTextForModerationWithoutChangingStoredSource()
    {
        IReadOnlyList<IReadOnlyList<string>> handlers = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(BinaryEndpoints),
                "CommentMarkdownPolicy.ValidateForSubmit",
                "RegionModerationRequest..ctor",
                "RecordCommentRiskSignalAsync");
        Assert.True(handlers.Count >= 2);
        foreach (IReadOnlyList<string> handler in handlers)
        {
            Assert.Contains(handler, static reference => reference.Contains("CommentMarkdownPolicyResult.get_ReviewText", StringComparison.Ordinal));
            Assert.Contains(handler, static reference => reference.Contains("set_Content", StringComparison.Ordinal));
            Assert.Contains(handler, static reference => reference.Contains("ContentValidationResult.get_IsValid", StringComparison.Ordinal));
            Assert.DoesNotContain(handler, static reference => reference.Contains("ContentValidationResult.get_Message", StringComparison.Ordinal));
        }
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentCreateService_PersistsInitialStatusBeforeModerationAndWarnsOnAutomaticHide()
    {
        IReadOnlyList<IReadOnlyList<string>> creationPaths = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(CommentCommandService),
                "ICommentModerationService.ResolveInitialState",
                "Comment.set_ModerationStatus",
                "ICommentModerationService.ApplyPostInsertAsync");
        Assert.All(creationPaths, creation => Assert.True(
            FindReference(creation, "Comment.set_ModerationStatus") <
            FindReference(creation, "ICommentModerationService.ApplyPostInsertAsync")));

        string creationBody = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CommentCommandService),
            "ICommentModerationService.ResolveInitialState",
            "set_ModerationStatus");
        Assert.Contains("ResolveInitialState", creationBody, StringComparison.Ordinal);
        Assert.Contains("Comment.set_ModerationStatus", creationBody, StringComparison.Ordinal);

        string notice = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentNotificationService),
            "NotifyModelRiskHiddenAsync");
        Assert.Contains("评论审核提醒", notice, StringComparison.Ordinal);
        Assert.Contains("本提醒不构成账号处罚", notice, StringComparison.Ordinal);
        Assert.Contains("SendAccountTransactionalNoticeAsync", notice, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentCreateService_AutomaticModelHideInvalidatesPublicCommentAndPushesRemoval()
    {
        string automaticBlock = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CommentModerationService),
            "ICommentNotificationService.PublishRemovedAsync",
            "NotifyModelRiskHiddenAsync");
        Assert.Contains("CommentCacheInvalidationScope..ctor", automaticBlock, StringComparison.Ordinal);
        Assert.Contains("ICommentNotificationService.PublishRemovedAsync", automaticBlock, StringComparison.Ordinal);

        MethodInfo apply = typeof(CommentModerationService).GetMethod(
            "ApplyAutomaticDispositionAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        Type stateMachine = apply.GetCustomAttribute<System.Runtime.CompilerServices.AsyncStateMachineAttribute>()!.StateMachineType;
        MethodInfo moveNext = stateMachine.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Assert.Contains((int)CommentModerationStatus.Hidden, RuntimeMetadataInspection.DescribeInt32Constants(moveNext));

        string conditionalUpdate = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentModerationService),
            "TryApplyDispositionAsync");
        Assert.Contains("@ExpectedStatus", conditionalUpdate, StringComparison.Ordinal);
        Assert.Contains("moderation_status = @ExpectedStatus", conditionalUpdate, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentModerationQueue_IncludesOnlyBorderlineModelHiddenCommentsInPendingReviewSource()
    {
        string queue = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(AuthoringModerationWorkflowService),
            "model_policy:model_risk_borderline_review",
            "BuildCommentModerationQueuePredicate");

        Assert.Contains("model_policy:model_risk_borderline_review", queue, StringComparison.Ordinal);
        Assert.Contains("BuildCommentModerationQueuePredicate", queue, StringComparison.Ordinal);
        Assert.DoesNotContain("model_policy:model_risk_auto_hidden", queue, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentCreateService_RequiresPublicArticleAndVisibleReplyAncestors()
    {
        string create = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CommentCommandService),
            "a.status = @PublishedStatus",
            "FROM article a, comment pc, comment rc");

        Assert.Contains("a.status = @PublishedStatus", create);
        Assert.Contains("a.published_at IS NULL OR a.published_at <= @Now", create);
        Assert.Contains("a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now", create);
        Assert.Contains("pc.moderation_status = @ApprovedStatus", create);
        Assert.Contains("rc.moderation_status = @ApprovedStatus", create);
        Assert.Contains("FROM article a, comment pc, comment rc", create);
        Assert.Contains("COALESCE(pc.root_id, pc.id) = @RootId", create);

        string invalidation = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CommentCommandService),
            "CommentCacheInvalidationScope..ctor",
            "InvalidateCommentMutationAsync");
        Assert.Contains("Comment.get_RootId", invalidation, StringComparison.Ordinal);
        Assert.Contains("Comment.get_Id", invalidation, StringComparison.Ordinal);
        Assert.Equal(CommentLimits.ContentMaxChars, 1000);
        Assert.Equal(CommentLimits.ContentMaxUtf8Bytes, 4096);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentRegionCompliance_AppliesSubmitAndViewerRegionPolicy()
    {
        string submitEndpoint = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(BinaryEndpoints),
            "IClientRegionResolver.Resolve",
            "IRegionLegalModerationService.EvaluateOnSubmit");
        Assert.Contains("CreateAttributablePublicCommentResultAsync", submitEndpoint, StringComparison.Ordinal);
        Assert.Contains("CreateStrongAnonymousCommentResultAsync", submitEndpoint, StringComparison.Ordinal);

        string rootFrame = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "BuildCommentThreadFrameIdentity");
        string replyFrame = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "BuildCommentReplyFrameIdentity");
        string cacheResult = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            "RecordCommentFrameCacheResult");
        Assert.Contains("roots", rootFrame, StringComparison.Ordinal);
        Assert.Contains(":region:", rootFrame, StringComparison.Ordinal);
        Assert.Contains("NormalizeCommentFrameRegion", rootFrame, StringComparison.Ordinal);
        Assert.Contains("replies", replyFrame, StringComparison.Ordinal);
        Assert.Contains(":region:", replyFrame, StringComparison.Ordinal);
        Assert.Contains("NormalizeCommentFrameRegion", replyFrame, StringComparison.Ordinal);
        Assert.Contains("NormalizeCommentFrameRegion", cacheResult, StringComparison.Ordinal);

        string command = RuntimeMetadataInspection.DescribeType(typeof(CommentCommandService));
        string moderation = RuntimeMetadataInspection.DescribeType(typeof(CommentModerationService));
        string service = string.Concat(command, moderation);
        string queries = RuntimeMetadataInspection.DescribeType(typeof(CommentQueryService));
        Assert.Contains(nameof(CommentRegionCompliance), service, StringComparison.Ordinal);
        Assert.Contains("set_RegionDecision", service, StringComparison.Ordinal);
        Assert.Contains("RegionLegalModerationService.SerializeRegions", service, StringComparison.Ordinal);
        Assert.Contains(nameof(CommentBlockedRegion), service, StringComparison.Ordinal);
        Assert.Contains("comment_blocked_region br", queries, StringComparison.Ordinal);

        string authoring = RuntimeMetadataInspection.DescribeType(typeof(AuthoringModerationWorkflowService));
        Assert.Contains("IsRegionApprovalAllowed", authoring, StringComparison.Ordinal);
        Assert.Contains("get_RegionCanPublish", authoring, StringComparison.Ordinal);
        Assert.Contains("RegionLegalModerationService.DeserializeRegions", authoring, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void ClientRegionResolver_KeyRotationInvalidatesPreviousIpHash()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.10");
        var regionService = new RegionLegalModerationService();
        var firstResolver = new ClientRegionResolver(
            CreateRegionPolicyConfiguration("first-region-ip-hash-key-with-at-least-thirty-two-chars"),
            regionService);
        var secondResolver = new ClientRegionResolver(
            CreateRegionPolicyConfiguration("second-region-ip-hash-key-with-at-least-thirty-two-chars"),
            regionService);

        string? firstHash = firstResolver.Resolve(context).ClientIpHash;
        string? secondHash = secondResolver.Resolve(context).ClientIpHash;

        Assert.Matches("^[0-9a-f]{64}$", firstHash);
        Assert.Matches("^[0-9a-f]{64}$", secondHash);
        Assert.NotEqual(firstHash, secondHash);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void ClientRegionResolver_IgnoresProxyRegionHeadersFromUntrustedRemote()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.10");
        context.Request.Headers["X-Fsus-Region"] = "US";
        var resolver = new ClientRegionResolver(
            CreateRegionPolicyConfiguration(
                "region-ip-hash-key-with-at-least-thirty-two-chars",
                trustedProxyEnabled: true),
            new RegionLegalModerationService());

        ClientRegionResolution resolution = resolver.Resolve(context);

        Assert.Equal("UNKNOWN", resolution.Region);
        Assert.Equal("connection_ip", resolution.Provider);
        Assert.Equal(0.35d, resolution.Confidence);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task RegionIpHashPepperRotationTool_InvalidatesStoredSubmitIpHashes()
    {
        string root = Directory.CreateTempSubdirectory("fsus-region-pepper-").FullName;
        try
        {
            string capture = Path.Combine(root, "psql-input.sql");
            string psql = Path.Combine(root, "psql");
            await File.WriteAllTextAsync(psql, $"#!/usr/bin/env bash\ncat > '{capture}'\n");
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(
                    psql,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
            string tool = BackendTestPaths.FromRoot("tools", "security", "rotate-region-ip-hash-pepper.sh");

            ProcessResult refused = await RunRotationToolAsync(tool, root, confirm: null);
            Assert.Equal(2, refused.ExitCode);
            Assert.Contains("FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION", refused.StandardError, StringComparison.Ordinal);
            Assert.DoesNotContain("fsusblog-region-ip-hash-development-key", refused.StandardError, StringComparison.Ordinal);
            Assert.False(File.Exists(capture));

            ProcessResult applied = await RunRotationToolAsync(
                tool,
                root,
                "INVALIDATE_OLD_REGION_IP_HASHES");
            Assert.Equal(0, applied.ExitCode);
            string sql = await File.ReadAllTextAsync(capture);
            Assert.Contains("UPDATE comment_region_compliance", sql, StringComparison.Ordinal);
            Assert.Contains("submit_ip_hash = NULL", sql, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentRegionCompliance_PublicReadFiltersAvoidUnsupportedSqlSugarStringComparison()
    {
        string publicReads = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(CommentQueryService),
            "comment_blocked_region br",
            "br.region_code = @ViewerRegion");

        Assert.DoesNotContain("rc.BlockedRegions", publicReads, StringComparison.Ordinal);
        Assert.DoesNotContain("position(@BlockedToken in crc.blocked_regions)", publicReads, StringComparison.Ordinal);
        Assert.DoesNotContain("@BlockedToken", publicReads, StringComparison.Ordinal);
        Assert.Contains("comment_blocked_region br", publicReads, StringComparison.Ordinal);
        Assert.Contains("br.region_code = @ViewerRegion", publicReads, StringComparison.Ordinal);
        Assert.Contains("@ConservativeUnknownViewer = true", publicReads, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void UserCommentHistory_ExposesModerationStatusWithoutInternalReasons()
    {
        string userCommentsBlock = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentQueryService),
            nameof(CommentQueryService.GetAttributableAsync));

        Assert.Contains("set_ModerationStatus", userCommentsBlock, StringComparison.Ordinal);
        Assert.Contains("set_HasBlockedRegions", userCommentsBlock, StringComparison.Ordinal);
        Assert.Contains("get_AuthorMode", userCommentsBlock, StringComparison.Ordinal);
        Assert.Contains("public", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerationReason", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("DecisionReason", userCommentsBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("RuleHitsJson", userCommentsBlock, StringComparison.Ordinal);

        string projection = RuntimeMetadataInspection.DescribeType(typeof(CommentProjection));
        Assert.Contains("set_ModerationStatusLabel", projection, StringComparison.Ordinal);
        Assert.Contains("set_VisibilityReasonCode", projection, StringComparison.Ordinal);
        string[] publicProperties = typeof(UserCommentResponse).GetProperties().Select(static property => property.Name).ToArray();
        Assert.Contains(nameof(UserCommentResponse.ModerationStatusLabel), publicProperties);
        Assert.Contains(nameof(UserCommentResponse.VisibilityReasonCode), publicProperties);
        Assert.DoesNotContain("ModerationReason", publicProperties);
        Assert.DoesNotContain("DecisionReason", publicProperties);
        Assert.DoesNotContain("RuleHitsJson", publicProperties);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task CommentModerationEndpoints_RequireRateLimitAndAdminSensitiveAdminStepUpProof()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint queue = EndpointContractApplication.Find(
            app,
            "/api/binary/author/comments/moderation",
            HttpMethods.Get);
        RouteEndpoint bulk = EndpointContractApplication.Find(
            app,
            "/api/binary/author/comments/moderation/bulk",
            HttpMethods.Post);
        RouteEndpoint single = EndpointContractApplication.Find(
            app,
            "/api/binary/author/comments/{commentId:long}/moderation",
            HttpMethods.Post);
        Assert.All(new[] { queue, bulk, single }, static endpoint => Assert.Equal(
            "fixed_ip",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName));
        Assert.IsType<AdminSensitiveStepUpMetadata>(bulk.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());
        Assert.IsType<AdminSensitiveStepUpMetadata>(single.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());

        string stepUp = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringEndpoints),
            "RequireAdminSensitiveStepUpAsync");
        Assert.Contains("ValidateAndConsumeAdminStepUpProofTokenAsync", stepUp, StringComparison.Ordinal);
        Assert.Contains("AedsJsonResults.PreconditionRequired", stepUp, StringComparison.Ordinal);
        Assert.Contains("MFA_PROOF_REQUIRED", stepUp, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentModerationService_UsesCasStateMachineAndRealtimePush()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
            nameof(AuthoringModerationWorkflowService.ModerateCommentAsync),
            nameof(AuthoringModerationWorkflowService.ModerateCommentsAsync));

        Assert.Contains("IsAllowedModerationTransition", runtimeShape);
        Assert.Contains("Comment.get_ModerationStatus", runtimeShape);
        Assert.Contains("CommentModerationStateRow.get_Status", runtimeShape);
        Assert.Contains("PushCommentAddAsync", runtimeShape);
        Assert.Contains("PushCommentRemoveAsync", runtimeShape);
        Assert.Contains("CommentCacheInvalidationScope", runtimeShape);
        Assert.Contains("SendAccountTransactionalNoticeAsync", runtimeShape);

        MethodInfo transition = typeof(AuthoringModerationWorkflowService).GetMethod(
            "IsAllowedModerationTransition",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.True((bool)transition.Invoke(null, [CommentModerationStatus.Pending, CommentModerationStatus.Approved])!);
        Assert.True((bool)transition.Invoke(null, [CommentModerationStatus.Approved, CommentModerationStatus.Hidden])!);
        Assert.True((bool)transition.Invoke(null, [CommentModerationStatus.Hidden, CommentModerationStatus.Approved])!);
        Assert.False((bool)transition.Invoke(null, [CommentModerationStatus.Hidden, CommentModerationStatus.Hidden])!);
        Assert.False((bool)transition.Invoke(null, [CommentModerationStatus.Hidden, CommentModerationStatus.Pending])!);
        Assert.False((bool)transition.Invoke(null, [CommentModerationStatus.Rejected, CommentModerationStatus.Pending])!);
        Assert.False((bool)transition.Invoke(null, [(CommentModerationStatus)99, CommentModerationStatus.Approved])!);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task CommentCacheInvalidation_BumpsScopedVersionsWithoutGlobalCommentOutputTag()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<long>(),
                Arg.Any<CancellationToken>())
            .Returns(1L);
        IHttpCacheInvalidator httpCache = Substitute.For<IHttpCacheInvalidator>();
        var dispatcher = new CacheInvalidationDispatcher(cache, cache, httpCache);

        await dispatcher.InvalidateCommentMutationAsync(new CommentCacheInvalidationScope(
            ArticleId: 42,
            RootId: 81,
            AccountId: 7,
            PublicArticleChanged: true,
            UserCommentsChanged: true));

        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42:root:81", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.UserCommentCursorVersion, "account:7", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixAsync(
            CachePolicyId.CommentCursor,
            string.Empty,
            Arg.Any<CancellationToken>());
        Assert.DoesNotContain(
            httpCache.ReceivedCalls(),
            static call => call.GetArguments()
                .OfType<CacheTag[]>()
                .Any(tags => tags.Contains(CacheTag.Comment)));
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void SchemaMigrationRegistry_ContainsPublicCommentHotPathIndexes()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        string hotPath = Fingerprint(descriptors, "20260603-post-comment-public-hot-path-indexes");
        string region = Fingerprint(descriptors, "20260610-post-comment-region-compliance");
        string blockedRegion = Fingerprint(descriptors, "20260628-post-comment-blocked-region-lookup");

        Assert.Contains("idx_comment_public_roots", hotPath);
        Assert.Contains("idx_comment_public_replies", hotPath);
        Assert.Contains("idx_comment_public_reply_count", hotPath);
        Assert.Contains("idx_comment_public_create_time_desc", hotPath);
        Assert.Contains("WHERE parent_id IS NULL AND moderation_status = 1 AND is_deleted = false", hotPath);
        Assert.Contains("WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false", hotPath);
        Assert.Contains("idx_comment_region_compliance_comment", region);
        Assert.Contains("idx_comment_region_compliance_submit_region", region);
        Assert.Contains("comment_blocked_region", blockedRegion);
        Assert.Contains("PRIMARY KEY(comment_id, region_code)", blockedRegion);
        Assert.Contains("idx_comment_blocked_region_region_comment", blockedRegion);
    }

    private static int FindReference(IReadOnlyList<string> references, string fact)
    {
        int index = references.ToList().FindIndex(reference => reference.Contains(fact, StringComparison.Ordinal));
        Assert.True(index >= 0, $"Missing runtime reference '{fact}'.");
        return index;
    }

    private static string Fingerprint(IReadOnlyList<ISchemaMigrationDescriptor> descriptors, string migrationId)
        => string.Join('\n', Assert.Single(descriptors, descriptor => descriptor.MigrationId == migrationId)
            .Steps
            .Select(static step => step.Fingerprint));

    private static async Task<ProcessResult> RunRotationToolAsync(string tool, string shimDirectory, string? confirm)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "/bin/bash",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(tool);
        startInfo.Environment["PATH"] = $"{shimDirectory}:/usr/bin:/bin";
        startInfo.Environment["FSUSBLOG_DATABASE_URL"] = "postgresql://test.invalid/fsus";
        startInfo.Environment["FSUSBLOG_REGION_IP_HASH_ROTATION_DRY_RUN"] = "0";
        if (confirm is null)
        {
            startInfo.Environment.Remove("FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION");
        }
        else
        {
            startInfo.Environment["FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION"] = confirm;
        }

        using Process process = Process.Start(startInfo)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

    private static IConfiguration CreateRegionPolicyConfiguration(string ipHashKey, bool trustedProxyEnabled = false)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:RegionPolicy:IpHashKey"] = ipHashKey,
                ["Moderation:RegionPolicy:TrustedProxyEnabled"] = trustedProxyEnabled ? "true" : "false"
            })
            .Build();
}

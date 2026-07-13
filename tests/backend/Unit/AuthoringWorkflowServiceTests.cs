using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Tests.Unit;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringWorkflowServiceTests
{
    [Fact]
    public void DraftAndRevisionRuntimeContractsUseAdminPrincipalAttribution()
    {
        IReadOnlyList<IReadOnlyList<string>> attributionHandlers = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(AuthoringEndpoints),
                "ResolveRequiredAdminPrincipalId");
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringWorkflowService.SaveDraftAsync), StringComparison.Ordinal)));
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringWorkflowService.RollbackRevisionAsync), StringComparison.Ordinal)));
        Assert.All(attributionHandlers, static handler =>
            Assert.DoesNotContain(handler, reference => reference.Contains("GetUserId", StringComparison.Ordinal)));

        MethodInfo saveDraft = typeof(AuthoringWorkflowService).GetMethod(nameof(AuthoringWorkflowService.SaveDraftAsync))!;
        MethodInfo rollback = typeof(AuthoringWorkflowService).GetMethod(nameof(AuthoringWorkflowService.RollbackRevisionAsync))!;
        Assert.Contains(saveDraft.GetParameters(), static parameter =>
            parameter.Name == "ownerAdminPrincipalId" && parameter.ParameterType == typeof(long));
        Assert.Contains(rollback.GetParameters(), static parameter =>
            parameter.Name == "actorAdminPrincipalId" && parameter.ParameterType == typeof(long));

        AssertColumn<ArticleDraft>(nameof(ArticleDraft.OwnerAdminPrincipalId), "owner_admin_principal_id");
        AssertColumn<ArticleRevision>(nameof(ArticleRevision.CreatedByAdminPrincipalId), "created_by_admin_principal_id");
        string[] revisionProperties = typeof(ArticleRevisionSummaryResponse).GetProperties().Select(static property => property.Name).ToArray();
        Assert.Contains("CreatedByAdminPrincipalId", revisionProperties);
        Assert.DoesNotContain("CreatedByUserId", revisionProperties);
    }

    [Fact]
    public void SaveDraftAsync_RuntimeUsesAtomicUpsert()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.SaveDraftAsync));

        Assert.Contains("ON CONFLICT (owner_admin_principal_id, draft_key) DO UPDATE", method, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Queryable<ArticleDraft>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable(existing)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable(existing)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ServerDraft_RuntimePreservesRightsV3Policy()
    {
        Assert.Equal(typeof(ArticleRightsRequest), typeof(ServerDraftSaveRequest).GetProperty("Rights")!.PropertyType);
        Assert.Equal(typeof(ArticleRightsRequest), typeof(ServerDraftResponse).GetProperty("Rights")!.PropertyType);
        AssertColumn<ArticleDraft>(nameof(ArticleDraft.RightsJson), "rights_json");

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.SaveDraftAsync),
            nameof(AuthoringWorkflowService.GetDraftAsync),
            "NormalizeDraftRights",
            "SerializeDraftRights",
            "DeserializeDraftRights");
        Assert.Contains("NormalizeDraftRights", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("all-rights-reserved", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("append-attribution", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("SerializeDraftRights", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("DeserializeDraftRights", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void RebuildAssetLibraryAsync_RuntimeUsesTransactionAndLocks()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "RebuildAssetLibraryAsync");

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ReindexAssetsAsync_RuntimeUsesArticleScopedAssetPath()
    {
        IReadOnlyList<IReadOnlyList<string>> reindex = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(AuthoringWorkflowService),
                "ReindexArticleAssetsAsync");
        string articleScoped = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "ReindexArticleAssetsAsync",
            "EnsureAssetArticleReferenceStoreAsync");

        Assert.All(reindex, static references =>
            Assert.DoesNotContain(references, reference => reference.Contains("RebuildAssetLibraryAsync", StringComparison.Ordinal)));
        Assert.Contains("EnsureAssetArticleReferenceStoreAsync", articleScoped, StringComparison.Ordinal);
        Assert.Contains("asset_library_article_ref", articleScoped, StringComparison.Ordinal);
        Assert.Contains("get_ArticleId", articleScoped, StringComparison.Ordinal);
    }

    [Fact]
    public void BanModerationUsersAsync_RuntimeUsesXminPredicateAndTransaction()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "BanModerationUsersAsync");

        Assert.Equal(typeof(string), typeof(User).GetProperty("RowVersion")!.PropertyType);
        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("xmin::text", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("status <> 2", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("deleted_at IS NULL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", method, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RestoreImportedRevisionsAsync_RuntimeUsesTransactionAndArticleLock()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "RestoreImportedRevisionsAsync");

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.Contains("Deleteable", method, StringComparison.Ordinal);
        Assert.Contains("Insertable", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerateCommentsAsync_RuntimeUsesSharedTransactionBeforeSideEffects()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.ModerateCommentsAsync));

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("InvalidateModeratedCommentAsync", method, StringComparison.Ordinal);
        Assert.Contains("PublishModerationRealtimeAsync", method, StringComparison.Ordinal);
        Assert.Contains("get_IsSuccess", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerateCommentsAsync_RuntimeKeepsSideEffectsOutsideTransaction()
    {
        string transactionBody = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(AuthoringWorkflowService),
            "Updateable",
            "Comment moderation bulk update conflicted.");
        Assert.DoesNotContain("InvalidateModeratedCommentAsync", transactionBody, StringComparison.Ordinal);
        Assert.DoesNotContain("PublishModerationRealtimeAsync", transactionBody, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteAudit", transactionBody, StringComparison.Ordinal);
        Assert.DoesNotContain("BanModerationUsersAsync", transactionBody, StringComparison.Ordinal);
    }

    [Fact]
    public void ExportContentBackupAsync_RuntimeUsesBatchLoadInsteadOfPerArticleExport()
    {
        IReadOnlyList<IReadOnlyList<string>> backup = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(AuthoringWorkflowService),
                "LoadContentBackupArticlesAsync");
        string batch = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "LoadContentBackupArticlesAsync");

        Assert.All(backup, static references =>
            Assert.DoesNotContain(references, reference => reference.Contains("ExportArticleAsync", StringComparison.Ordinal)));
        Assert.Contains(nameof(ArticleBody), batch, StringComparison.Ordinal);
        Assert.Contains(nameof(ArticleTag), batch, StringComparison.Ordinal);
        Assert.Contains(nameof(ArticleRevision), batch, StringComparison.Ordinal);
        Assert.Contains("Contains", batch, StringComparison.Ordinal);
        Assert.Contains("BuildExportMetadata", batch, StringComparison.Ordinal);
    }

    [Fact]
    public void GetAnalyticsAsync_RuntimeReadsRollupsInsteadOfRawLogWindows()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.GetAnalyticsAsync),
            "LoadArticleStatusCountsAsync",
            "LoadAuthorReadRollupAsync",
            "LoadAuthorRouteRollupsAsync",
            "LoadAuthorRumRollupsAsync");

        Assert.Contains("LoadArticleStatusCountsAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorReadRollupAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorRouteRollupsAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorRumRollupsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Take(5_000)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Take(2_000)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<VisitLogEntity>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<FrontendRumMetric>()", method, StringComparison.Ordinal);
        Assert.Contains("SUM(CASE WHEN", method, StringComparison.Ordinal);
        Assert.Contains("author_route_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_rum_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_aot_stats", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerationQueue_RuntimeLoadsLatestSignalAndCountsWithSingleAggregates()
    {
        string queue = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.ListCommentModerationQueueAsync),
            "LoadCommentModerationQueueCountsAsync");
        string signals = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "LoadLatestModelSignalsAsync");

        Assert.Contains("LoadCommentModerationQueueCountsAsync", queue, StringComparison.Ordinal);
        Assert.DoesNotContain("CountAsync(cancellationToken)", queue, StringComparison.Ordinal);
        Assert.Contains("SUM(CASE WHEN moderation_status", queue, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("DISTINCT ON (comment_id)", signals, StringComparison.Ordinal);
        Assert.Contains("ORDER BY comment_id, created_at_utc DESC", signals, StringComparison.Ordinal);
        Assert.DoesNotContain("GroupBy", signals, StringComparison.Ordinal);
        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.Steps.Any(step =>
                step.Fingerprint.Contains("idx_comment_moderation_signal_comment_created", StringComparison.Ordinal)));
        Assert.Equal("20260629-post-comment-moderation-signal-latest-index", migration.MigrationId);
    }

    [Fact]
    public void RumMetricSummaries_AverageUsesUnsortedSamplesAndP75UsesSortedSamples()
    {
        RumMetricAuditContext[] values =
        [
            CreateRumMetric("LCP", 5),
            CreateRumMetric("LCP", 1),
            CreateRumMetric("LCP", 4),
            CreateRumMetric("LCP", 2),
            CreateRumMetric("LCP", 3)
        ];

        AuthorRumMetricResponse metric = Assert.Single(InvokeBuildRumMetricSummaries(values));

        Assert.Equal("LCP", metric.Name);
        Assert.Equal(5, metric.Count);
        Assert.Equal(3d, metric.Average);
        Assert.Equal(4d, metric.P75);
    }

    [Fact]
    public void RumMetricSummaries_RuntimeUsesAverageAndSortedPercentileSamples()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "BuildRumMetricSummaries",
            "Percentile");
        Assert.Contains("Enumerable.Average", method, StringComparison.Ordinal);
        Assert.Contains("Enumerable.Order", method, StringComparison.Ordinal);
        Assert.Contains("Percentile", method, StringComparison.Ordinal);
        Assert.Contains("RoundingHelper.Round2", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ContentExportContracts_DoNotCarryImportableNumericActorIds()
    {
        string[] exportProperties = typeof(ContentRevisionExportResponse)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("CreatedByUserId", exportProperties);
        Assert.DoesNotContain("CreatedByAdminPrincipalId", exportProperties);

        string exportBuilder = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "BuildExportMetadata");
        Assert.DoesNotContain("get_CreatedByUserId", exportBuilder, StringComparison.Ordinal);
        Assert.DoesNotContain("get_CreatedByAdminPrincipalId", exportBuilder, StringComparison.Ordinal);

        string revisionRestore = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "RestoreImportedRevisionsAsync");
        Assert.DoesNotContain("get_CreatedByUserId", revisionRestore, StringComparison.Ordinal);
        Assert.DoesNotContain("get_CreatedByAdminPrincipalId", revisionRestore, StringComparison.Ordinal);
        Assert.Contains("set_CreatedByAdminPrincipalId", revisionRestore, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationIdentityProjection_RuntimeAvoidsLegacyAccountFallbacks()
    {
        string moderationQueue = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.ListCommentModerationQueueAsync),
            "ToCommentModerationItem",
            "ResolveModerationAuthorDisplayName");
        string displayName = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "ResolveCommentModerationDisplayName");
        string hydration = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            "HydrateCommentModerationDisplayNames");

        Assert.DoesNotContain("FsusBlog.Server.Entities.User", moderationQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("get_Username", moderationQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("get_UserName", moderationQueue, StringComparison.Ordinal);
        Assert.Contains("get_PublicHandle", moderationQueue, StringComparison.Ordinal);
        Assert.Contains("public", displayName, StringComparison.Ordinal);
        Assert.Contains("ResolveCommentModerationDisplayName", moderationQueue, StringComparison.Ordinal);
        Assert.Contains("CommentModerationItemResponse..ctor", moderationQueue, StringComparison.Ordinal);
        Assert.Contains("set_AuthorDisplayName", hydration, StringComparison.Ordinal);
        Assert.Contains("set_ReplyToAuthorDisplayName", hydration, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationAttribution_RuntimeUsesAdminPrincipal()
    {
        IReadOnlyList<IReadOnlyList<string>> attributionHandlers = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferenceSequencesContaining(
                typeof(AuthoringEndpoints),
                "ResolveRequiredAdminPrincipalId");
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringWorkflowService.ModerateCommentAsync), StringComparison.Ordinal)));
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringWorkflowService.ModerateCommentsAsync), StringComparison.Ordinal)));
        Assert.All(
            attributionHandlers.Where(static handler => handler.Any(reference =>
                reference.Contains(nameof(AuthoringWorkflowService.ModerateCommentAsync), StringComparison.Ordinal)
                || reference.Contains(nameof(AuthoringWorkflowService.ModerateCommentsAsync), StringComparison.Ordinal))),
            static handler => Assert.DoesNotContain(handler, reference => reference.Contains("GetUserId", StringComparison.Ordinal)));

        foreach (string methodName in new[]
        {
            nameof(AuthoringWorkflowService.ModerateCommentAsync),
            nameof(AuthoringWorkflowService.ModerateCommentsAsync)
        })
        {
            MethodInfo method = typeof(AuthoringWorkflowService).GetMethod(methodName)!;
            Assert.Contains(method.GetParameters(), static parameter =>
                parameter.Name == "actorAdminPrincipalId" && parameter.ParameterType == typeof(long));
        }

        AssertColumn<Comment>(nameof(Comment.ModeratedByAdminPrincipalId), "moderated_by_admin_principal_id");
        Assert.Null(typeof(Comment).GetProperty("ModeratedByUserId"));
        string[] dtoProperties = typeof(CommentModerationItemResponse).GetProperties()
            .Select(static property => property.Name)
            .ToArray();
        Assert.Contains("ModeratedByAdminPrincipalId", dtoProperties);
        Assert.DoesNotContain("UserId", dtoProperties);
        Assert.DoesNotContain("UserName", dtoProperties);
        Assert.DoesNotContain("ModeratedByUserId", dtoProperties);
    }

    [Fact]
    public void GenerateAiAssist_DefaultConfiguration_DoesNotEnableExternalProviderOrTitleCandidates()
    {
        AuthoringWorkflowService service = BuildService();

        AiAssistResponse response = service.GenerateAiAssist(new AiAssistRequest(
            "AOT 安全实践",
            "# AOT\n\n这是一篇安全实践记录。",
            "zh-CN"));

        Assert.False(response.ProviderEnabled);
        Assert.Equal("disabled-local-fallback", response.ProviderMode);
        Assert.False(response.ExternalProviderAllowed);
        Assert.Equal("author-ai-assist", response.AuditEvent);
        Assert.Equal(string.Empty, response.TranslationDraft);
        Assert.Empty(response.TitleCandidates);
        Assert.Contains("AOT", response.SuggestedTags);
        Assert.Contains("安全", response.SuggestedTags);
        Assert.DoesNotContain(response.StructureIssues, static issue => issue.Code == "dangerous_html");
    }

    [Fact]
    public void GenerateAiAssist_ExternalProviderRequiresReviewAndWritesAudit()
    {
        AuthoringWorkflowService service = BuildService(out AuditLogChannel auditLogChannel, config: new Dictionary<string, string?>
        {
            ["Authoring:AiAssist:Enabled"] = "true",
            ["Authoring:AiAssist:Provider"] = "external",
            ["Authoring:AiAssist:AllowExternalProvider"] = "true",
            ["Authoring:AiAssist:ExternalProviderReviewed"] = "false"
        });

        AiAssistResponse response = service.GenerateAiAssist(7, new AiAssistRequest(
            "AOT 安全实践",
            "# AOT\n\nsecurity WASM 内容。",
            "en-US",
            "title-tags-translate"));

        Assert.True(response.ProviderEnabled);
        Assert.False(response.ExternalProviderAllowed);
        Assert.Equal("external-blocked-review-required", response.ProviderMode);
        Assert.NotEmpty(response.TitleCandidates);
        Assert.Equal(string.Empty, response.TranslationDraft);
        Assert.True(auditLogChannel.Reader.TryRead(out AuditRecord? record));
        Assert.Equal("author-ai-assist", record.EventInfo);
        string payload = Encoding.UTF8.GetString(record.ContextPayload ?? []);
        Assert.Contains("actor=7", payload, StringComparison.Ordinal);
        Assert.Contains("provider=external", payload, StringComparison.Ordinal);
        Assert.Contains("externalAllowed=False", payload, StringComparison.Ordinal);
        Assert.Contains("operation=title-tags-translate", payload, StringComparison.Ordinal);
    }

    [Fact]
    public void RunPrepublishCheck_DangerousHtml_BlocksPublish()
    {
        AuthoringWorkflowService service = BuildService();

        PrepublishCheckResponse response = service.RunPrepublishCheck(
            "Title",
            "safe text <script>alert(1)</script>",
            "summary",
            "/uploads/illustration/cover.png");

        Assert.False(response.CanPublish);
        Assert.Contains(response.Issues, static issue => issue.Code == "dangerous_html" && issue.Severity == "error");
    }

    [Fact]
    public void RunPrepublishCheck_SeoMetadataWarningsAndInvalidCover_AreReported()
    {
        AuthoringWorkflowService service = BuildService();
        string longTitle = new('T', 61);
        string longSummary = new('S', 181);

        PrepublishCheckResponse response = service.RunPrepublishCheck(
            longTitle,
            "safe text",
            longSummary,
            "javascript:alert(1)");

        Assert.False(response.CanPublish);
        Assert.Contains(response.Issues, static issue => issue.Code == "seo_title_long" && issue.Severity == "warning");
        Assert.Contains(response.Issues, static issue => issue.Code == "seo_description_long" && issue.Severity == "warning");
        Assert.Contains(response.Issues, static issue => issue.Code == "cover_url_invalid" && issue.Severity == "error");
    }

    [Fact]
    public void RunPrepublishCheck_ContentQualityIssues_BlockAndWarn()
    {
        AuthoringWorkflowService service = BuildService();

        PrepublishCheckResponse response = service.RunPrepublishCheck(
            "Title",
            """
![ ](/uploads/illustration/no-alt.png)

[bad scheme](javascript:alert(1))
[private](/user/manage)
[broken article](/article/not-a-number)

```ts
const value = 1;
""",
            "summary",
            "/uploads/illustration/cover.png");

        Assert.False(response.CanPublish);
        Assert.Contains(response.Issues, static issue => issue.Code == "image_alt_missing" && issue.Severity == "warning");
        Assert.Contains(response.Issues, static issue => issue.Code == "link_url_invalid" && issue.Severity == "error");
        Assert.Contains(response.Issues, static issue => issue.Code == "internal_link_private" && issue.Severity == "error");
        Assert.Contains(response.Issues, static issue => issue.Code == "internal_link_invalid" && issue.Severity == "error");
        Assert.Contains(response.Issues, static issue => issue.Code == "markdown_fence_unclosed" && issue.Severity == "error");
    }

    [Fact]
    public void RunPrepublishCheck_WarningOverrideReason_WritesAudit()
    {
        AuthoringWorkflowService service = BuildService(out AuditLogChannel auditLogChannel);

        PrepublishCheckResponse response = service.RunPrepublishCheck(
            "Title",
            "![ ](/uploads/illustration/no-alt.png)",
            "summary",
            "/uploads/illustration/cover.png",
            actorUserId: 7,
            draftKey: "fsus:article-draft:create",
            articleId: null,
            warningOverrideReason: "Accepted because the illustration is decorative.");

        Assert.True(response.CanPublish);
        Assert.Contains(response.Issues, static issue => issue.Code == "image_alt_missing" && issue.Severity == "warning");
        Assert.True(auditLogChannel.Reader.TryRead(out AuditRecord? record));
        Assert.Equal("prepublish-warning-override", record.EventInfo);
        string payload = Encoding.UTF8.GetString(record.ContextPayload ?? []);
        Assert.Contains("warnings=image_alt_missing", payload, StringComparison.Ordinal);
        Assert.Contains("Accepted because the illustration is decorative.", payload, StringComparison.Ordinal);
    }

    [Fact]
    public void DetectCommentHitReasons_CombinesFilterSpamAndManualReasons()
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>()).Returns(call =>
        {
            string text = call.Arg<string>();
            return text.Contains("badword", StringComparison.OrdinalIgnoreCase)
                ? new ContentValidationResult(false, "sensitive_term_detected", "blocked")
                : new ContentValidationResult(true, "ok", string.Empty);
        });
        AuthoringWorkflowService service = BuildService(out _, contentFilter);

        IReadOnlyList<string> reasons = service.DetectCommentHitReasons(
            "<script>alert(1)</script> badword https://a.test https://b.test https://c.test aaaaaaaa",
            "pending_review");

        Assert.Contains("sensitive_term_detected", reasons);
        Assert.Contains("html-risk", reasons);
        Assert.Contains("link-heavy", reasons);
        Assert.Contains("spam-repeat", reasons);
        Assert.Contains("pending-review", reasons);
    }

    [Fact]
    public void DetectCommentHitReasons_DefaultsToManualReview()
    {
        AuthoringWorkflowService service = BuildService();

        IReadOnlyList<string> reasons = service.DetectCommentHitReasons("普通评论", null);

        Assert.Equal(["manual-review"], reasons);
    }

    [Fact]
    public void BuildArticleExportMarkdown_RoundTripsRecoverableMetadata()
    {
        DateTime scheduledAt = new(2026, 05, 19, 08, 00, 00, DateTimeKind.Utc);
        var article = new Article
        {
            Id = 42,
            Title = "Exported Article",
            Summary = "Exported summary",
            CoverImageUrl = "/uploads/illustration/cover.webp",
            CategoryId = 3,
            Status = ArticleStatus.Scheduled,
            ScheduledPublishAt = scheduledAt
        };
        var metadata = new ContentExportMetadataResponse(
            42,
            3,
            [5, 6],
            ArticleStatus.Scheduled,
            scheduledAt,
            "/uploads/illustration/cover.webp",
            1,
            [
                new ContentRevisionExportResponse(
                    1,
                    "Exported Article",
                    "# Body",
                    "Exported summary",
                    "/uploads/illustration/cover.webp",
                    3,
                    [5, 6],
                    "initial publish",
                    scheduledAt)
            ]);

        string markdown = AuthoringWorkflowService.BuildArticleExportMarkdown(article, "# Body", metadata);
        var parsed = AuthoringWorkflowService.ParseFrontmatter(markdown);

        Assert.Contains("fsusFormat: content-export-v1", markdown, StringComparison.Ordinal);
        Assert.Equal("Exported Article", parsed.Title);
        Assert.Equal(3, parsed.CategoryId);
        Assert.Equal([5, 6], parsed.TagIds);
        Assert.Equal(ArticleStatus.Scheduled, parsed.Status);
        Assert.Equal(scheduledAt, parsed.ScheduledPublishAt);
        Assert.NotNull(parsed.Metadata);
        ContentExportMetadataResponse parsedMetadata = parsed.Metadata!;
        Assert.Equal(1, parsedMetadata.RevisionCount);
        Assert.Equal("initial publish", parsedMetadata.Revisions[0].DiffSummary);
        string encodedMetadata = markdown.Split("fsusMetadataJson: ", StringSplitOptions.None)[1].Split('\n')[0];
        byte[] metadataJson = Convert.FromBase64String(encodedMetadata.Replace('-', '+').Replace('_', '/').PadRight(encodedMetadata.Length + ((4 - encodedMetadata.Length % 4) % 4), '='));
        string metadataText = Encoding.UTF8.GetString(metadataJson);
        Assert.DoesNotContain("CreatedByUserId", metadataText, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("createdByUserId", metadataText, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByAdminPrincipalId", metadataText, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("createdByAdminPrincipalId", metadataText, StringComparison.Ordinal);
        Assert.Equal("# Body", parsed.Content.Trim());
    }

    [Fact]
    public void ParseFrontmatter_LegacyRevisionActorIds_AreIgnored()
    {
        var metadata = new
        {
            SourceArticleId = 9,
            CategoryId = 3,
            TagIds = new[] { 5, 6 },
            Status = ArticleStatus.Draft,
            ScheduledPublishAt = (DateTime?)null,
            CoverImageUrl = "/uploads/legacy.webp",
            RevisionCount = 1,
            Revisions = new[]
            {
                new
                {
                    RevisionNo = 1,
                    Title = "Legacy",
                    Content = "# Legacy",
                    Summary = "summary",
                    CoverImageUrl = "/uploads/legacy.webp",
                    CategoryId = 3,
                    TagIds = new[] { 5, 6 },
                    DiffSummary = "legacy import",
                    createdByUserId = 12345,
                    createdByAdminPrincipalId = 67890,
                    CreatedAt = DateTime.Parse("2026-01-01T00:00:00Z")
                }
            }
        };
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(metadata);
        string encodedMetadata = Convert.ToBase64String(json).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        string markdown = $"""
---
fsusFormat: content-export-v1
fsusMetadataJson: {encodedMetadata}
---

# Legacy
""";

        var parsed = AuthoringWorkflowService.ParseFrontmatter(markdown);

        Assert.NotNull(parsed.Metadata);
        ContentRevisionExportResponse revision = Assert.Single(parsed.Metadata!.Revisions);
        Assert.Equal("legacy import", revision.DiffSummary);
        Assert.DoesNotContain(
            typeof(ContentRevisionExportResponse).GetProperties(),
            static property => property.Name is "CreatedByUserId" or "CreatedByAdminPrincipalId");
    }

    [Fact]
    public async Task PreviewAsync_RendersMarkdownLikeHtmlAndEscapesExecutableHtml()
    {
        AuthoringWorkflowService service = BuildService();

        ArticlePreviewResponse response = await service.PreviewAsync(new ServerDraftSaveRequest(
            "fsus:article-draft:create",
            null,
            "Preview <Title>",
            """
## Section

Paragraph with **bold**, *em*, `code`, and [link](https://example.com/docs).

![Cover](/uploads/illustration/cover.png)

```ts
const value = "<script>alert(1)</script>";
```

<script>alert(1)</script>
""",
            "Summary <safe>",
            "/uploads/illustration/cover.png",
            1,
            [2],
            "rev-1",
            0,
            null));

        Assert.Contains("data-preview-only=\"true\"", response.Html, StringComparison.Ordinal);
        Assert.Contains("data-markdown-renderer=\"server-preview\"", response.Html, StringComparison.Ordinal);
        Assert.Contains("<h2>Section</h2>", response.Html, StringComparison.Ordinal);
        Assert.Contains("<strong>bold</strong>", response.Html, StringComparison.Ordinal);
        Assert.Contains("<em>em</em>", response.Html, StringComparison.Ordinal);
        Assert.Contains("<code>code</code>", response.Html, StringComparison.Ordinal);
        Assert.Contains("href=\"https://example.com/docs\"", response.Html, StringComparison.Ordinal);
        Assert.Contains("<figure class=\"author-preview__image\"><img src=\"/uploads/illustration/cover.png\"", response.Html, StringComparison.Ordinal);
        Assert.Contains("<pre class=\"shiki author-preview__code\"><code class=\"language-ts\">", response.Html, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", response.Html, StringComparison.Ordinal);
        Assert.DoesNotContain("<script>", response.Html, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(response.Issues, static issue => issue.Code == "dangerous_html");
    }

    private static AuthoringWorkflowService BuildService()
        => BuildService(out _);

    private static RumMetricAuditContext CreateRumMetric(string name, double value)
        => new(name, "article", "server", value, [], DateTime.UnixEpoch);

    private static IReadOnlyList<AuthorRumMetricResponse> InvokeBuildRumMetricSummaries(IEnumerable<RumMetricAuditContext> values)
    {
        MethodInfo? method = typeof(AuthoringWorkflowService).GetMethod(
            "BuildRumMetricSummaries",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        object? result = method.Invoke(null, [values]);
        return Assert.IsAssignableFrom<IReadOnlyList<AuthorRumMetricResponse>>(result);
    }

    private static void AssertColumn<TEntity>(string propertyName, string expectedColumn)
    {
        PropertyInfo property = typeof(TEntity).GetProperty(propertyName)!;
        SugarColumn mapping = Assert.Single(property.GetCustomAttributes<SugarColumn>());
        Assert.Equal(expectedColumn, mapping.ColumnName);
    }

    private static AuthoringWorkflowService BuildService(
        out AuditLogChannel auditLogChannel,
        IContentFilterService? contentFilterOverride = null,
        IReadOnlyDictionary<string, string?>? config = null)
    {
        var contentFilter = contentFilterOverride ?? Substitute.For<IContentFilterService>();
        if (contentFilterOverride is null)
        {
            contentFilter.ValidateContent(Arg.Any<string>())
                .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        }

        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(config ?? new Dictionary<string, string?>())
            .Build();

        return new AuthoringWorkflowService(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<IArticleService>(),
            contentFilter,
            Substitute.For<IBlacklistService>(),
            Substitute.For<ICacheInvalidationDispatcher>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            auditLogChannel = new AuditLogChannel(),
            configuration,
            Substitute.For<ILogger<AuthoringWorkflowService>>());
    }
}

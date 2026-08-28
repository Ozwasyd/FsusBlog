using System.Reflection;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Tests.Unit;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

using NSubstitute;

using SqlSugar;
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
            handler.Any(reference => reference.Contains(nameof(AuthoringDraftLifecycleService.SaveDraftAsync), StringComparison.Ordinal)));
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringDraftLifecycleService.RollbackRevisionAsync), StringComparison.Ordinal)));
        Assert.All(attributionHandlers, static handler =>
            Assert.DoesNotContain(handler, reference => reference.Contains("GetUserId", StringComparison.Ordinal)));

        MethodInfo saveDraft = typeof(AuthoringDraftLifecycleService).GetMethod(nameof(AuthoringDraftLifecycleService.SaveDraftAsync))!;
        MethodInfo rollback = typeof(AuthoringDraftLifecycleService).GetMethod(nameof(AuthoringDraftLifecycleService.RollbackRevisionAsync))!;
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
    public void SaveDraftAsync_RuntimeUsesAtomicServerRevisionCas()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringDraftLifecycleService),
            nameof(AuthoringDraftLifecycleService.SaveDraftAsync));

        Assert.Contains("SaveDraftWithCasAsync", method, StringComparison.Ordinal);
        string cas = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringDraftLifecycleService),
            "SaveDraftWithCasAsync",
            "InsertDraftAsync",
            "UpdateDraftWithCasAsync");
        Assert.Contains("ON CONFLICT (owner_admin_principal_id, draft_key) DO NOTHING", cas, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("server_revision = server_revision + 1", cas, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("server_revision = @ExpectedServerRevision", cas, StringComparison.OrdinalIgnoreCase);
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
            typeof(AuthoringDraftLifecycleService),
            nameof(AuthoringDraftLifecycleService.SaveDraftAsync),
            nameof(AuthoringDraftLifecycleService.GetDraftAsync),
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
    public void ServerDraftEndpoints_ExposeCasConflictAndConditionalDiscard()
    {
        string routes = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringEndpoints),
            "MapAuthoringWorkflowRoutes",
            "DraftConflict");

        Assert.Contains("expectedServerRevision", routes, StringComparison.Ordinal);
        Assert.Contains("draft_conflict", routes, StringComparison.Ordinal);
        MethodInfo conflictResult = typeof(AuthoringEndpoints).GetMethod(
            "DraftConflict",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Contains(StatusCodes.Status409Conflict, RuntimeMetadataInspection.DescribeInt32Constants(conflictResult));
        Assert.Equal(typeof(long?), typeof(ServerDraftSaveRequest).GetProperty("ExpectedServerRevision")!.PropertyType);
        Assert.Equal(typeof(long), typeof(ServerDraftResponse).GetProperty("ServerRevision")!.PropertyType);
        Assert.Equal(
            ["CurrentServerRevision", "CurrentUpdatedAt", "TitleSummary"],
            typeof(ServerDraftConflictResponse).GetProperties().Select(static property => property.Name));
    }

    [Fact]
    public void AssetLibraryRuntime_HasNoSecondRebuildOwner()
    {
        Assert.DoesNotContain(
            typeof(AuthoringAssetLibraryService).GetMethods(),
            static method => method.Name.Contains("Rebuild", StringComparison.Ordinal));
    }

    [Fact]
    public void ReindexAssetsAsync_RuntimeUsesCanonicalLedgerProjection()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringAssetLibraryService),
            "ReindexAssetsAsync",
            "ListAssetsAsync");

        Assert.Contains("ListAssetsAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("content_asset", runtime, StringComparison.Ordinal);
        Assert.Contains("content_asset_reference", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("asset_library_", runtime, StringComparison.Ordinal);
    }

    [Fact]
    public void BanModerationUsersAsync_RuntimeUsesXminPredicateAndTransaction()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
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
            typeof(AuthoringContentTransferService),
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
            typeof(AuthoringModerationWorkflowService),
            nameof(AuthoringModerationWorkflowService.ModerateCommentsAsync));

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("InvalidateModeratedCommentAsync", method, StringComparison.Ordinal);
        Assert.Contains("PublishModerationRealtimeAsync", method, StringComparison.Ordinal);
        Assert.Contains("get_IsSuccess", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerateCommentsAsync_RuntimeKeepsSideEffectsOutsideTransaction()
    {
        string transactionBody = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(AuthoringModerationWorkflowService),
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
                typeof(AuthoringContentTransferService),
                "LoadContentBackupArticlesAsync");
        string batch = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringContentTransferService),
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
    public void GetAnalyticsAsync_RuntimeReadsPrivacyPreservingRollupsInsteadOfRawWindows()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringAnalyticsReadService),
            nameof(AuthoringAnalyticsReadService.GetAnalyticsAsync),
            "LoadArticleStatusCountsAsync",
            "LoadAuthorReadRollupAsync",
            "LoadAuthorAotRollupAsync",
            "LoadAuthorRumRollupsAsync",
            "LoadAuthorMetricRollupsAsync");

        Assert.Contains("LoadArticleStatusCountsAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorReadRollupAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorAotRollupAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorRumRollupsAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorMetricRollupsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadAuthorRouteRollupsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Take(5_000)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Take(2_000)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<VisitLogEntity>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<FrontendRumMetric>()", method, StringComparison.Ordinal);
        Assert.Contains("SUM(CASE WHEN", method, StringComparison.Ordinal);
        Assert.Contains("daily_read_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_rum_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_aot_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_rum_page_type_stats", method, StringComparison.Ordinal);
        Assert.Contains("author_rum_aot_source_stats", method, StringComparison.Ordinal);
        Assert.DoesNotContain("author_route_stats", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerationQueue_RuntimeLoadsLatestSignalAndCountsWithSingleAggregates()
    {
        string queue = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
            nameof(AuthoringModerationWorkflowService.ListCommentModerationQueueAsync),
            "LoadCommentModerationQueueCountsAsync");
        string signals = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
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
            typeof(AuthoringAnalyticsReadService),
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
            typeof(AuthoringContentTransferService),
            "BuildExportMetadata");
        Assert.DoesNotContain("get_CreatedByUserId", exportBuilder, StringComparison.Ordinal);
        Assert.DoesNotContain("get_CreatedByAdminPrincipalId", exportBuilder, StringComparison.Ordinal);

        string revisionRestore = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringContentTransferService),
            "RestoreImportedRevisionsAsync");
        Assert.DoesNotContain("get_CreatedByUserId", revisionRestore, StringComparison.Ordinal);
        Assert.DoesNotContain("get_CreatedByAdminPrincipalId", revisionRestore, StringComparison.Ordinal);
        Assert.Contains("set_CreatedByAdminPrincipalId", revisionRestore, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationIdentityProjection_RuntimeAvoidsLegacyAccountFallbacks()
    {
        string moderationQueue = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
            nameof(AuthoringModerationWorkflowService.ListCommentModerationQueueAsync),
            "ToCommentModerationItem",
            "ResolveModerationAuthorDisplayName");
        string displayName = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
            "ResolveCommentModerationDisplayName");
        string hydration = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringModerationWorkflowService),
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
            handler.Any(reference => reference.Contains(nameof(AuthoringModerationWorkflowService.ModerateCommentAsync), StringComparison.Ordinal)));
        Assert.Contains(attributionHandlers, static handler =>
            handler.Any(reference => reference.Contains(nameof(AuthoringModerationWorkflowService.ModerateCommentsAsync), StringComparison.Ordinal)));
        Assert.All(
            attributionHandlers.Where(static handler => handler.Any(reference =>
                reference.Contains(nameof(AuthoringModerationWorkflowService.ModerateCommentAsync), StringComparison.Ordinal)
                || reference.Contains(nameof(AuthoringModerationWorkflowService.ModerateCommentsAsync), StringComparison.Ordinal))),
            static handler => Assert.DoesNotContain(handler, reference => reference.Contains("GetUserId", StringComparison.Ordinal)));

        foreach (string methodName in new[]
        {
            nameof(AuthoringModerationWorkflowService.ModerateCommentAsync),
            nameof(AuthoringModerationWorkflowService.ModerateCommentsAsync)
        })
        {
            MethodInfo method = typeof(AuthoringModerationWorkflowService).GetMethod(methodName)!;
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
        AuthoringContentTransferService service = BuildContentTransferService();

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
        AuthoringContentTransferService service = BuildContentTransferService(out AuditLogChannel auditLogChannel, config: new Dictionary<string, string?>
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
        AuthoringDraftLifecycleService service = BuildDraftService();

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
        AuthoringDraftLifecycleService service = BuildDraftService();
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
        AuthoringDraftLifecycleService service = BuildDraftService();

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
        AuthoringDraftLifecycleService service = BuildDraftService(out AuditLogChannel auditLogChannel);

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
        AuthoringModerationWorkflowService service = BuildModerationService(contentFilter);

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
        AuthoringModerationWorkflowService service = BuildModerationService();

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

        string markdown = AuthoringContentTransferService.BuildArticleExportMarkdown(article, "# Body", metadata);
        var parsed = AuthoringContentTransferService.ParseFrontmatter(markdown);

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

        var parsed = AuthoringContentTransferService.ParseFrontmatter(markdown);

        Assert.NotNull(parsed.Metadata);
        ContentRevisionExportResponse revision = Assert.Single(parsed.Metadata!.Revisions);
        Assert.Equal("legacy import", revision.DiffSummary);
        Assert.DoesNotContain(
            typeof(ContentRevisionExportResponse).GetProperties(),
            static property => property.Name is "CreatedByUserId" or "CreatedByAdminPrincipalId");
    }

    [Fact]
    public async Task PreviewAsync_ReturnsNormalizedNonExecutableDataAndStableIdentity()
    {
        AuthoringDraftLifecycleService service = BuildDraftService();

        ArticlePreviewResponse response = await service.PreviewAsync(new ServerDraftSaveRequest(
            "fsus:article-draft:create",
            null,
            "Preview <Title>",
            "## Section\r\n正文🙂",
            "Summary <safe>",
            "/uploads/cover.png",
            1,
            [2],
            "rev-1",
            0,
            null));

        Assert.Equal("Preview <Title>", response.NormalizedTitle);
        Assert.Equal("Summary <safe>", response.NormalizedSummary);
        Assert.Equal("/uploads/cover.png", response.NormalizedCoverImageUrl);
        Assert.Equal("## Section\n正文🙂", response.NormalizedMarkdownSource);
        Assert.Equal(
            "preview:sha256:7ea4f661c9aa2612d0d105ea0b3078187ac0eb8ec02b33e180dd9b4574257a6b",
            response.SourceIdentity);
        Assert.DoesNotContain(
            typeof(ArticlePreviewResponse).GetProperties(),
            static property => property.Name.Equals("Html", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("/uploads/cover.png", "/uploads/cover.png")]
    [InlineData("https://example.com/cover.png", "https://example.com/cover.png")]
    [InlineData("http://example.com/cover.png", "http://example.com/cover.png")]
    [InlineData("//example.com/cover.png", null)]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("data:image/png;base64,AAAA", null)]
    [InlineData("https://user:pass@example.com/cover.png", null)]
    [InlineData("mailto:owner@example.com", null)]
    [InlineData("ftp://example.com/cover.png", null)]
    public async Task PreviewAsync_NormalizesCoverUrlWithFailClosedSchemePolicy(
        string coverImageUrl,
        string? expected)
    {
        AuthoringDraftLifecycleService service = BuildDraftService();
        ArticlePreviewResponse response = await service.PreviewAsync(new ServerDraftSaveRequest(
            "fsus:article-draft:create",
            null,
            "Title",
            "Content",
            null,
            coverImageUrl,
            1,
            [],
            "rev-1",
            0,
            null));

        Assert.Equal(expected, response.NormalizedCoverImageUrl);
    }

    [Fact]
    public async Task PreviewAsync_SourceIdentityUsesUtf8ByteLengthsAndNullAsEmpty()
    {
        AuthoringDraftLifecycleService service = BuildDraftService();
        ArticlePreviewResponse withNulls = await service.PreviewAsync(new ServerDraftSaveRequest(
            "fsus:article-draft:create",
            null,
            "é",
            "🙂",
            null,
            null,
            1,
            [],
            "rev-1",
            0,
            null));
        ArticlePreviewResponse withEmptyStrings = await service.PreviewAsync(new ServerDraftSaveRequest(
            "fsus:article-draft:create",
            null,
            "é",
            "🙂",
            string.Empty,
            string.Empty,
            1,
            [],
            "rev-1",
            0,
            null));

        Assert.Equal(
            "preview:sha256:a5211698f205f78847796364f1c2f15285f8946930c85d1c09c13db9f80c8272",
            withNulls.SourceIdentity);
        Assert.Equal(withNulls.SourceIdentity, withEmptyStrings.SourceIdentity);
    }

    private static AuthoringDraftLifecycleService BuildDraftService()
        => BuildDraftService(out _);

    private static RumMetricAuditContext CreateRumMetric(string name, double value)
        => new(name, "article", "server", value, [], DateTime.UnixEpoch);

    private static IReadOnlyList<AuthorRumMetricResponse> InvokeBuildRumMetricSummaries(IEnumerable<RumMetricAuditContext> values)
    {
        MethodInfo? method = typeof(AuthoringAnalyticsReadService).GetMethod(
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

    private static AuthoringDraftLifecycleService BuildDraftService(
        out AuditLogChannel auditLogChannel,
        IContentFilterService? contentFilterOverride = null)
    {
        var contentFilter = contentFilterOverride ?? Substitute.For<IContentFilterService>();
        if (contentFilterOverride is null)
        {
            contentFilter.ValidateContent(Arg.Any<string>())
                .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        }

        auditLogChannel = new AuditLogChannel();
        return new AuthoringDraftLifecycleService(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<FsusBlog.Core.Services.Abstractions.IArticleCoreService>(),
            new ArticlePublicationValidator(Substitute.For<ISqlSugarClient>(), contentFilter),
            new AuthoringAuditWriter(auditLogChannel));
    }

    private static AuthoringContentTransferService BuildContentTransferService()
        => BuildContentTransferService(out _);

    private static AuthoringContentTransferService BuildContentTransferService(
        out AuditLogChannel auditLogChannel,
        IReadOnlyDictionary<string, string?>? config = null)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(config ?? new Dictionary<string, string?>())
            .Build();
        AuthoringDraftLifecycleService prepublish = BuildDraftService(out auditLogChannel);
        var audit = new AuthoringAuditWriter(auditLogChannel);
        return new AuthoringContentTransferService(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<FsusBlog.Core.Services.Abstractions.IArticleCoreService>(),
            configuration,
            prepublish,
            audit,
            Substitute.For<ILogger<AuthoringContentTransferService>>());
    }

    private static AuthoringModerationWorkflowService BuildModerationService(IContentFilterService? contentFilterOverride = null)
    {
        var contentFilter = contentFilterOverride ?? Substitute.For<IContentFilterService>();
        if (contentFilterOverride is null)
        {
            contentFilter.ValidateContent(Arg.Any<string>())
                .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        }

        return new AuthoringModerationWorkflowService(
            Substitute.For<ISqlSugarClient>(),
            contentFilter,
            Substitute.For<IBlacklistService>(),
            Substitute.For<ICacheInvalidationDispatcher>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            new AuthoringAuditWriter(new AuditLogChannel()),
            Substitute.For<ILogger<AuthoringModerationWorkflowService>>());
    }
}

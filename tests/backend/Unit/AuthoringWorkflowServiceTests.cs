using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringWorkflowServiceTests
{
    [Fact]
    public void DraftAndRevisionContracts_SourceUseAdminPrincipalAttribution()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string entities = ReadRepoFile("src/backend/Entities/Article.cs");
        string dtos = ReadRepoFile("src/backend/Models/Dtos/AuthoringDtos.cs");
        string frontendApi = ReadRepoFile("src/frontend/src/api/authoring.ts");
        string revisionPanel = ReadRepoFile("src/frontend/src/components/admin/article/ArticleRevisionPanel.vue");

        Assert.Contains("ResolveRequiredAdminPrincipalId(context)", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("SaveDraftAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("GetDraftAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("DiscardDraftAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("RollbackRevisionAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);

        Assert.Contains("SaveDraftAsync(long ownerAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("RollbackRevisionAsync(long actorAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("OwnerAdminPrincipalId", entities, StringComparison.Ordinal);
        Assert.Contains("owner_admin_principal_id", entities, StringComparison.Ordinal);
        Assert.Contains("CreatedByAdminPrincipalId", entities, StringComparison.Ordinal);
        Assert.Contains("created_by_admin_principal_id", entities, StringComparison.Ordinal);

        Assert.Contains("CreatedByAdminPrincipalId", dtos, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByUserId", dtos, StringComparison.Ordinal);
        Assert.Contains("createdByAdminPrincipalId", frontendApi, StringComparison.Ordinal);
        Assert.DoesNotContain("createdByUserId", frontendApi, StringComparison.Ordinal);
        Assert.Contains("revision.createdByAdminPrincipalId", revisionPanel, StringComparison.Ordinal);
        Assert.DoesNotContain("revision.createdByUserId", revisionPanel, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveDraftAsync_SourceUsesAtomicUpsert()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string method = Slice(
            service,
            "public async Task<ServerDraftResponse> SaveDraftAsync",
            "public async Task<ServerDraftResponse?> GetDraftAsync");

        Assert.Contains("ON CONFLICT (owner_admin_principal_id, draft_key) DO UPDATE", method, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Queryable<ArticleDraft>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable(existing)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable(existing)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void RebuildAssetLibraryAsync_SourceUsesTransactionAndLocks()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string method = Slice(
            service,
            "private async Task RebuildAssetLibraryAsync",
            "public async Task<AuthorAnalyticsResponse> GetAnalyticsAsync");

        Assert.Contains("db.Ado.UseTranAsync(async ()", method, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
    }

    [Fact]
    public void BanModerationUsersAsync_SourceUsesXminPredicateAndTransaction()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string method = Slice(
            service,
            "private async Task<int> BanModerationUsersAsync",
            "private async Task<CommentModerationStateRow?> LoadCommentModerationStateAsync");
        string userEntity = ReadRepoFile("src/backend/Entities/User.cs");

        Assert.Contains("RowVersion", userEntity, StringComparison.Ordinal);
        Assert.Contains("db.Ado.UseTranAsync(async ()", method, StringComparison.Ordinal);
        Assert.Contains("xmin::text", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("status <> 2", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("deleted_at IS NULL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", method, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RestoreImportedRevisionsAsync_SourceUsesTransactionAndArticleLock()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string method = Slice(
            service,
            "private async Task<int> RestoreImportedRevisionsAsync",
            "private static string EscapeFrontmatterValue");

        Assert.Contains("db.Ado.UseTranAsync(async ()", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.Contains("Deleteable<ArticleRevision>()", method, StringComparison.Ordinal);
        Assert.Contains("Insertable(revisions)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerateCommentsAsync_SourceUsesSharedTransactionBeforeSideEffects()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string method = Slice(
            service,
            "public async Task<CommentModerationBulkResponse> ModerateCommentsAsync",
            "public async Task<ContentExportResponse?> ExportArticleAsync");

        Assert.Contains("db.Ado.UseTranAsync(async ()", method, StringComparison.Ordinal);
        Assert.Contains("updatedRows", method, StringComparison.Ordinal);
        AssertContainsAfter(method, "if (!transaction.IsSuccess)", "foreach (CommentModerationStateRow row in updatedRows)");
        AssertContainsAfter(method, "if (!transaction.IsSuccess)", "InvalidateModeratedCommentAsync");
        AssertContainsAfter(method, "if (!transaction.IsSuccess)", "PublishModerationRealtimeAsync");
    }

    [Fact]
    public void ContentExportContracts_DoNotCarryImportableNumericActorIds()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string dtos = ReadRepoFile("src/backend/Models/Dtos/AuthoringDtos.cs");
        string frontendApi = ReadRepoFile("src/frontend/src/api/authoring.ts");

        string exportDto = Slice(dtos, "public sealed record class ContentRevisionExportResponse", "public sealed record class ContentExportMetadataResponse");
        Assert.DoesNotContain("CreatedByUserId", exportDto, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByAdminPrincipalId", exportDto, StringComparison.Ordinal);

        string frontendExportDto = Slice(frontendApi, "export interface ContentRevisionExportResponse", "export interface ContentExportMetadataResponse");
        Assert.DoesNotContain("createdByUserId", frontendExportDto, StringComparison.Ordinal);
        Assert.DoesNotContain("createdByAdminPrincipalId", frontendExportDto, StringComparison.Ordinal);

        string exportBuilder = Slice(service, "private static ContentExportMetadataResponse BuildExportMetadata", "internal static string BuildArticleExportMarkdown");
        Assert.DoesNotContain("revision.CreatedByUserId", exportBuilder, StringComparison.Ordinal);
        Assert.DoesNotContain("revision.CreatedByAdminPrincipalId", exportBuilder, StringComparison.Ordinal);

        string revisionRestore = Slice(service, "private async Task<int> RestoreImportedRevisionsAsync", "private static string EscapeFrontmatterValue");
        Assert.DoesNotContain("revision.CreatedByUserId", revisionRestore, StringComparison.Ordinal);
        Assert.DoesNotContain("revision.CreatedByAdminPrincipalId", revisionRestore, StringComparison.Ordinal);
        Assert.Contains("CreatedByAdminPrincipalId = 0", revisionRestore, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationIdentityProjection_SourceAvoidsLegacyAccountFallbacks()
    {
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string moderationRegion = service[
            service.IndexOf("public async Task<CommentModerationQueueResponse> ListCommentModerationQueueAsync", StringComparison.Ordinal)..
            service.IndexOf("private static bool ShouldLinkBan", StringComparison.Ordinal)];

        Assert.DoesNotContain("Queryable<Comment, Article, User", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("JoinType.Left, c.UserId == u.Id", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("JoinType.Left, c.ReplyToUserId == ru.Id", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("u.PublicHandle", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("ru.PublicHandle", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Username", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("ru.Username", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("row.UserName", moderationRegion, StringComparison.Ordinal);
        Assert.DoesNotContain("isAnonymousActor ? null : row.UserId", moderationRegion, StringComparison.Ordinal);
        Assert.Contains("ResolveCommentModerationDisplayName", moderationRegion, StringComparison.Ordinal);
        Assert.Contains("AuthorDisplayName", moderationRegion, StringComparison.Ordinal);
        Assert.Contains("ReplyToAuthorDisplayName", moderationRegion, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentModerationAttribution_SourceUsesAdminPrincipal()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string service = ReadRepoFile("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string entity = ReadRepoFile("src/backend/Entities/Comment.cs");
        string dtos = ReadRepoFile("src/backend/Models/Dtos/AuthoringDtos.cs");
        string frontendApi = ReadRepoFile("src/frontend/src/api/authoring.ts");
        string moderationQueue = ReadRepoFile("src/frontend/src/composables/useCommentModerationQueue.ts");
        string moderationDetail = ReadRepoFile("src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue");

        Assert.Contains("ModerateCommentsAsync(ResolveRequiredAdminPrincipalId(context)", endpoints, StringComparison.Ordinal);
        Assert.Contains("ModerateCommentAsync(ResolveRequiredAdminPrincipalId(context)", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerateCommentsAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerateCommentAsync(context.GetUserId()", endpoints, StringComparison.Ordinal);

        Assert.Contains("public async Task<bool> ModerateCommentAsync(long actorAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("public async Task<CommentModerationBulkResponse> ModerateCommentsAsync(\n        long actorAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("ModeratedByAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerateCommentAsync(int actorUserId", service, StringComparison.Ordinal);
        Assert.DoesNotContain("ModerateCommentsAsync(\n        int actorUserId", service, StringComparison.Ordinal);
        Assert.DoesNotContain("ModeratedByUserId == actorUserId", service, StringComparison.Ordinal);

        Assert.Contains("ModeratedByAdminPrincipalId", entity, StringComparison.Ordinal);
        Assert.Contains("moderated_by_admin_principal_id", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("ModeratedByUserId", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("moderated_by_user_id", entity, StringComparison.Ordinal);

        Assert.Contains("ModeratedByAdminPrincipalId", dtos, StringComparison.Ordinal);
        Assert.DoesNotContain("int? UserId", dtos, StringComparison.Ordinal);
        Assert.DoesNotContain("string? UserName", dtos, StringComparison.Ordinal);
        Assert.DoesNotContain("ModeratedByUserId", dtos, StringComparison.Ordinal);
        Assert.Contains("moderatedByAdminPrincipalId", frontendApi, StringComparison.Ordinal);
        Assert.DoesNotContain("userId: number | null", frontendApi, StringComparison.Ordinal);
        Assert.DoesNotContain("userName?: string | null", frontendApi, StringComparison.Ordinal);
        Assert.DoesNotContain("moderatedByUserId", frontendApi, StringComparison.Ordinal);
        Assert.Contains("moderatedByAdminPrincipalId", moderationQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("item.userId", moderationQueue, StringComparison.Ordinal);
        Assert.DoesNotContain("moderatedByUserId", moderationQueue, StringComparison.Ordinal);
        Assert.Contains("moderatedByAdminPrincipalId", moderationDetail, StringComparison.Ordinal);
        Assert.DoesNotContain("moderatedByUserId", moderationDetail, StringComparison.Ordinal);
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

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string Slice(string content, string startMarker, string endMarker)
    {
        int start = content.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = content.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return content[start..end];
    }

    private static void AssertContainsAfter(string content, string first, string second)
    {
        int firstIndex = content.IndexOf(first, StringComparison.Ordinal);
        Assert.True(firstIndex >= 0, $"Missing first marker: {first}");
        int secondIndex = content.IndexOf(second, firstIndex + first.Length, StringComparison.Ordinal);
        Assert.True(secondIndex > firstIndex, $"Missing second marker after {first}: {second}");
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

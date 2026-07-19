using System.Data.Common;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class AuthoringWorkflowService
{
    public async Task<ServerDraftResponse> SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest request, CancellationToken cancellationToken = default)
    {
        string draftKey = NormalizeDraftKey(request.DraftKey, request.ArticleId);
        string tagIds = string.Join(',', NormalizeTagIds(request.TagIds));
        ArticleRightsRequest rights = NormalizeDraftRights(request.Rights);
        DateTime now = DateTime.UtcNow;
        var draft = new ArticleDraft
        {
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            DraftKey = draftKey,
            ArticleId = request.ArticleId,
            Title = Normalize(request.Title, 256),
            Summary = TextHelpers.NormalizeNullable(request.Summary, 512),
            CoverImageUrl = TextHelpers.NormalizeNullable(request.CoverImageUrl, 512),
            CategoryId = Math.Max(0, request.CategoryId),
            TagIds = tagIds,
            MarkdownContent = Normalize(request.Content, 200_000),
            Status = NormalizeArticleStatus(request.Status),
            RightsJson = SerializeDraftRights(rights),
            ClientRevision = TextHelpers.NormalizeNullable(request.ClientRevision, 64),
            CreatedAt = now,
            UpdatedAt = now
        };
        draft.ScheduledPublishAt = draft.Status == ArticleStatus.Scheduled ? request.ScheduledPublishAt : null;

        await UpsertDraftAsync(draft, cancellationToken);

        WriteAudit(AuditSourceCatalog.Article, "server-draft-save", ownerAdminPrincipalId, draftKey);
        return ToDraftResponse(draft);
    }

    private async Task UpsertDraftAsync(ArticleDraft draft, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_draft (
                owner_admin_principal_id,
                article_id,
                draft_key,
                title,
                summary,
                cover_image_url,
                categoryid,
                tag_ids,
                markdown_content,
                client_revision,
                status,
                scheduled_publish_at,
                rights_json,
                created_at,
                updated_at
            ) VALUES (
                @OwnerAdminPrincipalId,
                CAST(@ArticleId AS integer),
                @DraftKey,
                @Title,
                @Summary,
                @CoverImageUrl,
                @CategoryId,
                @TagIds,
                @MarkdownContent,
                @ClientRevision,
                @Status,
                CAST(@ScheduledPublishAt AS timestamp),
                @RightsJson,
                @CreatedAt,
                @UpdatedAt
            )
            ON CONFLICT (owner_admin_principal_id, draft_key) DO UPDATE SET
                article_id = EXCLUDED.article_id,
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                cover_image_url = EXCLUDED.cover_image_url,
                categoryid = EXCLUDED.categoryid,
                tag_ids = EXCLUDED.tag_ids,
                markdown_content = EXCLUDED.markdown_content,
                client_revision = EXCLUDED.client_revision,
                status = EXCLUDED.status,
                scheduled_publish_at = EXCLUDED.scheduled_publish_at,
                rights_json = EXCLUDED.rights_json,
                updated_at = EXCLUDED.updated_at;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", draft.OwnerAdminPrincipalId),
            new SugarParameter("@ArticleId", DbValue(draft.ArticleId)),
            new SugarParameter("@DraftKey", draft.DraftKey),
            new SugarParameter("@Title", draft.Title),
            new SugarParameter("@Summary", DbValue(draft.Summary)),
            new SugarParameter("@CoverImageUrl", DbValue(draft.CoverImageUrl)),
            new SugarParameter("@CategoryId", draft.CategoryId),
            new SugarParameter("@TagIds", draft.TagIds),
            new SugarParameter("@MarkdownContent", draft.MarkdownContent),
            new SugarParameter("@ClientRevision", DbValue(draft.ClientRevision)),
            new SugarParameter("@Status", (int)draft.Status),
            new SugarParameter("@ScheduledPublishAt", DbValue(draft.ScheduledPublishAt)),
            new SugarParameter("@RightsJson", DbValue(draft.RightsJson)),
            new SugarParameter("@CreatedAt", draft.CreatedAt),
            new SugarParameter("@UpdatedAt", draft.UpdatedAt));
    }

    public async Task<ServerDraftResponse?> GetDraftAsync(long ownerAdminPrincipalId, string draftKey, CancellationToken cancellationToken = default)
    {
        string normalized = NormalizeDraftKey(draftKey, null);
        ArticleDraft? draft = await db.Queryable<ArticleDraft>()
            .Where(it => it.OwnerAdminPrincipalId == ownerAdminPrincipalId && it.DraftKey == normalized)
            .FirstAsync(cancellationToken);
        return draft is null ? null : ToDraftResponse(draft);
    }

    public async Task<bool> DiscardDraftAsync(long ownerAdminPrincipalId, string draftKey, CancellationToken cancellationToken = default)
    {
        string normalized = NormalizeDraftKey(draftKey, null);
        int count = await db.Deleteable<ArticleDraft>()
            .Where(it => it.OwnerAdminPrincipalId == ownerAdminPrincipalId && it.DraftKey == normalized)
            .ExecuteCommandAsync(cancellationToken);
        if (count > 0)
        {
            WriteAudit(AuditSourceCatalog.Article, "server-draft-discard", ownerAdminPrincipalId, normalized);
        }

        return count > 0;
    }

    public async Task<IReadOnlyList<ArticleRevisionSummaryResponse>> GetRevisionsAsync(int articleId, CancellationToken cancellationToken = default)
    {
        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId)
            .OrderByDescending(it => it.RevisionNo)
            .Take(50)
            .ToListAsync(cancellationToken);

        return revisions.Select(static revision => new ArticleRevisionSummaryResponse(
            revision.Id.ToString(CultureInfo.InvariantCulture),
            revision.ArticleId,
            revision.RevisionNo,
            revision.Title,
            revision.DiffSummary,
            revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            revision.CreatedAt)).ToArray();
    }

    public async Task<ArticleRevisionDetailResponse?> GetRevisionAsync(int articleId, long revisionId, CancellationToken cancellationToken = default)
    {
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == revisionId)
            .FirstAsync(cancellationToken);
        return revision is null ? null : ToRevisionDetailResponse(revision);
    }

    public async Task<bool> RollbackRevisionAsync(long actorAdminPrincipalId, int articleId, long revisionId, CancellationToken cancellationToken = default)
    {
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId && it.Id == revisionId)
            .FirstAsync(cancellationToken);
        if (revision is null)
        {
            return false;
        }

        var updateResult = await articleService.UpdateAsync(new FsusBlog.Core.Services.Articles.UpdateArticleCommand(
            articleId,
            new FsusBlog.Core.Mapping.Models.ArticleWriteRequestCoreModel(
                revision.Title,
                revision.MarkdownContent,
                revision.Summary,
                revision.CoverImageUrl,
                revision.CategoryId,
                ParseTagIds(revision.TagIds),
                (int)ArticleStatus.Published)));
        bool updated = updateResult.IsSuccess;
        if (updated)
        {
            WriteAudit(AuditSourceCatalog.Article, "article-revision-rollback", actorAdminPrincipalId, $"{articleId}:{revisionId}");
        }

        return updated;
    }

    public Task<ArticlePreviewResponse> PreviewAsync(ServerDraftSaveRequest request)
    {
        PrepublishCheckResponse check = RunPrepublishCheck(request.Title, request.Content, request.Summary, request.CoverImageUrl);
        string plain = ImageHelper.StripMarkdown(request.Content, PreviewLength);
        string bodyHtml = RenderPreviewMarkdown(request.Content ?? string.Empty);
        string summary = request.Summary ?? plain[..Math.Min(plain.Length, 180)];
        string? cover = NormalizePreviewUrl(request.CoverImageUrl, allowMailTo: false);
        string coverHtml = cover is null
            ? string.Empty
            : $"  <figure class=\"author-preview__cover\"><img src=\"{WebUtility.HtmlEncode(cover)}\" alt=\"\" loading=\"lazy\" decoding=\"async\" /></figure>\n";
        string html = $"""
<article class="author-preview markdown-renderer markdown-renderer__body" data-preview-only="true" data-markdown-renderer="server-preview">
  <h1>{WebUtility.HtmlEncode(request.Title)}</h1>
  <p class="author-preview__summary">{WebUtility.HtmlEncode(summary)}</p>
{coverHtml}  <div class="author-preview__content">
{bodyHtml}
  </div>
</article>
""";
        return Task.FromResult(new ArticlePreviewResponse(html, plain, check.Issues));
    }

    public PrepublishCheckResponse RunPrepublishCheck(
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int? actorUserId = null,
        string? draftKey = null,
        int? articleId = null,
        string? warningOverrideReason = null)
    {
        var issues = new List<PrepublishIssue>();
        string body = content ?? string.Empty;
        if (string.IsNullOrWhiteSpace(title) || title.Trim().Length > 100)
        {
            issues.Add(new PrepublishIssue("error", "title_invalid", "标题不能为空，且不能超过 100 字符。"));
        }
        else if (title.Trim().Length > 60)
        {
            issues.Add(new PrepublishIssue("warning", "seo_title_long", "SEO 标题超过 60 字符，搜索结果可能截断。"));
        }

        if (string.IsNullOrWhiteSpace(summary))
        {
            issues.Add(new PrepublishIssue("warning", "summary_missing", "建议发布前补齐摘要。"));
        }
        else if (summary.Trim().Length > 180)
        {
            issues.Add(new PrepublishIssue("warning", "seo_description_long", "SEO 描述超过 180 字符，分享卡片可能截断。"));
        }

        if (string.IsNullOrWhiteSpace(coverImageUrl))
        {
            issues.Add(new PrepublishIssue("warning", "cover_missing", "建议发布前补齐封面图。"));
        }
        else if (NormalizePreviewUrl(coverImageUrl, allowMailTo: false) is null)
        {
            issues.Add(new PrepublishIssue("error", "cover_url_invalid", "封面图必须使用站内路径或 http/https URL。"));
        }

        AddMarkdownQualityIssues(body, issues);

        ContentValidationResult validation = contentFilter.ValidateContent(body);
        if (!validation.IsValid)
        {
            issues.Add(new PrepublishIssue("error", validation.ReasonCode, validation.Message));
        }

        bool canPublish = issues.All(static issue => !string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase));
        RecordPrepublishWarningOverride(actorUserId, articleId, draftKey, warningOverrideReason, canPublish, issues);
        return new PrepublishCheckResponse(canPublish, issues);
    }


    private static ServerDraftResponse ToDraftResponse(ArticleDraft draft)
        => new(
            draft.DraftKey,
            draft.ArticleId,
            draft.Title,
            draft.MarkdownContent,
            draft.Summary,
            draft.CoverImageUrl,
            draft.CategoryId,
            ParseTagIds(draft.TagIds),
            draft.ClientRevision,
            (int)draft.Status,
            draft.ScheduledPublishAt,
            draft.UpdatedAt,
            DeserializeDraftRights(draft.RightsJson));

    private static ArticleRevisionDetailResponse ToRevisionDetailResponse(ArticleRevision revision)
        => new(
            revision.Id.ToString(CultureInfo.InvariantCulture),
            revision.ArticleId,
            revision.RevisionNo,
            revision.Title,
            revision.MarkdownContent,
            revision.Summary,
            revision.CoverImageUrl,
            revision.CategoryId,
            ParseTagIds(revision.TagIds),
            revision.DiffSummary,
            revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            revision.CreatedAt);


    private static void AddMarkdownQualityIssues(string content, List<PrepublishIssue> issues)
    {
        AddDangerousHtmlIssues(content, issues);
        AddMarkdownStructureIssues(content, issues);
        AddMarkdownImageIssues(content, issues);
        AddMarkdownLinkIssues(content, issues);
    }

    private static void AddDangerousHtmlIssues(string content, List<PrepublishIssue> issues)
    {
        bool hasExecutableTag = Regex.IsMatch(
            content,
            @"<\s*(script|iframe|object|embed|base|link|meta)\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        bool hasEventHandler = Regex.IsMatch(
            content,
            @"\son[a-z]+\s*=",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        bool hasUnsafeProtocol = Regex.IsMatch(
            content,
            @"(href|src)\s*=\s*[""']?\s*(javascript:|data:text/html)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (hasExecutableTag || hasEventHandler || hasUnsafeProtocol)
        {
            issues.Add(new PrepublishIssue("error", "dangerous_html", "正文不能包含可执行 HTML、事件处理器或危险链接协议。"));
        }
    }

    private static void AddMarkdownStructureIssues(string content, List<PrepublishIssue> issues)
    {
        int fenceCount = Regex.Matches(content, @"(?m)^```", RegexOptions.CultureInvariant).Count;
        if (fenceCount % 2 != 0)
        {
            issues.Add(new PrepublishIssue("error", "markdown_fence_unclosed", "存在未闭合的 Markdown 代码块。"));
        }

        int lineCount = content.Length == 0 ? 0 : content.Count(static ch => ch == '\n') + 1;
        int headingCount = Regex.Matches(content, @"(?m)^#{1,6}\s+\S", RegexOptions.CultureInvariant).Count;
        int mermaidCount = Regex.Matches(content, @"(?im)^```\s*mermaid\b", RegexOptions.CultureInvariant).Count;
        int tableSeparatorCount = Regex.Matches(content, @"(?m)^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$", RegexOptions.CultureInvariant).Count;
        if (content.Length > 500_000 || lineCount > 12_000 || headingCount > 300 || mermaidCount > 25 || tableSeparatorCount > 120)
        {
            issues.Add(new PrepublishIssue("warning", "markdown_extreme_structure", "正文包含超大 Markdown、密集标题、表格或 Mermaid 结构，发布前需要确认渲染稳定性。"));
        }
    }

    private static void AddMarkdownImageIssues(string content, List<PrepublishIssue> issues)
    {
        MatchCollection images = Regex.Matches(
            content,
            @"!\[(?<alt>[^\]\n]*)\]\((?<url>[^)\n]*)(?:\s+""[^""]*"")?\)",
            RegexOptions.CultureInvariant);
        int missingAlt = images.Cast<Match>().Count(static match => string.IsNullOrWhiteSpace(match.Groups["alt"].Value));
        if (missingAlt > 0)
        {
            issues.Add(new PrepublishIssue("warning", "image_alt_missing", $"正文中有 {missingAlt} 张图片缺少 alt text。"));
        }

        int invalidImageUrls = images.Cast<Match>().Count(static match => !IsAuthoringUrlAllowed(match.Groups["url"].Value, allowMailTo: false));
        if (invalidImageUrls > 0)
        {
            issues.Add(new PrepublishIssue("error", "image_url_invalid", $"正文中有 {invalidImageUrls} 张图片 URL 不可发布。"));
        }
    }

    private static void AddMarkdownLinkIssues(string content, List<PrepublishIssue> issues)
    {
        MatchCollection links = Regex.Matches(
            content,
            @"(?<!!)\[(?<text>[^\]\n]+)\]\((?<url>[^)\n]*)(?:\s+""[^""]*"")?\)",
            RegexOptions.CultureInvariant);
        int emptyLinks = 0;
        int unsafeLinks = 0;
        int privateLinks = 0;
        int invalidInternalLinks = 0;
        int unverifiedInternalLinks = 0;
        int relativeLinks = 0;

        foreach (Match link in links)
        {
            LinkValidationResult result = ValidateAuthoringLink(link.Groups["url"].Value);
            emptyLinks += result == LinkValidationResult.Empty ? 1 : 0;
            unsafeLinks += result == LinkValidationResult.Unsafe ? 1 : 0;
            privateLinks += result == LinkValidationResult.PrivateRoute ? 1 : 0;
            invalidInternalLinks += result == LinkValidationResult.InvalidInternalRoute ? 1 : 0;
            unverifiedInternalLinks += result == LinkValidationResult.UnknownInternalRoute ? 1 : 0;
            relativeLinks += result == LinkValidationResult.Relative ? 1 : 0;
        }

        if (emptyLinks > 0)
        {
            issues.Add(new PrepublishIssue("error", "link_empty", $"正文中有 {emptyLinks} 个空链接。"));
        }

        if (unsafeLinks > 0)
        {
            issues.Add(new PrepublishIssue("error", "link_url_invalid", $"正文中有 {unsafeLinks} 个链接使用不安全或不支持的协议。"));
        }

        if (privateLinks > 0)
        {
            issues.Add(new PrepublishIssue("error", "internal_link_private", $"正文中有 {privateLinks} 个站内链接指向登录、账户、admin 或 API 私有路径。"));
        }

        if (invalidInternalLinks > 0)
        {
            issues.Add(new PrepublishIssue("error", "internal_link_invalid", $"正文中有 {invalidInternalLinks} 个站内文章、分类或标签链接格式无效。"));
        }

        if (unverifiedInternalLinks > 0)
        {
            issues.Add(new PrepublishIssue("warning", "internal_link_unverified", $"正文中有 {unverifiedInternalLinks} 个站内链接不在公开路由清单内，发布前需要人工核对。"));
        }

        if (relativeLinks > 0)
        {
            issues.Add(new PrepublishIssue("warning", "relative_link_unverified", $"正文中有 {relativeLinks} 个相对链接无法由发布前检查确认目标。"));
        }
    }

    private static LinkValidationResult ValidateAuthoringLink(string rawUrl)
    {
        string value = rawUrl.Trim().Trim('<', '>');
        if (value.Length == 0)
        {
            return LinkValidationResult.Empty;
        }

        if (value.StartsWith("#", StringComparison.Ordinal))
        {
            return LinkValidationResult.Valid;
        }

        if (value.StartsWith("/", StringComparison.Ordinal))
        {
            return ValidatePublicInternalPath(value);
        }

        if (Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
        {
            return uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                || uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || uri.Scheme.Equals(Uri.UriSchemeMailto, StringComparison.OrdinalIgnoreCase)
                ? LinkValidationResult.Valid
                : LinkValidationResult.Unsafe;
        }

        return value.StartsWith("./", StringComparison.Ordinal) || value.StartsWith("../", StringComparison.Ordinal)
            ? LinkValidationResult.Relative
            : LinkValidationResult.Unsafe;
    }

    private static bool IsAuthoringUrlAllowed(string rawUrl, bool allowMailTo)
    {
        string value = rawUrl.Trim().Trim('<', '>');
        if (value.Length == 0 || value.StartsWith("#", StringComparison.Ordinal))
        {
            return false;
        }

        if (value.StartsWith("/", StringComparison.Ordinal))
        {
            LinkValidationResult result = ValidatePublicInternalPath(value);
            return result is LinkValidationResult.Valid or LinkValidationResult.UnknownInternalRoute;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
        {
            return false;
        }

        return uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            || uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || (allowMailTo && uri.Scheme.Equals(Uri.UriSchemeMailto, StringComparison.OrdinalIgnoreCase));
    }

    private static LinkValidationResult ValidatePublicInternalPath(string rawPath)
    {
        string path = rawPath.Split(new[] { '?', '#' }, 2, StringSplitOptions.None)[0].TrimEnd('/');
        path = path.Length == 0 ? "/" : path;
        if (path.Equals("/", StringComparison.Ordinal)
            || path.Equals("/about", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/archive", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/search", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/robots.txt", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/sitemap.xml", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/rss.xml", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/atom.xml", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/feed.json", StringComparison.OrdinalIgnoreCase))
        {
            return LinkValidationResult.Valid;
        }

        if (path.StartsWith("/user", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/admin", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/api", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/login", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/register", StringComparison.OrdinalIgnoreCase))
        {
            return LinkValidationResult.PrivateRoute;
        }

        if (TryValidatePositiveIdRoute(path, "/article/")
            || TryValidatePositiveIdRoute(path, "/category/")
            || TryValidatePositiveIdRoute(path, "/tag/"))
        {
            return LinkValidationResult.Valid;
        }

        if (path.StartsWith("/article/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/category/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/tag/", StringComparison.OrdinalIgnoreCase))
        {
            return LinkValidationResult.InvalidInternalRoute;
        }

        return LinkValidationResult.UnknownInternalRoute;
    }

    private static bool TryValidatePositiveIdRoute(string path, string prefix)
        => path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && int.TryParse(path[prefix.Length..], out int id)
            && id > 0;

    private void RecordPrepublishWarningOverride(
        int? actorUserId,
        int? articleId,
        string? draftKey,
        string? warningOverrideReason,
        bool canPublish,
        IReadOnlyList<PrepublishIssue> issues)
    {
        if (actorUserId is not > 0 || !canPublish || string.IsNullOrWhiteSpace(warningOverrideReason))
        {
            return;
        }

        string[] warnings = issues
            .Where(static issue => issue.Severity.Equals("warning", StringComparison.OrdinalIgnoreCase))
            .Select(static issue => issue.Code)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(static code => code, StringComparer.Ordinal)
            .ToArray();
        if (warnings.Length == 0)
        {
            return;
        }

        string reason = Normalize(warningOverrideReason, WarningOverrideReasonLength);
        if (reason.Length < 8)
        {
            return;
        }

        string target = articleId is > 0
            ? $"article:{articleId.Value}"
            : $"draft:{NormalizeDraftKey(draftKey, null)}";
        WriteAudit(AuditSourceCatalog.Article, "prepublish-warning-override", actorUserId.Value, $"{target};warnings={string.Join(',', warnings)};reason={reason}");
    }


    private enum LinkValidationResult
    {
        Valid,
        Empty,
        Unsafe,
        PrivateRoute,
        InvalidInternalRoute,
        UnknownInternalRoute,
        Relative
    }

    private static string NormalizeDraftKey(string? raw, int? articleId)
    {
        string fallback = articleId is > 0 ? $"edit:{articleId.Value}" : "create";
        string value = string.IsNullOrWhiteSpace(raw) ? fallback : raw.Trim();
        return value.Length > MaxDraftKeyLength ? value[..MaxDraftKeyLength] : value;
    }

    private static string Normalize(string? raw, int maxLength)
    {
        string value = TextHelpers.TrimOrEmpty(raw);
        return value.Length > maxLength ? value[..maxLength] : value;
    }

    private static ArticleRightsRequest NormalizeDraftRights(ArticleRightsRequest? request)
    {
        if (request is null)
        {
            return new ArticleRightsRequest
            {
                Mode = "site",
                Enabled = true,
                LicenseType = "all-rights-reserved",
                CopyrightHolder = null,
                CopyrightYear = null,
                RightsStatement = null,
                AttributionTemplate = null,
                CopyPolicy = "append-attribution",
                MaxExcerptChars = 300,
                AllowCodeCopy = true,
                ShowPublicBadge = true,
                ProofBindingEnabled = true
            };
        }

        return new ArticleRightsRequest
        {
            Mode = string.Equals(request.Mode, "custom", StringComparison.OrdinalIgnoreCase) ? "custom" : "site",
            Enabled = request.Enabled,
            LicenseType = NormalizeDraftRightsToken(request.LicenseType, "all-rights-reserved"),
            CopyrightHolder = TextHelpers.NormalizeNullable(request.CopyrightHolder, 256),
            CopyrightYear = request.CopyrightYear,
            RightsStatement = TextHelpers.NormalizeNullable(request.RightsStatement, 4000),
            AttributionTemplate = TextHelpers.NormalizeNullable(request.AttributionTemplate, 4000),
            CopyPolicy = NormalizeDraftRightsToken(request.CopyPolicy, "append-attribution"),
            MaxExcerptChars = Math.Max(0, request.MaxExcerptChars),
            AllowCodeCopy = request.AllowCodeCopy,
            ShowPublicBadge = request.ShowPublicBadge,
            ProofBindingEnabled = request.ProofBindingEnabled
        };
    }

    private static string NormalizeDraftRightsToken(string? value, string fallback)
    {
        string normalized = Normalize(value, 48);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private static string SerializeDraftRights(ArticleRightsRequest rights)
        => JsonSerializer.Serialize(rights, s_draftRightsJsonOptions);

    private static ArticleRightsRequest DeserializeDraftRights(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return NormalizeDraftRights(null);
        }

        try
        {
            return NormalizeDraftRights(JsonSerializer.Deserialize<ArticleRightsRequest>(raw, s_draftRightsJsonOptions));
        }
        catch (JsonException)
        {
            return NormalizeDraftRights(null);
        }
    }

    private static object DbValue(string? value)
        => string.IsNullOrWhiteSpace(value) ? DBNull.Value : value;

    private static object DbValue(int? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private static object DbValue(DateTime? value)
        => value.HasValue ? value.Value : DBNull.Value;


    private static List<int> NormalizeTagIds(IEnumerable<int>? tagIds)
        => tagIds is null
            ? []
            : tagIds.Where(static id => id > 0).Distinct().OrderBy(static id => id).Take(32).ToList();

    private static List<int> ParseTagIds(string? raw)
        => string.IsNullOrWhiteSpace(raw)
            ? []
            : raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(static item => int.TryParse(item, out int id) ? id : 0)
                .Where(static id => id > 0)
                .Distinct()
                .ToList();

    private static ArticleStatus NormalizeArticleStatus(int? raw)
    {
        return raw is (int)ArticleStatus.Draft
            or (int)ArticleStatus.Scheduled
            or (int)ArticleStatus.Published
            or (int)ArticleStatus.Archived
            or (int)ArticleStatus.Deleted
            ? (ArticleStatus)raw.Value
            : ArticleStatus.Published;
    }

    private static string HashText(string text)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));


    private static string RenderPreviewMarkdown(string markdown)
    {
        string normalized = (markdown ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        string[] lines = normalized.Length == 0 ? [] : normalized.Split('\n');
        var html = new StringBuilder(Math.Min(normalized.Length + 256, PreviewLength + 512));
        var paragraph = new List<string>();
        var code = new StringBuilder();
        string? codeLanguage = null;
        bool inCode = false;

        void FlushParagraph()
        {
            if (paragraph.Count == 0)
            {
                return;
            }

            html.Append("    <p>")
                .Append(RenderInlineMarkdown(string.Join(' ', paragraph)))
                .AppendLine("</p>");
            paragraph.Clear();
        }

        for (int index = 0; index < lines.Length; index++)
        {
            string line = lines[index];
            string trimmed = line.Trim();
            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                if (inCode)
                {
                    string languageClass = string.IsNullOrWhiteSpace(codeLanguage)
                        ? string.Empty
                        : $" class=\"language-{WebUtility.HtmlEncode(codeLanguage)}\"";
                    html.Append("    <pre class=\"shiki author-preview__code\"><code")
                        .Append(languageClass)
                        .Append('>')
                        .Append(WebUtility.HtmlEncode(code.ToString()))
                        .AppendLine("</code></pre>");
                    code.Clear();
                    codeLanguage = null;
                    inCode = false;
                    continue;
                }

                FlushParagraph();
                codeLanguage = NormalizeCodeLanguage(trimmed[3..]);
                inCode = true;
                continue;
            }

            if (inCode)
            {
                code.AppendLine(line);
                continue;
            }

            if (trimmed.Length == 0)
            {
                FlushParagraph();
                continue;
            }

            if (TryParseHeading(trimmed, out int level, out string heading))
            {
                FlushParagraph();
                html.Append("    <h")
                    .Append(level)
                    .Append('>')
                    .Append(RenderInlineMarkdown(heading))
                    .Append("</h")
                    .Append(level)
                    .AppendLine(">");
                continue;
            }

            if (TryParseStandaloneImage(trimmed, out string imageHtml))
            {
                FlushParagraph();
                html.Append("    ")
                    .AppendLine(imageHtml);
                continue;
            }

            if (trimmed.StartsWith("> ", StringComparison.Ordinal))
            {
                FlushParagraph();
                var quoteLines = new List<string> { trimmed[2..].Trim() };
                while (index + 1 < lines.Length && lines[index + 1].TrimStart().StartsWith("> ", StringComparison.Ordinal))
                {
                    index++;
                    quoteLines.Add(lines[index].TrimStart()[2..].Trim());
                }

                html.Append("    <blockquote><p>")
                    .Append(RenderInlineMarkdown(string.Join(' ', quoteLines)))
                    .AppendLine("</p></blockquote>");
                continue;
            }

            if (TryParseListItem(trimmed, ordered: false, out string firstListItem))
            {
                FlushParagraph();
                html.AppendLine("    <ul>");
                html.Append("      <li>").Append(RenderInlineMarkdown(firstListItem)).AppendLine("</li>");
                while (index + 1 < lines.Length && TryParseListItem(lines[index + 1].Trim(), ordered: false, out string nextItem))
                {
                    index++;
                    html.Append("      <li>").Append(RenderInlineMarkdown(nextItem)).AppendLine("</li>");
                }

                html.AppendLine("    </ul>");
                continue;
            }

            if (TryParseListItem(trimmed, ordered: true, out firstListItem))
            {
                FlushParagraph();
                html.AppendLine("    <ol>");
                html.Append("      <li>").Append(RenderInlineMarkdown(firstListItem)).AppendLine("</li>");
                while (index + 1 < lines.Length && TryParseListItem(lines[index + 1].Trim(), ordered: true, out string nextItem))
                {
                    index++;
                    html.Append("      <li>").Append(RenderInlineMarkdown(nextItem)).AppendLine("</li>");
                }

                html.AppendLine("    </ol>");
                continue;
            }

            paragraph.Add(trimmed);
        }

        if (inCode)
        {
            string languageClass = string.IsNullOrWhiteSpace(codeLanguage)
                ? string.Empty
                : $" class=\"language-{WebUtility.HtmlEncode(codeLanguage)}\"";
            html.Append("    <pre class=\"shiki author-preview__code\"><code")
                .Append(languageClass)
                .Append('>')
                .Append(WebUtility.HtmlEncode(code.ToString()))
                .AppendLine("</code></pre>");
        }

        FlushParagraph();
        return html.ToString();
    }

    private static bool TryParseHeading(string line, out int level, out string text)
    {
        level = 0;
        while (level < Math.Min(6, line.Length) && line[level] == '#')
        {
            level++;
        }

        if (level == 0 || level >= line.Length || line[level] != ' ')
        {
            text = string.Empty;
            return false;
        }

        text = line[(level + 1)..].Trim();
        return text.Length > 0;
    }

    private static bool TryParseListItem(string line, bool ordered, out string value)
    {
        value = string.Empty;
        if (!ordered)
        {
            if (line.Length > 2 && (line[0] == '-' || line[0] == '*' || line[0] == '+') && line[1] == ' ')
            {
                value = line[2..].Trim();
                return value.Length > 0;
            }

            return false;
        }

        Match match = Regex.Match(line, @"^\d+[.)]\s+(.+)$", RegexOptions.CultureInvariant);
        if (!match.Success)
        {
            return false;
        }

        value = match.Groups[1].Value.Trim();
        return value.Length > 0;
    }

    private static bool TryParseStandaloneImage(string line, out string html)
    {
        html = string.Empty;
        Match match = Regex.Match(line, @"^!\[([^\]]*)\]\(([^)\s]+)(?:\s+""[^""]*"")?\)$", RegexOptions.CultureInvariant);
        if (!match.Success)
        {
            return false;
        }

        string? url = NormalizePreviewUrl(match.Groups[2].Value, allowMailTo: false);
        if (url is null)
        {
            return false;
        }

        html = $"<figure class=\"author-preview__image\"><img src=\"{WebUtility.HtmlEncode(url)}\" alt=\"{WebUtility.HtmlEncode(match.Groups[1].Value)}\" loading=\"lazy\" decoding=\"async\" /></figure>";
        return true;
    }

    private static string RenderInlineMarkdown(string text)
    {
        string html = WebUtility.HtmlEncode(text ?? string.Empty);
        html = Regex.Replace(html, @"`([^`]+)`", "<code>$1</code>", RegexOptions.CultureInvariant);
        html = Regex.Replace(html, @"!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)", match =>
        {
            string alt = match.Groups[1].Value;
            string? url = NormalizePreviewUrl(WebUtility.HtmlDecode(match.Groups[2].Value), allowMailTo: false);
            return url is null
                ? alt
                : $"<img src=\"{WebUtility.HtmlEncode(url)}\" alt=\"{alt}\" loading=\"lazy\" decoding=\"async\" />";
        }, RegexOptions.CultureInvariant);
        html = Regex.Replace(html, @"\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)", match =>
        {
            string label = match.Groups[1].Value;
            string? url = NormalizePreviewUrl(WebUtility.HtmlDecode(match.Groups[2].Value), allowMailTo: true);
            return url is null
                ? label
                : $"<a href=\"{WebUtility.HtmlEncode(url)}\" rel=\"nofollow noopener noreferrer\" target=\"_blank\">{label}</a>";
        }, RegexOptions.CultureInvariant);
        html = Regex.Replace(html, @"\*\*([^*]+)\*\*", "<strong>$1</strong>", RegexOptions.CultureInvariant);
        html = Regex.Replace(html, @"(?<!\*)\*([^*]+)\*(?!\*)", "<em>$1</em>", RegexOptions.CultureInvariant);
        return html;
    }

    private static string? NormalizePreviewUrl(string? raw, bool allowMailTo)
    {
        string value = TextHelpers.TrimOrEmpty(raw);
        if (value.Length == 0 || value.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase) || value.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (value.StartsWith("/", StringComparison.Ordinal) && !value.StartsWith("//", StringComparison.Ordinal))
        {
            return value;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
        {
            return null;
        }

        return uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            || (allowMailTo && uri.Scheme.Equals(Uri.UriSchemeMailto, StringComparison.OrdinalIgnoreCase))
            ? uri.ToString()
            : null;
    }

    private static string? NormalizeCodeLanguage(string raw)
    {
        string language = Regex.Replace(raw.Trim(), @"[^A-Za-z0-9_+-]", string.Empty, RegexOptions.CultureInvariant);
        return language.Length == 0 ? null : language[..Math.Min(language.Length, 32)];
    }

}

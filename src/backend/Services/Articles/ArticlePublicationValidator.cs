using System.Text.RegularExpressions;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public sealed record ArticlePublicationValidationInput(
    string? Title,
    string? Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    ArticleStatus Status,
    DateTime? ScheduledPublishAt);

public sealed record ArticlePublicationValidationResult(
    bool CanWrite,
    bool CanPublish,
    IReadOnlyList<PrepublishIssue> Issues)
{
    public void ThrowIfWriteBlocked()
    {
        if (CanWrite)
        {
            return;
        }

        PrepublishIssue issue = Issues.First(static item =>
            item.Severity.Equals("error", StringComparison.OrdinalIgnoreCase));
        throw new ArticleWriteValidationException(issue.Code, issue.Message);
    }

    public PrepublishCheckResponse ToPrepublishResponse()
        => new(CanPublish, Issues);
}

public interface IArticlePublicationValidator
{
    ArticlePublicationValidationResult ValidateContent(ArticlePublicationValidationInput input, DateTime utcNow);

    Task<ArticlePublicationValidationResult> ValidateAsync(
        ArticlePublicationValidationInput input,
        DateTime utcNow,
        CancellationToken cancellationToken = default);
}

public sealed class ArticlePublicationValidator(
    ISqlSugarClient db,
    IContentFilterService contentFilter) : IArticlePublicationValidator
{
    public const int MaxTitleLength = 256;
    public const int MaxSummaryLength = 512;
    public const int MaxContentLength = 200_000;
    public const int MaxCoverImageUrlLength = 512;
    public const int MaxTagIds = 32;

    public ArticlePublicationValidationResult ValidateContent(
        ArticlePublicationValidationInput input,
        DateTime utcNow)
    {
        var issues = new List<PrepublishIssue>();
        bool hardWriteFailure = AddContentIssues(input, utcNow, issues);
        bool requiresPublishReady = RequiresPublishReady(input.Status);
        bool canPublish = !HasErrors(issues);
        return new ArticlePublicationValidationResult(
            CanWrite: !hardWriteFailure && (!requiresPublishReady || canPublish),
            CanPublish: canPublish,
            Issues: issues);
    }

    public async Task<ArticlePublicationValidationResult> ValidateAsync(
        ArticlePublicationValidationInput input,
        DateTime utcNow,
        CancellationToken cancellationToken = default)
    {
        ArticlePublicationValidationResult content = ValidateContent(input, utcNow);
        var issues = content.Issues.ToList();
        bool taxonomyFailure = await AddTaxonomyIssuesAsync(input, issues, cancellationToken).ConfigureAwait(false);
        bool canPublish = !HasErrors(issues);
        return new ArticlePublicationValidationResult(
            CanWrite: content.CanWrite && !taxonomyFailure && (!RequiresPublishReady(input.Status) || canPublish),
            CanPublish: canPublish,
            Issues: issues);
    }

    private bool AddContentIssues(
        ArticlePublicationValidationInput input,
        DateTime utcNow,
        List<PrepublishIssue> issues)
    {
        string title = input.Title?.Trim() ?? string.Empty;
        string body = input.Content ?? string.Empty;
        string? summary = input.Summary?.Trim();
        string? coverImageUrl = input.CoverImageUrl?.Trim();
        bool hardWriteFailure = false;

        ArticleStatusTransitionValidation? statusValidation = ArticleStatusTransitionPolicy.ValidateTarget(
            (int)input.Status,
            input.ScheduledPublishAt,
            utcNow);
        if (statusValidation.HasValue)
        {
            AddError(issues, statusValidation.Value.Code, statusValidation.Value.Message);
            hardWriteFailure = true;
        }

        if (title.Length == 0)
        {
            AddError(issues, "title_invalid", "标题不能为空。");
        }
        else if (title.Length > MaxTitleLength)
        {
            AddError(issues, "title_invalid", $"标题不能超过 {MaxTitleLength} 字符。");
            hardWriteFailure = true;
        }
        else if (title.Length > 60)
        {
            AddWarning(issues, "seo_title_long", "SEO 标题超过 60 字符，搜索结果可能截断。");
        }

        if (string.IsNullOrWhiteSpace(summary))
        {
            AddWarning(issues, "summary_missing", "建议发布前补齐摘要。");
        }
        else if (summary.Length > MaxSummaryLength)
        {
            AddError(issues, "summary_invalid", $"摘要不能超过 {MaxSummaryLength} 字符。");
            hardWriteFailure = true;
        }
        else if (summary.Length > 180)
        {
            AddWarning(issues, "seo_description_long", "SEO 描述超过 180 字符，分享卡片可能截断。");
        }

        if (string.IsNullOrWhiteSpace(coverImageUrl))
        {
            AddWarning(issues, "cover_missing", "建议发布前补齐封面图。");
        }
        else if (coverImageUrl.Length > MaxCoverImageUrlLength || !IsAuthoringUrlAllowed(coverImageUrl, allowMailTo: false))
        {
            AddError(issues, "cover_url_invalid", "封面图必须是 512 字符内的站内路径或 http/https URL。");
            hardWriteFailure = true;
        }

        if (string.IsNullOrWhiteSpace(body))
        {
            AddError(issues, "content_invalid", "正文不能为空。");
        }
        else if (body.Length > MaxContentLength)
        {
            AddError(issues, "content_invalid", $"正文不能超过 {MaxContentLength} 字符。");
            hardWriteFailure = true;
        }

        int markdownErrorCount = CountErrors(issues);
        AddMarkdownQualityIssues(body, issues);
        hardWriteFailure |= CountErrors(issues) > markdownErrorCount;

        ContentValidationResult validation = contentFilter.ValidateContent(body);
        if (!validation.IsValid)
        {
            AddError(
                issues,
                "content_invalid",
                string.IsNullOrWhiteSpace(validation.Message) ? "正文未通过内容安全检查。" : validation.Message);
            hardWriteFailure = true;
        }

        return hardWriteFailure;
    }

    private async Task<bool> AddTaxonomyIssuesAsync(
        ArticlePublicationValidationInput input,
        List<PrepublishIssue> issues,
        CancellationToken cancellationToken)
    {
        bool failed = false;
        bool requiresPublishReady = RequiresPublishReady(input.Status);
        if (input.CategoryId < 0)
        {
            AddError(issues, "category_not_found", "分类 ID 必须为正数。默认未选择值只能是 0。");
            failed = true;
        }
        else if (input.CategoryId == 0)
        {
            if (requiresPublishReady)
            {
                AddError(issues, "category_not_found", "发布文章必须选择有效分类。");
                failed = true;
            }
        }
        else if (!await db.Queryable<Category>()
            .Where(category => category.Id == input.CategoryId)
            .AnyAsync(cancellationToken))
        {
            AddError(issues, "category_not_found", $"分类 {input.CategoryId} 不存在。");
            failed = true;
        }

        IReadOnlyList<int> requestedTagIds = input.TagIds ?? [];
        if (requestedTagIds.Count > MaxTagIds)
        {
            AddError(issues, "tag_limit_exceeded", $"标签数量不能超过 {MaxTagIds} 个。");
            failed = true;
        }

        if (requestedTagIds.Any(static id => id <= 0))
        {
            AddError(issues, "tag_not_found", "标签 ID 必须为正数。");
            failed = true;
        }

        int[] distinctTagIds = requestedTagIds
            .Where(static id => id > 0)
            .Distinct()
            .ToArray();
        if (distinctTagIds.Length > 0)
        {
            List<int> existingTagIds = await db.Queryable<Tag>()
                .Where(tag => distinctTagIds.Contains(tag.Id))
                .Select(tag => tag.Id)
                .ToListAsync(cancellationToken);
            int[] missingTagIds = distinctTagIds.Except(existingTagIds).Order().ToArray();
            if (missingTagIds.Length > 0)
            {
                AddError(issues, "tag_not_found", $"标签不存在：{string.Join(',', missingTagIds)}。");
                failed = true;
            }
        }

        return failed;
    }

    private static bool RequiresPublishReady(ArticleStatus status)
        => status is ArticleStatus.Scheduled or ArticleStatus.Published;

    private static bool HasErrors(IEnumerable<PrepublishIssue> issues)
        => issues.Any(static issue => issue.Severity.Equals("error", StringComparison.OrdinalIgnoreCase));

    private static int CountErrors(IEnumerable<PrepublishIssue> issues)
        => issues.Count(static issue => issue.Severity.Equals("error", StringComparison.OrdinalIgnoreCase));

    private static void AddError(List<PrepublishIssue> issues, string code, string message)
        => issues.Add(new PrepublishIssue("error", code, message));

    private static void AddWarning(List<PrepublishIssue> issues, string code, string message)
        => issues.Add(new PrepublishIssue("warning", code, message));

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
            AddError(issues, "dangerous_html", "正文不能包含可执行 HTML、事件处理器或危险链接协议。");
        }
    }

    private static void AddMarkdownStructureIssues(string content, List<PrepublishIssue> issues)
    {
        int fenceCount = Regex.Matches(content, @"(?m)^```", RegexOptions.CultureInvariant).Count;
        if (fenceCount % 2 != 0)
        {
            AddError(issues, "markdown_fence_unclosed", "存在未闭合的 Markdown 代码块。");
        }

        int lineCount = content.Length == 0 ? 0 : content.Count(static ch => ch == '\n') + 1;
        int headingCount = Regex.Matches(content, @"(?m)^#{1,6}\s+\S", RegexOptions.CultureInvariant).Count;
        int mermaidCount = Regex.Matches(content, @"(?im)^```\s*mermaid\b", RegexOptions.CultureInvariant).Count;
        int tableSeparatorCount = Regex.Matches(content, @"(?m)^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$", RegexOptions.CultureInvariant).Count;
        if (lineCount > 12_000 || headingCount > 300 || mermaidCount > 25 || tableSeparatorCount > 120)
        {
            AddWarning(issues, "markdown_extreme_structure", "正文包含密集标题、表格或 Mermaid 结构，发布前需要确认渲染稳定性。");
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
            AddWarning(issues, "image_alt_missing", $"正文中有 {missingAlt} 张图片缺少 alt text。");
        }

        int invalidImageUrls = images.Cast<Match>().Count(static match => !IsAuthoringUrlAllowed(match.Groups["url"].Value, allowMailTo: false));
        if (invalidImageUrls > 0)
        {
            AddError(issues, "image_url_invalid", $"正文中有 {invalidImageUrls} 张图片 URL 不可发布。");
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
            AddError(issues, "link_empty", $"正文中有 {emptyLinks} 个空链接。");
        }
        if (unsafeLinks > 0)
        {
            AddError(issues, "link_url_invalid", $"正文中有 {unsafeLinks} 个链接使用不安全或不支持的协议。");
        }
        if (privateLinks > 0)
        {
            AddError(issues, "internal_link_private", $"正文中有 {privateLinks} 个站内链接指向登录、账户、admin 或 API 私有路径。");
        }
        if (invalidInternalLinks > 0)
        {
            AddError(issues, "internal_link_invalid", $"正文中有 {invalidInternalLinks} 个站内文章、分类或标签链接格式无效。");
        }
        if (unverifiedInternalLinks > 0)
        {
            AddWarning(issues, "internal_link_unverified", $"正文中有 {unverifiedInternalLinks} 个站内链接不在公开路由清单内，发布前需要人工核对。");
        }
        if (relativeLinks > 0)
        {
            AddWarning(issues, "relative_link_unverified", $"正文中有 {relativeLinks} 个相对链接无法由发布前检查确认目标。");
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
}

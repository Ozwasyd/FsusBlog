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
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed class AuthoringDraftLifecycleService(
    ISqlSugarClient db,
    FsusBlog.Core.Services.Abstractions.IArticleCoreService articleService,
    IArticlePublicationValidator publicationValidator,
    IAuthoringAuditWriter auditWriter) : IAuthoringDraftLifecycle, IAuthoringPrepublishPolicy
{
    private const int MaxDraftKeyLength = 96;
    private const int PreviewLength = 24_000;
    private const int WarningOverrideReasonLength = 180;
    private static readonly JsonSerializerOptions s_draftRightsJsonOptions = new(JsonSerializerDefaults.Web);
    public async Task<ServerDraftResponse> SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest request, CancellationToken cancellationToken = default)
    {
        string draftKey = NormalizeDraftKey(request.DraftKey, request.ArticleId);
        string tagIds = string.Join(',', AuthoringNormalization.NormalizeTagIds(request.TagIds));
        ArticleRightsRequest rights = NormalizeDraftRights(request.Rights);
        DateTime now = DateTime.UtcNow;
        var draft = new ArticleDraft
        {
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            DraftKey = draftKey,
            ArticleId = request.ArticleId,
            Title = AuthoringNormalization.Normalize(request.Title, 256),
            Summary = TextHelpers.NormalizeNullable(request.Summary, 512),
            CoverImageUrl = TextHelpers.NormalizeNullable(request.CoverImageUrl, 512),
            CategoryId = Math.Max(0, request.CategoryId),
            TagIds = tagIds,
            MarkdownContent = AuthoringNormalization.Normalize(request.Content, 200_000),
            Status = NormalizeArticleStatus(request.Status),
            RightsJson = SerializeDraftRights(rights),
            ClientRevision = TextHelpers.NormalizeNullable(request.ClientRevision, 64),
            CreatedAt = now,
            UpdatedAt = now
        };
        draft.ScheduledPublishAt = draft.Status == ArticleStatus.Scheduled ? request.ScheduledPublishAt : null;

        await UpsertDraftAsync(draft, cancellationToken);

        auditWriter.Write(AuditSourceCatalog.Article, "server-draft-save", ownerAdminPrincipalId, draftKey);
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
            new SugarParameter("@ArticleId", AuthoringNormalization.DbValue(draft.ArticleId)),
            new SugarParameter("@DraftKey", draft.DraftKey),
            new SugarParameter("@Title", draft.Title),
            new SugarParameter("@Summary", AuthoringNormalization.DbValue(draft.Summary)),
            new SugarParameter("@CoverImageUrl", AuthoringNormalization.DbValue(draft.CoverImageUrl)),
            new SugarParameter("@CategoryId", draft.CategoryId),
            new SugarParameter("@TagIds", draft.TagIds),
            new SugarParameter("@MarkdownContent", draft.MarkdownContent),
            new SugarParameter("@ClientRevision", AuthoringNormalization.DbValue(draft.ClientRevision)),
            new SugarParameter("@Status", (int)draft.Status),
            new SugarParameter("@ScheduledPublishAt", AuthoringNormalization.DbValue(draft.ScheduledPublishAt)),
            new SugarParameter("@RightsJson", AuthoringNormalization.DbValue(draft.RightsJson)),
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
            auditWriter.Write(AuditSourceCatalog.Article, "server-draft-discard", ownerAdminPrincipalId, normalized);
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
                AuthoringNormalization.ParseTagIds(revision.TagIds),
                (int)ArticleStatus.Published),
            FsusBlog.Core.Services.Articles.ArticleUpdateIntent.Rollback));
        bool updated = updateResult.IsSuccess;
        if (updated)
        {
            auditWriter.Write(AuditSourceCatalog.Article, "article-revision-rollback", actorAdminPrincipalId, $"{articleId}:{revisionId}");
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
        ArticlePublicationValidationResult validation = publicationValidator.ValidateContent(
            new ArticlePublicationValidationInput(
                title,
                content,
                summary,
                coverImageUrl,
                CategoryId: 0,
                TagIds: [],
                ArticleStatus.Published,
                ScheduledPublishAt: null),
            DateTime.UtcNow);
        RecordPrepublishWarningOverride(
            actorUserId,
            articleId,
            draftKey,
            warningOverrideReason,
            validation.CanPublish,
            validation.Issues);
        return validation.ToPrepublishResponse();
    }

    public async Task<PrepublishCheckResponse> RunPrepublishCheckAsync(
        ServerDraftSaveRequest request,
        int? actorUserId = null,
        CancellationToken cancellationToken = default)
    {
        var status = (ArticleStatus)(request.Status ?? (int)ArticleStatus.Published);
        ArticlePublicationValidationResult validation = await publicationValidator.ValidateAsync(
            new ArticlePublicationValidationInput(
                request.Title,
                request.Content,
                request.Summary,
                request.CoverImageUrl,
                request.CategoryId,
                request.TagIds,
                status,
                request.ScheduledPublishAt),
            DateTime.UtcNow,
            cancellationToken).ConfigureAwait(false);
        RecordPrepublishWarningOverride(
            actorUserId,
            request.ArticleId,
            request.DraftKey,
            request.WarningOverrideReason,
            validation.CanPublish,
            validation.Issues);
        return validation.ToPrepublishResponse();
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
            AuthoringNormalization.ParseTagIds(draft.TagIds),
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
            AuthoringNormalization.ParseTagIds(revision.TagIds),
            revision.DiffSummary,
            revision.CreatedByAdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            revision.CreatedAt);


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

        string reason = AuthoringNormalization.Normalize(warningOverrideReason, WarningOverrideReasonLength);
        if (reason.Length < 8)
        {
            return;
        }

        string target = articleId is > 0
            ? $"article:{articleId.Value}"
            : $"draft:{NormalizeDraftKey(draftKey, null)}";
        auditWriter.Write(AuditSourceCatalog.Article, "prepublish-warning-override", actorUserId.Value, $"{target};warnings={string.Join(',', warnings)};reason={reason}");
    }


    private static string NormalizeDraftKey(string? raw, int? articleId)
    {
        string fallback = articleId is > 0 ? $"edit:{articleId.Value}" : "create";
        string value = string.IsNullOrWhiteSpace(raw) ? fallback : raw.Trim();
        return value.Length > MaxDraftKeyLength ? value[..MaxDraftKeyLength] : value;
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
        string normalized = AuthoringNormalization.Normalize(value, 48);
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

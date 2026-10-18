using System.Data.Common;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Articles;
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

public sealed class AuthoringContentTransferService(
    ISqlSugarClient db,
    FsusBlog.Core.Services.Abstractions.IArticleCoreService articleService,
    IConfiguration configuration,
    IAuthoringPrepublishPolicy prepublishPolicy,
    IAuthoringAuditWriter auditWriter,
    ILogger<AuthoringContentTransferService> logger) : IAuthoringContentExport, IAuthoringContentImport, IAuthoringAiAssist
{
    public async Task<ContentExportResponse?> ExportArticleAsync(int articleId, CancellationToken cancellationToken = default)
    {
        Article? article = await db.Queryable<Article>().ClearFilter().Where(it => it.Id == articleId).FirstAsync(cancellationToken);
        if (article is null)
        {
            return null;
        }

        string content = await db.Queryable<ArticleBody>().Where(it => it.ArticleId == articleId).Select(it => it.MarkdownContent).FirstAsync(cancellationToken) ?? string.Empty;
        List<int> tagIds = await LoadArticleTagIdsAsync(articleId, cancellationToken);
        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>()
            .Where(it => it.ArticleId == articleId)
            .OrderBy(it => it.RevisionNo)
            .ToListAsync(cancellationToken);
        await ArticleRevisionContentBlockStore.HydrateAsync(db, revisions, cancellationToken).ConfigureAwait(false);
        ContentExportMetadataResponse metadata = BuildExportMetadata(article, tagIds, revisions);
        return new ContentExportResponse($"article-{articleId}.md", BuildArticleExportMarkdown(article, content, metadata), metadata);
    }

    public async Task<ContentBackupExportResponse> ExportContentBackupAsync(CancellationToken cancellationToken = default)
    {
        IReadOnlyList<ContentExportResponse> articles = await LoadContentBackupArticlesAsync(cancellationToken);
        DateTime now = DateTime.UtcNow;
        return new ContentBackupExportResponse(
            $"fsusblog-content-{now:yyyyMMddHHmmss}.json",
            now,
            articles);
    }

    private async Task<IReadOnlyList<ContentExportResponse>> LoadContentBackupArticlesAsync(CancellationToken cancellationToken)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        List<Article> articles = await db.Queryable<Article>()
            .ClearFilter()
            .OrderBy(it => it.Id)
            .ToListAsync(cancellationToken);
        if (articles.Count == 0)
        {
            logger.LogInformation("content-backup-export articleCount=0 revisionCount=0 dbCommandCount=1 elapsedMs={ElapsedMs}", stopwatch.ElapsedMilliseconds);
            return [];
        }

        List<int> ids = [.. articles.Select(static article => article.Id)];
        Dictionary<int, string> bodyByArticleId = (await db.Queryable<ArticleBody>()
            .Where(it => ids.Contains(it.ArticleId))
            .ToListAsync(cancellationToken))
            .GroupBy(static body => body.ArticleId)
            .ToDictionary(static group => group.Key, static group => group.First().MarkdownContent ?? string.Empty);
        Dictionary<int, List<int>> tagIdsByArticleId = (await db.Queryable<ArticleTag>()
            .Where(it => ids.Contains(it.ArticleId))
            .ToListAsync(cancellationToken))
            .GroupBy(static tag => tag.ArticleId)
            .ToDictionary(
                static group => group.Key,
                static group => group.Select(static tag => tag.TagId).ToList());
        Dictionary<int, List<ArticleRevision>> revisionsByArticleId = (await db.Queryable<ArticleRevision>()
            .Where(it => ids.Contains(it.ArticleId))
            .OrderBy(it => it.ArticleId)
            .OrderBy(it => it.RevisionNo)
            .ToListAsync(cancellationToken))
            .GroupBy(static revision => revision.ArticleId)
            .ToDictionary(static group => group.Key, static group => group.ToList());
        await ArticleRevisionContentBlockStore.HydrateAsync(
            db,
            revisionsByArticleId.Values.SelectMany(static revisions => revisions).ToArray(),
            cancellationToken).ConfigureAwait(false);

        var exports = new List<ContentExportResponse>(articles.Count);
        int revisionCount = 0;
        foreach (Article article in articles)
        {
            bodyByArticleId.TryGetValue(article.Id, out string? content);
            tagIdsByArticleId.TryGetValue(article.Id, out List<int>? tagIds);
            revisionsByArticleId.TryGetValue(article.Id, out List<ArticleRevision>? revisions);
            tagIds ??= [];
            revisions ??= [];
            revisionCount += revisions.Count;

            ContentExportMetadataResponse metadata = BuildExportMetadata(article, tagIds, revisions);
            exports.Add(new ContentExportResponse(
                $"article-{article.Id}.md",
                BuildArticleExportMarkdown(article, content ?? string.Empty, metadata),
                metadata));
        }

        logger.LogInformation(
            "content-backup-export articleCount={ArticleCount} revisionCount={RevisionCount} dbCommandCount={DbCommandCount} elapsedMs={ElapsedMs}",
            exports.Count,
            revisionCount,
            4,
            stopwatch.ElapsedMilliseconds);
        return exports;
    }

    public async Task<ContentImportResponse> ImportArticleAsync(ContentImportRequest request, CancellationToken cancellationToken = default)
    {
        ParsedFrontmatter parsed = ParseFrontmatter(request.MarkdownWithFrontmatter);
        ArticleStatus status = request.Publish
            ? ArticleStatus.Published
            : parsed.Status ?? ArticleStatus.Draft;
        var createResult = await articleService.CreateAsync(new FsusBlog.Core.Services.Articles.CreateArticleCommand(
            new FsusBlog.Core.Mapping.Models.ArticleWriteRequestCoreModel(
                parsed.Title,
                parsed.Content,
                parsed.Summary,
                parsed.Cover,
                parsed.CategoryId,
                [.. parsed.TagIds],
                (int)status,
                status == ArticleStatus.Scheduled ? parsed.ScheduledPublishAt : null,
                Rights: null,
                RightsMutation: FsusBlog.Core.Mapping.Models.ArticleRightsMutationMode.Preserve)));
        int articleId = createResult.IsSuccess ? createResult.Value : 0;
        int restoredRevisionCount = articleId > 0 && request.PreserveRevisions
            ? await RestoreImportedRevisionsAsync(articleId, parsed.Metadata, cancellationToken)
            : 0;
        return new ContentImportResponse(articleId, restoredRevisionCount);
    }

    public AiAssistResponse GenerateAiAssist(int actorUserId, AiAssistRequest request)
    {
        bool enabled = configuration.GetValue<bool>("Authoring:AiAssist:Enabled");
        string provider = NormalizeAiAssistProvider(configuration["Authoring:AiAssist:Provider"]);
        bool allowExternal = configuration.GetValue<bool>("Authoring:AiAssist:AllowExternalProvider");
        bool externalReviewed = configuration.GetValue<bool>("Authoring:AiAssist:ExternalProviderReviewed");
        bool externalProviderAllowed = enabled
            && !string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase)
            && allowExternal
            && externalReviewed;
        string providerMode = ResolveAiAssistProviderMode(enabled, provider, allowExternal, externalReviewed);
        string operation = NormalizeAiAssistOperation(request.Operation);
        string clean = ImageHelper.StripMarkdown(request.Content ?? string.Empty, 240);
        IReadOnlyList<PrepublishIssue> issues = prepublishPolicy.RunPrepublishCheck(request.Title, request.Content ?? string.Empty, clean, null).Issues;
        string auditTarget = $"operation={operation};provider={provider};mode={providerMode};externalAllowed={externalProviderAllowed};locale={TextHelpers.NormalizeNullable(request.Locale, 24) ?? "default"}";
        auditWriter.Write(AuditSourceCatalog.Article, "author-ai-assist", actorUserId, auditTarget);
        return new AiAssistResponse(
            enabled,
            providerMode,
            externalProviderAllowed,
            "author-ai-assist",
            clean.Length <= 160 ? clean : string.Concat(clean.AsSpan(0, 160), "..."),
            SuggestTags(request.Content),
            enabled ? [$"{request.Title}：实践记录", $"{request.Title} 的关键问题"] : [],
            BuildTranslationDraft(request.Content, request.Locale, externalProviderAllowed),
            issues);
    }

    public AiAssistResponse GenerateAiAssist(AiAssistRequest request)
        => GenerateAiAssist(0, request);


    private static string NormalizeAiAssistProvider(string? raw)
    {
        string value = AuthoringNormalization.Normalize(raw, 32).ToLowerInvariant();
        return value.Length == 0 ? "local" : value;
    }

    private static string NormalizeAiAssistOperation(string? raw)
    {
        string value = AuthoringNormalization.Normalize(raw, 48).ToLowerInvariant();
        return value.Length == 0 ? "summary-tags-structure" : value;
    }

    private static string ResolveAiAssistProviderMode(
        bool enabled,
        string provider,
        bool allowExternal,
        bool externalReviewed)
    {
        if (!enabled)
        {
            return "disabled-local-fallback";
        }

        if (string.Equals(provider, "local", StringComparison.OrdinalIgnoreCase))
        {
            return "local";
        }

        return allowExternal && externalReviewed
            ? "external-configured"
            : "external-blocked-review-required";
    }

    private static string BuildTranslationDraft(string? content, string? locale, bool externalProviderAllowed)
    {
        if (!externalProviderAllowed)
        {
            return string.Empty;
        }

        string targetLocale = TextHelpers.NormalizeNullable(locale, 24) ?? "target-locale";
        string clean = ImageHelper.StripMarkdown(content ?? string.Empty, 800);
        return clean.Length == 0
            ? string.Empty
            : $"<!-- translation-target:{targetLocale} -->\n\n{clean}";
    }


    private static IReadOnlyList<string> SuggestTags(string? content)
    {
        string value = content ?? string.Empty;
        var tags = new List<string>(3);
        if (value.Contains("AOT", StringComparison.OrdinalIgnoreCase))
            tags.Add("AOT");
        if (value.Contains("WASM", StringComparison.OrdinalIgnoreCase))
            tags.Add("Wasm");
        if (value.Contains("security", StringComparison.OrdinalIgnoreCase) || value.Contains("安全", StringComparison.OrdinalIgnoreCase))
            tags.Add("安全");
        return tags.Count == 0 ? ["写作"] : tags;
    }

    private async Task<List<int>> LoadArticleTagIdsAsync(int articleId, CancellationToken cancellationToken)
        => await db.Queryable<ArticleTag>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.TagId)
            .ToListAsync(cancellationToken);

    private static ContentExportMetadataResponse BuildExportMetadata(
        Article article,
        IReadOnlyList<int> tagIds,
        IReadOnlyList<ArticleRevision> revisions)
        => new(
            article.Id,
            article.CategoryId,
            [.. tagIds.Where(static id => id > 0).Distinct().OrderBy(static id => id)],
            article.Status,
            article.ScheduledPublishAt,
            article.CoverImageUrl,
            revisions.Count,
            revisions.Select(static revision => new ContentRevisionExportResponse(
                revision.RevisionNo,
                revision.Title,
                revision.MarkdownContent,
                revision.Summary,
                revision.CoverImageUrl,
                revision.CategoryId,
                AuthoringNormalization.ParseTagIds(revision.TagIds),
                revision.DiffSummary,
                revision.CreatedAt)).ToArray());

    internal static string BuildArticleExportMarkdown(Article article, string content, ContentExportMetadataResponse metadata)
    {
        string encodedMetadata = EncodeExportMetadata(metadata);
        string scheduled = article.ScheduledPublishAt?.ToString("O", System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
        string tagIds = string.Join(',', metadata.TagIds);
        return $"""
---
fsusFormat: content-export-v1
sourceArticleId: {article.Id}
title: {EscapeFrontmatterValue(article.Title)}
summary: {EscapeFrontmatterValue(article.Summary)}
cover: {EscapeFrontmatterValue(article.CoverImageUrl)}
categoryId: {article.CategoryId}
status: {(int)article.Status}
scheduledPublishAt: {scheduled}
tagIds: {tagIds}
revisionCount: {metadata.RevisionCount}
fsusMetadataJson: {encodedMetadata}
---

{content ?? string.Empty}
""";
    }

    internal static string EncodeExportMetadata(ContentExportMetadataResponse metadata)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(metadata);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    internal static ContentExportMetadataResponse? TryDecodeExportMetadata(string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded))
        {
            return null;
        }

        string value = encoded.Trim().Replace('-', '+').Replace('_', '/');
        int padding = (4 - value.Length % 4) % 4;
        value = padding == 0 ? value : value.PadRight(value.Length + padding, '=');
        byte[] buffer = new byte[value.Length];
        if (!Convert.TryFromBase64String(value, buffer, out int bytesWritten))
        {
            return null;
        }

        return JsonDecodeHelper.DeserializeOrNull<ContentExportMetadataResponse>(buffer.AsSpan(0, bytesWritten));
    }

    internal static ParsedFrontmatter ParseFrontmatter(string raw)
    {
        string content = raw ?? string.Empty;
        string title = "Imported Article";
        string? summary = null;
        string? cover = null;
        int categoryId = 1;
        ArticleStatus? status = null;
        DateTime? scheduledPublishAt = null;
        List<int> tagIds = [];
        ContentExportMetadataResponse? metadata = null;

        if (content.StartsWith("---", StringComparison.Ordinal))
        {
            int end = content.IndexOf("\n---", 3, StringComparison.Ordinal);
            if (end > 0)
            {
                string frontmatter = content[3..end];
                content = content[(end + 4)..].TrimStart();
                var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string line in frontmatter.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    int separator = line.IndexOf(':');
                    if (separator <= 0)
                        continue;
                    string key = line[..separator].Trim();
                    string value = line[(separator + 1)..].Trim();
                    values[key] = value;
                }

                if (values.TryGetValue("fsusMetadataJson", out string? encodedMetadata))
                {
                    metadata = TryDecodeExportMetadata(encodedMetadata);
                }

                if (values.TryGetValue("title", out string? rawTitle) && !string.IsNullOrWhiteSpace(rawTitle))
                    title = rawTitle;
                if (values.TryGetValue("summary", out string? rawSummary))
                    summary = TextHelpers.NormalizeNullable(rawSummary, 512);
                if (values.TryGetValue("cover", out string? rawCover))
                    cover = TextHelpers.NormalizeNullable(rawCover, 512);
                if (values.TryGetValue("categoryId", out string? rawCategory) && int.TryParse(rawCategory, out int parsedCategory))
                    categoryId = Math.Max(1, parsedCategory);
                if (values.TryGetValue("status", out string? rawStatus) && int.TryParse(rawStatus, out int parsedStatus) && ArticleStatusProjection.IsDefined(parsedStatus))
                    status = (ArticleStatus)parsedStatus;
                if (values.TryGetValue("scheduledPublishAt", out string? rawScheduled)
                    && DateTime.TryParse(
                        rawScheduled,
                        System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out DateTime parsedScheduled))
                {
                    scheduledPublishAt = parsedScheduled;
                }
                if (values.TryGetValue("tagIds", out string? rawTagIds))
                    tagIds = AuthoringNormalization.ParseTagIds(rawTagIds);
            }
        }

        if (metadata is not null)
        {
            categoryId = Math.Max(1, metadata.CategoryId);
            tagIds = [.. metadata.TagIds.Where(static id => id > 0).Distinct().OrderBy(static id => id)];
            status ??= metadata.Status;
            scheduledPublishAt ??= metadata.ScheduledPublishAt;
            cover ??= metadata.CoverImageUrl;
        }

        return new ParsedFrontmatter(title, summary, cover, Math.Max(1, categoryId), tagIds, status, scheduledPublishAt, metadata, content);
    }

    private async Task<int> RestoreImportedRevisionsAsync(int articleId, ContentExportMetadataResponse? metadata, CancellationToken cancellationToken)
    {
        if (metadata?.Revisions is null || metadata.Revisions.Count == 0)
        {
            return 0;
        }

        var revisions = metadata.Revisions
            .OrderBy(static revision => revision.RevisionNo)
            .Select(revision => new ArticleRevision
            {
                ArticleId = articleId,
                RevisionNo = Math.Max(1, revision.RevisionNo),
                Title = AuthoringNormalization.Normalize(revision.Title, 256),
                Summary = TextHelpers.NormalizeNullable(revision.Summary, 512),
                CoverImageUrl = TextHelpers.NormalizeNullable(revision.CoverImageUrl, 512),
                CategoryId = Math.Max(1, revision.CategoryId),
                TagIds = string.Join(',', AuthoringNormalization.NormalizeTagIds(revision.TagIds)),
                MarkdownContent = AuthoringNormalization.Normalize(revision.Content, 200_000),
                DiffSummary = AuthoringNormalization.Normalize(revision.DiffSummary, 512),
                CreatedByAdminPrincipalId = 0,
                CreatedAt = revision.CreatedAt == default ? DateTime.UtcNow : revision.CreatedAt
            })
            .ToList();
        if (revisions.Count == 0)
        {
            return 0;
        }

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT 1
                FROM article
                WHERE id = @ArticleId
                FOR UPDATE;
                """,
                new SugarParameter("@ArticleId", articleId)))
            {
                if (!await reader.ReadAsync(cancellationToken))
                {
                    throw new InvalidOperationException("Article must exist before restoring imported revisions.");
                }
            }

            await db.Deleteable<ArticleRevision>().Where(it => it.ArticleId == articleId).ExecuteCommandAsync(cancellationToken);
            foreach (ArticleRevision revision in revisions)
            {
                revision.ContentBlockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
                    db,
                    revision.MarkdownContent,
                    revision.CreatedAt,
                    cancellationToken).ConfigureAwait(false);
                revision.MarkdownContent = string.Empty;
            }
            await db.Insertable(revisions).ExecuteCommandAsync(cancellationToken);
            ArticleMutationOutboxEvent outbox = await ArticleMutationOutboxProducer.CreateCurrentAsync(
                db, articleId, ArticleMutationEventTypes.Updated, DateTime.UtcNow, cancellationToken)
                .ConfigureAwait(false);
            await db.Insertable(outbox).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken).ConfigureAwait(false);
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Imported revision restore failed.", transaction.ErrorException);
        }

        return revisions.Count;
    }

    private static string EscapeFrontmatterValue(string? raw)
    {
        string value = (raw ?? string.Empty).Replace("\r", " ", StringComparison.Ordinal).Replace("\n", " ", StringComparison.Ordinal).Trim();
        return value.Length > 512 ? value[..512] : value;
    }

    internal readonly record struct ParsedFrontmatter(
        string Title,
        string? Summary,
        string? Cover,
        int CategoryId,
        IReadOnlyList<int> TagIds,
        ArticleStatus? Status,
        DateTime? ScheduledPublishAt,
        ContentExportMetadataResponse? Metadata,
        string Content);
}

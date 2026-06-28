using System.Net;
using System.Data.Common;
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
using System.Globalization;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Services.Authoring;

public sealed class AuthoringWorkflowService(
    ISqlSugarClient db,
    IArticleService articleService,
    IContentFilterService contentFilter,
    IBlacklistService blacklistService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IMessageRealtimePublisher messageRealtimePublisher,
    IMessageCommandService messageCommandService,
    AuditLogChannel auditLogChannel,
    IConfiguration configuration,
    ILogger<AuthoringWorkflowService> logger)
{
    private const int MaxDraftKeyLength = 96;
    private const int PreviewLength = 24_000;
    private const int WarningOverrideReasonLength = 180;
    private static int assetArticleReferenceStoreEnsured;

    public async Task<ServerDraftResponse> SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest request, CancellationToken cancellationToken = default)
    {
        string draftKey = NormalizeDraftKey(request.DraftKey, request.ArticleId);
        string tagIds = string.Join(',', NormalizeTagIds(request.TagIds));
        DateTime now = DateTime.UtcNow;
        var draft = new ArticleDraft
        {
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            DraftKey = draftKey,
            ArticleId = request.ArticleId,
            Title = Normalize(request.Title, 256),
            Summary = NormalizeNullable(request.Summary, 512),
            CoverImageUrl = NormalizeNullable(request.CoverImageUrl, 512),
            CategoryId = Math.Max(0, request.CategoryId),
            TagIds = tagIds,
            MarkdownContent = Normalize(request.Content, 200_000),
            Status = NormalizeArticleStatus(request.Status),
            ClientRevision = NormalizeNullable(request.ClientRevision, 64),
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

        bool updated = await articleService.UpdateAsync(articleId, new UpdateArticleRequest
        {
            Title = revision.Title,
            Content = revision.MarkdownContent,
            Summary = revision.Summary,
            CoverImageUrl = revision.CoverImageUrl,
            CategoryId = revision.CategoryId,
            TagIds = ParseTagIds(revision.TagIds),
            Status = ArticleStatus.Published
        });
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

    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ReindexAssetsAsync(int articleId, CancellationToken cancellationToken = default)
    {
        bool articleExists = await db.Queryable<Article>()
            .ClearFilter()
            .Where(it => it.Id == articleId)
            .AnyAsync(cancellationToken);
        if (!articleExists)
        {
            return await ListAssetsAsync(cancellationToken);
        }

        await ReindexArticleAssetsAsync(articleId, cancellationToken);
        return await ListAssetsAsync(cancellationToken);
    }

    public async Task<AssetCleanupResponse> CleanupOrphanAssetsAsync(CancellationToken cancellationToken = default)
    {
        int deleted = await db.Deleteable<AssetLibraryItem>()
            .Where(it => it.ReferenceCount <= 0)
            .ExecuteCommandAsync(cancellationToken);
        return new AssetCleanupResponse(deleted);
    }

    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ListAssetsAsync(CancellationToken cancellationToken = default)
        => (await db.Queryable<AssetLibraryItem>()
            .OrderByDescending(it => it.UpdatedAt)
            .Take(100)
            .ToListAsync(cancellationToken))
            .Select(ToAssetResponse)
            .ToArray();

    private async Task ReindexArticleAssetsAsync(int articleId, CancellationToken cancellationToken)
    {
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireAssetLibraryRebuildLockAsync(cancellationToken).ConfigureAwait(false);
            await EnsureAssetArticleReferenceStoreAsync(cancellationToken).ConfigureAwait(false);
            DateTime now = DateTime.UtcNow;

            Article? article = await db.Queryable<Article>()
                .ClearFilter()
                .Where(it => it.Id == articleId)
                .FirstAsync(cancellationToken);
            string markdown = await db.Queryable<ArticleBody>()
                .Where(it => it.ArticleId == articleId)
                .Select(it => it.MarkdownContent)
                .FirstAsync(cancellationToken) ?? string.Empty;

            Dictionary<string, AssetReferenceAggregate> currentAssets = BuildArticleAssetReferences(articleId, markdown, article?.CoverImageUrl);
            List<AssetArticleReferenceRow> previousRefs = await LoadArticleAssetReferencesForUpdateAsync(articleId, cancellationToken)
                .ConfigureAwait(false);
            HashSet<string> touchedUrls = new(StringComparer.OrdinalIgnoreCase);
            foreach (string url in currentAssets.Keys)
            {
                touchedUrls.Add(url);
            }

            foreach (AssetArticleReferenceRow previous in previousRefs)
            {
                touchedUrls.Add(previous.Url);
                if (!currentAssets.ContainsKey(previous.Url))
                {
                    await DeleteAssetArticleReferenceAsync(articleId, previous.Url, cancellationToken).ConfigureAwait(false);
                }
            }

            foreach (AssetReferenceAggregate asset in currentAssets.Values)
            {
                await UpsertAssetArticleReferenceAsync(asset, now, cancellationToken).ConfigureAwait(false);
            }

            await RefreshAssetLibraryItemsForUrlsAsync(touchedUrls, now, cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Article asset reindex failed.", transaction.ErrorException);
        }
    }

    private async Task RebuildAssetLibraryAsync(CancellationToken cancellationToken)
    {
        await EnsureAssetArticleReferenceStoreAsync(cancellationToken).ConfigureAwait(false);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireAssetLibraryRebuildLockAsync(cancellationToken);
            DateTime now = DateTime.UtcNow;
            List<ArticleBody> bodies = await db.Queryable<ArticleBody>().ToListAsync(cancellationToken);
            List<int> articleIds = [.. bodies.Select(static body => body.ArticleId).Distinct()];
            List<Article> articles = articleIds.Count == 0
                ? []
                : await db.Queryable<Article>()
                    .ClearFilter()
                    .Where(it => articleIds.Contains(it.Id))
                    .ToListAsync(cancellationToken);
            Dictionary<int, Article> articleById = articles.ToDictionary(static article => article.Id);
            var assets = new Dictionary<string, AssetReferenceAggregate>(StringComparer.OrdinalIgnoreCase);
            var articleAssetReferences = new List<AssetReferenceAggregate>();

            foreach (ArticleBody body in bodies)
            {
                articleById.TryGetValue(body.ArticleId, out Article? article);
                Dictionary<string, AssetReferenceAggregate> articleAssets = BuildArticleAssetReferences(body.ArticleId, body.MarkdownContent, article?.CoverImageUrl);
                foreach (AssetReferenceAggregate articleAsset in articleAssets.Values)
                {
                    articleAssetReferences.Add(articleAsset);
                    MergeAssetReference(assets, articleAsset);
                }
            }

            List<AssetLibraryItem> existingAssets = await LoadAssetLibraryForUpdateAsync(cancellationToken);
            Dictionary<string, AssetLibraryItem> existingAssetsByUrl = existingAssets
                .GroupBy(static item => item.Url, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(static group => group.Key, static group => group.First(), StringComparer.OrdinalIgnoreCase);
            HashSet<string> activeUrls = [.. assets.Keys];
            await db.Ado.ExecuteCommandAsync("DELETE FROM asset_library_article_ref;").ConfigureAwait(false);
            foreach (AssetReferenceAggregate articleAsset in articleAssetReferences)
            {
                await UpsertAssetArticleReferenceAsync(articleAsset, now, cancellationToken).ConfigureAwait(false);
            }

            foreach (AssetReferenceAggregate asset in assets.Values)
            {
                existingAssetsByUrl.TryGetValue(asset.Url, out AssetLibraryItem? existing);
                if (existing is null)
                {
                    await InsertAssetAsync(asset, now, cancellationToken);
                    continue;
                }

                await UpdateAssetAsync(existing, asset, now, cancellationToken);
            }

            foreach (AssetLibraryItem orphan in existingAssets.Where(item => !activeUrls.Contains(item.Url) && item.ReferenceCount != 0))
            {
                await MarkAssetOrphanAsync(orphan.Id, now, cancellationToken);
            }
        });

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Asset library rebuild failed.", transaction.ErrorException);
        }
    }

    private async Task AcquireAssetLibraryRebuildLockAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT pg_advisory_xact_lock(785);");
        await reader.ReadAsync(cancellationToken);
    }

    private async Task<List<AssetLibraryItem>> LoadAssetLibraryForUpdateAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, url, alt_text, source_article_id, width, height, sha256, reference_count, created_at, updated_at
            FROM asset_library_item
            ORDER BY id
            FOR UPDATE;
            """);
        var assets = new List<AssetLibraryItem>();
        while (await reader.ReadAsync(cancellationToken))
        {
            assets.Add(new AssetLibraryItem
            {
                Id = reader.GetInt64(0),
                Url = reader.GetString(1),
                AltText = reader.IsDBNull(2) ? null : reader.GetString(2),
                SourceArticleId = reader.IsDBNull(3) ? null : reader.GetInt32(3),
                Width = reader.IsDBNull(4) ? null : reader.GetInt32(4),
                Height = reader.IsDBNull(5) ? null : reader.GetInt32(5),
                Sha256 = reader.IsDBNull(6) ? null : reader.GetString(6),
                ReferenceCount = reader.GetInt32(7),
                CreatedAt = reader.GetDateTime(8),
                UpdatedAt = reader.GetDateTime(9)
            });
        }

        return assets;
    }

    private async Task EnsureAssetArticleReferenceStoreAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref assetArticleReferenceStoreEnsured) == 1)
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE IF NOT EXISTS asset_library_article_ref (
                url varchar(512) NOT NULL,
                article_id integer NOT NULL,
                alt_text varchar(256) NULL,
                reference_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                PRIMARY KEY (url, article_id)
            );

            CREATE INDEX IF NOT EXISTS idx_asset_library_article_ref_article
            ON asset_library_article_ref(article_id);
            """).ConfigureAwait(false);
        Volatile.Write(ref assetArticleReferenceStoreEnsured, 1);
    }

    private async Task<List<AssetArticleReferenceRow>> LoadArticleAssetReferencesForUpdateAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT url, article_id, alt_text, reference_count
            FROM asset_library_article_ref
            WHERE article_id = @ArticleId
            FOR UPDATE;
            """,
            new SugarParameter("@ArticleId", articleId));
        var rows = new List<AssetArticleReferenceRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new AssetArticleReferenceRow(
                reader.GetString(0),
                reader.GetInt32(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.GetInt32(3)));
        }

        return rows;
    }

    private async Task UpsertAssetArticleReferenceAsync(AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO asset_library_article_ref
                (url, article_id, alt_text, reference_count, updated_at_utc)
            VALUES
                (@Url, @ArticleId, @AltText, @ReferenceCount, @UpdatedAtUtc)
            ON CONFLICT (url, article_id) DO UPDATE
            SET alt_text = EXCLUDED.alt_text,
                reference_count = EXCLUDED.reference_count,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@Url", asset.Url),
            new SugarParameter("@ArticleId", asset.SourceArticleId),
            new SugarParameter("@AltText", DbValue(asset.AltText)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
    }

    private async Task DeleteAssetArticleReferenceAsync(int articleId, string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM asset_library_article_ref
            WHERE article_id = @ArticleId
              AND lower(url) = lower(@Url);
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Url", url)).ConfigureAwait(false);
    }

    private async Task RefreshAssetLibraryItemsForUrlsAsync(IReadOnlyCollection<string> urls, DateTime now, CancellationToken cancellationToken)
    {
        foreach (string url in urls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AssetReferenceAggregate? aggregate = await LoadAssetReferenceAggregateAsync(url, cancellationToken).ConfigureAwait(false);
            if (aggregate is null)
            {
                await MarkAssetOrphanByUrlAsync(url, now, cancellationToken).ConfigureAwait(false);
                continue;
            }

            AssetLibraryItem? existing = await LoadAssetLibraryItemByUrlForUpdateAsync(url, cancellationToken).ConfigureAwait(false);
            if (existing is null)
            {
                await InsertAssetAsync(aggregate, now, cancellationToken).ConfigureAwait(false);
                continue;
            }

            await UpdateAssetAsync(existing, aggregate, now, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<AssetReferenceAggregate?> LoadAssetReferenceAggregateAsync(string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                url,
                MIN(article_id) AS source_article_id,
                MAX(alt_text) FILTER (WHERE alt_text IS NOT NULL AND alt_text <> '') AS alt_text,
                SUM(reference_count)::integer AS reference_count
            FROM asset_library_article_ref
            WHERE lower(url) = lower(@Url)
            GROUP BY url;
            """,
            new SugarParameter("@Url", url));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var aggregate = new AssetReferenceAggregate(reader.GetString(0), reader.GetInt32(1))
        {
            AltText = reader.IsDBNull(2) ? null : reader.GetString(2),
            ReferenceCount = reader.GetInt32(3)
        };
        return aggregate;
    }

    private async Task<AssetLibraryItem?> LoadAssetLibraryItemByUrlForUpdateAsync(string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, url, alt_text, source_article_id, width, height, sha256, reference_count, created_at, updated_at
            FROM asset_library_item
            WHERE lower(url) = lower(@Url)
            ORDER BY id
            LIMIT 1
            FOR UPDATE;
            """,
            new SugarParameter("@Url", url));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new AssetLibraryItem
        {
            Id = reader.GetInt64(0),
            Url = reader.GetString(1),
            AltText = reader.IsDBNull(2) ? null : reader.GetString(2),
            SourceArticleId = reader.IsDBNull(3) ? null : reader.GetInt32(3),
            Width = reader.IsDBNull(4) ? null : reader.GetInt32(4),
            Height = reader.IsDBNull(5) ? null : reader.GetInt32(5),
            Sha256 = reader.IsDBNull(6) ? null : reader.GetString(6),
            ReferenceCount = reader.GetInt32(7),
            CreatedAt = reader.GetDateTime(8),
            UpdatedAt = reader.GetDateTime(9)
        };
    }

    private async Task InsertAssetAsync(AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO asset_library_item
                (url, alt_text, source_article_id, sha256, reference_count, created_at, updated_at)
            VALUES
                (@Url, @AltText, @SourceArticleId, @Sha256, @ReferenceCount, @Now, @Now);
            """,
            new SugarParameter("@Url", asset.Url),
            new SugarParameter("@AltText", DbValue(asset.AltText)),
            new SugarParameter("@SourceArticleId", asset.SourceArticleId),
            new SugarParameter("@Sha256", HashText(asset.Url)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@Now", now));
    }

    private async Task UpdateAssetAsync(AssetLibraryItem existing, AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET alt_text = COALESCE(@AltText, alt_text),
                source_article_id = COALESCE(source_article_id, @SourceArticleId),
                sha256 = COALESCE(sha256, @Sha256),
                reference_count = @ReferenceCount,
                updated_at = @UpdatedAt
            WHERE id = @Id;
            """,
            new SugarParameter("@Id", existing.Id),
            new SugarParameter("@AltText", DbValue(asset.AltText)),
            new SugarParameter("@SourceArticleId", asset.SourceArticleId),
            new SugarParameter("@Sha256", HashText(asset.Url)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@UpdatedAt", now));
    }

    private async Task MarkAssetOrphanAsync(long assetId, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET reference_count = 0,
                updated_at = @UpdatedAt
            WHERE id = @Id
              AND reference_count <> 0;
            """,
            new SugarParameter("@Id", assetId),
            new SugarParameter("@UpdatedAt", now));
    }

    private async Task MarkAssetOrphanByUrlAsync(string url, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET reference_count = 0,
                updated_at = @UpdatedAt
            WHERE lower(url) = lower(@Url)
              AND reference_count <> 0;
            """,
            new SugarParameter("@Url", url),
            new SugarParameter("@UpdatedAt", now)).ConfigureAwait(false);
    }

    public async Task<AuthorAnalyticsResponse> GetAnalyticsAsync(CancellationToken cancellationToken = default)
    {
        int published = await db.Queryable<Article>().Where(it => !it.IsDeleted && it.Status == ArticleStatus.Published).CountAsync(cancellationToken);
        int draft = await db.Queryable<Article>().Where(it => !it.IsDeleted && it.Status == ArticleStatus.Draft).CountAsync(cancellationToken);
        int scheduled = await db.Queryable<Article>().Where(it => !it.IsDeleted && it.Status == ArticleStatus.Scheduled).CountAsync(cancellationToken);
        int archived = await db.Queryable<Article>().Where(it => !it.IsDeleted && it.Status == ArticleStatus.Archived).CountAsync(cancellationToken);
        int reads = await db.Queryable<VisitLogEntity>().Where(it => it.EventType == HumanReadEventTypes.ArticleRead || it.EventType == HumanReadEventTypes.SiteRead).CountAsync(cancellationToken);
        List<VisitLogEntity> recentReads = await db.Queryable<VisitLogEntity>()
            .Where(it => it.EventType == HumanReadEventTypes.ArticleRead || it.EventType == HumanReadEventTypes.SiteRead)
            .OrderByDescending(it => it.CreateTime)
            .Take(5_000)
            .ToListAsync(cancellationToken);

        int averageDwellMs = recentReads.Count == 0
            ? 0
            : RoundingHelper.RoundToInt(recentReads.Average(static item => Math.Max(0, item.DwellMs)));
        VisitLogEntity[] articleReads = [.. recentReads.Where(static item => item.EventType == HumanReadEventTypes.ArticleRead)];
        double readingCompletionRate = articleReads.Length == 0
            ? 0d
            : RoundingHelper.Round4(articleReads.Count(static item => item.DwellMs >= 30_000) / (double)articleReads.Length);

        List<AuditLog> recentAotLogs = await db.Queryable<AuditLog>()
            .Where(it => it.Source == AuditSourceCatalog.PublicAot)
            .OrderByDescending(it => it.OccurredAtUtc)
            .Take(2_000)
            .ToListAsync(cancellationToken);
        List<RumMetricAuditContext> recentRumMetrics = [.. (await db.Queryable<FrontendRumMetric>()
            .OrderByDescending(it => it.OccurredAtUtc)
            .Take(5_000)
            .ToListAsync(cancellationToken))
            .Select(TryReadRumMetric)
            .OfType<RumMetricAuditContext>()];
        int aotMisses = recentAotLogs.Count(static item => item.EventInfo.Contains("Public AOT cache miss", StringComparison.OrdinalIgnoreCase));
        double aotHitRate = reads <= 0
            ? 0d
            : RoundingHelper.Round4(Math.Clamp((reads - aotMisses) / (double)reads, 0d, 1d));

        return new AuthorAnalyticsResponse(
            published,
            draft,
            scheduled,
            archived,
            reads,
            published,
            aotHitRate,
            averageDwellMs,
            readingCompletionRate,
            BuildRankedMetrics(recentReads.Select(static item => TryExtractSearchKeyword(item.RouteKey))),
            BuildRankedMetrics(recentReads.Select(static item => NormalizeAnalyticsRouteKey(item.RouteKey))),
            BuildRankedMetrics(recentReads.Select(static item => TryExtractNotFoundPath(item.RouteKey))),
            BuildRumMetricSummaries(recentRumMetrics),
            BuildRankedMetrics(recentRumMetrics.Select(static item => item.PageType)),
            BuildRankedMetrics(recentRumMetrics.Select(static item => item.AotSource)));
    }

    public async Task<CommentModerationQueueResponse> ListCommentModerationQueueAsync(
        CommentModerationStatus? status = null,
        int limit = 50,
        CancellationToken cancellationToken = default)
    {
        CommentModerationStatus resolvedStatus = status ?? CommentModerationStatus.Pending;
        int normalizedLimit = Math.Clamp(limit, 1, 100);
        List<CommentModerationQueueRow> rows = await db.Queryable<Comment, Article, CommentRegionCompliance>((c, a, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.Id == rc.CommentId
            })
            .Where((c, a, rc) => c.ModerationStatus == resolvedStatus && !c.IsDeleted)
            .OrderByDescending((c, a, rc) => c.CreateTime)
            .Take(normalizedLimit)
            .Select((c, a, rc) => new CommentModerationQueueRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                ModerationSubjectHash = c.ModerationSubjectHash,
                AnonymousNullifierHash = c.AnonymousNullifierHash,
                AnonymousScope = c.AnonymousScope,
                CredentialLevel = c.CredentialLevel,
                ReputationBucket = c.ReputationBucket,
                AccountAgeBucket = c.AccountAgeBucket,
                Content = c.Content,
                CreateTime = c.CreateTime,
                Status = c.ModerationStatus,
                Reason = c.ModerationReason,
                ModeratedByAdminPrincipalId = c.ModeratedByAdminPrincipalId,
                ModeratedAt = c.ModeratedAt,
                RegionComplianceId = rc.Id,
                SubmitRegion = rc.SubmitRegion,
                SubmitRegionConfidence = rc.SubmitRegionConfidence,
                BlockedRegions = rc.BlockedRegions,
                RegionPolicyVersion = rc.PolicyVersion,
                RegionDecisionReason = rc.DecisionReason,
                RegionRiskLabels = rc.RiskLabels,
                RegionCanPublish = rc.CanPublish,
                RegionRequiresManualReview = rc.RequiresManualReview,
                RegionHideUntilReviewed = rc.HideUntilReviewed
            })
            .ToListAsync(cancellationToken);
        await LoadAnonymousNullifierSummariesAsync(rows, cancellationToken);
        IReadOnlyDictionary<long, CommentModerationModelSignalResponse> latestSignals = await LoadLatestModelSignalsAsync(rows, cancellationToken);
        foreach (CommentModerationQueueRow row in rows)
        {
            if (latestSignals.TryGetValue(row.Id, out CommentModerationModelSignalResponse? signal))
            {
                row.ModelSignals = [signal];
            }
        }

        int pending = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Pending && !item.IsDeleted).CountAsync(cancellationToken);
        int rejected = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Rejected && !item.IsDeleted).CountAsync(cancellationToken);
        int hidden = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Hidden && !item.IsDeleted).CountAsync(cancellationToken);

        return new CommentModerationQueueResponse(
            rows.Select(ToCommentModerationItem).ToArray(),
            pending,
            rejected,
            hidden);
    }

    public async Task<bool> ModerateCommentAsync(long actorAdminPrincipalId, long commentId, CommentModerationRequest request, CancellationToken cancellationToken = default)
    {
        if (commentId <= 0 || !IsValidModerationStatus(request.Status))
        {
            return false;
        }

        CommentModerationStateRow? current = await LoadCommentModerationStateAsync(commentId, cancellationToken);
        if (current is null || !IsAllowedModerationTransition(current.Status, request.Status))
        {
            return false;
        }

        if (request.Status == CommentModerationStatus.Approved && !IsRegionApprovalAllowed(current))
        {
            return false;
        }

        DateTime moderatedAt = DateTime.UtcNow;
        string? normalizedReason = NormalizeNullable(request.Reason, 256);
        int count = await db.Updateable<Comment>()
            .SetColumns(it => it.ModerationStatus == request.Status)
            .SetColumns(it => it.ModerationReason == normalizedReason)
            .SetColumns(it => it.ModeratedByAdminPrincipalId == actorAdminPrincipalId)
            .SetColumns(it => it.ModeratedAt == moderatedAt)
            .Where(it => it.Id == commentId && !it.IsDeleted && it.ModerationStatus == current.Status)
            .ExecuteCommandAsync(cancellationToken);
        if (count > 0)
        {
            int banned = request.BanUser && ShouldLinkBan(request.Status)
                ? await BanModerationUsersAsync([commentId], request.Reason, cancellationToken)
                : 0;
            await InvalidateModeratedCommentAsync(current, request.Status, cancellationToken);
            await PublishModerationRealtimeAsync(current, request.Status, moderatedAt);
            WriteAudit(
                AuditSourceCatalog.Comment,
                "comment-moderation",
                actorAdminPrincipalId,
                $"comment:{commentId.ToString(System.Globalization.CultureInfo.InvariantCulture)};from={(int)current.Status};to={(int)request.Status};ban={banned}");
        }

        return count > 0;
    }

    public async Task<CommentModerationBulkResponse> ModerateCommentsAsync(
        long actorAdminPrincipalId,
        CommentModerationBulkRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidModerationStatus(request.Status))
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        long[] ids = [.. (request.CommentIds ?? [])
            .Select(static id => long.TryParse(id, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long parsed) ? parsed : 0)
            .Where(static id => id > 0)
            .Distinct()
            .Take(100)];
        if (ids.Length == 0)
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        List<CommentModerationStateRow> rows = await LoadCommentModerationStatesAsync(ids, cancellationToken);
        var eligibleRows = new List<CommentModerationStateRow>(rows.Count);
        DateTime moderatedAt = DateTime.UtcNow;
        string? normalizedReason = NormalizeNullable(request.Reason, 256);
        foreach (CommentModerationStateRow row in rows)
        {
            if (!IsAllowedModerationTransition(row.Status, request.Status))
            {
                continue;
            }

            if (request.Status == CommentModerationStatus.Approved && !IsRegionApprovalAllowed(row))
            {
                continue;
            }

            eligibleRows.Add(row);
        }

        if (eligibleRows.Count == 0)
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        var updatedRows = new List<CommentModerationStateRow>(eligibleRows.Count);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            foreach (CommentModerationStateRow row in eligibleRows)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int affected = await db.Updateable<Comment>()
                    .SetColumns(it => it.ModerationStatus == request.Status)
                    .SetColumns(it => it.ModerationReason == normalizedReason)
                    .SetColumns(it => it.ModeratedByAdminPrincipalId == actorAdminPrincipalId)
                    .SetColumns(it => it.ModeratedAt == moderatedAt)
                    .Where(it => it.Id == row.Id && !it.IsDeleted && it.ModerationStatus == row.Status)
                    .ExecuteCommandAsync(cancellationToken);
                if (affected <= 0)
                {
                    throw new InvalidOperationException("Comment moderation bulk update conflicted.");
                }

                updatedRows.Add(row);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Comment moderation bulk update failed.", transaction.ErrorException);
        }

        foreach (CommentModerationStateRow row in updatedRows)
        {
            await InvalidateModeratedCommentAsync(row, request.Status, cancellationToken);
            await PublishModerationRealtimeAsync(row, request.Status, moderatedAt);
        }

        int updated = updatedRows.Count;
        long[] updatedIds = [.. updatedRows.Select(static row => row.Id)];
        int banned = updated > 0 && request.BanUsers && ShouldLinkBan(request.Status)
            ? await BanModerationUsersAsync(updatedIds, request.Reason, cancellationToken)
            : 0;

        if (updated > 0)
        {
            WriteAudit(
                AuditSourceCatalog.Comment,
                "comment-moderation-bulk",
                actorAdminPrincipalId,
                $"comments:{ids.Length};updated={updated};status={(int)request.Status};ban={banned}");
        }

        return new CommentModerationBulkResponse(updated, banned);
    }

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
        int articleId = await articleService.CreateAsync(new CreateArticleRequest
        {
            Title = parsed.Title,
            Content = parsed.Content,
            Summary = parsed.Summary,
            CoverImageUrl = parsed.Cover,
            CategoryId = parsed.CategoryId,
            TagIds = [.. parsed.TagIds],
            Status = status,
            ScheduledPublishAt = status == ArticleStatus.Scheduled ? parsed.ScheduledPublishAt : null
        });
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
        IReadOnlyList<PrepublishIssue> issues = RunPrepublishCheck(request.Title, request.Content ?? string.Empty, clean, null).Issues;
        string auditTarget = $"operation={operation};provider={provider};mode={providerMode};externalAllowed={externalProviderAllowed};locale={NormalizeNullable(request.Locale, 24) ?? "default"}";
        WriteAudit(AuditSourceCatalog.Article, "author-ai-assist", actorUserId, auditTarget);
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
            draft.UpdatedAt);

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

    private static AssetLibraryItemResponse ToAssetResponse(AssetLibraryItem item)
        => new(item.Id.ToString(CultureInfo.InvariantCulture), item.Url, item.AltText, item.SourceArticleId, item.ReferenceCount, item.Sha256, item.UpdatedAt);

    private CommentModerationItemResponse ToCommentModerationItem(CommentModerationQueueRow row)
    {
        CommentModerationModelSignalResponse? latestSignal = row.ModelSignals.FirstOrDefault();
        bool isAnonymousActor = IsAnonymousActor(row);
        string authorDisplayName = ResolveModerationAuthorDisplayName(row);
        string? nullifierHash = isAnonymousActor ? NormalizeNullable(row.AnonymousNullifierHash, 128) : null;
        return new CommentModerationItemResponse(
            row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            row.ArticleId,
            string.IsNullOrWhiteSpace(row.ArticleTitle) ? "未命名文章" : row.ArticleTitle,
            authorDisplayName,
            row.Content,
            row.CreateTime,
            row.Status,
            row.Reason,
            row.ModeratedByAdminPrincipalId,
            row.ModeratedAt,
            IsModelAutoModerated(row),
            ResolveModerationActor(row),
            [.. DetectCommentHitReasons(row.Content, row.Reason)
                .Concat(ParseCommaList(row.RegionRiskLabels).Select(static label => $"region:{label}"))
                .Concat(row.ModelSignals.SelectMany(static signal => signal.RiskCategories.Select(static category => $"model:{category}")))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(static label => label, StringComparer.OrdinalIgnoreCase)],
            row.SubmitRegion,
            row.RegionComplianceId <= 0 ? null : row.SubmitRegionConfidence,
            RegionLegalModerationService.DeserializeRegions(row.BlockedRegions),
            row.RegionPolicyVersion,
            row.RegionDecisionReason,
            row.RegionComplianceId <= 0 || row.RegionCanPublish,
            row.RegionRequiresManualReview,
            row.RegionHideUntilReviewed,
            row.ModelSignals,
            latestSignal?.Label,
            latestSignal?.Confidence,
            latestSignal?.PrimaryReason,
            latestSignal?.Provider,
            latestSignal is not null && !string.Equals(latestSignal.Status, "ok", StringComparison.Ordinal),
            row.AuthorMode,
            row.AnonymousDisplayLanguage,
            row.ModerationSubjectHash,
            nullifierHash,
            isAnonymousActor ? BuildNullifierStatusLabel(row) : null,
            row.AnonymousScope,
            row.CredentialLevel,
            row.ReputationBucket,
            row.AccountAgeBucket,
            null,
            !string.IsNullOrWhiteSpace(nullifierHash) && row.NullifierKnown && !row.NullifierBlocked,
            false);
    }

    private static bool IsAnonymousActor(CommentModerationQueueRow row)
    {
        string mode = (row.AuthorMode ?? string.Empty).Trim().ToLowerInvariant();
        return mode is "" or "anonymous" or "zk_anonymous"
            || !string.IsNullOrWhiteSpace(row.AnonymousNullifierHash)
            || !string.IsNullOrWhiteSpace(row.ModerationSubjectHash);
    }

    private static string ResolveModerationAuthorDisplayName(CommentModerationQueueRow row)
    {
        return ResolveCommentModerationDisplayName(
            row.AuthorMode,
            row.PublicHandle,
            row.AnonymousDisplayName,
            row.AnonymousDisplayLanguage);
    }

    private static string ResolveCommentModerationDisplayName(
        string? authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousDisplayLanguage)
    {
        string mode = string.IsNullOrWhiteSpace(authorMode)
            ? CommentAuthorModes.Anonymous
            : authorMode.Trim();
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.OrdinalIgnoreCase))
        {
            return string.IsNullOrWhiteSpace(publicHandle) ? "未署名用户" : publicHandle.Trim();
        }

        if (!string.IsNullOrWhiteSpace(anonymousDisplayName))
        {
            return anonymousDisplayName.Trim();
        }

        return string.Equals(anonymousDisplayLanguage, "en", StringComparison.OrdinalIgnoreCase)
            ? "Anonymous User"
            : "匿名用户";
    }

    private static string BuildNullifierStatusLabel(CommentModerationQueueRow row)
    {
        if (string.IsNullOrWhiteSpace(row.AnonymousNullifierHash))
        {
            return "Nullifier：未记录";
        }

        if (!row.NullifierKnown)
        {
            return "Nullifier：待同步";
        }

        string status = row.NullifierBlocked ? "已封禁" : "可治理";
        return $"Nullifier：{status} / 使用 {Math.Max(0, row.NullifierUseCount ?? 0)} 次";
    }

    private static bool IsModelAutoModerated(CommentModerationQueueRow row)
        => row.ModeratedByAdminPrincipalId is null
            && row.ModeratedAt.HasValue
            && !string.IsNullOrWhiteSpace(row.Reason)
            && row.Reason.StartsWith("model_policy:", StringComparison.Ordinal);

    private static string ResolveModerationActor(CommentModerationQueueRow row)
    {
        if (IsModelAutoModerated(row))
        {
            return "model";
        }

        return row.ModeratedByAdminPrincipalId.HasValue
            ? $"admin:{row.ModeratedByAdminPrincipalId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
            : "human-review-pending";
    }

    internal IReadOnlyList<string> DetectCommentHitReasons(string? content, string? storedReason)
    {
        var reasons = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        string value = content ?? string.Empty;
        ContentValidationResult validation = contentFilter.ValidateContent(value);
        if (!validation.IsValid && !string.IsNullOrWhiteSpace(validation.ReasonCode))
        {
            reasons.Add(validation.ReasonCode);
        }

        if (Regex.IsMatch(value, @"<\s*(script|iframe|object|embed)\b|\son[a-z]+\s*=", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        {
            reasons.Add("html-risk");
        }

        if (Regex.Matches(value, @"https?://|www\.|t\.me/|bit\.ly/", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Count >= 3)
        {
            reasons.Add("link-heavy");
        }

        if (Regex.IsMatch(value, @"(.)\1{7,}", RegexOptions.CultureInvariant))
        {
            reasons.Add("spam-repeat");
        }

        string? reason = NormalizeNullable(storedReason, 64);
        if (string.Equals(reason, "pending_review", StringComparison.OrdinalIgnoreCase))
        {
            reasons.Add("pending-review");
        }
        else if (!string.IsNullOrWhiteSpace(reason))
        {
            reasons.Add($"manual:{reason}");
        }

        return reasons.Count == 0 ? ["manual-review"] : reasons.ToArray();
    }

    private async Task<IReadOnlyDictionary<long, CommentModerationModelSignalResponse>> LoadLatestModelSignalsAsync(
        IReadOnlyList<CommentModerationQueueRow> rows,
        CancellationToken cancellationToken)
    {
        long[] commentIds = [.. rows.Select(static row => row.Id).Where(static id => id > 0).Distinct()];
        if (commentIds.Length == 0)
        {
            return new Dictionary<long, CommentModerationModelSignalResponse>();
        }

        List<CommentModerationSignal> signals = await db.Queryable<CommentModerationSignal>()
            .Where(signal => commentIds.Contains(signal.CommentId))
            .OrderByDescending(static signal => signal.CreatedAtUtc)
            .ToListAsync(cancellationToken);
        return signals
            .GroupBy(static signal => signal.CommentId)
            .ToDictionary(
                static group => group.Key,
                group => ToModelSignalResponse(group.First()));
    }

    private async Task LoadAnonymousNullifierSummariesAsync(
        IReadOnlyList<CommentModerationQueueRow> rows,
        CancellationToken cancellationToken)
    {
        string[] hashes = [.. rows
            .Select(static row => NormalizeNullable(row.AnonymousNullifierHash, 128))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)];
        if (hashes.Length == 0)
        {
            return;
        }

        List<CommentAnonymousNullifier> nullifiers = await db.Queryable<CommentAnonymousNullifier>()
            .Where(item => hashes.Contains(item.NullifierHash))
            .ToListAsync(cancellationToken);
        Dictionary<string, CommentAnonymousNullifier> byKey = nullifiers.ToDictionary(
            static item => BuildNullifierKey(item.NullifierHash, item.Scope),
            static item => item,
            StringComparer.Ordinal);

        foreach (CommentModerationQueueRow row in rows)
        {
            string? hash = NormalizeNullable(row.AnonymousNullifierHash, 128);
            string? scope = NormalizeNullable(row.AnonymousScope, 128);
            if (hash is null || scope is null)
            {
                continue;
            }

            if (!byKey.TryGetValue(BuildNullifierKey(hash, scope), out CommentAnonymousNullifier? nullifier))
            {
                continue;
            }

            row.NullifierKnown = true;
            row.NullifierBlocked = nullifier.Blocked;
            row.NullifierUseCount = nullifier.UseCount;
        }
    }

    private static string BuildNullifierKey(string nullifierHash, string scope)
        => string.Concat(nullifierHash.Trim(), "\n", scope.Trim());

    private static CommentModerationModelSignalResponse ToModelSignalResponse(CommentModerationSignal signal)
        => new(
            signal.Provider,
            signal.Model,
            signal.ContractVersion,
            signal.Label,
            Math.Clamp(signal.Confidence, 0d, 1d),
            signal.Severity,
            signal.PrimaryReason,
            signal.NeedsSecondRound,
            ParseCommaList(signal.RiskCategories),
            signal.EvidenceJson,
            signal.RawReason,
            Math.Max(0, signal.LatencyMs),
            signal.Status,
            signal.ErrorCode,
            signal.ThresholdProfile,
            signal.CreatedAtUtc);

    private async Task<int> BanModerationUsersAsync(IEnumerable<long> commentIds, string? reason, CancellationToken cancellationToken)
    {
        long[] ids = [.. commentIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return 0;
        }

        List<int?> userIds = await db.Queryable<Comment>()
            .Where(item => ids.Contains(item.Id) && item.AuthorMode == "public")
            .Select(item => item.UserId)
            .ToListAsync(cancellationToken);
        int[] uniqueUserIds = [.. userIds
            .Where(static id => id is > 0)
            .Select(static id => id.GetValueOrDefault())
            .Distinct()];
        if (uniqueUserIds.Length == 0)
        {
            return 0;
        }

        string effectiveReason = NormalizeNullable(reason, 256) ?? "评论审核处置";
        var bannedUserIds = new List<int>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            List<UserBanCandidate> banTargets = await LoadUserBanCandidatesAsync(uniqueUserIds, cancellationToken);
            foreach (UserBanCandidate target in banTargets)
            {
                if (!await TryBanUserCandidateAsync(target, effectiveReason, cancellationToken))
                {
                    continue;
                }

                bannedUserIds.Add(target.Id);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Comment moderation user ban failed.", transaction.ErrorException);
        }

        foreach (int userId in bannedUserIds)
        {
            await blacklistService.BanUserAsync(userId, effectiveReason);
        }

        return bannedUserIds.Count;
    }

    private async Task<List<UserBanCandidate>> LoadUserBanCandidatesAsync(int[] userIds, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (userIds.Length == 0)
        {
            return [];
        }

        string[] parameterNames = new string[userIds.Length];
        var parameters = new SugarParameter[userIds.Length];
        for (int i = 0; i < userIds.Length; i++)
        {
            string parameterName = string.Concat("@UserId", i.ToString(CultureInfo.InvariantCulture));
            parameterNames[i] = parameterName;
            parameters[i] = new SugarParameter(parameterName, userIds[i]);
        }

        string sql = $"""
            SELECT id, xmin::text AS row_version
            FROM sys_user
            WHERE id IN ({string.Join(", ", parameterNames)})
              AND status <> 2
              AND deleted_at IS NULL;
            """;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        var candidates = new List<UserBanCandidate>();
        while (await reader.ReadAsync(cancellationToken))
        {
            candidates.Add(new UserBanCandidate(reader.GetInt32(0), reader.GetString(1)));
        }

        return candidates;
    }

    private async Task<bool> TryBanUserCandidateAsync(UserBanCandidate target, string reason, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE sys_user
            SET status = 1,
                banreason = @Reason
            WHERE id = @UserId
              AND status <> 2
              AND deleted_at IS NULL
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@UserId", target.Id),
            new SugarParameter("@Reason", reason),
            new SugarParameter("@RowVersion", target.RowVersion));
        return updated > 0;
    }

    private async Task<CommentModerationStateRow?> LoadCommentModerationStateAsync(long commentId, CancellationToken cancellationToken)
    {
        CommentModerationStateRow? row = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == rc.CommentId
            })
            .Where((c, a, pc, rc) => c.Id == commentId && !c.IsDeleted)
            .Select((c, a, pc, rc) => new CommentModerationStateRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                AnonymousScope = c.AnonymousScope,
                CredentialLevel = c.CredentialLevel,
                Content = c.Content,
                CreateTime = c.CreateTime,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage,
                Depth = c.Depth,
                Status = c.ModerationStatus,
                RegionComplianceId = rc.Id,
                RegionCanPublish = rc.CanPublish
            })
            .FirstAsync(cancellationToken);

        return row is null ? null : HydrateCommentModerationDisplayNames(row);
    }

    private async Task<List<CommentModerationStateRow>> LoadCommentModerationStatesAsync(long[] commentIds, CancellationToken cancellationToken)
    {
        if (commentIds.Length == 0)
        {
            return [];
        }

        List<CommentModerationStateRow> rows = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == rc.CommentId
            })
            .Where((c, a, pc, rc) => commentIds.Contains(c.Id) && !c.IsDeleted)
            .Select((c, a, pc, rc) => new CommentModerationStateRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                Content = c.Content,
                CreateTime = c.CreateTime,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage,
                Depth = c.Depth,
                Status = c.ModerationStatus,
                RegionComplianceId = rc.Id,
                RegionCanPublish = rc.CanPublish
            })
            .ToListAsync(cancellationToken);

        foreach (CommentModerationStateRow row in rows)
        {
            HydrateCommentModerationDisplayNames(row);
        }

        return rows;
    }

    private static CommentModerationStateRow HydrateCommentModerationDisplayNames(CommentModerationStateRow row)
    {
        row.AuthorDisplayName = ResolveCommentModerationDisplayName(
            row.AuthorMode,
            row.PublicHandle,
            row.AnonymousDisplayName,
            row.AnonymousDisplayLanguage);
        row.ReplyToAuthorDisplayName = row.ReplyToCommentId.HasValue
            ? ResolveCommentModerationDisplayName(
                row.ReplyToAuthorMode,
                row.ReplyToPublicHandle,
                row.ReplyToAnonymousDisplayName,
                row.ReplyToAnonymousDisplayLanguage)
            : null;
        return row;
    }

    private async Task InvalidateModeratedCommentAsync(
        CommentModerationStateRow row,
        CommentModerationStatus nextStatus,
        CancellationToken cancellationToken)
    {
        bool publicArticleChanged = row.Status == CommentModerationStatus.Approved || nextStatus == CommentModerationStatus.Approved;
        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: row.ArticleId,
                RootId: row.RootId ?? row.Id,
                AccountId: row.UserId,
                PublicArticleChanged: publicArticleChanged,
                UserCommentsChanged: true),
            cancellationToken);
    }

    private async Task PublishModerationRealtimeAsync(CommentModerationStateRow row, CommentModerationStatus nextStatus, DateTime eventTime)
    {
        if (row.Status != CommentModerationStatus.Approved && nextStatus == CommentModerationStatus.Approved)
        {
            await messageRealtimePublisher.PushCommentAddAsync(new CommentAddedNotifyDto
            {
                ArticleId = row.ArticleId,
                Time = eventTime,
                Comment = new CommentPushDto
                {
                    Id = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Content = row.Content,
                    CreateTime = row.CreateTime,
                    Author = BuildCommentAuthorView(
                        row.AuthorMode,
                        row.AuthorDisplayName,
                        row.AnonymousDisplayLanguage,
                        null,
                        null),
                    ParentId = row.ParentId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    RootId = (row.RootId ?? row.Id).ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ReplyToAuthor = row.ReplyToCommentId.HasValue
                        ? BuildCommentAuthorView(
                            row.ReplyToAuthorMode,
                            row.ReplyToAuthorDisplayName,
                            row.ReplyToAnonymousDisplayLanguage,
                            null,
                            null)
                        : null,
                    ReplyToCommentId = row.ReplyToCommentId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Depth = Math.Min(2, Math.Max(0, row.Depth)),
                    IsDeleted = false
                }
            });
            await NotifyApprovedReplyAsync(row);
            return;
        }

        if (row.Status == CommentModerationStatus.Approved && nextStatus is CommentModerationStatus.Hidden or CommentModerationStatus.Rejected)
        {
            await messageRealtimePublisher.PushCommentRemoveAsync(row.ArticleId, row.Id, row.RootId ?? row.Id, row.ParentId);
        }
    }

    private static CommentAuthorViewDto BuildCommentAuthorView(
        string? mode,
        string? displayName,
        string? displayLanguage,
        string? scopeLabel,
        string? credentialLevel)
    {
        string normalizedMode = string.IsNullOrWhiteSpace(mode) ? CommentAuthorModes.Anonymous : mode.Trim();
        bool isPublic = string.Equals(normalizedMode, CommentAuthorModes.Public, StringComparison.OrdinalIgnoreCase);
        string resolvedLanguage = string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase) ? "en" : "zh-CN";
        string fallbackName = isPublic
            ? "未署名用户"
            : (resolvedLanguage == "en" ? "Anonymous User" : "匿名用户");

        return new CommentAuthorViewDto(
            normalizedMode,
            string.IsNullOrWhiteSpace(displayName) ? fallbackName : displayName.Trim(),
            resolvedLanguage,
            null,
            string.IsNullOrWhiteSpace(scopeLabel) ? null : scopeLabel.Trim(),
            string.IsNullOrWhiteSpace(credentialLevel) ? null : credentialLevel.Trim());
    }

    private async Task NotifyApprovedReplyAsync(CommentModerationStateRow row)
    {
        if (!row.ReplyToUserId.HasValue ||
            row.ReplyToUserId.Value <= 0 ||
            (row.UserId.HasValue && row.ReplyToUserId.Value == row.UserId.Value))
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                string actor = row.AuthorDisplayName;
                string targetName = string.IsNullOrWhiteSpace(row.ReplyToAuthorDisplayName) ? "您" : row.ReplyToAuthorDisplayName!;
                string snippet = row.Content.Length > 40 ? row.Content[..40] : row.Content;
                await messageCommandService.SendAccountTransactionalNoticeAsync(
                    row.ReplyToUserId.Value,
                    "收到新的评论回复",
                    $"{actor} 回复了 {targetName}：{snippet}");
            },
            logger,
            $"comment-moderation-notify-reply:{row.ReplyToUserId.Value}",
            LogLevel.Warning);
    }

    private static bool ShouldLinkBan(CommentModerationStatus status)
        => status is CommentModerationStatus.Rejected or CommentModerationStatus.Hidden;

    private static bool IsValidModerationStatus(CommentModerationStatus status)
        => status is CommentModerationStatus.Pending
            or CommentModerationStatus.Approved
            or CommentModerationStatus.Rejected
            or CommentModerationStatus.Hidden;

    private static bool IsAllowedModerationTransition(CommentModerationStatus currentStatus, CommentModerationStatus nextStatus)
        => currentStatus == nextStatus
            || currentStatus switch
            {
                CommentModerationStatus.Pending => nextStatus is CommentModerationStatus.Approved
                    or CommentModerationStatus.Rejected
                    or CommentModerationStatus.Hidden,
                CommentModerationStatus.Approved => nextStatus is CommentModerationStatus.Rejected
                    or CommentModerationStatus.Hidden,
                CommentModerationStatus.Rejected => nextStatus is CommentModerationStatus.Pending
                    or CommentModerationStatus.Approved
                    or CommentModerationStatus.Hidden,
                CommentModerationStatus.Hidden => nextStatus is CommentModerationStatus.Pending
                    or CommentModerationStatus.Approved
                    or CommentModerationStatus.Rejected,
                _ => false
            };

    private static bool IsRegionApprovalAllowed(CommentModerationStateRow row)
        => row.RegionComplianceId <= 0 || row.RegionCanPublish;

    private static IReadOnlyList<string> ParseCommaList(string? value)
        => (value ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .ToArray();

    private static IReadOnlyList<AuthorAnalyticsMetricResponse> BuildRankedMetrics(IEnumerable<string?> values)
        => values
            .Select(static value => NormalizeAnalyticsLabel(value))
            .Where(static value => value is not null)
            .GroupBy(static value => value!, StringComparer.OrdinalIgnoreCase)
            .Select(static group => new AuthorAnalyticsMetricResponse(group.Key, group.Count()))
            .OrderByDescending(static item => item.Count)
            .ThenBy(static item => item.Label, StringComparer.Ordinal)
            .Take(6)
            .ToArray();

    private static IReadOnlyList<AuthorRumMetricResponse> BuildRumMetricSummaries(IEnumerable<RumMetricAuditContext> values)
        => values
            .Select(static value => new
            {
                value.Name,
                Value = SelectRumMetricValue(value)
            })
            .Where(static value => value.Value.HasValue)
            .GroupBy(static value => value.Name, StringComparer.Ordinal)
            .Select(static group =>
            {
                double average = RoundingHelper.Round2(group.Average(static item => item.Value!.Value));
                double[] sortedSamples = [.. group.Select(static item => item.Value!.Value).Order()];
                return new AuthorRumMetricResponse(
                    group.Key,
                    sortedSamples.Length,
                    Percentile(sortedSamples, 0.75d),
                    average);
            })
            .OrderBy(static item => item.Name, StringComparer.Ordinal)
            .Take(8)
            .ToArray();

    private static RumMetricAuditContext? TryReadRumMetric(FrontendRumMetric metric)
    {
        Dictionary<string, double>? metrics = JsonDecodeHelper.DeserializeOrNull<Dictionary<string, double>>(metric.MetricsJson);

        return new RumMetricAuditContext(
            metric.Name,
            metric.PageType,
            metric.AotSource,
            metric.Value,
            metrics ?? [],
            metric.OccurredAtUtc);
    }

    private static double? SelectRumMetricValue(RumMetricAuditContext context)
    {
        if (context.Value.HasValue)
        {
            return context.Value.Value;
        }

        return context.Metrics.TryGetValue("value", out double value)
            || context.Metrics.TryGetValue("durationMs", out value)
            || context.Metrics.TryGetValue("domInteractive", out value)
            ? value
            : null;
    }

    private static double Percentile(ReadOnlySpan<double> sortedSamples, double percentile)
    {
        if (sortedSamples.Length == 0)
        {
            return 0d;
        }

        int index = (int)Math.Ceiling(sortedSamples.Length * percentile) - 1;
        index = Math.Clamp(index, 0, sortedSamples.Length - 1);
        return RoundingHelper.Round2(sortedSamples[index]);
    }

    private static string? NormalizeAnalyticsRouteKey(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || value.StartsWith("search:", StringComparison.OrdinalIgnoreCase) || value.StartsWith("not-found:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return value switch
        {
            "home" => "/",
            "about" => "/about",
            "archive" => "/archive",
            "search" => "/search",
            var item when item.StartsWith("article:", StringComparison.OrdinalIgnoreCase) => $"/article/{item["article:".Length..]}",
            var item when item.StartsWith("category:", StringComparison.OrdinalIgnoreCase) => $"/category/{item["category:".Length..]}",
            var item when item.StartsWith("tag:", StringComparison.OrdinalIgnoreCase) => $"/tag/{item["tag:".Length..]}",
            var item when item.StartsWith("tag-name:", StringComparison.OrdinalIgnoreCase) => $"/tag/{item["tag-name:".Length..]}",
            _ => value
        };
    }

    private static string? TryExtractSearchKeyword(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || !value.StartsWith("search:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string keyword = value["search:".Length..].Trim();
        return keyword.Length == 0 ? null : keyword;
    }

    private static string? TryExtractNotFoundPath(string? routeKey)
    {
        string? value = NormalizeAnalyticsLabel(routeKey);
        if (value is null || !value.StartsWith("not-found:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        string path = value["not-found:".Length..].Trim();
        return path.Length == 0 ? null : path;
    }

    private static string? NormalizeAnalyticsLabel(string? raw)
    {
        string value = (raw ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return null;
        }

        value = Regex.Replace(value, @"\s+", " ", RegexOptions.CultureInvariant);
        return value.Length > 96 ? value[..96] : value;
    }

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

    private static void AddAssetReference(Dictionary<string, AssetReferenceAggregate> assets, string url, string? altText, int articleId)
    {
        if (!IsUploadAssetUrl(url))
        {
            return;
        }

        if (!assets.TryGetValue(url, out AssetReferenceAggregate? aggregate))
        {
            aggregate = new AssetReferenceAggregate(url, articleId);
            assets[url] = aggregate;
        }

        aggregate.ReferenceCount++;
        if (string.IsNullOrWhiteSpace(aggregate.AltText) && !string.IsNullOrWhiteSpace(altText))
        {
            aggregate.AltText = NormalizeNullable(altText, 256);
        }
    }

    private static Dictionary<string, AssetReferenceAggregate> BuildArticleAssetReferences(int articleId, string markdownContent, string? coverImageUrl)
    {
        var assets = new Dictionary<string, AssetReferenceAggregate>(StringComparer.OrdinalIgnoreCase);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent))
        {
            AddAssetReference(assets, reference.Url, reference.AltText, articleId);
        }

        if (IsUploadAssetUrl(coverImageUrl))
        {
            AddAssetReference(assets, coverImageUrl!, null, articleId);
        }

        return assets;
    }

    private static void MergeAssetReference(Dictionary<string, AssetReferenceAggregate> assets, AssetReferenceAggregate source)
    {
        if (!assets.TryGetValue(source.Url, out AssetReferenceAggregate? aggregate))
        {
            aggregate = new AssetReferenceAggregate(source.Url, source.SourceArticleId);
            assets[source.Url] = aggregate;
        }

        aggregate.ReferenceCount += source.ReferenceCount;
        if (string.IsNullOrWhiteSpace(aggregate.AltText) && !string.IsNullOrWhiteSpace(source.AltText))
        {
            aggregate.AltText = source.AltText;
        }
    }

    private static bool IsUploadAssetUrl(string? url)
        => !string.IsNullOrWhiteSpace(url)
            && url.StartsWith("/uploads/illustration/", StringComparison.OrdinalIgnoreCase)
            && (url.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                || url.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
                || url.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                || url.EndsWith(".gif", StringComparison.OrdinalIgnoreCase)
                || url.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)
                || url.EndsWith(".svg", StringComparison.OrdinalIgnoreCase));

    private sealed class AssetReferenceAggregate(string url, int sourceArticleId)
    {
        public string Url { get; } = url;
        public string? AltText { get; set; }
        public int SourceArticleId { get; } = sourceArticleId;
        public int ReferenceCount { get; set; }
    }

    private sealed record AssetArticleReferenceRow(
        string Url,
        int ArticleId,
        string? AltText,
        int ReferenceCount);

    private sealed record UserBanCandidate(int Id, string RowVersion);

    private sealed class CommentModerationQueueRow
    {
        public long Id { get; set; }
        public int ArticleId { get; set; }
        public string? ArticleTitle { get; set; }
        public int? UserId { get; set; }
        public string? AuthorMode { get; set; }
        public string? PublicHandle { get; set; }
        public string? AnonymousDisplayName { get; set; }
        public string? AnonymousDisplayLanguage { get; set; }
        public string? ModerationSubjectHash { get; set; }
        public string? AnonymousNullifierHash { get; set; }
        public string? AnonymousScope { get; set; }
        public string? CredentialLevel { get; set; }
        public string? ReputationBucket { get; set; }
        public string? AccountAgeBucket { get; set; }
        public string Content { get; set; } = string.Empty;
        public DateTime CreateTime { get; set; }
        public CommentModerationStatus Status { get; set; }
        public string? Reason { get; set; }
        public long? ModeratedByAdminPrincipalId { get; set; }
        public DateTime? ModeratedAt { get; set; }
        public long RegionComplianceId { get; set; }
        public string? SubmitRegion { get; set; }
        public double SubmitRegionConfidence { get; set; }
        public string? BlockedRegions { get; set; }
        public string? RegionPolicyVersion { get; set; }
        public string? RegionDecisionReason { get; set; }
        public string? RegionRiskLabels { get; set; }
        public bool RegionCanPublish { get; set; }
        public bool RegionRequiresManualReview { get; set; }
        public bool RegionHideUntilReviewed { get; set; }
        public bool NullifierKnown { get; set; }
        public bool NullifierBlocked { get; set; }
        public int? NullifierUseCount { get; set; }
        public IReadOnlyList<CommentModerationModelSignalResponse> ModelSignals { get; set; } = [];
    }

    private sealed class CommentModerationStateRow
    {
        public long Id { get; init; }
        public int ArticleId { get; init; }
        public string? ArticleTitle { get; init; }
        public int? UserId { get; init; }
        public string AuthorDisplayName { get; set; } = "匿名用户";
        public string? AuthorMode { get; set; }
        public string? PublicHandle { get; set; }
        public string? AnonymousDisplayName { get; set; }
        public string? AnonymousDisplayLanguage { get; set; }
        public string? AnonymousScope { get; set; }
        public string? CredentialLevel { get; set; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public long? ParentId { get; init; }
        public long? RootId { get; init; }
        public int? ReplyToUserId { get; init; }
        public string? ReplyToAuthorDisplayName { get; set; }
        public string? ReplyToAuthorMode { get; set; }
        public string? ReplyToPublicHandle { get; set; }
        public string? ReplyToAnonymousDisplayName { get; set; }
        public string? ReplyToAnonymousDisplayLanguage { get; set; }
        public long? ReplyToCommentId { get; init; }
        public int Depth { get; init; }
        public CommentModerationStatus Status { get; init; }
        public long RegionComplianceId { get; init; }
        public bool RegionCanPublish { get; init; }
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
        string value = raw?.Trim() ?? string.Empty;
        return value.Length > maxLength ? value[..maxLength] : value;
    }

    private static string? NormalizeNullable(string? raw, int maxLength)
    {
        string value = Normalize(raw, maxLength);
        return value.Length == 0 ? null : value;
    }

    private static object DbValue(string? value)
        => string.IsNullOrWhiteSpace(value) ? DBNull.Value : value;

    private static object DbValue(int? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private static object DbValue(DateTime? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private static string NormalizeAiAssistProvider(string? raw)
    {
        string value = Normalize(raw, 32).ToLowerInvariant();
        return value.Length == 0 ? "local" : value;
    }

    private static string NormalizeAiAssistOperation(string? raw)
    {
        string value = Normalize(raw, 48).ToLowerInvariant();
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

        string targetLocale = NormalizeNullable(locale, 24) ?? "target-locale";
        string clean = ImageHelper.StripMarkdown(content ?? string.Empty, 800);
        return clean.Length == 0
            ? string.Empty
            : $"<!-- translation-target:{targetLocale} -->\n\n{clean}";
    }

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
        string value = raw?.Trim() ?? string.Empty;
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

    private static IReadOnlyList<string> SuggestTags(string? content)
    {
        string value = content ?? string.Empty;
        var tags = new List<string>(3);
        if (value.Contains("AOT", StringComparison.OrdinalIgnoreCase)) tags.Add("AOT");
        if (value.Contains("WASM", StringComparison.OrdinalIgnoreCase)) tags.Add("Wasm");
        if (value.Contains("security", StringComparison.OrdinalIgnoreCase) || value.Contains("安全", StringComparison.OrdinalIgnoreCase)) tags.Add("安全");
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
                ParseTagIds(revision.TagIds),
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
                    if (separator <= 0) continue;
                    string key = line[..separator].Trim();
                    string value = line[(separator + 1)..].Trim();
                    values[key] = value;
                }

                if (values.TryGetValue("fsusMetadataJson", out string? encodedMetadata))
                {
                    metadata = TryDecodeExportMetadata(encodedMetadata);
                }

                if (values.TryGetValue("title", out string? rawTitle) && !string.IsNullOrWhiteSpace(rawTitle)) title = rawTitle;
                if (values.TryGetValue("summary", out string? rawSummary)) summary = NormalizeNullable(rawSummary, 512);
                if (values.TryGetValue("cover", out string? rawCover)) cover = NormalizeNullable(rawCover, 512);
                if (values.TryGetValue("categoryId", out string? rawCategory) && int.TryParse(rawCategory, out int parsedCategory)) categoryId = Math.Max(1, parsedCategory);
                if (values.TryGetValue("status", out string? rawStatus) && int.TryParse(rawStatus, out int parsedStatus) && ArticleStatusProjection.IsDefined(parsedStatus)) status = (ArticleStatus)parsedStatus;
                if (values.TryGetValue("scheduledPublishAt", out string? rawScheduled)
                    && DateTime.TryParse(
                        rawScheduled,
                        System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind,
                        out DateTime parsedScheduled))
                {
                    scheduledPublishAt = parsedScheduled;
                }
                if (values.TryGetValue("tagIds", out string? rawTagIds)) tagIds = ParseTagIds(rawTagIds);
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
                Title = Normalize(revision.Title, 256),
                Summary = NormalizeNullable(revision.Summary, 512),
                CoverImageUrl = NormalizeNullable(revision.CoverImageUrl, 512),
                CategoryId = Math.Max(1, revision.CategoryId),
                TagIds = string.Join(',', NormalizeTagIds(revision.TagIds)),
                MarkdownContent = Normalize(revision.Content, 200_000),
                DiffSummary = Normalize(revision.DiffSummary, 512),
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
            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT 1
                FROM article
                WHERE id = @ArticleId
                FOR UPDATE;
                """,
                new SugarParameter("@ArticleId", articleId));
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException("Article must exist before restoring imported revisions.");
            }

            await db.Deleteable<ArticleRevision>().Where(it => it.ArticleId == articleId).ExecuteCommandAsync(cancellationToken);
            await db.Insertable(revisions).ExecuteCommandAsync(cancellationToken);
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

    private void WriteAudit(string source, string eventInfo, long actorAdminPrincipalId, string target)
    {
        byte[] payload = Encoding.UTF8.GetBytes($"actor={actorAdminPrincipalId};target={target}");
        auditLogChannel.TryWrite(new AuditRecord(source, AuditTypeCatalog.Business, DateTime.UtcNow, eventInfo, payload));
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

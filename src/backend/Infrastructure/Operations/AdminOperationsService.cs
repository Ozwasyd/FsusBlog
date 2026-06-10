using System.Reflection;
using System.Text;
using System.Xml.Linq;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed class AdminOperationsService(
    ISqlSugarClient db,
    IWebHostEnvironment environment,
    IConfiguration configuration,
    ProductionReadinessProbe readinessProbe,
    PublicHotReadStore publicHotReadStore,
    PublicHotReadCounters publicHotReadCounters,
    PublicAotInvalidationTracker publicAotInvalidationTracker,
    CacheInvalidationRuntimeState cacheInvalidationRuntime,
    IHotStatsInvalidationCoalescer hotStatsInvalidation,
    AuditLogRuntimeState auditLogRuntime,
    StartupRuntimeState startupRuntime,
    ScheduledPublishRuntimeState scheduledPublishRuntime,
    CrawlerDetectorService crawlerDetector,
    BlogDistributionService distributionService,
    ISearchIndexService searchIndexService,
    PublicHotArtifactUpdateQueue publicHotArtifactUpdateQueue,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    ILogger<AdminOperationsService> logger)
{
    private const uint SearchManifestMagic = 0x4D495346;
    private const uint SearchManifestBinaryVersion = 1;
    private const string IntegrityFixPhrase = "APPLY_SAFE_FIXES";

    public async Task<OpsHealthResponse> GetOpsHealthAsync(CancellationToken cancellationToken)
    {
        ProductionHealthReport readiness = await readinessProbe.CheckAsync(cancellationToken);
        BackupStatusResponse backup = GetBackupStatus();
        AuditLogRuntimeSnapshot audit = auditLogRuntime.Snapshot();
        StartupRuntimeSnapshot startup = startupRuntime.CreateSnapshot();
        ScheduledPublishRuntimeSnapshot scheduled = scheduledPublishRuntime.CreateSnapshot();
        PublicHotReadRuntimeSnapshot publicHot = publicHotReadStore.CreateRuntimeSnapshot();
        CrawlerRangeStatus crawler = crawlerDetector.GetRangeStatus();
        SearchIndexDiagnosticsResponse search = GetSearchIndexDiagnostics();
        QueueBacklogResponse backlog = await GetQueueBacklogAsync(audit, cancellationToken);

        var services = new List<AdminServiceStatusResponse>
        {
            BuildStatus("postgres", "数据库", ReadinessStatus(readiness, "postgres"), ReadinessDetail(readiness, "postgres"), readiness.CheckedAt, ReadinessMetrics(readiness, "postgres")),
            BuildStatus("redis", "Redis", ReadinessStatus(readiness, "redis"), ReadinessDetail(readiness, "redis"), readiness.CheckedAt, ReadinessMetrics(readiness, "redis")),
            BuildStatus("audit", "审计写入", audit.WriteFailureCount > 0 || audit.DroppedCount > 0 ? "degraded" : "ok", $"queued={audit.QueuedCount}, dropped={audit.DroppedCount}, failed={audit.WriteFailureCount}", ToOffset(audit.LastWriteSuccessUtc), Metrics(("fallback", audit.FallbackWriteCount))),
            BuildStatus("crawler-cidr", "Crawler CIDR", crawler.LastError is null ? "ok" : "degraded", crawler.LastError ?? crawler.Source, crawler.LastSuccessAt, Metrics(("google", crawler.GoogleRanges), ("bing", crawler.BingRanges))),
            BuildStatus("backup", "最近备份", backup.Status, backup.BackupRoot, backup.CheckedAt, Metrics(("artifactCount", backup.Artifacts.Count))),
            BuildStatus("public-hot-read", "PublicHotRead", publicHot.LastBuildStatus == "failed" ? "degraded" : "ok", publicHot.LastError ?? publicHot.LastBuildReason, publicHot.LastBuildAt, Metrics(("version", publicHot.Version), ("articleFrames", publicHot.ArticleFrameCount), ("htmlFrames", publicHot.HtmlFrameCount))),
            BuildStatus("search-index", "搜索索引", search.Status, search.LastError ?? search.Version, search.LastUpdatedAt, Metrics(("schema", search.SchemaVersion), ("shards", search.ShardCount)))
        };

        var workers = new List<AdminServiceStatusResponse>
        {
            BuildStatus("scheduled-publish", "定时发布 worker", scheduled.Status, scheduled.LastError, scheduled.UpdatedAt, Metrics(("dueBacklog", scheduled.DueBacklog), ("published", scheduled.LastPublishedCount), ("failed", scheduled.LastFailedCount)))
        };
        foreach (KeyValuePair<string, StartupLifecycleTaskReport> task in startup.Tasks)
        {
            workers.Add(BuildStatus(
                $"startup:{task.Key}",
                $"启动任务 {task.Key}",
                NormalizeTaskStatus(task.Value.Status),
                task.Value.Detail,
                task.Value.UpdatedAt,
                Metrics()));
        }

        IReadOnlyList<string> recentErrors = await LoadRecentErrorsAsync(cancellationToken);
        string status = services.Concat(workers).Any(item => item.Status is "failed" or "degraded") ? "degraded" : "ok";
        return new OpsHealthResponse(
            status,
            DateTimeOffset.UtcNow,
            environment.EnvironmentName,
            ResolveVersion(),
            ResolveCommit(),
            services,
            workers,
            backlog,
            backup,
            recentErrors);
    }

    public BackupStatusResponse GetBackupStatus()
    {
        string backupRoot = ResolveBackupRoot();
        Directory.CreateDirectory(backupRoot);
        string dataRoot = ResolveDataRoot();
        string keyRingPath = ResolveDataProtectionKeyRingPath(dataRoot);

        List<BackupArtifactResponse> artifacts =
        [
            FindLatestArtifact(backupRoot, "database", ["database", "postgres", "db"], ["*.dump", "*.backup", "*.sql", "*.sql.gz"]),
            FindLatestArtifact(backupRoot, "uploads", ["uploads"], ["*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "data-protection-keyring", ["data-protection", "keyring"], ["*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "config", ["config", "appsettings"], ["*.json", "*.tar", "*.tar.gz", "*.tgz"]),
            FindLatestArtifact(backupRoot, "site-package", ["fsusblog-site", "site-package"], ["*.tar.gz", "*.tgz"]),
            FindRestoreDrillArtifact(backupRoot)
        ];

        if (Directory.Exists(keyRingPath) && artifacts[2].Status == "missing")
        {
            artifacts[2] = DirectoryArtifact("data-protection-keyring", keyRingPath, "live-keyring-not-yet-packaged");
        }

        string status = artifacts.Where(static item => item.Kind is "database" or "uploads" or "data-protection-keyring" or "config")
            .All(static item => item.Status != "missing")
            ? "ok"
            : "missing";

        return new BackupStatusResponse(
            status,
            DateTimeOffset.UtcNow,
            backupRoot,
            artifacts,
            "tools/operations/backup-restore-drill.sh",
            "tools/operations/restore-site.sh --backup <package> --confirm");
    }

    public async Task<CacheDiagnosticsResponse> GetCacheDiagnosticsAsync(int? articleId, CancellationToken cancellationToken)
    {
        PublicHotReadRuntimeSnapshot publicHot = publicHotReadStore.CreateRuntimeSnapshot();
        PublicAotInvalidationRuntimeSnapshot invalidation = publicAotInvalidationTracker.Snapshot();
        SearchIndexDiagnosticsResponse search = GetSearchIndexDiagnostics();
        DistributionDiagnosticsResponse distribution = await GetDistributionDiagnosticsAsync(cancellationToken);
        ArticleCacheDiagnosisResponse? article = articleId is > 0
            ? await DiagnoseArticleCacheAsync(articleId.Value, cancellationToken)
            : null;

        AotDiagnosticsResponse aot = new(
            publicHot.LastBuildStatus == "failed" ? "degraded" : "ok",
            publicHot.Version,
            publicHot.LastBuildAt,
            publicHot.LastBuildStatus,
            publicHot.LastBuildReason,
            publicHot.LastError,
            invalidation.TrackedInvalidationKeys,
            invalidation.CurrentVersion,
            invalidation.TrackedInvalidationKeys);

        string status = aot.Status == "ok" && search.Status == "ok" && distribution.Status == "ok" ? "ok" : "degraded";
        return new CacheDiagnosticsResponse(
            status,
            DateTimeOffset.UtcNow,
            aot,
            search,
            distribution,
            cacheInvalidationRuntime.Snapshot(),
            hotStatsInvalidation.Snapshot(),
            new OutputCacheDiagnosticsResponse(
                "ok",
                Enabled: true,
                Tags: Enum.GetNames<CacheTag>(),
                Detail: "ASP.NET OutputCache + IHttpCacheInvalidator tag eviction"),
            publicHotReadCounters.Snapshot(),
            article);
    }

    public async Task<AdminCacheActionResponse> RunCacheActionAsync(AdminCacheActionRequest request, CancellationToken cancellationToken)
    {
        string action = NormalizeAction(request.Action);
        switch (action)
        {
            case "search-rebuild":
                await searchIndexService.BuildIndexAsync([]);
                return ActionResult(action, "ok", "search index rebuild completed");
            case "public-hot-rebuild":
            case "aot-rebuild":
                bool queued = publicHotArtifactUpdateQueue.TryEnqueue(request.ArticleId, "admin-cache-action");
                return ActionResult(action, queued ? "queued" : "degraded", queued ? "public hot/AOT rebuild queued" : "public hot/AOT rebuild queue rejected");
            case "output-cache-clear":
                await cacheInvalidationDispatcher.InvalidateArticleMutationAsync(request.ArticleId, cancellationToken);
                await cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken);
                return ActionResult(action, "ok", "output/cache tags invalidated");
            case "sitemap-feed-refresh":
                await cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken);
                return ActionResult(action, "ok", "feed/sitemap cache invalidated");
            default:
                return ActionResult(action, "unsupported", "supported actions: search-rebuild, aot-rebuild, public-hot-rebuild, output-cache-clear, sitemap-feed-refresh");
        }
    }

    public async Task<IntegrityReportResponse> InspectIntegrityAsync(CancellationToken cancellationToken)
    {
        IntegrityData data = await LoadIntegrityDataAsync(cancellationToken);
        List<IntegrityCheckResponse> checks =
        [
            BuildCheck("article_missing_body", "文章缺少 ArticleBody", MissingBody(data), "warning", true, "可通过内容导入或人工补正文修复。"),
            BuildCheck("article_body_without_revision", "正文缺少 revision", BodyWithoutRevision(data), "warning", false, "需要人工确认首个 revision 的正文来源。"),
            BuildCheck("article_missing_category", "文章引用不存在分类", MissingCategory(data), "error", false, "需要重新指定分类或恢复分类。"),
            BuildCheck("article_tag_missing_tag", "文章标签关联不存在 tag", MissingArticleTag(data), "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("article_tag_missing_article", "标签关联不存在文章", MissingArticleTagArticle(data), "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("comment_missing_article", "评论指向不存在文章", MissingCommentArticle(data), "error", false, "需要人工确认评论是否删除或迁移。"),
            BuildCheck("comment_chain_invalid", "评论 root/parent 链异常", InvalidCommentChain(data), "warning", false, "需要人工判断楼层结构。"),
            BuildCheck("session_deleted_user", "session 指向已注销用户", DeletedUserSessions(data), "warning", true, "安全修复会撤销这些 session。"),
            BuildCheck("upload_untracked", "uploads 文件未进 asset library", UntrackedUploads(data), "info", false, "可通过文章资产重建补齐。"),
            BuildCheck("asset_missing_file", "asset library 指向不存在文件", MissingAssetFiles(data), "warning", false, "需要人工确认是否清理资产记录。"),
            BuildCheck("sitemap_visibility", "sitemap 公开性", [], "info", false, "sitemap 文章、分类、标签均复用 published visibility 过滤。"),
            BuildCheck("search_visibility", "搜索公开性", [], "info", false, "SearchIndexService 只加载 published 且已到发布时间的文章。"),
            BuildCheck("taxonomy_count_runtime", "taxonomy 公开计数", [], "info", false, "后台 taxonomy 计数实时聚合，不依赖易漂移的持久计数字段。")
        ];

        int issueCount = checks.Count(static item => item.Count > 0);
        return new IntegrityReportResponse(
            issueCount == 0 ? "ok" : "issues",
            DateTimeOffset.UtcNow,
            checks.Count,
            issueCount,
            checks);
    }

    public async Task<IntegrityFixPreviewResponse> PreviewIntegrityFixAsync(CancellationToken cancellationToken)
    {
        IntegrityData data = await LoadIntegrityDataAsync(cancellationToken);
        IReadOnlyList<AdminDiffResponse> diffs = BuildSafeFixDiffs(data);
        return new IntegrityFixPreviewResponse(
            diffs.Count == 0 ? "empty" : "ready",
            DateTimeOffset.UtcNow,
            diffs,
            $"输入 {IntegrityFixPhrase} 后应用安全修复",
            "admin.integrity.safe_fix_applied");
    }

    public async Task<IntegrityFixResponse> ApplyIntegrityFixAsync(IntegrityFixRequest request, CancellationToken cancellationToken)
    {
        if (!string.Equals(request.ConfirmPhrase, IntegrityFixPhrase, StringComparison.Ordinal))
        {
            return new IntegrityFixResponse("confirmation_required", DateTimeOffset.UtcNow, 0, []);
        }

        HashSet<string> codes = request.Codes is { Count: > 0 }
            ? request.Codes.ToHashSet(StringComparer.OrdinalIgnoreCase)
            : ["article_tag_missing_tag", "article_tag_missing_article", "session_deleted_user"];
        IntegrityData data = await LoadIntegrityDataAsync(cancellationToken);
        List<AdminDiffResponse> diffs = [];

        if (codes.Contains("article_tag_missing_tag") || codes.Contains("article_tag_missing_article"))
        {
            foreach (ArticleTag tag in data.ArticleTags.Where(tag => !data.TagIds.Contains(tag.TagId) || !data.ArticleIds.Contains(tag.ArticleId)))
            {
                await db.Deleteable<ArticleTag>()
                    .Where(item => item.ArticleId == tag.ArticleId && item.TagId == tag.TagId)
                    .ExecuteCommandAsync(cancellationToken);
                diffs.Add(new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted"));
            }
        }

        if (codes.Contains("session_deleted_user"))
        {
            DateTime now = DateTime.UtcNow;
            foreach (UserSession session in data.Sessions.Where(session => data.DeletedOrMissingUserIds.Contains(session.UserId) && session.RevokedAt is null))
            {
                await db.Updateable<UserSession>()
                    .SetColumns(item => item.RevokedAt == now)
                    .SetColumns(item => item.RevokeReason == "integrity_safe_fix_deleted_user")
                    .Where(item => item.SessionId == session.SessionId)
                    .ExecuteCommandAsync(cancellationToken);
                diffs.Add(new AdminDiffResponse($"session:{session.SessionId}", "active", "revoked"));
            }
        }

        return new IntegrityFixResponse(
            diffs.Count == 0 ? "empty" : "applied",
            DateTimeOffset.UtcNow,
            diffs.Count,
            diffs);
    }

    public DangerousOperationPolicyResponse GetDangerousOperationPolicy()
        => new(
            [
                new DangerousOperationRuleResponse("normal-confirm", "confirm", ["刷新缓存", "重建搜索索引", "重新生成 sitemap/feed"]),
                new DangerousOperationRuleResponse("strong-confirm", "二次确认", ["删除文件", "清理孤立资产", "清空 output cache"]),
                new DangerousOperationRuleResponse("typed-confirm", "输入对象名", ["删除标签并解除关联", "删除分类并迁移文章"]),
                new DangerousOperationRuleResponse("mfa-step-up", "MFA proof", ["批量封禁", "重置密码", "导出站点备份", "应用数据巡检修复"]),
                new DangerousOperationRuleResponse("diff-preview", "展示 changed fields", ["系统设置保存", "内容导入", "revision rollback", "静态页面修改"])
            ],
            ["system-settings-save", "content-import", "revision-rollback", "taxonomy-update", "integrity-fix"],
            ["comment-bulk-moderation", "user-ban", "password-reset", "site-backup-export", "integrity-fix"],
            "single-author-v1");

    private async Task<QueueBacklogResponse> GetQueueBacklogAsync(AuditLogRuntimeSnapshot audit, CancellationToken cancellationToken)
    {
        int pending = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.Status == "pending")
            .CountAsync(cancellationToken);
        int failed = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.Status == "failed")
            .CountAsync(cancellationToken);
        return new QueueBacklogResponse(pending, failed, audit.QueuedCount, audit.DroppedCount);
    }

    private async Task<IReadOnlyList<string>> LoadRecentErrorsAsync(CancellationToken cancellationToken)
        => await db.Queryable<AuditLog>()
            .Where(item => item.Severity == "error" || item.Severity == "critical")
            .OrderBy(item => item.OccurredAtUtc, OrderByType.Desc)
            .Take(5)
            .Select(item => $"{item.OccurredAtUtc:O} {item.Action} {item.EventInfo}")
            .ToListAsync(cancellationToken);

    private async Task<DistributionDiagnosticsResponse> GetDistributionDiagnosticsAsync(CancellationToken cancellationToken)
    {
        try
        {
            string sitemap = await distributionService.BuildSitemapAsync(cancellationToken);
            string rss = await distributionService.BuildRssAsync(cancellationToken);
            int sitemapUrlCount = XDocument.Parse(sitemap).Descendants().Count(static node => node.Name.LocalName == "url");
            int feedItemCount = XDocument.Parse(rss).Descendants().Count(static node => node.Name.LocalName == "item");
            DateTimeOffset checkedAt = DateTimeOffset.UtcNow;
            return new DistributionDiagnosticsResponse("ok", checkedAt, sitemapUrlCount, feedItemCount, checkedAt, checkedAt, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "distribution diagnostics failed");
            return new DistributionDiagnosticsResponse("degraded", DateTimeOffset.UtcNow, 0, 0, null, null, ex.GetType().Name);
        }
    }

    private async Task<ArticleCacheDiagnosisResponse> DiagnoseArticleCacheAsync(int articleId, CancellationToken cancellationToken)
    {
        Article? article = await db.Queryable<Article>().FirstAsync(item => item.Id == articleId, cancellationToken);
        if (article is null)
        {
            return new ArticleCacheDiagnosisResponse(articleId, false, false, false, false, false, "article_not_found");
        }

        DateTime now = DateTime.UtcNow;
        bool publicVisible = ArticlePublication.IsPubliclyVisible(article, now);
        bool frameReady = publicHotReadStore.Current.TryGetArticle(articleId, out _);
        string routeKey = PublicRouteIdentity.BuildArticleRouteKey(articleId);
        bool htmlReady = publicHotReadStore.Current.TryGetHtml(PublicHotReadRouteKeys.HtmlPath(routeKey), out _);
        return new ArticleCacheDiagnosisResponse(
            articleId,
            publicVisible,
            frameReady,
            htmlReady,
            publicVisible,
            publicVisible,
            publicVisible
                ? "published article should appear in search/sitemap and public hot read after rebuild"
                : "article is not public; search/sitemap/public cache should exclude it");
    }

    private SearchIndexDiagnosticsResponse GetSearchIndexDiagnostics()
    {
        string root = ResolveWebRoot();
        string manifestPath = Path.Combine(root, "search", "index.manifest.aeds");
        if (!File.Exists(manifestPath))
        {
            return new SearchIndexDiagnosticsResponse("missing", null, null, 0, 0, false, manifestPath, "manifest_missing");
        }

        try
        {
            using var stream = File.OpenRead(manifestPath);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            if (reader.ReadUInt32() != SearchManifestMagic || reader.ReadUInt32() != SearchManifestBinaryVersion)
            {
                return new SearchIndexDiagnosticsResponse("degraded", null, File.GetLastWriteTimeUtc(manifestPath), 0, 0, true, manifestPath, "manifest_header_invalid");
            }

            int schemaVersion = reader.ReadInt32();
            DateTimeOffset generatedAt = new(new DateTime(reader.ReadInt64(), DateTimeKind.Utc));
            string version = ReadManifestString(reader);
            int shardCount = reader.ReadInt32();
            return new SearchIndexDiagnosticsResponse("ok", version, generatedAt, schemaVersion, shardCount, true, manifestPath, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new SearchIndexDiagnosticsResponse("degraded", null, File.GetLastWriteTimeUtc(manifestPath), 0, 0, true, manifestPath, ex.GetType().Name);
        }
    }

    private static string ReadManifestString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > 4096)
        {
            throw new InvalidDataException("manifest_string_length_invalid");
        }

        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw new EndOfStreamException();
        }

        return Encoding.UTF8.GetString(bytes);
    }

    private IntegrityCheckResponse BuildCheck(
        string code,
        string title,
        IReadOnlyList<string> sampleKeys,
        string severity,
        bool autoFixAvailable,
        string detail)
        => new(
            code,
            title,
            sampleKeys.Count == 0 ? "ok" : "issue",
            sampleKeys.Count == 0 ? "ok" : severity,
            sampleKeys.Count,
            autoFixAvailable && sampleKeys.Count > 0,
            detail,
            sampleKeys.Take(10).ToArray(),
            autoFixAvailable ? sampleKeys.Take(10).Select(key => new AdminDiffResponse(key, "present", "fixed")).ToArray() : []);

    private async Task<IntegrityData> LoadIntegrityDataAsync(CancellationToken cancellationToken)
    {
        List<Article> articles = await db.Queryable<Article>().ToListAsync(cancellationToken);
        List<ArticleBody> bodies = await db.Queryable<ArticleBody>().ToListAsync(cancellationToken);
        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>().ToListAsync(cancellationToken);
        List<Category> categories = await db.Queryable<Category>().ToListAsync(cancellationToken);
        List<Tag> tags = await db.Queryable<Tag>().ToListAsync(cancellationToken);
        List<ArticleTag> articleTags = await db.Queryable<ArticleTag>().ToListAsync(cancellationToken);
        List<Comment> comments = await db.Queryable<Comment>().ToListAsync(cancellationToken);
        List<User> users = await db.Queryable<User>().ToListAsync(cancellationToken);
        List<UserSession> sessions = await db.Queryable<UserSession>().ToListAsync(cancellationToken);
        List<AssetLibraryItem> assets = await db.Queryable<AssetLibraryItem>().ToListAsync(cancellationToken);
        string webRoot = ResolveWebRoot();

        return new IntegrityData(articles, bodies, revisions, categories, tags, articleTags, comments, users, sessions, assets, webRoot);
    }

    private static IReadOnlyList<string> MissingBody(IntegrityData data)
        => data.Articles
            .Where(article => article.Status != ArticleStatus.Deleted && !data.BodyArticleIds.Contains(article.Id))
            .Select(article => $"article:{article.Id}")
            .ToArray();

    private static IReadOnlyList<string> BodyWithoutRevision(IntegrityData data)
        => data.Bodies
            .Where(body => !data.RevisionArticleIds.Contains(body.ArticleId))
            .Select(body => $"article:{body.ArticleId}")
            .ToArray();

    private static IReadOnlyList<string> MissingCategory(IntegrityData data)
        => data.Articles
            .Where(article => article.Status != ArticleStatus.Deleted && !data.CategoryIds.Contains(article.CategoryId))
            .Select(article => $"article:{article.Id}:category:{article.CategoryId}")
            .ToArray();

    private static IReadOnlyList<string> MissingArticleTag(IntegrityData data)
        => data.ArticleTags
            .Where(tag => !data.TagIds.Contains(tag.TagId))
            .Select(tag => $"article_tag:{tag.ArticleId}:{tag.TagId}")
            .ToArray();

    private static IReadOnlyList<string> MissingArticleTagArticle(IntegrityData data)
        => data.ArticleTags
            .Where(tag => !data.ArticleIds.Contains(tag.ArticleId))
            .Select(tag => $"article_tag:{tag.ArticleId}:{tag.TagId}")
            .ToArray();

    private static IReadOnlyList<string> MissingCommentArticle(IntegrityData data)
        => data.Comments
            .Where(comment => !data.ArticleIds.Contains(comment.ArticleId))
            .Select(comment => $"comment:{comment.Id}:article:{comment.ArticleId}")
            .ToArray();

    private static IReadOnlyList<string> InvalidCommentChain(IntegrityData data)
        => data.Comments
            .Where(comment => (comment.ParentId is > 0 && !data.CommentIds.Contains(comment.ParentId.Value))
                || (comment.RootId is > 0 && !data.CommentIds.Contains(comment.RootId.Value)))
            .Select(comment => $"comment:{comment.Id}")
            .ToArray();

    private static IReadOnlyList<string> DeletedUserSessions(IntegrityData data)
        => data.Sessions
            .Where(session => data.DeletedOrMissingUserIds.Contains(session.UserId) && session.RevokedAt is null)
            .Select(session => $"session:{session.SessionId}:user:{session.UserId}")
            .ToArray();

    private static IReadOnlyList<string> MissingAssetFiles(IntegrityData data)
        => data.Assets
            .Where(asset => IsUploadUrl(asset.Url) && !File.Exists(ToUploadPath(data.WebRoot, asset.Url)))
            .Select(asset => $"asset:{asset.Id}:{asset.Url}")
            .ToArray();

    private static IReadOnlyList<string> UntrackedUploads(IntegrityData data)
    {
        string uploadRoot = Path.Combine(data.WebRoot, "uploads");
        if (!Directory.Exists(uploadRoot))
        {
            return [];
        }

        HashSet<string> assetUrls = data.Assets
            .Select(static asset => asset.Url)
            .Where(static url => !string.IsNullOrWhiteSpace(url))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return Directory.EnumerateFiles(uploadRoot, "*", SearchOption.AllDirectories)
            .Select(path => "/uploads/" + Path.GetRelativePath(uploadRoot, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(url => !assetUrls.Contains(url))
            .Take(1000)
            .ToArray();
    }

    private static IReadOnlyList<AdminDiffResponse> BuildSafeFixDiffs(IntegrityData data)
    {
        List<AdminDiffResponse> diffs = [];
        diffs.AddRange(data.ArticleTags
            .Where(tag => !data.TagIds.Contains(tag.TagId) || !data.ArticleIds.Contains(tag.ArticleId))
            .Select(tag => new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted")));
        diffs.AddRange(data.Sessions
            .Where(session => data.DeletedOrMissingUserIds.Contains(session.UserId) && session.RevokedAt is null)
            .Select(session => new AdminDiffResponse($"session:{session.SessionId}", "active", "revoked")));
        return diffs;
    }

    private static bool IsUploadUrl(string? url)
        => !string.IsNullOrWhiteSpace(url) && url.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase);

    private static string ToUploadPath(string webRoot, string url)
        => Path.Combine(webRoot, url.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));

    private BackupArtifactResponse FindLatestArtifact(string backupRoot, string kind, string[] nameHints, string[] patterns)
    {
        FileInfo? latest = null;
        foreach (string pattern in patterns)
        {
            foreach (string file in Directory.EnumerateFiles(backupRoot, pattern, SearchOption.AllDirectories))
            {
                string fileName = Path.GetFileName(file);
                if (!nameHints.Any(hint => fileName.Contains(hint, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                var info = new FileInfo(file);
                if (latest is null || info.LastWriteTimeUtc > latest.LastWriteTimeUtc)
                {
                    latest = info;
                }
            }
        }

        return latest is null
            ? new BackupArtifactResponse(kind, "missing", null, null, null, "not_found")
            : new BackupArtifactResponse(kind, "ok", latest.FullName, latest.LastWriteTimeUtc, latest.Length, "latest");
    }

    private BackupArtifactResponse FindRestoreDrillArtifact(string backupRoot)
    {
        string[] candidates =
        [
            Path.Combine(backupRoot, "backup-restore-drill.json"),
            Path.Combine(environment.ContentRootPath, ".tmp", "operations", "backup-restore-drill.json")
        ];
        string? path = candidates.FirstOrDefault(File.Exists);
        return path is null
            ? new BackupArtifactResponse("restore-drill", "missing", null, null, null, "not_run")
            : new BackupArtifactResponse("restore-drill", "ok", path, File.GetLastWriteTimeUtc(path), new FileInfo(path).Length, "latest-report");
    }

    private static BackupArtifactResponse DirectoryArtifact(string kind, string path, string detail)
        => new(kind, "ok", path, Directory.GetLastWriteTimeUtc(path), null, detail);

    private string ResolveBackupRoot()
        => configuration["Operations:BackupRoot"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_BACKUP_ROOT")
            ?? Path.Combine(ResolveDataRoot(), "backups");

    private string ResolveDataRoot()
        => configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");

    private string ResolveDataProtectionKeyRingPath(string dataRoot)
        => configuration["DataProtection:KeyRingPath"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_PROTECTION_KEY_RING")
            ?? Path.Combine(dataRoot, "data-protection-keys");

    private string ResolveWebRoot()
        => string.IsNullOrWhiteSpace(environment.WebRootPath)
            ? Path.Combine(AppContext.BaseDirectory, "wwwroot")
            : environment.WebRootPath;

    private static AdminCacheActionResponse ActionResult(string action, string status, string detail)
        => new(action, status, detail, DateTimeOffset.UtcNow);

    private static string NormalizeAction(string? action)
        => string.IsNullOrWhiteSpace(action) ? "unknown" : action.Trim().ToLowerInvariant();

    private static string NormalizeTaskStatus(string status)
        => status is "ok" or "skipped" ? "ok" : status is "failed" or "rolled_back" ? "degraded" : status;

    private static AdminServiceStatusResponse BuildStatus(
        string key,
        string label,
        string status,
        string? detail,
        DateTimeOffset? updatedAt,
        IReadOnlyList<AdminMetricResponse> metrics)
        => new(key, label, status, detail, updatedAt, metrics);

    private static IReadOnlyList<AdminMetricResponse> Metrics(params (string Key, object? Value)[] values)
        => values.Select(static item => new AdminMetricResponse(item.Key, item.Value)).ToArray();

    private static string ReadinessStatus(ProductionHealthReport report, string key)
        => report.Checks.TryGetValue(key, out object? check) ? ExtractStatus(check) : "unknown";

    private static string? ReadinessDetail(ProductionHealthReport report, string key)
        => report.Checks.TryGetValue(key, out object? check) ? ExtractProperty(check, "error") ?? ExtractProperty(check, "status") : null;

    private static IReadOnlyList<AdminMetricResponse> ReadinessMetrics(ProductionHealthReport report, string key)
    {
        if (!report.Checks.TryGetValue(key, out object? check) || check is null)
        {
            return [];
        }

        return check.GetType()
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Where(static property => property.Name is not "status" and not "error")
            .Select(property => new AdminMetricResponse(property.Name, property.GetValue(check)))
            .ToArray();
    }

    private static string ExtractStatus(object? value)
        => ExtractProperty(value, "status") ?? "unknown";

    private static string? ExtractProperty(object? value, string propertyName)
        => value?.GetType()
            .GetProperty(propertyName, BindingFlags.IgnoreCase | BindingFlags.Instance | BindingFlags.Public)
            ?.GetValue(value)
            ?.ToString();

    private static DateTimeOffset? ToOffset(DateTime? value)
        => value is null ? null : new DateTimeOffset(DateTime.SpecifyKind(value.Value, DateTimeKind.Utc));

    private static string ResolveVersion()
        => Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? Assembly.GetEntryAssembly()?.GetName().Version?.ToString()
            ?? "unknown";

    private static string ResolveCommit()
        => Environment.GetEnvironmentVariable("GITHUB_SHA")
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_COMMIT")
            ?? "unknown";

    private sealed record IntegrityData(
        List<Article> Articles,
        List<ArticleBody> Bodies,
        List<ArticleRevision> Revisions,
        List<Category> Categories,
        List<Tag> Tags,
        List<ArticleTag> ArticleTags,
        List<Comment> Comments,
        List<User> Users,
        List<UserSession> Sessions,
        List<AssetLibraryItem> Assets,
        string WebRoot)
    {
        public HashSet<int> ArticleIds { get; } = Articles.Select(static item => item.Id).ToHashSet();
        public HashSet<int> BodyArticleIds { get; } = Bodies.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> RevisionArticleIds { get; } = Revisions.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> CategoryIds { get; } = Categories.Select(static item => item.Id).ToHashSet();
        public HashSet<int> TagIds { get; } = Tags.Select(static item => item.Id).ToHashSet();
        public HashSet<long> CommentIds { get; } = Comments.Select(static item => item.Id).ToHashSet();
        public HashSet<int> DeletedOrMissingUserIds { get; } = Sessions
            .Select(static session => session.UserId)
            .Where(userId => !Users.Any(user => user.Id == userId && user.Status != 2 && user.DeletedAt is null))
            .ToHashSet();
    }
}

using System.Data.Common;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
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
    IPublicAotInvalidationService publicAotInvalidationService,
    IArticleDetailAedsArtifactMaintenanceService articleDetailAedsMaintenance,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IUnifiedCache cache,
    ILogger<AdminOperationsService> logger)
{
    private const uint SearchManifestMagic = 0x4D495346;
    private const uint SearchManifestBinaryVersion = 1;
    private const string IntegrityFixPhrase = "APPLY_SAFE_FIXES";
    private const int RecentErrorQueryLimit = 50;
    private const int RecentErrorDisplayLimit = 5;
    private const int RecentErrorMessageMaxLength = 140;
    private const int RecentErrorDetailMaxLength = 2000;
    private const int MaxUntrackedUploadScanFiles = 10_000;

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
            BuildStatus("public-hot-read", "PublicHotRead", publicHot.LastBuildStatus == "failed" || publicHot.ResidentByteBudgetExceeded ? "degraded" : "ok", publicHot.LastError ?? publicHot.LastBuildReason, publicHot.LastBuildAt, Metrics(("version", publicHot.Version), ("articleFrames", publicHot.ArticleFrameCount), ("htmlFrames", publicHot.HtmlFrameCount), ("residentBytes", publicHot.ResidentBytes), ("htmlTemplateResidentBytes", publicHot.HtmlTemplateResidentBytes), ("residentByteBudget", publicHot.ResidentByteBudget))),
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

        IReadOnlyList<RecentOpsErrorResponse> recentErrors = await LoadRecentErrorsAsync(cancellationToken);
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
        IReadOnlyList<ArticleCachePolicyDiagnosticsResponse> articlePolicies = await BuildArticleCachePolicyDiagnosticsAsync(cancellationToken);

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
            await cacheInvalidationRuntime.SnapshotAsync(cancellationToken),
            await hotStatsInvalidation.SnapshotAsync(cancellationToken),
            new OutputCacheDiagnosticsResponse(
                "ok",
                Enabled: true,
                Tags: Enum.GetNames<CacheTag>(),
                Detail: "ASP.NET OutputCache + IHttpCacheInvalidator tag eviction"),
            articlePolicies,
            publicHotReadCounters.Snapshot(),
            article);
    }

    private async Task<IReadOnlyList<ArticleCachePolicyDiagnosticsResponse>> BuildArticleCachePolicyDiagnosticsAsync(CancellationToken cancellationToken)
    {
        CachePolicyId[] policyIds = ArticleCacheOwnershipCatalog.Policies.Keys.OrderBy(static policy => (int)policy).ToArray();
        IReadOnlyList<CachePolicyStorageSnapshot> storage = await cache.GetPolicyStorageSnapshotsAsync(policyIds, cancellationToken);
        Dictionary<CachePolicyId, CachePolicyStorageSnapshot> storageByPolicy = storage.ToDictionary(static item => item.PolicyId);
        IReadOnlyList<CacheOperationRuntimeCounter> counters = FsusObservability.GetCacheOperationCounters();
        var result = new List<ArticleCachePolicyDiagnosticsResponse>(policyIds.Length);
        foreach (CachePolicyId policyId in policyIds)
        {
            ArticleCacheOwnership ownership = ArticleCacheOwnershipCatalog.Policies[policyId];
            storageByPolicy.TryGetValue(policyId, out CachePolicyStorageSnapshot? snapshot);
            string policyName = policyId.ToString();
            long hits = counters
                .Where(counter => string.Equals(counter.Policy, policyName, StringComparison.Ordinal)
                    && counter.Result.Contains("hit", StringComparison.OrdinalIgnoreCase))
                .Sum(static counter => counter.Count);
            long misses = counters
                .Where(counter => string.Equals(counter.Policy, policyName, StringComparison.Ordinal)
                    && counter.Result.Contains("miss", StringComparison.OrdinalIgnoreCase))
                .Sum(static counter => counter.Count);
            result.Add(new ArticleCachePolicyDiagnosticsResponse(
                policyId,
                policyName,
                ownership.Owner,
                ownership.Consumers,
                ownership.Writes,
                ownership.Invalidation,
                ownership.Retention,
                snapshot?.KeyCount ?? 0,
                snapshot?.Bytes ?? 0,
                hits,
                misses));
        }

        return result;
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
                if (request.ArticleId is > 0)
                {
                    await publicAotInvalidationService.InvalidateArticleMutationAsync(request.ArticleId, null, null, cancellationToken);
                }
                else
                {
                    await publicAotInvalidationService.InvalidateAllAsync(cancellationToken);
                }

                bool queued = publicHotArtifactUpdateQueue.TryEnqueue(request.ArticleId, "admin-cache-action");
                return ActionResult(action, queued ? "queued" : "degraded", queued ? "public hot/AOT rebuild queued" : "AOT invalidated; public hot rebuild queue rejected");
            case "output-cache-clear":
                await Task.WhenAll(
                    cacheInvalidationDispatcher.InvalidateArticleMutationAsync(request.ArticleId, cancellationToken),
                    cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken));
                return ActionResult(action, "ok", "output/cache tags invalidated");
            case "recompute-article-rights":
            {
                ArticleDetailAedsArtifactMaintenanceResult result =
                    await articleDetailAedsMaintenance.RecomputeArticleRightsAsync(cancellationToken);
                return ActionResult(action, result.Failed == 0 ? "ok" : "degraded", result.ToDetail());
            }
            case "rebuild-article-detail-aeds-v3":
            {
                bool all = request.ArticleId is not > 0;
                ArticleDetailAedsArtifactMaintenanceResult result =
                    await articleDetailAedsMaintenance.RebuildArticleDetailAedsV3Async(all, request.ArticleId, cancellationToken);
                return ActionResult(action, result.Failed == 0 ? "ok" : "degraded", result.ToDetail());
            }
            case "sitemap-feed-refresh":
                await cacheInvalidationDispatcher.InvalidateSeoAsync(cancellationToken);
                return ActionResult(action, "ok", "feed/sitemap cache invalidated");
            default:
                return ActionResult(action, "unsupported", "supported actions: search-rebuild, aot-rebuild, public-hot-rebuild, output-cache-clear, recompute-article-rights, rebuild-article-detail-aeds-v3, sitemap-feed-refresh");
        }
    }

    public async Task<IntegrityReportResponse> InspectIntegrityAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<IntegrityCheckResponse> checks = await BuildIntegrityChecksAsync(cancellationToken);

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
        IReadOnlyList<AdminDiffResponse> diffs = await BuildSafeFixDiffsAsync(cancellationToken);
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
        List<AdminDiffResponse> diffs = [];

        if (codes.Contains("article_tag_missing_tag") || codes.Contains("article_tag_missing_article"))
        {
            diffs.AddRange(await DeleteInvalidArticleTagsAsync(await QueryInvalidArticleTagsAsync(cancellationToken), cancellationToken));
        }

        if (codes.Contains("session_deleted_user"))
        {
            diffs.AddRange(await RevokeDeletedUserSessionsAsync(await QueryDeletedUserSessionsAsync(cancellationToken), cancellationToken));
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
                new DangerousOperationRuleResponse("admin-step-up", "Admin step-up proof", ["批量封禁匿名账号", "撤销账号会话", "导出站点备份", "应用数据巡检修复"]),
                new DangerousOperationRuleResponse("diff-preview", "展示 changed fields", ["系统设置保存", "内容导入", "revision rollback", "静态页面修改"])
            ],
            ["system-settings-save", "content-import", "revision-rollback", "taxonomy-update", "integrity-fix"],
            ["comment-bulk-moderation", "anonymous-account-suspend", "session-revoke", "site-backup-export", "integrity-fix"],
            "single-author-v1");

    private async Task<T> QueryWithNewClientAsync<T>(Func<ISqlSugarClient, Task<T>> query)
    {
        using SqlSugarClient queryDb = db.CopyNew();
        return await query(queryDb);
    }

    private async Task<QueueBacklogResponse> GetQueueBacklogAsync(AuditLogRuntimeSnapshot audit, CancellationToken cancellationToken)
    {
        Task<int> pendingTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.Status == "pending")
            .CountAsync(cancellationToken));
        Task<int> failedTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.Status == "failed")
            .CountAsync(cancellationToken));
        int pending = await pendingTask;
        int failed = await failedTask;
        return new QueueBacklogResponse(pending, failed, audit.QueuedCount, audit.DroppedCount);
    }

    private async Task<IReadOnlyList<RecentOpsErrorResponse>> LoadRecentErrorsAsync(CancellationToken cancellationToken)
    {
        List<RecentOpsErrorAuditRow> rows = await db.Queryable<AuditLog>()
            .Where(item => item.Severity == "error" || item.Severity == "critical")
            .OrderBy(item => item.OccurredAtUtc, OrderByType.Desc)
            .Take(RecentErrorQueryLimit)
            .Select(item => new RecentOpsErrorAuditRow
            {
                OccurredAtUtc = item.OccurredAtUtc,
                Severity = item.Severity,
                Action = item.Action,
                EventInfo = item.EventInfo
            })
            .ToListAsync(cancellationToken);

        return BuildRecentErrorResponses(rows);
    }

    internal static IReadOnlyList<RecentOpsErrorResponse> BuildRecentErrorResponses(
        IEnumerable<RecentOpsErrorAuditRow> rows,
        int maxItems = RecentErrorDisplayLimit)
        => rows.Select(MapRecentError)
            .GroupBy(RecentErrorGroupKey, StringComparer.OrdinalIgnoreCase)
            .Select(static group =>
            {
                RecentOpsErrorResponse latest = group.OrderByDescending(static item => item.OccurredAt).First();
                return latest with { Count = group.Sum(static item => Math.Max(1, item.Count)) };
            })
            .OrderByDescending(static item => item.OccurredAt)
            .Take(maxItems)
            .ToArray();

    private static RecentOpsErrorResponse MapRecentError(RecentOpsErrorAuditRow row)
    {
        string action = NormalizeRecentErrorToken(row.Action, "unknown");
        string severity = NormalizeRecentErrorToken(row.Severity, "error").ToLowerInvariant();
        string cleaned = CleanRecentErrorDetail(row.EventInfo, action);
        (string message, string? detail) = SummarizeRecentError(cleaned);

        return new RecentOpsErrorResponse(
            ToUtcOffset(row.OccurredAtUtc),
            severity,
            action,
            message,
            detail,
            1);
    }

    private static string RecentErrorGroupKey(RecentOpsErrorResponse error)
        => $"{error.Action}\n{NormalizeRecentErrorToken(error.Message, string.Empty)}";

    private static DateTimeOffset ToUtcOffset(DateTime value)
    {
        DateTime utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return new DateTimeOffset(utc);
    }

    private static string CleanRecentErrorDetail(string? eventInfo, string action)
    {
        string cleaned = RemoveSqlProjectionArtifacts(CollapseWhitespace(eventInfo));
        if (cleaned.StartsWith(action, StringComparison.OrdinalIgnoreCase))
        {
            cleaned = cleaned[action.Length..].TrimStart(' ', ':', '-', '|');
        }

        return string.IsNullOrWhiteSpace(cleaned) ? "未提供错误详情" : cleaned;
    }

    private static string RemoveSqlProjectionArtifacts(string value)
    {
        string result = value;
        int castIndex = result.IndexOf("CAST(", StringComparison.OrdinalIgnoreCase);
        while (castIndex >= 0)
        {
            int endIndex = result.IndexOf(')', castIndex);
            if (endIndex < 0)
            {
                break;
            }

            result = string.Concat(result.AsSpan(0, castIndex), " ", result.AsSpan(endIndex + 1));
            castIndex = result.IndexOf("CAST(", StringComparison.OrdinalIgnoreCase);
        }

        return CollapseWhitespace(result);
    }

    private static (string Message, string? Detail) SummarizeRecentError(string cleaned)
    {
        int separatorIndex = cleaned.IndexOf(':', StringComparison.Ordinal);
        if (separatorIndex > 0 && separatorIndex <= RecentErrorMessageMaxLength)
        {
            string message = TrimToLength(cleaned[..separatorIndex].Trim(), RecentErrorMessageMaxLength);
            string detail = NormalizeRecentErrorDetail(cleaned[(separatorIndex + 1)..]);
            return (string.IsNullOrWhiteSpace(message) ? "未提供错误详情" : message, string.IsNullOrWhiteSpace(detail) ? null : detail);
        }

        if (cleaned.Length <= RecentErrorMessageMaxLength)
        {
            return (cleaned, null);
        }

        return (TrimToLength(cleaned, RecentErrorMessageMaxLength), TrimToLength(cleaned, RecentErrorDetailMaxLength));
    }

    private static string NormalizeRecentErrorDetail(string value)
    {
        string detail = CollapseWhitespace(value).Trim();
        if (detail.Length >= 2 && detail[0] == '"' && detail[^1] == '"')
        {
            detail = detail[1..^1].Trim();
        }

        return TrimToLength(detail, RecentErrorDetailMaxLength);
    }

    private static string NormalizeRecentErrorToken(string? value, string fallback)
    {
        string token = CollapseWhitespace(value);
        return string.IsNullOrWhiteSpace(token) ? fallback : token;
    }

    private static string CollapseWhitespace(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        bool previousWasWhitespace = false;
        foreach (char character in value)
        {
            if (char.IsWhiteSpace(character))
            {
                if (!previousWasWhitespace)
                {
                    builder.Append(' ');
                    previousWasWhitespace = true;
                }

                continue;
            }

            builder.Append(character);
            previousWasWhitespace = false;
        }

        return builder.ToString().Trim();
    }

    private static string TrimToLength(string value, int maxLength)
    {
        if (value.Length <= maxLength)
        {
            return value;
        }

        return string.Concat(value.AsSpan(0, Math.Max(0, maxLength - 3)).TrimEnd(), "...");
    }

    private async Task<DistributionDiagnosticsResponse> GetDistributionDiagnosticsAsync(CancellationToken cancellationToken)
    {
        try
        {
            DistributionDiagnosticsCounts counts = await distributionService.GetDiagnosticsCountsAsync(cancellationToken);
            return new DistributionDiagnosticsResponse(
                "ok",
                counts.CheckedAt,
                counts.SitemapUrlCount,
                counts.FeedItemCount,
                counts.CheckedAt,
                counts.CheckedAt,
                null);
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

    private IntegrityCheckResponse BuildCheck(
        string code,
        string title,
        IntegrityCheckSample sample,
        string severity,
        bool autoFixAvailable,
        string detail)
        => new(
            code,
            title,
            sample.Count == 0 ? "ok" : "issue",
            sample.Count == 0 ? "ok" : severity,
            sample.Count,
            autoFixAvailable && sample.Count > 0,
            sample.ScannedFileCount > 0 ? $"{detail} scannedFiles={sample.ScannedFileCount}" : detail,
            sample.SampleKeys,
            autoFixAvailable ? sample.SampleKeys.Select(key => new AdminDiffResponse(key, "present", "fixed")).ToArray() : []);

    private async Task<IReadOnlyList<IntegrityCheckResponse>> BuildIntegrityChecksAsync(CancellationToken cancellationToken)
    {
        IntegrityCheckSample missingBody = await RunIntegritySqlCheckAsync("article_missing_body", $$"""
            SELECT 'article:' || a.id AS sample_key
            FROM article a
            LEFT JOIN article_body b ON b.article_id = a.id
            WHERE a.status <> {{(int)ArticleStatus.Deleted}}
              AND b.article_id IS NULL
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample bodyWithoutRevision = await RunIntegritySqlCheckAsync("article_body_without_revision", """
            SELECT 'article:' || b.article_id AS sample_key
            FROM article_body b
            LEFT JOIN article_revision r ON r.article_id = b.article_id
            WHERE r.article_id IS NULL
            ORDER BY b.article_id
            """, cancellationToken);
        IntegrityCheckSample missingCategory = await RunIntegritySqlCheckAsync("article_missing_category", $$"""
            SELECT 'article:' || a.id || ':category:' || a.categoryid AS sample_key
            FROM article a
            LEFT JOIN category c ON c.id = a.categoryid
            WHERE a.status <> {{(int)ArticleStatus.Deleted}}
              AND c.id IS NULL
            ORDER BY a.id
            """, cancellationToken);
        IntegrityCheckSample missingTag = await RunIntegritySqlCheckAsync("article_tag_missing_tag", """
            SELECT 'article_tag:' || at.articleid || ':' || at.tagid AS sample_key
            FROM article_tag at
            LEFT JOIN tag t ON t.id = at.tagid
            WHERE t.id IS NULL
            ORDER BY at.articleid, at.tagid
            """, cancellationToken);
        IntegrityCheckSample missingTagArticle = await RunIntegritySqlCheckAsync("article_tag_missing_article", """
            SELECT 'article_tag:' || at.articleid || ':' || at.tagid AS sample_key
            FROM article_tag at
            LEFT JOIN article a ON a.id = at.articleid
            WHERE a.id IS NULL
            ORDER BY at.articleid, at.tagid
            """, cancellationToken);
        IntegrityCheckSample missingCommentArticle = await RunIntegritySqlCheckAsync("comment_missing_article", """
            SELECT 'comment:' || c.id || ':article:' || c.article_id AS sample_key
            FROM comment c
            LEFT JOIN article a ON a.id = c.article_id
            WHERE a.id IS NULL
            ORDER BY c.id
            """, cancellationToken);
        IntegrityCheckSample invalidCommentChain = await RunIntegritySqlCheckAsync("comment_chain_invalid", """
            SELECT 'comment:' || c.id AS sample_key
            FROM comment c
            LEFT JOIN comment p ON p.id = c.parent_id
            LEFT JOIN comment r ON r.id = c.root_id
            WHERE (c.parent_id IS NOT NULL AND c.parent_id > 0 AND p.id IS NULL)
               OR (c.root_id IS NOT NULL AND c.root_id > 0 AND r.id IS NULL)
            ORDER BY c.id
            """, cancellationToken);
        IntegrityCheckSample deletedUserSessions = await RunIntegritySqlCheckAsync("session_deleted_user", """
            SELECT 'session:' || s.sessionid || ':user:' || s.userid AS sample_key
            FROM sys_user_session s
            LEFT JOIN sys_user u ON u.id = s.userid
            WHERE s.revokedat IS NULL
              AND (u.id IS NULL OR u.status = 2 OR u.deleted_at IS NOT NULL)
            ORDER BY s.sessionid
            """, cancellationToken);
        IntegrityCheckSample untrackedUploads = await BuildUntrackedUploadsCheckAsync(cancellationToken);
        IntegrityCheckSample missingAssetFiles = await BuildMissingAssetFilesCheckAsync(cancellationToken);

        return
        [
            BuildCheck("article_missing_body", "文章缺少 ArticleBody", missingBody, "warning", true, "可通过内容导入或人工补正文修复。"),
            BuildCheck("article_body_without_revision", "正文缺少 revision", bodyWithoutRevision, "warning", false, "需要人工确认首个 revision 的正文来源。"),
            BuildCheck("article_missing_category", "文章引用不存在分类", missingCategory, "error", false, "需要重新指定分类或恢复分类。"),
            BuildCheck("article_tag_missing_tag", "文章标签关联不存在 tag", missingTag, "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("article_tag_missing_article", "标签关联不存在文章", missingTagArticle, "warning", true, "安全修复会删除无效 article_tag 关联。"),
            BuildCheck("comment_missing_article", "评论指向不存在文章", missingCommentArticle, "error", false, "需要人工确认评论是否删除或迁移。"),
            BuildCheck("comment_chain_invalid", "评论 root/parent 链异常", invalidCommentChain, "warning", false, "需要人工判断楼层结构。"),
            BuildCheck("session_deleted_user", "session 指向已注销用户", deletedUserSessions, "warning", true, "安全修复会撤销这些 session。"),
            BuildCheck("upload_untracked", "uploads 文件未进 asset library", untrackedUploads, "info", false, "可通过文章资产重建补齐。"),
            BuildCheck("asset_missing_file", "asset library 指向不存在文件", missingAssetFiles, "warning", false, "需要人工确认是否清理资产记录。"),
            BuildCheck("sitemap_visibility", "sitemap 公开性", new IntegrityCheckSample(0, []), "info", false, "sitemap 文章、分类、标签均复用 published visibility 过滤。"),
            BuildCheck("search_visibility", "搜索公开性", new IntegrityCheckSample(0, []), "info", false, "SearchIndexService 只加载 published 且已到发布时间的文章。"),
            BuildCheck("taxonomy_count_runtime", "taxonomy 公开计数", new IntegrityCheckSample(0, []), "info", false, "后台 taxonomy 计数实时聚合，不依赖易漂移的持久计数字段。")
        ];
    }

    private async Task<IntegrityCheckSample> RunIntegritySqlCheckAsync(string code, string issueSql, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        int count = await db.Ado.GetIntAsync($"SELECT COUNT(*) FROM ({issueSql}) AS integrity_issues;");
        var sampleKeys = new List<string>(Math.Min(10, Math.Max(0, count)));
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync($"SELECT sample_key FROM ({issueSql}) AS integrity_issues LIMIT 10;");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            sampleKeys.Add(reader.IsDBNull(0) ? string.Empty : reader.GetString(0));
        }

        IntegrityCheckSample sample = new(count, sampleKeys);
        FsusObservability.RecordAdminIntegrityCheck(code, FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<IntegrityCheckSample> BuildUntrackedUploadsCheckAsync(CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        string uploadRoot = Path.Combine(ResolveWebRoot(), "uploads");
        if (!Directory.Exists(uploadRoot))
        {
            IntegrityCheckSample empty = new(0, []);
            FsusObservability.RecordAdminIntegrityCheck("upload_untracked", FsusObservability.GetElapsed(started), empty.Count, empty.SampleKeys.Count, empty.ScannedFileCount);
            return empty;
        }

        HashSet<string> assetUrls = await LoadAssetUrlSetAsync(cancellationToken);
        var samples = new List<string>(10);
        int count = 0;
        int scanned = 0;
        foreach (string path in EnumerateUploadFilesBounded(uploadRoot, MaxUntrackedUploadScanFiles))
        {
            cancellationToken.ThrowIfCancellationRequested();
            scanned++;
            string url = "/uploads/" + Path.GetRelativePath(uploadRoot, path).Replace(Path.DirectorySeparatorChar, '/');
            if (assetUrls.Contains(url))
            {
                continue;
            }

            count++;
            if (samples.Count < 10)
            {
                samples.Add(url);
            }
        }

        IntegrityCheckSample sample = new(count, samples, scanned);
        FsusObservability.RecordAdminIntegrityCheck("upload_untracked", FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<IntegrityCheckSample> BuildMissingAssetFilesCheckAsync(CancellationToken cancellationToken)
    {
        long started = Stopwatch.GetTimestamp();
        List<IntegrityAssetRow> assets = await db.Queryable<AssetLibraryItem>()
            .Where(asset => asset.Url.StartsWith("/uploads/"))
            .Select(asset => new IntegrityAssetRow { Id = asset.Id, Url = asset.Url })
            .ToListAsync(cancellationToken);
        string webRoot = ResolveWebRoot();
        var samples = new List<string>(10);
        int count = 0;
        foreach (IntegrityAssetRow asset in assets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryResolveUploadPath(webRoot, asset.Url, out string path) || !File.Exists(path))
            {
                count++;
                if (samples.Count < 10)
                {
                    samples.Add($"asset:{asset.Id}:{asset.Url}");
                }
            }
        }

        IntegrityCheckSample sample = new(count, samples, assets.Count);
        FsusObservability.RecordAdminIntegrityCheck("asset_missing_file", FsusObservability.GetElapsed(started), sample.Count, sample.SampleKeys.Count, sample.ScannedFileCount);
        return sample;
    }

    private async Task<HashSet<string>> LoadAssetUrlSetAsync(CancellationToken cancellationToken)
    {
        List<string> urls = await db.Queryable<AssetLibraryItem>()
            .Where(asset => asset.Url != null && asset.Url != "")
            .Select(asset => asset.Url)
            .ToListAsync(cancellationToken);
        return urls.ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private async Task<IntegrityData> LoadIntegrityDataAsync(CancellationToken cancellationToken)
    {
        Task<List<IntegrityArticleRow>> articlesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Article>()
            .Select(article => new IntegrityArticleRow
            {
                Id = article.Id,
                CategoryId = article.CategoryId,
                Status = article.Status
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleBodyRow>> bodiesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleBody>()
            .Select(body => new IntegrityArticleBodyRow { ArticleId = body.ArticleId })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleRevisionRow>> revisionsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleRevision>()
            .Select(revision => new IntegrityArticleRevisionRow { ArticleId = revision.ArticleId })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityCategoryRow>> categoriesTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Category>()
            .Select(category => new IntegrityCategoryRow { Id = category.Id })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityTagRow>> tagsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Tag>()
            .Select(tag => new IntegrityTagRow { Id = tag.Id })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityArticleTagRow>> articleTagsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<ArticleTag>()
            .Select(tag => new IntegrityArticleTagRow
            {
                ArticleId = tag.ArticleId,
                TagId = tag.TagId
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityCommentRow>> commentsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<Comment>()
            .Select(comment => new IntegrityCommentRow
            {
                Id = comment.Id,
                ArticleId = comment.ArticleId,
                ParentId = comment.ParentId,
                RootId = comment.RootId
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityUserRow>> usersTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<User>()
            .Select(user => new IntegrityUserRow
            {
                Id = user.Id,
                Status = user.Status,
                DeletedAt = user.DeletedAt
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegritySessionRow>> sessionsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<UserSession>()
            .Select(session => new IntegritySessionRow
            {
                SessionId = session.SessionId,
                UserId = session.UserId,
                RevokedAt = session.RevokedAt
            })
            .ToListAsync(cancellationToken));
        Task<List<IntegrityAssetRow>> assetsTask = QueryWithNewClientAsync(queryDb => queryDb.Queryable<AssetLibraryItem>()
            .Select(asset => new IntegrityAssetRow
            {
                Id = asset.Id,
                Url = asset.Url
            })
            .ToListAsync(cancellationToken));
        List<IntegrityArticleRow> articles = await articlesTask;
        List<IntegrityArticleBodyRow> bodies = await bodiesTask;
        List<IntegrityArticleRevisionRow> revisions = await revisionsTask;
        List<IntegrityCategoryRow> categories = await categoriesTask;
        List<IntegrityTagRow> tags = await tagsTask;
        List<IntegrityArticleTagRow> articleTags = await articleTagsTask;
        List<IntegrityCommentRow> comments = await commentsTask;
        List<IntegrityUserRow> users = await usersTask;
        List<IntegritySessionRow> sessions = await sessionsTask;
        List<IntegrityAssetRow> assets = await assetsTask;

        string webRoot = ResolveWebRoot();

        return new IntegrityData(
            articles,
            bodies,
            revisions,
            categories,
            tags,
            articleTags,
            comments,
            users,
            sessions,
            assets,
            webRoot);
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
            .Where(asset => IsUploadUrl(asset.Url) &&
                (!TryResolveUploadPath(data.WebRoot, asset.Url, out string path) || !File.Exists(path)))
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
        return EnumerateUploadFilesBounded(uploadRoot, MaxUntrackedUploadScanFiles)
            .Select(path => "/uploads/" + Path.GetRelativePath(uploadRoot, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(url => !assetUrls.Contains(url))
            .Take(1000)
            .ToArray();
    }

    private async Task<IReadOnlyList<AdminDiffResponse>> BuildSafeFixDiffsAsync(CancellationToken cancellationToken)
    {
        List<IntegrityArticleTagRow> invalidTags = await QueryInvalidArticleTagsAsync(cancellationToken);
        List<IntegritySessionRow> sessions = await QueryDeletedUserSessionsAsync(cancellationToken);
        var diffs = new List<AdminDiffResponse>(invalidTags.Count + sessions.Count);
        diffs.AddRange(invalidTags.Select(tag => new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted")));
        diffs.AddRange(sessions.Select(session => new AdminDiffResponse($"session:{session.SessionId}", "active", "revoked")));
        return diffs;
    }

    private async Task<List<IntegrityArticleTagRow>> QueryInvalidArticleTagsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT at.articleid AS "ArticleId", at.tagid AS "TagId"
            FROM article_tag at
            LEFT JOIN tag t ON t.id = at.tagid
            LEFT JOIN article a ON a.id = at.articleid
            WHERE t.id IS NULL OR a.id IS NULL
            ORDER BY at.articleid, at.tagid;
            """);
        var result = new List<IntegrityArticleTagRow>();
        int fArticleId = reader.GetOrdinal("ArticleId");
        int fTagId = reader.GetOrdinal("TagId");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new IntegrityArticleTagRow
            {
                ArticleId = reader.GetInt32(fArticleId),
                TagId = reader.GetInt32(fTagId)
            });
        }

        return result;
    }

    private async Task<List<IntegritySessionRow>> QueryDeletedUserSessionsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT s.sessionid AS "SessionId", s.userid AS "UserId", s.revokedat AS "RevokedAt"
            FROM sys_user_session s
            LEFT JOIN sys_user u ON u.id = s.userid
            WHERE s.revokedat IS NULL
              AND (u.id IS NULL OR u.status = 2 OR u.deleted_at IS NOT NULL)
            ORDER BY s.sessionid;
            """);
        var result = new List<IntegritySessionRow>();
        int fSessionId = reader.GetOrdinal("SessionId");
        int fUserId = reader.GetOrdinal("UserId");
        int fRevokedAt = reader.GetOrdinal("RevokedAt");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new IntegritySessionRow
            {
                SessionId = reader.GetString(fSessionId),
                UserId = reader.GetInt32(fUserId),
                RevokedAt = reader.IsDBNull(fRevokedAt) ? null : reader.GetDateTime(fRevokedAt)
            });
        }

        return result;
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

    private async Task<IReadOnlyList<AdminDiffResponse>> DeleteInvalidArticleTagsAsync(
        IReadOnlyList<IntegrityArticleTagRow> invalidTags,
        CancellationToken cancellationToken)
    {
        if (invalidTags.Count == 0)
        {
            return [];
        }

        var diffs = new List<AdminDiffResponse>(invalidTags.Count);
        for (int i = 0; i < invalidTags.Count; i++)
        {
            IntegrityArticleTagRow tag = invalidTags[i];
            diffs.Add(new AdminDiffResponse($"article_tag:{tag.ArticleId}:{tag.TagId}", "present", "deleted"));
        }

        const int BatchSize = 500;
        for (int offset = 0; offset < invalidTags.Count; offset += BatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count = Math.Min(BatchSize, invalidTags.Count - offset);
            await DeleteArticleTagBatchAsync(invalidTags, offset, count);
        }

        return diffs;
    }

    private async Task DeleteArticleTagBatchAsync(
        IReadOnlyList<IntegrityArticleTagRow> tags,
        int offset,
        int count)
    {
        var sql = new StringBuilder("DELETE FROM article_tag WHERE ");
        var parameters = new List<SugarParameter>(count * 2);
        for (int i = 0; i < count; i++)
        {
            if (i > 0)
            {
                sql.Append(" OR ");
            }

            int parameterIndex = offset + i;
            string articleParameter = $"@article_id_{parameterIndex}";
            string tagParameter = $"@tag_id_{parameterIndex}";
            sql.Append("(articleid = ")
                .Append(articleParameter)
                .Append(" AND tagid = ")
                .Append(tagParameter)
                .Append(')');
            IntegrityArticleTagRow tag = tags[parameterIndex];
            parameters.Add(new SugarParameter(articleParameter, tag.ArticleId));
            parameters.Add(new SugarParameter(tagParameter, tag.TagId));
        }

        await db.Ado.ExecuteCommandAsync(sql.ToString(), parameters.ToArray());
    }

    private async Task<IReadOnlyList<AdminDiffResponse>> RevokeDeletedUserSessionsAsync(
        IReadOnlyList<IntegritySessionRow> sessions,
        CancellationToken cancellationToken)
    {
        if (sessions.Count == 0)
        {
            return [];
        }

        var diffs = new List<AdminDiffResponse>(sessions.Count);
        for (int i = 0; i < sessions.Count; i++)
        {
            diffs.Add(new AdminDiffResponse($"session:{sessions[i].SessionId}", "active", "revoked"));
        }

        DateTime now = DateTime.UtcNow;
        const int BatchSize = 500;
        for (int offset = 0; offset < sessions.Count; offset += BatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string[] sessionIds = sessions
                .Skip(offset)
                .Take(Math.Min(BatchSize, sessions.Count - offset))
                .Select(static session => session.SessionId)
                .ToArray();
            await db.Updateable<UserSession>()
                .SetColumns(item => item.RevokedAt == now)
                .SetColumns(item => item.RevokeReason == "integrity_safe_fix_deleted_user")
                .Where(item => sessionIds.Contains(item.SessionId))
                .ExecuteCommandAsync(cancellationToken);
        }

        return diffs;
    }

    private static bool IsUploadUrl(string? url)
        => !string.IsNullOrWhiteSpace(url) && url.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> EnumerateUploadFilesBounded(string uploadRoot, int maxFiles)
    {
        if (maxFiles <= 0)
        {
            yield break;
        }

        var pending = new Stack<string>();
        pending.Push(uploadRoot);
        int yielded = 0;
        while (pending.Count > 0 && yielded < maxFiles)
        {
            string current = pending.Pop();
            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(current);
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (string file in files)
            {
                if (yielded >= maxFiles)
                {
                    yield break;
                }

                yielded++;
                yield return file;
            }

            IEnumerable<string> directories;
            try
            {
                directories = Directory.EnumerateDirectories(current);
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (string directory in directories)
            {
                pending.Push(directory);
            }
        }
    }

    private static bool TryResolveUploadPath(string webRoot, string url, out string path)
    {
        path = string.Empty;
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        string normalizedUrl = url.Trim().Replace('\\', '/');
        const string uploadPrefix = "/uploads/";
        if (!normalizedUrl.StartsWith(uploadPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        string uploadRoot = Path.GetFullPath(Path.Combine(webRoot, "uploads"));
        return CanonicalPathBoundary.TryResolveRelative(
            uploadRoot,
            normalizedUrl[uploadPrefix.Length..],
            out path);
    }

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
        => TextHelpers.LowerTrimmed(action) ?? "unknown";

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
        => report.Checks.TryGetValue(key, out object? check) && check is IProductionHealthCheck health
            ? health.Status
            : "unknown";

    private static string? ReadinessDetail(ProductionHealthReport report, string key)
        => report.Checks.TryGetValue(key, out object? check)
            ? check switch
            {
                ProductionDependencyHealthCheck dependency => dependency.Error ?? dependency.Status,
                IProductionHealthCheck health => health.Status,
                _ => null
            }
            : null;

    private static IReadOnlyList<AdminMetricResponse> ReadinessMetrics(ProductionHealthReport report, string key)
    {
        return report.Checks.TryGetValue(key, out object? check) && check is ProductionDependencyHealthCheck { LatencyMs: not null } dependency
            ? Metrics(("latencyMs", dependency.LatencyMs.Value))
            : [];
    }

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
        List<IntegrityArticleRow> Articles,
        List<IntegrityArticleBodyRow> Bodies,
        List<IntegrityArticleRevisionRow> Revisions,
        List<IntegrityCategoryRow> Categories,
        List<IntegrityTagRow> Tags,
        List<IntegrityArticleTagRow> ArticleTags,
        List<IntegrityCommentRow> Comments,
        List<IntegrityUserRow> Users,
        List<IntegritySessionRow> Sessions,
        List<IntegrityAssetRow> Assets,
        string WebRoot)
    {
        public HashSet<int> ArticleIds { get; } = Articles.Select(static item => item.Id).ToHashSet();
        public HashSet<int> BodyArticleIds { get; } = Bodies.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> RevisionArticleIds { get; } = Revisions.Select(static item => item.ArticleId).ToHashSet();
        public HashSet<int> CategoryIds { get; } = Categories.Select(static item => item.Id).ToHashSet();
        public HashSet<int> TagIds { get; } = Tags.Select(static item => item.Id).ToHashSet();
        public HashSet<long> CommentIds { get; } = Comments.Select(static item => item.Id).ToHashSet();

        private HashSet<int>? _activeUserIds;
        private HashSet<int>? _deletedOrMissingUserIds;

        public HashSet<int> ActiveUserIds => _activeUserIds ??= Users
            .Where(static user => user.Status != 2 && user.DeletedAt is null)
            .Select(static user => user.Id)
            .ToHashSet();

        public HashSet<int> DeletedOrMissingUserIds => _deletedOrMissingUserIds ??= Sessions
            .Select(static session => session.UserId)
            .Where(userId => !ActiveUserIds.Contains(userId))
            .ToHashSet();
    }

    private sealed record IntegrityCheckSample(
        int Count,
        IReadOnlyList<string> SampleKeys,
        int ScannedFileCount = 0);

    private sealed class IntegrityArticleRow
    {
        public int Id { get; init; }

        public int CategoryId { get; init; }

        public ArticleStatus Status { get; init; }
    }

    private sealed class IntegrityArticleBodyRow
    {
        public int ArticleId { get; init; }
    }

    private sealed class IntegrityArticleRevisionRow
    {
        public int ArticleId { get; init; }
    }

    private sealed class IntegrityCategoryRow
    {
        public int Id { get; init; }
    }

    private sealed class IntegrityTagRow
    {
        public int Id { get; init; }
    }

    private sealed class IntegrityArticleTagRow
    {
        public int ArticleId { get; init; }

        public int TagId { get; init; }
    }

    private sealed class IntegrityCommentRow
    {
        public long Id { get; init; }

        public int ArticleId { get; init; }

        public long? ParentId { get; init; }

        public long? RootId { get; init; }
    }

    private sealed class IntegrityUserRow
    {
        public int Id { get; init; }

        public int Status { get; init; }

        public DateTime? DeletedAt { get; init; }
    }

    private sealed class IntegritySessionRow
    {
        public string SessionId { get; init; } = string.Empty;

        public int UserId { get; init; }

        public DateTime? RevokedAt { get; init; }
    }

    private sealed class IntegrityAssetRow
    {
        public long Id { get; init; }

        public string Url { get; init; } = string.Empty;
    }
}

internal sealed class RecentOpsErrorAuditRow
{
    public DateTime OccurredAtUtc { get; init; }

    public string Severity { get; init; } = string.Empty;

    public string Action { get; init; } = string.Empty;

    public string EventInfo { get; init; } = string.Empty;
}

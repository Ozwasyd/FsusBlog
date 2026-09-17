using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IAdminOperationsHealthReader
{
    Task<OpsHealthResponse> GetAsync(CancellationToken cancellationToken);
}

internal sealed class AdminOperationsHealthReader(
    ISqlSugarClient db,
    IWebHostEnvironment environment,
    IAdminBackupStatusReader backupStatusReader,
    ProductionReadinessProbe readinessProbe,
    PublicHotReadStore publicHotReadStore,
    AuditLogRuntimeState auditLogRuntime,
    DependencyGraphRuntimeState dependencyGraphRuntime,
    StartupRuntimeState startupRuntime,
    ScheduledPublishRuntimeState scheduledPublishRuntime,
    CrawlerDetectorService crawlerDetector,
    IAdminCacheDiagnosticsReader cacheDiagnosticsReader,
    IReleaseIdentityProvider releaseIdentityProvider) : IAdminOperationsHealthReader
{
    private const int RecentErrorQueryLimit = 50;
    private const int RecentErrorDisplayLimit = 5;
    private const int RecentErrorMessageMaxLength = 140;
    private const int RecentErrorDetailMaxLength = 2000;

    public async Task<OpsHealthResponse> GetAsync(CancellationToken cancellationToken)
    {
        ProductionHealthReport readiness = await readinessProbe.CheckAsync(cancellationToken);
        BackupStatusResponse backup = backupStatusReader.GetStatus();
        AuditLogRuntimeSnapshot audit = auditLogRuntime.Snapshot();
        DependencyGraphRuntimeSnapshot dependencyGraph = dependencyGraphRuntime.Snapshot;
        StartupRuntimeSnapshot startup = startupRuntime.CreateSnapshot();
        ScheduledPublishRuntimeSnapshot scheduled = scheduledPublishRuntime.CreateSnapshot();
        PublicHotReadRuntimeSnapshot publicHot = publicHotReadStore.CreateRuntimeSnapshot();
        CrawlerRangeStatus crawler = crawlerDetector.GetRangeStatus();
        SearchIndexDiagnosticsResponse search = cacheDiagnosticsReader.GetSearchIndexDiagnostics();
        QueueBacklogResponse backlog = await GetQueueBacklogAsync(audit, cancellationToken);

        var services = new List<AdminServiceStatusResponse>
        {
            BuildStatus("postgres", "数据库", ReadinessStatus(readiness, "postgres"), ReadinessDetail(readiness, "postgres"), readiness.CheckedAt, ReadinessMetrics(readiness, "postgres")),
            BuildStatus("redis", "Redis", ReadinessStatus(readiness, "redis"), ReadinessDetail(readiness, "redis"), readiness.CheckedAt, ReadinessMetrics(readiness, "redis")),
            BuildStatus("audit", "审计写入", audit.WriteFailureCount > 0 || audit.DroppedCount > 0 ? "degraded" : "ok", $"queued={audit.QueuedCount}, dropped={audit.DroppedCount}, failed={audit.WriteFailureCount}", ToOffset(audit.LastWriteSuccessUtc), Metrics(("fallback", audit.FallbackWriteCount))),
            BuildStatus("crawler-cidr", "Crawler CIDR", crawler.LastError is null ? "ok" : "degraded", crawler.LastError ?? crawler.Source, crawler.LastSuccessAt, Metrics(("google", crawler.GoogleRanges), ("bing", crawler.BingRanges))),
            BuildStatus("backup", "最近备份", backup.Status, backup.BackupRoot, backup.CheckedAt, Metrics(("artifactCount", backup.Artifacts.Count))),
            BuildStatus(
                "dependency-graph",
                "DI 依赖图",
                dependencyGraph.CaptiveDependencies.Count == 0 ? "ok" : "degraded",
                dependencyGraph.CaptiveDependencies.Count == 0
                    ? "ValidateOnBuild + ValidateScopes + static graph validation"
                    : $"static graph validation blocked {dependencyGraph.CaptiveDependencies.Count} captive dependencies",
                readiness.CheckedAt,
                Metrics(
                    ("registrations", dependencyGraph.RegistrationCount),
                    ("singletons", dependencyGraph.SingletonCount),
                    ("scoped", dependencyGraph.ScopedCount),
                    ("transient", dependencyGraph.TransientCount),
                    ("hostedServices", dependencyGraph.HostedServiceCount),
                    ("opaqueFactories", dependencyGraph.OpaqueFactoryCount),
                    ("captiveDependencies", dependencyGraph.CaptiveDependencies.Count))),
            BuildStatus(
                "public-hot-read",
                "PublicHotRead",
                publicHot.LastBuildStatus == "failed" || publicHot.ResidentByteBudgetExceeded ? "degraded" : "ok",
                publicHot.LastError ?? publicHot.LastBuildReason,
                publicHot.LastBuildAt,
                Metrics(
                    ("version", publicHot.Version),
                    ("articleFrames", publicHot.ArticleFrameCount),
                    ("htmlFrames", publicHot.HtmlFrameCount),
                    ("residentBytes", publicHot.ResidentBytes),
                    ("rawBytes", publicHot.Residency.RawAedsBytes),
                    ("brotliBytes", publicHot.Residency.BrotliBytes),
                    ("gzipBytes", publicHot.Residency.GzipBytes),
                    ("compressedBytes", publicHot.Residency.CompressedBytes),
                    ("htmlBytes", publicHot.Residency.HtmlResidentBytes),
                    ("keyIndexBytes", publicHot.Residency.KeyIndexBytes),
                    ("articleBytes", publicHot.Residency.ArticleBytes),
                    ("listBytes", publicHot.Residency.ListBytes),
                    ("taxonomyBytes", publicHot.Residency.TaxonomyBytes),
                    ("baseBytes", publicHot.Residency.BaseBytes),
                    ("overlayBytes", publicHot.Residency.OverlayBytes),
                    ("removedSetBytes", publicHot.Residency.RemovedSetBytes),
                    ("artifactCount", publicHot.Residency.ArtifactCount),
                    ("artifactObjects", publicHot.Residency.ObjectCount),
                    ("arrayCount", publicHot.Residency.ArrayCount),
                    ("lohEligibleArrayCount", publicHot.Residency.LohEligibleArrayCount),
                    ("lohEligibleBytes", publicHot.Residency.LohEligibleArrayBytes),
                    ("snapshotOverlapBytes", publicHot.SnapshotOverlapBytes),
                    ("retiringSnapshotBytes", publicHot.RetiringSnapshotBytes),
                    ("residentByteBudget", publicHot.Budgets.MaxResidentBytes),
                    ("rawByteBudget", publicHot.Budgets.MaxRawBytes),
                    ("compressedByteBudget", publicHot.Budgets.MaxCompressedBytes),
                    ("htmlByteBudget", publicHot.Budgets.MaxHtmlBytes),
                    ("snapshotOverlapBudget", publicHot.Budgets.MaxSnapshotOverlapBytes),
                    ("artifactObjectBudget", publicHot.Budgets.MaxArtifactObjects),
                    ("budgetViolationCount", publicHot.BudgetViolationCount),
                    ("lifecycleStage", publicHot.LifecycleStage),
                    ("storageModel", publicHot.StorageModel),
                    ("compressionPolicy", publicHot.CompressionPolicy))),
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
        string status = services.Concat(workers).Any(item => item.Status is "failed" or "degraded")
            ? "degraded"
            : "ok";
        return new OpsHealthResponse(
            status,
            DateTimeOffset.UtcNow,
            environment.EnvironmentName,
            new OpsReleaseIdentityResponse(
                releaseIdentityProvider.Current.ReleaseId,
                releaseIdentityProvider.Current.CommitSha,
                releaseIdentityProvider.Current.ReleaseSlot),
            services,
            workers,
            backlog,
            backup,
            recentErrors);
    }

    internal static IReadOnlyList<RecentOpsErrorResponse> BuildRecentErrorResponses(
        IEnumerable<RecentOpsErrorAuditRow> rows,
        int maxItems = RecentErrorDisplayLimit)
        => rows.Select(MapRecentError)
            .GroupBy(RecentErrorGroupKey, StringComparer.OrdinalIgnoreCase)
            .Select(static group =>
            {
                RecentOpsErrorResponse latest = group.OrderByDescending(static item => item.OccurredAt).First();
                return latest with
                {
                    Count = group.Sum(static item => Math.Max(1, item.Count))
                };
            })
            .OrderByDescending(static item => item.OccurredAt)
            .Take(maxItems)
            .ToArray();

    private async Task<T> QueryWithNewClientAsync<T>(Func<ISqlSugarClient, Task<T>> query)
    {
        using SqlSugarClient queryDb = db.CopyNew();
        return await query(queryDb);
    }

    private async Task<QueueBacklogResponse> GetQueueBacklogAsync(
        AuditLogRuntimeSnapshot audit,
        CancellationToken cancellationToken)
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

    private async Task<IReadOnlyList<RecentOpsErrorResponse>> LoadRecentErrorsAsync(
        CancellationToken cancellationToken)
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

    private static RecentOpsErrorResponse MapRecentError(RecentOpsErrorAuditRow row)
    {
        string action = NormalizeRecentErrorToken(row.Action, "unknown");
        string severity = NormalizeRecentErrorToken(row.Severity, "error").ToLowerInvariant();
        string cleaned = CleanRecentErrorDetail(row.EventInfo, action);
        (string message, string? detail) = SummarizeRecentError(cleaned);
        return new RecentOpsErrorResponse(ToUtcOffset(row.OccurredAtUtc), severity, action, message, detail, 1);
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
            return (string.IsNullOrWhiteSpace(message) ? "未提供错误详情" : message,
                string.IsNullOrWhiteSpace(detail) ? null : detail);
        }

        if (cleaned.Length <= RecentErrorMessageMaxLength)
        {
            return (cleaned, null);
        }

        return (TrimToLength(cleaned, RecentErrorMessageMaxLength),
            TrimToLength(cleaned, RecentErrorDetailMaxLength));
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
        => value.Length <= maxLength
            ? value
            : string.Concat(value.AsSpan(0, Math.Max(0, maxLength - 3)).TrimEnd(), "...");

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
        => report.Checks.TryGetValue(key, out object? check)
            && check is ProductionDependencyHealthCheck { LatencyMs: not null } dependency
                ? Metrics(("latencyMs", dependency.LatencyMs.Value))
                : [];

    private static DateTimeOffset? ToOffset(DateTime? value)
        => value is null ? null : new DateTimeOffset(DateTime.SpecifyKind(value.Value, DateTimeKind.Utc));

}

internal sealed class RecentOpsErrorAuditRow
{
    public DateTime OccurredAtUtc
    {
        get; init;
    }

    public string Severity { get; init; } = string.Empty;

    public string Action { get; init; } = string.Empty;

    public string EventInfo { get; init; } = string.Empty;
}

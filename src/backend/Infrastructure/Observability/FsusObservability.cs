using System.Collections.Frozen;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed record FsusRouteKindMetadata(string RouteKind);

public sealed record SecurityChallengeV2PerformanceBudgetSnapshot(
    string Status,
    double IssueP99Ms,
    double VerifyP99Ms,
    int PayloadP95Bytes,
    double ClientRenderP95Ms,
    int IssueP99BudgetMs,
    int VerifyP99BudgetMs,
    int PayloadP95BudgetBytes,
    int ClientRenderP95BudgetMs,
    IReadOnlyList<string> Warnings);

public static class FsusObservability
{
    public const string DefaultServiceName = "FsusBlog";
    public const string ServiceVersion = "2.0.0";
    public const string ActivitySourceName = "FsusBlog.Server";
    public const string MeterName = "FsusBlog.Server";

    private static readonly string[] AllowedCustomAttributeNames =
    [
        "fsus.aot.backfill",
        "fsus.aot.source",
        "fsus.background.backlog",
        "fsus.background.failed",
        "fsus.background.job",
        "fsus.background.published",
        "fsus.cache.layer",
        "fsus.cache.operation",
        "fsus.cache.policy",
        "fsus.component",
        "fsus.db.operation",
        "fsus.db.system",
        "fsus.exporter.enabled",
        "fsus.http.status_code",
        "fsus.operation",
        "fsus.result",
        "fsus.route_kind",
        "fsus.security.action",
        "fsus.security.kind",
        "fsus.security.outcome",
        "fsus.security.policy_version",
        "fsus.security.reason",
        "fsus.security.source",
        "fsus.security.task_kind",
        "fsus.search.mode",
        "fsus.notification_stream.operation"
    ];

    private static readonly FrozenSet<string> AllowedCustomAttributes = AllowedCustomAttributeNames.ToFrozenSet(StringComparer.Ordinal);

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName, ServiceVersion);

    private static readonly Meter Meter = new(MeterName, ServiceVersion);
    private static readonly Counter<long> OperationCounter = Meter.CreateCounter<long>("fsus.operation.count");
    private static readonly Histogram<double> OperationDuration = Meter.CreateHistogram<double>("fsus.operation.duration", "ms");
    private static readonly Counter<long> CacheOperationCounter = Meter.CreateCounter<long>("fsus.cache.operation.count");
    private static readonly Counter<long> SecurityEventCounter = Meter.CreateCounter<long>("fsus.security.event.count");
    private static readonly Counter<long> SecurityRiskEventCounter = Meter.CreateCounter<long>("fsus.security.risk.event.count");
    private static readonly Counter<long> SecurityChallengeIssuedCounter = Meter.CreateCounter<long>("fsus.security.challenge.issued.count");
    private static readonly Counter<long> SecurityChallengeVerifiedCounter = Meter.CreateCounter<long>("fsus.security.challenge.verified.count");
    private static readonly Counter<long> SecurityChallengeFailedCounter = Meter.CreateCounter<long>("fsus.security.challenge.failed.count");
    private static readonly Counter<long> SecurityChallengeReplayedCounter = Meter.CreateCounter<long>("fsus.security.challenge.replayed.count");
    private static readonly Histogram<double> SecurityChallengeSolveDuration = Meter.CreateHistogram<double>("fsus.security.challenge.solve.duration", "ms");
    private static readonly Counter<long> SecurityChallengeV2IssuedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.issued.count");
    private static readonly Counter<long> SecurityChallengeV2VerifiedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.verified.count");
    private static readonly Counter<long> SecurityChallengeV2FailedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.failed.count");
    private static readonly Counter<long> SecurityChallengeV2ReplayedCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.replayed.count");
    private static readonly Histogram<double> SecurityChallengeV2SolveDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.solve.duration", "ms");
    private static readonly Histogram<double> SecurityChallengeV2PayloadBytes = Meter.CreateHistogram<double>("fsus.security.challenge.v2.payload.bytes", "By");
    private static readonly Histogram<double> SecurityChallengeV2VerifyDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.verify.duration", "ms");
    private static readonly Counter<long> SecurityChallengeV2TaskKindCounter = Meter.CreateCounter<long>("fsus.security.challenge.v2.task.kind.count");
    private static readonly Histogram<double> SecurityChallengeV2IssueDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.issue.duration", "ms");
    private static readonly Histogram<double> SecurityChallengeV2ClientRenderDuration = Meter.CreateHistogram<double>("fsus.security.challenge.v2.client.render.duration", "ms");
    private static readonly Counter<long> SecurityDecisionCounter = Meter.CreateCounter<long>("fsus.security.decision.count");
    private static readonly Histogram<double> CacheOperationDuration = Meter.CreateHistogram<double>("fsus.cache.operation.duration", "ms");
    private static readonly Histogram<double> DbOperationDuration = Meter.CreateHistogram<double>("fsus.db.operation.duration", "ms");
    private static readonly Histogram<double> AotRenderDuration = Meter.CreateHistogram<double>("fsus.aot.render.duration", "ms");
    private static readonly Histogram<double> SearchOperationDuration = Meter.CreateHistogram<double>("fsus.search.operation.duration", "ms");
    private static readonly Histogram<double> BackgroundJobDuration = Meter.CreateHistogram<double>("fsus.background.job.duration", "ms");
    private static readonly Counter<long> VisitLogFlushCounter = Meter.CreateCounter<long>("fsus.visitlog.flush.count");
    private static readonly Counter<long> HotArticlesDirtyCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.dirty.count");
    private static readonly Counter<long> HotArticlesFlushCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.flush.count");
    private static readonly Counter<long> HotArticlesCoalescedCounter = Meter.CreateCounter<long>("fsus.cache.hot_articles.flush.coalesced_batches");
    private static readonly Counter<long> StatsDirtyCounter = Meter.CreateCounter<long>("fsus.cache.stats.dirty.count");
    private static readonly Counter<long> StatsFlushCounter = Meter.CreateCounter<long>("fsus.cache.stats.flush.count");
    private static long HotArticlesVersionValue;
    private static string ActiveSecurityPolicyVersionValue = "unknown";
    private static readonly ObservableGauge<long> HotArticlesVersionGauge = Meter.CreateObservableGauge(
        "fsus.cache.hot_articles.version",
        static () => Volatile.Read(ref HotArticlesVersionValue));
    private static readonly ObservableGauge<long> SecurityPolicyVersionActiveGauge = Meter.CreateObservableGauge(
        "fsus.security.policy.version.active",
        ObserveActiveSecurityPolicyVersion);
    private static readonly Counter<long> CacheRemoveManyKeyCounter = Meter.CreateCounter<long>("fsus.cache.remove_many.keys");
    private static readonly Counter<long> CacheRemoveManyRedisBatchCounter = Meter.CreateCounter<long>("fsus.cache.remove_many.redis_batches");
    private static readonly Histogram<double> CacheRemoveManyElapsed = Meter.CreateHistogram<double>("fsus.cache.remove_many.elapsed_ms", "ms");
    private static readonly Counter<long> CacheRemovePrefixManyPrefixCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.prefixes");
    private static readonly Counter<long> CacheRemovePrefixManyRegistryScanCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.registry_scans");
    private static readonly Counter<long> CacheRemovePrefixManyDeletedKeyCounter = Meter.CreateCounter<long>("fsus.cache.remove_prefix_many.deleted_keys");
    private static readonly Histogram<double> CacheRemovePrefixManyElapsed = Meter.CreateHistogram<double>("fsus.cache.remove_prefix_many.elapsed_ms", "ms");
    private static readonly Counter<long> PublicAotInvalidationScopeCounter = Meter.CreateCounter<long>("public_aot_invalidation_scope");
    private static readonly Counter<long> PublicAotInvalidatedKeyCounter = Meter.CreateCounter<long>("public_aot_invalidated_keys");
    private static readonly Counter<long> PublicAotDeletedFileCounter = Meter.CreateCounter<long>("public_aot_deleted_files");
    private static readonly Counter<long> PublicAotRegistryRemovedMemberCounter = Meter.CreateCounter<long>("public_aot_registry_removed_members");
    private static readonly Counter<long> PublicAotRegistryCleanupCounter = Meter.CreateCounter<long>("public_aot_registry_cleanup_count");
    private static readonly Counter<long> PublicAotRegistryDeletedKeyCounter = Meter.CreateCounter<long>("public_aot_registry_deleted_keys");
    private static readonly Counter<long> PublicAotPublishCounter = Meter.CreateCounter<long>("public_aot_publish_count");
    private static readonly Histogram<double> PublicAotInvalidationDuration = Meter.CreateHistogram<double>("public_aot_invalidation_duration_ms", "ms");

    public static IReadOnlyList<string> CustomAttributeNames => AllowedCustomAttributeNames;

    internal const int SecurityChallengeV2IssueP99BudgetMs = 100;
    internal const int SecurityChallengeV2VerifyP99BudgetMs = 32;
    internal const int SecurityChallengeV2PayloadP95BudgetBytes = 6200;
    internal const int SecurityChallengeV2ClientRenderP95BudgetMs = 55;
    private const int SecurityChallengeV2SampleLimit = 512;
    private static readonly ConcurrentQueue<double> SecurityChallengeV2IssueSamples = new();
    private static readonly ConcurrentQueue<double> SecurityChallengeV2VerifySamples = new();
    private static readonly ConcurrentQueue<int> SecurityChallengeV2PayloadSamples = new();
    private static readonly ConcurrentQueue<double> SecurityChallengeV2ClientRenderSamples = new();

    public static bool IsAllowedCustomAttribute(string name)
        => AllowedCustomAttributes.Contains(name);

    public static Activity? StartActivity(string name, string component, ActivityKind kind = ActivityKind.Internal)
    {
        Activity? activity = ActivitySource.StartActivity(name, kind);
        SetTag(activity, "fsus.component", component);
        SetTag(activity, "fsus.operation", name);
        return activity;
    }

    public static void SetTag(Activity? activity, string key, object? value)
    {
        if (activity is null || value is null || !IsAllowedCustomAttribute(key))
        {
            return;
        }

        activity.SetTag(key, value);
    }

    public static string ClassifyRoute(PathString path)
    {
        string value = path.Value ?? string.Empty;
        if (value.StartsWith("/api/binary", StringComparison.OrdinalIgnoreCase))
        {
            return "binary";
        }

        if (value.StartsWith("/api/notifications/stream", StringComparison.OrdinalIgnoreCase))
        {
            return "notification-stream";
        }

        if (value.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
        {
            return "api";
        }

        if (value.StartsWith("/health/", StringComparison.OrdinalIgnoreCase))
        {
            return "health";
        }

        if (value.StartsWith("/search/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith(".wasm", StringComparison.OrdinalIgnoreCase))
        {
            return "static";
        }

        return "public";
    }

    public static string ResolveRouteKind(HttpContext context)
    {
        string? routeKind = context.GetEndpoint()?.Metadata.GetMetadata<FsusRouteKindMetadata>()?.RouteKind;
        return string.IsNullOrWhiteSpace(routeKind)
            ? ClassifyRoute(context.Request.Path)
            : routeKind;
    }

    public static void RecordOperation(string component, string operation, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags(component, operation, result);
        OperationCounter.Add(1, tags);
        OperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordHttpRequest(string routeKind, int statusCode, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("http", "request", statusCode < 500 ? "ok" : "error");
        tags.Add("fsus.route_kind", routeKind);
        tags.Add("fsus.http.status_code", statusCode);
        OperationCounter.Add(1, tags);
        OperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordCacheOperation(string operation, string policyId, string layer, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("cache", operation, result);
        tags.Add("fsus.cache.operation", operation);
        tags.Add("fsus.cache.policy", policyId);
        tags.Add("fsus.cache.layer", layer);
        CacheOperationCounter.Add(1, tags);
        CacheOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSecurityEvent(string operation, string reason, string result)
    {
        TagList tags = CreateBaseTags("security", operation, result);
        tags.Add("fsus.security.reason", reason);
        SecurityEventCounter.Add(1, tags);
    }

    public static void RecordSecurityRiskEvent(string source, string reason, string action, string result)
    {
        TryRecord(() =>
        {
            TagList tags = CreateBaseTags("security", "risk_event", NormalizeTelemetryValue(result, "received"));
            tags.Add("fsus.security.source", NormalizeTelemetryValue(source, "unknown"));
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "unknown"));
            tags.Add("fsus.security.action", NormalizeTelemetryValue(action, "unknown"));
            SecurityRiskEventCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityDecision(RiskDecision decision)
    {
        ArgumentNullException.ThrowIfNull(decision);

        RecordSecurityPolicyVersion(decision.PolicyVersion);
        TryRecord(() =>
        {
            string outcome = NormalizeTelemetryValue(decision.Kind.ToString(), "unknown").ToLowerInvariant();
            TagList tags = CreateBaseTags("security", "risk_decision", outcome);
            tags.Add("fsus.security.action", NormalizeTelemetryValue(decision.ActionName, "unknown"));
            tags.Add("fsus.security.outcome", outcome);
            tags.Add("fsus.security.policy_version", NormalizeTelemetryValue(decision.PolicyVersion, "unknown"));
            SecurityDecisionCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityPolicyVersion(string? policyVersion)
    {
        string normalized = NormalizeTelemetryValue(policyVersion, "unknown");
        if (!string.Equals(normalized, "unknown", StringComparison.Ordinal))
        {
            Volatile.Write(ref ActiveSecurityPolicyVersionValue, normalized);
        }
    }

    public static void RecordSecurityChallengeIssued(string kind, string action, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_issue", "issued", kind, action, policyVersion);
            SecurityChallengeIssuedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeVerified(string kind, string action, string policyVersion, TimeSpan? solveDuration = null)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "verified", kind, action, policyVersion);
            SecurityChallengeVerifiedCounter.Add(1, tags);
            if (solveDuration is { } duration && duration >= TimeSpan.Zero)
            {
                SecurityChallengeSolveDuration.Record(duration.TotalMilliseconds, tags);
            }
        });
    }

    public static void RecordSecurityChallengeFailed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "failed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "failed"));
            SecurityChallengeFailedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeReplayed(string kind, string action, string reason, string policyVersion)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeTags("challenge_verify", "replayed", kind, action, policyVersion);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "replayed"));
            SecurityChallengeReplayedCounter.Add(1, tags);
        });
    }

    public static void RecordSecurityChallengeV2Issued(
        string kind,
        string action,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan issueDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_issue", "issued", kind, action, policyVersion, taskKind);
            SecurityChallengeV2IssuedCounter.Add(1, tags);
            SecurityChallengeV2TaskKindCounter.Add(1, tags);
            RecordNonNegativeHistogram(SecurityChallengeV2PayloadBytes, payloadBytes, tags);
            RecordNonNegativeHistogram(SecurityChallengeV2IssueDuration, issueDuration.TotalMilliseconds, tags);
            AddBoundedSample(SecurityChallengeV2PayloadSamples, payloadBytes);
            AddBoundedSample(SecurityChallengeV2IssueSamples, issueDuration.TotalMilliseconds);
        });
    }

    public static void RecordSecurityChallengeV2Verified(
        string kind,
        string action,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "verified", kind, action, policyVersion, taskKind);
            SecurityChallengeV2VerifiedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2Failed(
        string kind,
        string action,
        string reason,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "failed", kind, action, policyVersion, taskKind);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "failed"));
            SecurityChallengeV2FailedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2Replayed(
        string kind,
        string action,
        string reason,
        string policyVersion,
        string taskKind,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags("challenge_v2_verify", "replayed", kind, action, policyVersion, taskKind);
            tags.Add("fsus.security.reason", NormalizeTelemetryValue(reason, "replayed"));
            SecurityChallengeV2ReplayedCounter.Add(1, tags);
            RecordSecurityChallengeV2VerifyMeasurements(tags, payloadBytes, verifyDuration, solveDuration);
        });
    }

    public static void RecordSecurityChallengeV2ClientRender(string taskKind, TimeSpan renderDuration)
    {
        TryRecord(() =>
        {
            TagList tags = CreateSecurityChallengeV2Tags(
                "challenge_v2_client_render",
                "ok",
                "perception",
                "client-render",
                "unknown",
                taskKind);
            RecordNonNegativeHistogram(SecurityChallengeV2ClientRenderDuration, renderDuration.TotalMilliseconds, tags);
            AddBoundedSample(SecurityChallengeV2ClientRenderSamples, renderDuration.TotalMilliseconds);
        });
    }

    public static SecurityChallengeV2PerformanceBudgetSnapshot CreateSecurityChallengeV2PerformanceBudgetSnapshot()
    {
        double issueP99 = Percentile(SecurityChallengeV2IssueSamples.ToArray(), 0.99);
        double verifyP99 = Percentile(SecurityChallengeV2VerifySamples.ToArray(), 0.99);
        int payloadP95 = Percentile(SecurityChallengeV2PayloadSamples.ToArray(), 0.95);
        double clientRenderP95 = Percentile(SecurityChallengeV2ClientRenderSamples.ToArray(), 0.95);
        List<string> warnings = [];

        if (issueP99 > SecurityChallengeV2IssueP99BudgetMs)
        {
            warnings.Add("issue_p99_budget_exceeded");
        }

        if (verifyP99 > SecurityChallengeV2VerifyP99BudgetMs)
        {
            warnings.Add("verify_p99_budget_exceeded");
        }

        if (payloadP95 > SecurityChallengeV2PayloadP95BudgetBytes)
        {
            warnings.Add("payload_p95_budget_exceeded");
        }

        if (clientRenderP95 > SecurityChallengeV2ClientRenderP95BudgetMs)
        {
            warnings.Add("client_render_p95_budget_exceeded");
        }

        return new SecurityChallengeV2PerformanceBudgetSnapshot(
            warnings.Count == 0 ? "ok" : "warning",
            Math.Round(issueP99, 2, MidpointRounding.AwayFromZero),
            Math.Round(verifyP99, 2, MidpointRounding.AwayFromZero),
            payloadP95,
            Math.Round(clientRenderP95, 2, MidpointRounding.AwayFromZero),
            SecurityChallengeV2IssueP99BudgetMs,
            SecurityChallengeV2VerifyP99BudgetMs,
            SecurityChallengeV2PayloadP95BudgetBytes,
            SecurityChallengeV2ClientRenderP95BudgetMs,
            warnings);
    }

    internal static void ResetSecurityChallengeV2RuntimeMetricsForTests()
    {
        ClearQueue(SecurityChallengeV2IssueSamples);
        ClearQueue(SecurityChallengeV2VerifySamples);
        ClearQueue(SecurityChallengeV2PayloadSamples);
        ClearQueue(SecurityChallengeV2ClientRenderSamples);
    }

    public static void RecordDbOperation(string operation, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("db", operation, result);
        tags.Add("fsus.db.system", "postgresql");
        tags.Add("fsus.db.operation", operation);
        DbOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordAotRender(string source, string backfill, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("public_aot", "render", result);
        tags.Add("fsus.aot.source", source);
        tags.Add("fsus.aot.backfill", backfill);
        AotRenderDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordSearchOperation(string mode, string result, TimeSpan duration)
    {
        TagList tags = CreateBaseTags("search", mode, result);
        tags.Add("fsus.search.mode", mode);
        SearchOperationDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordBackgroundJob(string job, string result, TimeSpan duration, int? published = null, int? failed = null, int? backlog = null)
    {
        TagList tags = CreateBaseTags("background", job, result);
        tags.Add("fsus.background.job", job);
        if (published.HasValue)
        {
            tags.Add("fsus.background.published", published.Value);
        }

        if (failed.HasValue)
        {
            tags.Add("fsus.background.failed", failed.Value);
        }

        if (backlog.HasValue)
        {
            tags.Add("fsus.background.backlog", backlog.Value);
        }

        BackgroundJobDuration.Record(duration.TotalMilliseconds, tags);
    }

    public static void RecordVisitLogFlush(long count)
    {
        if (count > 0)
        {
            VisitLogFlushCounter.Add(count);
        }
    }

    public static void RecordHotStatsInvalidation(string kind, string operation, string reason, long count)
    {
        long value = Math.Max(1, count);
        if (string.Equals(kind, "hot_articles", StringComparison.Ordinal))
        {
            if (string.Equals(operation, "dirty", StringComparison.Ordinal))
            {
                HotArticlesDirtyCounter.Add(value);
                return;
            }

            HotArticlesFlushCounter.Add(1);
            HotArticlesCoalescedCounter.Add(value);
            return;
        }

        if (string.Equals(operation, "dirty", StringComparison.Ordinal))
        {
            StatsDirtyCounter.Add(value);
            return;
        }

        StatsFlushCounter.Add(1);
    }

    public static void RecordHotArticlesVersion(long version)
    {
        if (version > 0)
        {
            Volatile.Write(ref HotArticlesVersionValue, version);
        }
    }

    public static void RecordCacheRemoveMany(long keys, long redisBatches, TimeSpan elapsed)
    {
        CacheRemoveManyKeyCounter.Add(Math.Max(0, keys));
        CacheRemoveManyRedisBatchCounter.Add(Math.Max(0, redisBatches));
        CacheRemoveManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordCacheRemovePrefixMany(long prefixes, long registryScans, long deletedKeys, TimeSpan elapsed)
    {
        CacheRemovePrefixManyPrefixCounter.Add(Math.Max(0, prefixes));
        CacheRemovePrefixManyRegistryScanCounter.Add(Math.Max(0, registryScans));
        CacheRemovePrefixManyDeletedKeyCounter.Add(Math.Max(0, deletedKeys));
        CacheRemovePrefixManyElapsed.Record(elapsed.TotalMilliseconds);
    }

    public static void RecordPublicAotInvalidation(
        long scopes,
        long invalidatedKeys,
        long deletedFiles,
        long registryRemovedMembers,
        long publishCount,
        TimeSpan elapsed,
        string? registryCleanupStatus = null,
        long registryDeletedKeys = 0)
    {
        PublicAotInvalidationScopeCounter.Add(Math.Max(0, scopes));
        PublicAotInvalidatedKeyCounter.Add(Math.Max(0, invalidatedKeys));
        PublicAotDeletedFileCounter.Add(Math.Max(0, deletedFiles));
        PublicAotRegistryRemovedMemberCounter.Add(Math.Max(0, registryRemovedMembers));
        PublicAotPublishCounter.Add(Math.Max(0, publishCount));
        PublicAotInvalidationDuration.Record(elapsed.TotalMilliseconds);
        if (!string.IsNullOrWhiteSpace(registryCleanupStatus))
        {
            TagList tags = CreateBaseTags("public_aot", "registry_cleanup", registryCleanupStatus);
            PublicAotRegistryCleanupCounter.Add(1, tags);
            PublicAotRegistryDeletedKeyCounter.Add(Math.Max(0, registryDeletedKeys), tags);
        }
    }

    public static TimeSpan GetElapsed(long startTimestamp)
        => Stopwatch.GetElapsedTime(startTimestamp);

    private static TagList CreateBaseTags(string component, string operation, string result)
    {
        TagList tags = [];
        tags.Add("fsus.component", component);
        tags.Add("fsus.operation", operation);
        tags.Add("fsus.result", result);
        return tags;
    }

    private static TagList CreateSecurityChallengeTags(
        string operation,
        string result,
        string kind,
        string action,
        string policyVersion)
    {
        RecordSecurityPolicyVersion(policyVersion);
        TagList tags = CreateBaseTags("security", operation, result);
        tags.Add("fsus.security.kind", NormalizeTelemetryValue(kind, "unknown"));
        tags.Add("fsus.security.action", NormalizeTelemetryValue(action, "unknown"));
        tags.Add("fsus.security.outcome", result);
        tags.Add("fsus.security.policy_version", NormalizeTelemetryValue(policyVersion, "unknown"));
        return tags;
    }

    private static TagList CreateSecurityChallengeV2Tags(
        string operation,
        string result,
        string kind,
        string action,
        string policyVersion,
        string taskKind)
    {
        TagList tags = CreateSecurityChallengeTags(operation, result, kind, action, policyVersion);
        tags.Add("fsus.security.task_kind", NormalizeTelemetryValue(taskKind, "unknown"));
        return tags;
    }

    private static void RecordSecurityChallengeV2VerifyMeasurements(
        TagList tags,
        int payloadBytes,
        TimeSpan verifyDuration,
        TimeSpan? solveDuration)
    {
        RecordNonNegativeHistogram(SecurityChallengeV2PayloadBytes, payloadBytes, tags);
        RecordNonNegativeHistogram(SecurityChallengeV2VerifyDuration, verifyDuration.TotalMilliseconds, tags);
        AddBoundedSample(SecurityChallengeV2PayloadSamples, payloadBytes);
        AddBoundedSample(SecurityChallengeV2VerifySamples, verifyDuration.TotalMilliseconds);
        if (solveDuration is { } duration)
        {
            RecordNonNegativeHistogram(SecurityChallengeV2SolveDuration, duration.TotalMilliseconds, tags);
        }
    }

    private static void RecordNonNegativeHistogram(Histogram<double> histogram, double value, TagList tags)
    {
        if (double.IsFinite(value) && value >= 0)
        {
            histogram.Record(value, tags);
        }
    }

    private static void AddBoundedSample(ConcurrentQueue<double> queue, double value)
    {
        if (!double.IsFinite(value) || value < 0)
        {
            return;
        }

        queue.Enqueue(value);
        TrimQueue(queue);
    }

    private static void AddBoundedSample(ConcurrentQueue<int> queue, int value)
    {
        if (value < 0)
        {
            return;
        }

        queue.Enqueue(value);
        TrimQueue(queue);
    }

    private static void TrimQueue<T>(ConcurrentQueue<T> queue)
    {
        while (queue.Count > SecurityChallengeV2SampleLimit && queue.TryDequeue(out _))
        {
        }
    }

    private static void ClearQueue<T>(ConcurrentQueue<T> queue)
    {
        while (queue.TryDequeue(out _))
        {
        }
    }

    private static double Percentile(double[] values, double percentile)
    {
        if (values.Length == 0)
        {
            return 0;
        }

        Array.Sort(values);
        int index = PercentileIndex(values.Length, percentile);
        return values[index];
    }

    private static int Percentile(int[] values, double percentile)
    {
        if (values.Length == 0)
        {
            return 0;
        }

        Array.Sort(values);
        int index = PercentileIndex(values.Length, percentile);
        return values[index];
    }

    private static int PercentileIndex(int count, double percentile)
        => Math.Clamp((int)Math.Ceiling(count * Math.Clamp(percentile, 0d, 1d)) - 1, 0, count - 1);

    private static Measurement<long> ObserveActiveSecurityPolicyVersion()
    {
        TagList tags = CreateBaseTags("security", "risk_policy", "active");
        tags.Add("fsus.security.policy_version", Volatile.Read(ref ActiveSecurityPolicyVersionValue));
        return new Measurement<long>(1, tags);
    }

    private static string NormalizeTelemetryValue(string? value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return fallback;
        }

        return normalized.Length <= 96 ? normalized : normalized[..96];
    }

    private static void TryRecord(Action record)
    {
        try
        {
            record();
        }
        catch
        {
            // Telemetry listeners/exporters must not affect RiskControl decisions.
        }
    }
}

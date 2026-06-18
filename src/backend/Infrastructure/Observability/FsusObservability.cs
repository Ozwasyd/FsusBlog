using System.Collections.Frozen;
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed record FsusRouteKindMetadata(string RouteKind);

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
        "fsus.security.reason",
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
    private static readonly ObservableGauge<long> HotArticlesVersionGauge = Meter.CreateObservableGauge(
        "fsus.cache.hot_articles.version",
        static () => Volatile.Read(ref HotArticlesVersionValue));
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
}

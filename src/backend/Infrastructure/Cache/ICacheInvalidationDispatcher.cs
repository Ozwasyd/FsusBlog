using System.Globalization;

using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICacheInvalidationDispatcher
{
    Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateComplianceAsync(CancellationToken cancellationToken = default);
    Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default);
    Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default);
    Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default);
    Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default);
    Task InvalidateStatsAsync(CancellationToken cancellationToken = default);
    Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default);
    Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default);
}

public interface IHotStatsInvalidationCoalescer
{
    Task MarkStatsDirtyAsync(string reason, CancellationToken cancellationToken = default);
    Task MarkHotArticlesDirtyAsync(string reason, CancellationToken cancellationToken = default);
    Task FlushPendingAsync(CancellationToken cancellationToken = default);
    HotStatsInvalidationSnapshot Snapshot();
    Task<HotStatsInvalidationSnapshot> SnapshotAsync(CancellationToken cancellationToken = default);
}

public interface IHotArticlesCacheVersionProvider
{
    long CurrentHotArticlesVersion
    {
        get;
    }
    string BuildVersionedHotArticlesIdentity(string identity);
}

public interface IHotArticlesCacheVersionPublisher : IHotArticlesCacheVersionProvider
{
    long PublishNextHotArticlesVersion(string reason);
}

internal static class AdminStatsFrameVersioning
{
    internal const string CounterIdentity = "frame-version";

    internal static string BuildIdentity(long version)
        => $"core:v{Math.Max(0, version).ToString(CultureInfo.InvariantCulture)}:main";

    internal static string BuildCoreSourceIdentity(long version)
        => $"core:v{Math.Max(0, version).ToString(CultureInfo.InvariantCulture)}:main";

    internal static string BuildSourceIdentity(long version)
        => $"v{Math.Max(0, version).ToString(CultureInfo.InvariantCulture)}:main";

    internal static async Task<long> ResolveAsync(
        ICacheCounterStore cache,
        CancellationToken cancellationToken = default)
    {
        // INCRBY 0 is an authoritative Redis counter read. Unlike GetStringAsync it cannot
        // observe or repopulate a process-local L1 generation that another node has retired.
        long version = await cache.IncrementAsync(
                CachePolicyId.AdminStats,
                CounterIdentity,
                0,
                cancellationToken)
            .ConfigureAwait(false);
        return Math.Max(0, version);
    }
}

public sealed record HotStatsInvalidationSnapshot(
    long HotArticlesVersion,
    long StatsDirtyCount,
    long StatsFlushCount,
    long StatsCoalescedDirtyCount,
    long HotArticlesDirtyCount,
    long HotArticlesFlushCount,
    long HotArticlesCoalescedDirtyCount,
    bool StatsDirty,
    bool HotArticlesDirty,
    DateTimeOffset? LastDirtyAt,
    DateTimeOffset? LastFlushAt,
    string? LastDirtyReason,
    string? LastFlushReason);

public sealed record class CommentCacheInvalidationScope(
    int? ArticleId = null,
    long? RootId = null,
    int? AccountId = null,
    bool PublicArticleChanged = false,
    bool UserCommentsChanged = false);

public sealed record CacheInvalidationRuntimeSnapshot(
    long ArticleMutationCount,
    long SeoCount,
    long ComplianceCount,
    long SystemPageCount,
    long CategoryTagCount,
    long CommentMutationCount,
    long StatsCount,
    long ArticleViewCount,
    long HotArticlesCount,
    DateTimeOffset? LastInvalidatedAt,
    string? LastKind,
    string? LastDetail);

public sealed class CacheInvalidationRuntimeState(
    ICacheCounterStore? sharedCounters = null,
    ICacheStringReader? sharedReader = null)
{
    private readonly object _gate = new();
    private CacheInvalidationRuntimeSnapshot _snapshot = new(0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null);

    public void Record(string kind, string? detail = null)
    {
        lock (_gate)
        {
            ApplyRecord(kind, detail, sharedCount: null);
        }
    }

    public async Task RecordAsync(string kind, string? detail = null, CancellationToken cancellationToken = default)
    {
        long? sharedCount = null;
        if (sharedCounters is not null && CounterIdentity(kind) is { } identity)
        {
            sharedCount = await sharedCounters.IncrementAsync(CachePolicyId.AdminStats, identity, 1, cancellationToken).ConfigureAwait(false);
        }

        lock (_gate)
        {
            ApplyRecord(kind, detail, sharedCount);
        }
    }

    public CacheInvalidationRuntimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public async Task<CacheInvalidationRuntimeSnapshot> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        CacheInvalidationRuntimeSnapshot current = Snapshot();
        if (sharedCounters is null || sharedReader is null)
        {
            return current;
        }

        return current with
        {
            ArticleMutationCount = Math.Max(current.ArticleMutationCount, await ReadCounterAsync("article", cancellationToken).ConfigureAwait(false)),
            SeoCount = Math.Max(current.SeoCount, await ReadCounterAsync("seo", cancellationToken).ConfigureAwait(false)),
            ComplianceCount = Math.Max(current.ComplianceCount, await ReadCounterAsync("compliance", cancellationToken).ConfigureAwait(false)),
            SystemPageCount = Math.Max(current.SystemPageCount, await ReadCounterAsync("system_page", cancellationToken).ConfigureAwait(false)),
            CategoryTagCount = Math.Max(current.CategoryTagCount, await ReadCounterAsync("taxonomy", cancellationToken).ConfigureAwait(false)),
            CommentMutationCount = Math.Max(current.CommentMutationCount, await ReadCounterAsync("comment", cancellationToken).ConfigureAwait(false)),
            StatsCount = Math.Max(current.StatsCount, await ReadCounterAsync("stats", cancellationToken).ConfigureAwait(false)),
            ArticleViewCount = Math.Max(current.ArticleViewCount, await ReadCounterAsync("article_view", cancellationToken).ConfigureAwait(false)),
            HotArticlesCount = Math.Max(current.HotArticlesCount, await ReadCounterAsync("hot_articles", cancellationToken).ConfigureAwait(false))
        };
    }

    private void ApplyRecord(string kind, string? detail, long? sharedCount)
    {
        _snapshot = kind switch
        {
            "article" => _snapshot with { ArticleMutationCount = sharedCount ?? _snapshot.ArticleMutationCount + 1 },
            "seo" => _snapshot with { SeoCount = sharedCount ?? _snapshot.SeoCount + 1 },
            "compliance" => _snapshot with { ComplianceCount = sharedCount ?? _snapshot.ComplianceCount + 1 },
            "system_page" => _snapshot with { SystemPageCount = sharedCount ?? _snapshot.SystemPageCount + 1 },
            "taxonomy" => _snapshot with { CategoryTagCount = sharedCount ?? _snapshot.CategoryTagCount + 1 },
            "comment" => _snapshot with { CommentMutationCount = sharedCount ?? _snapshot.CommentMutationCount + 1 },
            "stats" => _snapshot with { StatsCount = sharedCount ?? _snapshot.StatsCount + 1 },
            "article_view" => _snapshot with { ArticleViewCount = sharedCount ?? _snapshot.ArticleViewCount + 1 },
            "hot_articles" => _snapshot with { HotArticlesCount = sharedCount ?? _snapshot.HotArticlesCount + 1 },
            _ => _snapshot
        };

        _snapshot = _snapshot with
        {
            LastInvalidatedAt = DateTimeOffset.UtcNow,
            LastKind = kind,
            LastDetail = detail
        };
    }

    private async Task<long> ReadCounterAsync(string kind, CancellationToken cancellationToken)
    {
        string? identity = CounterIdentity(kind);
        if (identity is null || sharedReader is null)
        {
            return 0;
        }

        string? value = await sharedReader.GetStringAsync(CachePolicyId.AdminStats, identity, cancellationToken).ConfigureAwait(false);
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed) ? parsed : 0;
    }

    private static string? CounterIdentity(string kind)
        => kind switch
        {
            "article" or "seo" or "compliance" or "system_page" or "taxonomy" or "comment" or "stats" or "article_view" or "hot_articles"
                => $"cache-invalidation:{kind}",
            _ => null
        };
}

public sealed class CacheInvalidationDispatcher(
    ICacheCounterStore counters,
    ICacheInvalidationStore invalidation,
    IHttpCacheInvalidator httpCacheInvalidator,
    CacheInvalidationRuntimeState? runtimeState = null,
    IHotArticlesCacheVersionPublisher? hotArticlesVersionPublisher = null,
    IAnonymousCommentPolicyInvalidationSink? commentPolicyInvalidationSink = null,
    IAotSeoConfigSnapshot? aotSeoConfigSnapshot = null,
    IDistributedInvalidationPublisher? distributedInvalidationPublisher = null) : ICacheInvalidationDispatcher
{
    public async Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
    {
        if (articleId is > 0)
        {
            await invalidation.RemoveManyAsync(
                [
                    new(CachePolicyId.ArticleDetail, articleId.Value.ToString()),
                    new(CachePolicyId.ArticleDetail, $"core:v2:{articleId.Value}"),
                    new(CachePolicyId.ArticleDetail, $"core:v3:{articleId.Value}"),
                    new(CachePolicyId.ArticleDetailFrame, $"core:v3:{articleId.Value}")
                ],
                cancellationToken);
        }

        await counters.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        long searchVersion = await counters.IncrementAsync(CachePolicyId.ArticleSearchVersion, "main", 1, cancellationToken);
        await invalidation.RemoveAsync(CachePolicyId.ArticleRss, "main", cancellationToken);
        await InvalidateAdminStatsCachesAsync(cancellationToken);
        long hotVersion = PublishHotArticlesVersion("article-mutation");
        await httpCacheInvalidator.InvalidateAsync(CacheTag.ArticleList, CacheTag.HotArticles, CacheTag.Stats);
        await RecordRuntimeAsync("article", articleId is > 0 ? $"article:{articleId.Value};hot:v{hotVersion};search:v{searchVersion}" : $"all;hot:v{hotVersion};search:v{searchVersion}", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article-list", "hot-articles", "stats"],
            [articleId is > 0 ? $"article:{articleId.Value}" : "article:*"],
            [articleId is > 0 ? $"article-detail:{articleId.Value}" : "article-detail:*", "public-aot", "public-hot-read"],
            cancellationToken);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        aotSeoConfigSnapshot?.Invalidate();
        await invalidation.RemoveAsync(CachePolicyId.SystemSeo, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("seo", "system-seo", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.SeoMutation,
            ["seo"],
            ["system:seo"],
            ["public-aot"],
            cancellationToken);
    }

    public async Task InvalidateComplianceAsync(CancellationToken cancellationToken = default)
    {
        aotSeoConfigSnapshot?.Invalidate();
        await invalidation.RemoveAsync(CachePolicyId.SystemCompliance, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("compliance", "site-compliance", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ComplianceMutation,
            ["seo"],
            ["system:compliance"],
            ["public-aot"],
            cancellationToken);
    }

    public async Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default)
    {
        await invalidation.RemoveAsync(CachePolicyId.SystemPage, slug, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.SystemPage);
        await RecordRuntimeAsync("system_page", slug, cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.SystemPageMutation,
            ["system-page"],
            [$"system-page:{slug}"],
            ["public-aot"],
            cancellationToken);
    }

    public async Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default)
    {
        await counters.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, cancellationToken);
        await invalidation.RemoveManyAsync(
            [
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all")
            ],
            cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.Tag, CacheTag.ArticleList);
        await RecordRuntimeAsync("taxonomy", "category-tag", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.TaxonomyMutation,
            ["article-list", "category", "tag"],
            ["taxonomy:*"],
            ["public-aot", "public-hot-read"],
            cancellationToken);
    }

    public async Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default)
    {
        commentPolicyInvalidationSink?.InvalidateLocalSnapshot();
        long version = await counters.IncrementAsync(CachePolicyId.AnonymousCommentPolicyVersion, "main", 1, cancellationToken);
        await RecordRuntimeAsync("comment_policy", $"anonymous-comment-policy:v{version}", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.CommentMutation,
            ["comment-policy"],
            ["comment-policy:anonymous"],
            ["public-hot-read"],
            cancellationToken);
    }

    public async Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
    {
        await IncrementCommentCursorVersionsAsync(scope, cancellationToken);

        await InvalidateStatsAsync(cancellationToken);
        await RecordRuntimeAsync("comment", scope is null ? "all" : $"article:{scope.ArticleId?.ToString() ?? "*"} root:{scope.RootId?.ToString() ?? "*"} account:{scope.AccountId?.ToString() ?? "*"}", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.CommentMutation,
            ["comments", "stats"],
            [scope?.ArticleId is > 0 ? $"article:{scope.ArticleId.Value}:comments" : "comments:*"],
            ["public-hot-read"],
            cancellationToken);
    }

    private async Task IncrementCommentCursorVersionsAsync(CommentCacheInvalidationScope? scope, CancellationToken cancellationToken)
    {
        if (scope is null)
        {
            await counters.IncrementAsync(CachePolicyId.CommentCursorVersion, "global", 1, cancellationToken);
            await counters.IncrementAsync(CachePolicyId.UserCommentCursorVersion, "global", 1, cancellationToken);
            return;
        }

        if (scope.PublicArticleChanged && scope.ArticleId is > 0)
        {
            await counters.IncrementAsync(CachePolicyId.CommentCursorVersion, $"article:{scope.ArticleId.Value}", 1, cancellationToken);
        }

        if (scope.ArticleId is > 0 && scope.RootId is > 0)
        {
            await counters.IncrementAsync(CachePolicyId.CommentCursorVersion, $"article:{scope.ArticleId.Value}:root:{scope.RootId.Value}", 1, cancellationToken);
        }

        if (scope.UserCommentsChanged && scope.AccountId is > 0)
        {
            await counters.IncrementAsync(CachePolicyId.UserCommentCursorVersion, $"account:{scope.AccountId.Value}", 1, cancellationToken);
        }
    }

    public async Task InvalidateStatsAsync(CancellationToken cancellationToken = default)
    {
        await InvalidateAdminStatsCachesAsync(cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Stats);
        await RecordRuntimeAsync("stats", "admin-stats", cancellationToken);
    }

    private async Task InvalidateAdminStatsCachesAsync(CancellationToken cancellationToken)
    {
        long nextFrameVersion = await counters.IncrementAsync(
            CachePolicyId.AdminStats,
            AdminStatsFrameVersioning.CounterIdentity,
            1,
            cancellationToken);
        string previousFrameIdentity = AdminStatsFrameVersioning.BuildIdentity(nextFrameVersion - 1);
        string previousCoreSourceIdentity = AdminStatsFrameVersioning.BuildCoreSourceIdentity(nextFrameVersion - 1);
        string previousSourceIdentity = AdminStatsFrameVersioning.BuildSourceIdentity(nextFrameVersion - 1);
        await invalidation.RemoveManyAsync(
            [
                new(CachePolicyId.AdminStats, "main"),
                new(CachePolicyId.AdminStats, "core:main"),
                new(CachePolicyId.AdminStats, previousCoreSourceIdentity),
                new(CachePolicyId.AdminStatsOverview, "main"),
                new(CachePolicyId.AdminStatsOverview, previousSourceIdentity),
                new(CachePolicyId.AdminStatsRecentComments, "main"),
                new(CachePolicyId.AdminStatsRecentComments, "core:main"),
                new(CachePolicyId.AdminStatsRecentComments, previousSourceIdentity),
                new(CachePolicyId.AdminStatsRegions, "main"),
                new(CachePolicyId.AdminStatsRegions, "core:main"),
                new(CachePolicyId.AdminStatsRegions, previousSourceIdentity),
                new(CachePolicyId.AdminStatsFrame, "core:main"),
                new(CachePolicyId.AdminStatsFrame, previousFrameIdentity)
            ],
            cancellationToken);
    }

    public async Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default)
    {
        await RecordRuntimeAsync("article_view", articleId > 0 ? $"article:{articleId}" : "unknown", cancellationToken);
    }

    public async Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default)
    {
        long hotVersion = PublishHotArticlesVersion("direct-invalidation");
        await httpCacheInvalidator.InvalidateAsync(CacheTag.HotArticles);
        await RecordRuntimeAsync("hot_articles", $"article-hot:v{hotVersion}", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.PublicHotReadVersionPublished,
            ["hot-articles"],
            ["article:hot"],
            [$"public-hot-read:v{hotVersion}"],
            cancellationToken);
    }

    private Task RecordRuntimeAsync(string kind, string? detail, CancellationToken cancellationToken)
        => runtimeState?.RecordAsync(kind, detail, cancellationToken) ?? Task.CompletedTask;

    private long PublishHotArticlesVersion(string reason)
        => hotArticlesVersionPublisher?.PublishNextHotArticlesVersion(reason) ?? 0;

    private Task<DistributedInvalidationPublishResult> PublishDistributedAsync(
        string kind,
        IReadOnlyList<string> cacheTags,
        IReadOnlyList<string> routeKeys,
        IReadOnlyList<string> artifactKeys,
        CancellationToken cancellationToken)
        => distributedInvalidationPublisher?.PublishAsync(
            new DistributedInvalidationRequest(kind, cacheTags, routeKeys, artifactKeys),
            cancellationToken)
            ?? Task.FromResult(new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.LocalOnly,
                null,
                "distributed-publisher-not-registered"));
}

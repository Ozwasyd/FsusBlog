using System.Globalization;

using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICacheInvalidationDispatcher
{
    Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default);
    Task InvalidateArticleMutationAsync(int? articleId, string mutationId, CancellationToken cancellationToken)
        => InvalidateArticleMutationAsync(articleId, cancellationToken);
    Task InvalidateArticleBodyRepairAsync(int articleId, string mutationId, CancellationToken cancellationToken)
        => InvalidateArticleMutationAsync(articleId, mutationId, cancellationToken);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateSeoAsync(string mutationId, CancellationToken cancellationToken)
        => InvalidateSeoAsync(cancellationToken);
    Task InvalidateComplianceAsync(CancellationToken cancellationToken = default);
    Task InvalidateComplianceAsync(string mutationId, CancellationToken cancellationToken)
        => InvalidateComplianceAsync(cancellationToken);
    Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default);
    Task InvalidateSystemPageAsync(string slug, string mutationId, CancellationToken cancellationToken)
        => InvalidateSystemPageAsync(slug, cancellationToken);
    Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default);
    Task InvalidateCategoryTagAsync(string mutationId, CancellationToken cancellationToken)
        => InvalidateCategoryTagAsync(cancellationToken);
    Task InvalidateTaxonomyMetadataAsync(
        string filterRouteKey,
        string mutationId,
        CancellationToken cancellationToken)
        => InvalidateCategoryTagAsync(mutationId, cancellationToken);
    Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default);
    Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default);
    Task InvalidateStatsAsync(CancellationToken cancellationToken = default);
    Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default);
    Task PublishArticleViewProjectionsAsync(
        IReadOnlyDictionary<int, int> authoritativeViews,
        CancellationToken cancellationToken = default)
        => Task.WhenAll(authoritativeViews.Keys.Select(articleId =>
            InvalidateArticleViewAsync(articleId, cancellationToken)));
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
    const string AuthorityCounterIdentity = "hot-stats:hot-articles:version";

    long CurrentHotArticlesVersion
    {
        get;
    }
    string BuildVersionedHotArticlesIdentity(string identity);

    Task EnsureHotArticlesVersionInitializedAsync(CancellationToken cancellationToken = default)
        => Task.CompletedTask;

    void ObserveHotArticlesVersion(long version)
    {
    }
}

public interface IHotArticlesCacheVersionPublisher : IHotArticlesCacheVersionProvider
{
    Task<long> PublishNextHotArticlesVersionAsync(
        string reason,
        CancellationToken cancellationToken = default);
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
    IDistributedInvalidationPublisher? distributedInvalidationPublisher = null,
    IDistributedInvalidationObligationStore? distributedInvalidationObligations = null,
    PublicAotInvalidationTracker? publicAotInvalidationTracker = null) : ICacheInvalidationDispatcher
{
    public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
        => InvalidateArticleMutationAsync(articleId, CreateMutationId("article"), cancellationToken);

    public async Task InvalidateArticleMutationAsync(int? articleId, string mutationId, CancellationToken cancellationToken)
    {
        await AdvanceSitemapGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
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
            await invalidation.RemoveByPrefixAsync(
                CachePolicyId.RelatedReading,
                $"article:{articleId.Value}:",
                cancellationToken);
        }

        await counters.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        long searchVersion = await counters.IncrementAsync(CachePolicyId.ArticleSearchVersion, "main", 1, cancellationToken);
        await invalidation.RemoveAsync(CachePolicyId.ArticleRss, "main", cancellationToken);
        await InvalidateAdminStatsCachesAsync(cancellationToken);
        long hotVersion = await PublishHotArticlesVersionAsync("article-mutation", cancellationToken).ConfigureAwait(false);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.ArticleList, CacheTag.HotArticles, CacheTag.Stats);
        await RecordRuntimeAsync("article", articleId is > 0 ? $"article:{articleId.Value};hot:v{hotVersion};search:v{searchVersion}" : $"all;hot:v{hotVersion};search:v{searchVersion}", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article-list", "hot-articles", "stats"],
            [articleId is > 0 ? $"article:{articleId.Value}" : "article:*"],
            [articleId is > 0 ? $"article-detail:{articleId.Value}" : "article-detail:*", "public-aot", "public-hot-read"],
            cancellationToken,
            mutationId);
    }

    public async Task InvalidateArticleBodyRepairAsync(
        int articleId,
        string mutationId,
        CancellationToken cancellationToken)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(articleId);
        ArgumentException.ThrowIfNullOrWhiteSpace(mutationId);
        await invalidation.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleDetail, articleId.ToString()),
                new(CachePolicyId.ArticleDetail, $"core:v2:{articleId}"),
                new(CachePolicyId.ArticleDetail, $"core:v3:{articleId}"),
                new(CachePolicyId.ArticleDetailFrame, $"core:v3:{articleId}")
            ],
            cancellationToken).ConfigureAwait(false);
        await invalidation.RemoveByPrefixAsync(
            CachePolicyId.RelatedReading,
            $"article:{articleId}:",
            cancellationToken).ConfigureAwait(false);
        long searchVersion = await counters.IncrementAsync(
            CachePolicyId.ArticleSearchVersion,
            "main",
            1,
            cancellationToken).ConfigureAwait(false);
        await RecordRuntimeAsync(
            "article",
            $"article:{articleId};body-repair;search:v{searchVersion}",
            cancellationToken).ConfigureAwait(false);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article"],
            [$"article:{articleId}"],
            [$"article-detail:{articleId}", "public-aot", "public-hot-read"],
            cancellationToken,
            mutationId).ConfigureAwait(false);
    }

    public Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
        => InvalidateSeoAsync(CreateMutationId("seo"), cancellationToken);

    public async Task InvalidateSeoAsync(string mutationId, CancellationToken cancellationToken)
    {
        await AdvanceGlobalPublicAotGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
        aotSeoConfigSnapshot?.Invalidate();
        await invalidation.RemoveAsync(CachePolicyId.SystemSeo, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("seo", "system-seo", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.SeoMutation,
            ["seo"],
            ["system:seo"],
            ["public-aot"],
            cancellationToken,
            mutationId);
    }

    public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default)
        => InvalidateComplianceAsync(CreateMutationId("compliance"), cancellationToken);

    public async Task InvalidateComplianceAsync(string mutationId, CancellationToken cancellationToken)
    {
        await AdvanceGlobalPublicAotGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
        aotSeoConfigSnapshot?.Invalidate();
        await invalidation.RemoveAsync(CachePolicyId.SystemCompliance, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("compliance", "site-compliance", cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ComplianceMutation,
            ["seo"],
            ["system:compliance"],
            ["public-aot"],
            cancellationToken,
            mutationId);
    }

    public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default)
        => InvalidateSystemPageAsync(slug, CreateMutationId("system-page"), cancellationToken);

    public async Task InvalidateSystemPageAsync(string slug, string mutationId, CancellationToken cancellationToken)
    {
        await AdvanceSitemapGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
        await invalidation.RemoveAsync(CachePolicyId.SystemPage, slug, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.SystemPage);
        await RecordRuntimeAsync("system_page", slug, cancellationToken);
        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.SystemPageMutation,
            ["system-page"],
            [$"system-page:{slug}"],
            ["public-aot"],
            cancellationToken,
            mutationId);
    }

    public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default)
        => InvalidateCategoryTagAsync(CreateMutationId("taxonomy"), cancellationToken);

    public async Task InvalidateCategoryTagAsync(string mutationId, CancellationToken cancellationToken)
    {
        await AdvanceSitemapGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
        await counters.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        await counters.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, cancellationToken);
        await invalidation.RemoveByPrefixAsync(CachePolicyId.RelatedReading, "article:", cancellationToken);
        await invalidation.RemoveManyAsync(
            [
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all")
            ],
            cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.Tag, CacheTag.ArticleList);
        await RecordRuntimeAsync("taxonomy", "category-tag", cancellationToken);
        _ = await PublishDistributedAsync(
            DistributedInvalidationEventKinds.TaxonomyMutation,
            ["article-list", "category", "tag"],
            ["taxonomy:*"],
            ["public-aot", "public-hot-read"],
            cancellationToken,
            mutationId);
    }

    public async Task InvalidateTaxonomyMetadataAsync(
        string filterRouteKey,
        string mutationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(filterRouteKey))
        {
            throw new ArgumentException("Filter route identity is required.", nameof(filterRouteKey));
        }

        await AdvanceSitemapGenerationAsync(mutationId, cancellationToken).ConfigureAwait(false);
        await RecordRuntimeAsync("taxonomy", $"metadata:{filterRouteKey}", cancellationToken);
        _ = await PublishDistributedAsync(
            DistributedInvalidationEventKinds.TaxonomyMutation,
            [],
            [filterRouteKey],
            ["public-aot"],
            cancellationToken,
            mutationId);
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

    public async Task PublishArticleViewProjectionsAsync(
        IReadOnlyDictionary<int, int> authoritativeViews,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(authoritativeViews);
        if (authoritativeViews.Count == 0)
        {
            return;
        }

        KeyValuePair<int, int>[] normalized = authoritativeViews
            .OrderBy(static pair => pair.Key)
            .ToArray();
        if (normalized.Any(static pair => pair.Key <= 0 || pair.Value <= 0))
        {
            throw new ArgumentOutOfRangeException(nameof(authoritativeViews), "Article view projection identities and values must be positive.");
        }

        await PublishDistributedAsync(
            DistributedInvalidationEventKinds.ArticleViewProjection,
            [],
            [],
            normalized.Select(static pair =>
                DistributedInvalidationTargetResolver.FormatArticleViewProjectionTarget(
                    pair.Key,
                    pair.Value,
                    pair.Value)).ToArray(),
            cancellationToken).ConfigureAwait(false);
        await RecordRuntimeAsync(
            "article_view",
            $"articles:{normalized.Length};maxViews:{normalized.Max(static pair => pair.Value)}",
            cancellationToken).ConfigureAwait(false);
    }

    public async Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default)
    {
        long hotVersion = await PublishHotArticlesVersionAsync("direct-invalidation", cancellationToken).ConfigureAwait(false);
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

    private Task<long> PublishHotArticlesVersionAsync(string reason, CancellationToken cancellationToken)
        => hotArticlesVersionPublisher?.PublishNextHotArticlesVersionAsync(reason, cancellationToken)
            ?? Task.FromResult(0L);

    private static string CreateMutationId(string mutationKind)
        => $"{mutationKind}:{Guid.CreateVersion7():N}";

    private async Task AdvanceSitemapGenerationAsync(string mutationId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(mutationId))
        {
            throw new ArgumentException("Mutation identity is required.", nameof(mutationId));
        }
        if (publicAotInvalidationTracker is not null)
        {
            _ = await publicAotInvalidationTracker
                .MarkSitemapAsync(mutationId, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task AdvanceGlobalPublicAotGenerationAsync(string mutationId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(mutationId))
        {
            throw new ArgumentException("Mutation identity is required.", nameof(mutationId));
        }
        if (publicAotInvalidationTracker is not null)
        {
            _ = await publicAotInvalidationTracker
                .MarkAllAsync(mutationId, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task<DistributedInvalidationPublishResult> PublishDistributedAsync(
        string kind,
        IReadOnlyList<string> cacheTags,
        IReadOnlyList<string> routeKeys,
        IReadOnlyList<string> artifactKeys,
        CancellationToken cancellationToken,
        string? eventId = null)
    {
        DistributedInvalidationPublishResult result = await (distributedInvalidationPublisher?.PublishAsync(
            new DistributedInvalidationRequest(kind, cacheTags, routeKeys, artifactKeys, eventId),
            cancellationToken)
            ?? Task.FromResult(new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.LocalOnly,
                null,
                "distributed-publisher-not-registered"))).ConfigureAwait(false);
        if (result.Status != DistributedInvalidationPublishStatus.LocalOnly)
        {
            if (distributedInvalidationObligations is null)
            {
                await RecordRuntimeAsync("distributed_degraded", "distributed-invalidation-obligation-store-missing", cancellationToken).ConfigureAwait(false);
                throw new InvalidOperationException("distributed_invalidation_obligation_store_missing");
            }
            await distributedInvalidationObligations.UpsertAsync(result, cancellationToken).ConfigureAwait(false);
        }
        return result;
    }
}

using System.Globalization;
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
    long CurrentHotArticlesVersion { get; }
    string BuildVersionedHotArticlesIdentity(string identity);
}

public interface IHotArticlesCacheVersionPublisher : IHotArticlesCacheVersionProvider
{
    long PublishNextHotArticlesVersion(string reason);
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

public sealed class CacheInvalidationRuntimeState(IUnifiedCache? sharedCache = null)
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
        if (sharedCache is not null && CounterIdentity(kind) is { } identity)
        {
            sharedCount = await sharedCache.IncrementAsync(CachePolicyId.AdminStats, identity, 1, cancellationToken).ConfigureAwait(false);
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
        if (sharedCache is null)
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
        if (identity is null || sharedCache is null)
        {
            return 0;
        }

        string? value = await sharedCache.GetStringAsync(CachePolicyId.AdminStats, identity, cancellationToken).ConfigureAwait(false);
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
    IUnifiedCache cache,
    IHttpCacheInvalidator httpCacheInvalidator,
    CacheInvalidationRuntimeState? runtimeState = null,
    IHotArticlesCacheVersionPublisher? hotArticlesVersionPublisher = null,
    IAnonymousCommentPolicyInvalidationSink? commentPolicyInvalidationSink = null) : ICacheInvalidationDispatcher
{
    public async Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
    {
        if (articleId is > 0)
        {
            await cache.RemoveManyAsync(
                [
                    new(CachePolicyId.ArticleDetail, articleId.Value.ToString()),
                    new(CachePolicyId.ArticleDetail, $"core:v2:{articleId.Value}"),
                    new(CachePolicyId.ArticleDetail, $"core:v3:{articleId.Value}"),
                    new(CachePolicyId.ArticleDetailFrame, $"core:v3:{articleId.Value}")
                ],
                cancellationToken);
        }

        await cache.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        long searchVersion = await cache.IncrementAsync(CachePolicyId.ArticleSearchVersion, "main", 1, cancellationToken);
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleRss, "main"),
                new(CachePolicyId.AdminStats, "main"),
                new(CachePolicyId.AdminStats, "core:main"),
                new(CachePolicyId.AdminStatsOverview, "main"),
                new(CachePolicyId.AdminStatsRecentComments, "main"),
                new(CachePolicyId.AdminStatsRecentComments, "core:main"),
                new(CachePolicyId.AdminStatsRegions, "main"),
                new(CachePolicyId.AdminStatsRegions, "core:main"),
                new(CachePolicyId.AdminStatsFrame, "core:main"),
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all")
            ],
            cancellationToken);
        long hotVersion = PublishHotArticlesVersion("article-mutation");
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList, CacheTag.HotArticles, CacheTag.Stats);
        await RecordRuntimeAsync("article", articleId is > 0 ? $"article:{articleId.Value};hot:v{hotVersion};search:v{searchVersion}" : $"all;hot:v{hotVersion};search:v{searchVersion}", cancellationToken);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemSeo, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("seo", "system-seo", cancellationToken);
    }

    public async Task InvalidateComplianceAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemCompliance, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        await RecordRuntimeAsync("compliance", "site-compliance", cancellationToken);
    }

    public async Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemPage, slug, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.SystemPage);
        await RecordRuntimeAsync("system_page", slug, cancellationToken);
    }

    public async Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all")
            ],
            cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.Tag, CacheTag.ArticleList);
        await RecordRuntimeAsync("taxonomy", "category-tag", cancellationToken);
    }

    public async Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default)
    {
        commentPolicyInvalidationSink?.InvalidateLocalSnapshot();
        long version = await cache.IncrementAsync(CachePolicyId.AnonymousCommentPolicyVersion, "main", 1, cancellationToken);
        await RecordRuntimeAsync("comment_policy", $"anonymous-comment-policy:v{version}", cancellationToken);
    }

    public async Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
    {
        if (scope is null)
        {
            await cache.RemoveByPrefixManyAsync(
                [
                    new(CachePolicyId.CommentCursor, "article:"),
                    new(CachePolicyId.UserCommentCursor, "account:"),
                    new(CachePolicyId.CommentCursorFrame, "article:"),
                    new(CachePolicyId.UserCommentCursorFrame, "account:")
                ],
                cancellationToken);
        }
        else
        {
            var prefixes = new List<CachePrefixIdentity>(6);
            if (scope.PublicArticleChanged && scope.ArticleId is > 0)
            {
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.CommentCursor, $"article:{scope.ArticleId.Value}:"));
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.CommentCursorFrame, $"article:{scope.ArticleId.Value}:"));
            }

            if (scope.ArticleId is > 0 && scope.RootId is > 0)
            {
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.CommentCursor, $"article:{scope.ArticleId.Value}:root:{scope.RootId.Value}:"));
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.CommentCursorFrame, $"article:{scope.ArticleId.Value}:root:{scope.RootId.Value}:"));
            }

            if (scope.UserCommentsChanged && scope.AccountId is > 0)
            {
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursor, $"account:{scope.AccountId.Value}:"));
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursorFrame, $"account:{scope.AccountId.Value}:"));
            }

            if (prefixes.Count > 0)
            {
                await cache.RemoveByPrefixManyAsync(prefixes, cancellationToken);
            }
        }

        await InvalidateStatsAsync(cancellationToken);
        await RecordRuntimeAsync("comment", scope is null ? "all" : $"article:{scope.ArticleId?.ToString() ?? "*"} root:{scope.RootId?.ToString() ?? "*"} account:{scope.AccountId?.ToString() ?? "*"}", cancellationToken);
    }

    public async Task InvalidateStatsAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.AdminStats, "main"),
                new(CachePolicyId.AdminStats, "core:main"),
                new(CachePolicyId.AdminStatsOverview, "main"),
                new(CachePolicyId.AdminStatsRecentComments, "main"),
                new(CachePolicyId.AdminStatsRecentComments, "core:main"),
                new(CachePolicyId.AdminStatsRegions, "main"),
                new(CachePolicyId.AdminStatsRegions, "core:main"),
                new(CachePolicyId.AdminStatsFrame, "core:main")
            ],
            cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Stats);
        await RecordRuntimeAsync("stats", "admin-stats", cancellationToken);
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
    }

    private Task RecordRuntimeAsync(string kind, string? detail, CancellationToken cancellationToken)
        => runtimeState?.RecordAsync(kind, detail, cancellationToken) ?? Task.CompletedTask;

    private long PublishHotArticlesVersion(string reason)
        => hotArticlesVersionPublisher?.PublishNextHotArticlesVersion(reason) ?? 0;
}

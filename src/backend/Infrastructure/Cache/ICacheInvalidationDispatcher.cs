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
    void MarkStatsDirty(string reason);
    void MarkHotArticlesDirty(string reason);
    Task FlushPendingAsync(CancellationToken cancellationToken = default);
    HotStatsInvalidationSnapshot Snapshot();
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
    int? UserId = null,
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

public sealed class CacheInvalidationRuntimeState
{
    private readonly object _gate = new();
    private CacheInvalidationRuntimeSnapshot _snapshot = new(0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null);

    public void Record(string kind, string? detail = null)
    {
        lock (_gate)
        {
            _snapshot = kind switch
            {
                "article" => _snapshot with { ArticleMutationCount = _snapshot.ArticleMutationCount + 1 },
                "seo" => _snapshot with { SeoCount = _snapshot.SeoCount + 1 },
                "compliance" => _snapshot with { ComplianceCount = _snapshot.ComplianceCount + 1 },
                "system_page" => _snapshot with { SystemPageCount = _snapshot.SystemPageCount + 1 },
                "taxonomy" => _snapshot with { CategoryTagCount = _snapshot.CategoryTagCount + 1 },
                "comment" => _snapshot with { CommentMutationCount = _snapshot.CommentMutationCount + 1 },
                "stats" => _snapshot with { StatsCount = _snapshot.StatsCount + 1 },
                "article_view" => _snapshot with { ArticleViewCount = _snapshot.ArticleViewCount + 1 },
                "hot_articles" => _snapshot with { HotArticlesCount = _snapshot.HotArticlesCount + 1 },
                _ => _snapshot
            };

            _snapshot = _snapshot with
            {
                LastInvalidatedAt = DateTimeOffset.UtcNow,
                LastKind = kind,
                LastDetail = detail
            };
        }
    }

    public CacheInvalidationRuntimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }
}

public sealed class CacheInvalidationDispatcher(
    IUnifiedCache cache,
    IHttpCacheInvalidator httpCacheInvalidator,
    CacheInvalidationRuntimeState? runtimeState = null,
    IHotArticlesCacheVersionPublisher? hotArticlesVersionPublisher = null) : ICacheInvalidationDispatcher
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
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleRss, "main"),
                new(CachePolicyId.AdminStats, "main"),
                new(CachePolicyId.AdminStats, "core:main"),
                new(CachePolicyId.AdminStatsFrame, "core:main"),
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all")
            ],
            cancellationToken);
        long hotVersion = PublishHotArticlesVersion("article-mutation");
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList, CacheTag.HotArticles, CacheTag.Stats);
        runtimeState?.Record("article", articleId is > 0 ? $"article:{articleId.Value};hot:v{hotVersion}" : $"all;hot:v{hotVersion}");
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemSeo, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        runtimeState?.Record("seo", "system-seo");
    }

    public async Task InvalidateComplianceAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemCompliance, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
        runtimeState?.Record("compliance", "site-compliance");
    }

    public async Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemPage, slug, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.SystemPage);
        runtimeState?.Record("system_page", slug);
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
        runtimeState?.Record("taxonomy", "category-tag");
    }

    public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default)
    {
        runtimeState?.Record("comment_policy", "anonymous-comment-policy");
        return Task.CompletedTask;
    }

    public async Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
    {
        if (scope is null)
        {
            await cache.RemoveByPrefixManyAsync(
                [
                    new(CachePolicyId.CommentCursor, "article:"),
                    new(CachePolicyId.UserCommentCursor, "user:"),
                    new(CachePolicyId.CommentCursorFrame, "article:"),
                    new(CachePolicyId.UserCommentCursorFrame, "user:")
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

            if (scope.UserCommentsChanged && scope.UserId is > 0)
            {
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursor, $"user:{scope.UserId.Value}:"));
                prefixes.Add(new CachePrefixIdentity(CachePolicyId.UserCommentCursorFrame, $"user:{scope.UserId.Value}:"));
            }

            if (prefixes.Count > 0)
            {
                await cache.RemoveByPrefixManyAsync(prefixes, cancellationToken);
            }
        }

        await InvalidateStatsAsync(cancellationToken);
        runtimeState?.Record("comment", scope is null ? "all" : $"article:{scope.ArticleId?.ToString() ?? "*"} root:{scope.RootId?.ToString() ?? "*"} user:{scope.UserId?.ToString() ?? "*"}");
    }

    public async Task InvalidateStatsAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.AdminStats, "main"),
                new(CachePolicyId.AdminStats, "core:main"),
                new(CachePolicyId.AdminStatsFrame, "core:main")
            ],
            cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Stats);
        runtimeState?.Record("stats", "admin-stats");
    }

    public async Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default)
    {
        if (articleId > 0)
        {
            await cache.RemoveManyAsync(
                [
                    new(CachePolicyId.ArticleDetail, articleId.ToString()),
                    new(CachePolicyId.ArticleDetail, $"core:v2:{articleId}"),
                    new(CachePolicyId.ArticleDetail, $"core:v3:{articleId}"),
                    new(CachePolicyId.ArticleDetailFrame, $"core:v3:{articleId}")
                ],
                cancellationToken);
        }

        runtimeState?.Record("article_view", articleId > 0 ? $"article:{articleId}" : "unknown");
    }

    public async Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default)
    {
        long hotVersion = PublishHotArticlesVersion("direct-invalidation");
        await httpCacheInvalidator.InvalidateAsync(CacheTag.HotArticles);
        runtimeState?.Record("hot_articles", $"article-hot:v{hotVersion}");
    }

    private long PublishHotArticlesVersion(string reason)
        => hotArticlesVersionPublisher?.PublishNextHotArticlesVersion(reason) ?? 0;
}

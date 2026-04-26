namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICacheInvalidationDispatcher
{
    Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default);
    Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default);
    Task InvalidateStatsAsync(CancellationToken cancellationToken = default);
}

public sealed class CacheInvalidationDispatcher(
    IUnifiedCache cache,
    IHttpCacheInvalidator httpCacheInvalidator) : ICacheInvalidationDispatcher
{
    public async Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
    {
        if (articleId is > 0)
        {
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.Value.ToString(), cancellationToken);
        }

        await cache.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        await cache.RemoveAsync(CachePolicyId.ArticleRss, "main", cancellationToken);
        await cache.RemoveAsync(CachePolicyId.AdminStats, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList, CacheTag.HotArticles, CacheTag.Stats);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemSeo, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Seo);
    }

    public async Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.SystemPage, slug, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.SystemPage);
    }

    public async Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default)
    {
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.Tag, CacheTag.ArticleList);
    }

    public async Task InvalidateStatsAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.AdminStats, "main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Stats);
    }
}

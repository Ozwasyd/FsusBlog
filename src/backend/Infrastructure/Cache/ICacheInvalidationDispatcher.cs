namespace FsusBlog.Server.Infrastructure.Cache;

public interface ICacheInvalidationDispatcher
{
    Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default);
    Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default);
    Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default);
    Task InvalidateStatsAsync(CancellationToken cancellationToken = default);
    Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default);
    Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default);
}

public sealed record class CommentCacheInvalidationScope(
    int? ArticleId = null,
    long? RootId = null,
    int? UserId = null,
    bool PublicArticleChanged = false,
    bool UserCommentsChanged = false);

public sealed class CacheInvalidationDispatcher(
    IUnifiedCache cache,
    IHttpCacheInvalidator httpCacheInvalidator) : ICacheInvalidationDispatcher
{
    public async Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default)
    {
        if (articleId is > 0)
        {
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.Value.ToString(), cancellationToken);
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, $"core:v2:{articleId.Value}", cancellationToken);
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, $"core:v3:{articleId.Value}", cancellationToken);
        }

        await cache.IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, cancellationToken);
        await cache.RemoveAsync(CachePolicyId.ArticleRss, "main", cancellationToken);
        await cache.RemoveAsync(CachePolicyId.AdminStats, "main", cancellationToken);
        await cache.RemoveAsync(CachePolicyId.AdminStats, "core:main", cancellationToken);
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

    public async Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
    {
        if (scope is null)
        {
            await cache.RemoveByPrefixAsync(CachePolicyId.CommentCursor, "article:", cancellationToken);
            await cache.RemoveByPrefixAsync(CachePolicyId.UserCommentCursor, "user:", cancellationToken);
        }
        else
        {
            if (scope.PublicArticleChanged && scope.ArticleId is > 0)
            {
                await cache.RemoveByPrefixAsync(CachePolicyId.CommentCursor, $"article:{scope.ArticleId.Value}:", cancellationToken);
            }

            if (scope.ArticleId is > 0 && scope.RootId is > 0)
            {
                await cache.RemoveByPrefixAsync(CachePolicyId.CommentCursor, $"article:{scope.ArticleId.Value}:root:{scope.RootId.Value}:", cancellationToken);
            }

            if (scope.UserCommentsChanged && scope.UserId is > 0)
            {
                await cache.RemoveByPrefixAsync(CachePolicyId.UserCommentCursor, $"user:{scope.UserId.Value}:", cancellationToken);
            }
        }

        await InvalidateStatsAsync(cancellationToken);
    }

    public async Task InvalidateStatsAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.AdminStats, "main", cancellationToken);
        await cache.RemoveAsync(CachePolicyId.AdminStats, "core:main", cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.Stats);
    }

    public async Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default)
    {
        if (articleId > 0)
        {
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId.ToString(), cancellationToken);
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, $"core:v2:{articleId}", cancellationToken);
            await cache.RemoveAsync(CachePolicyId.ArticleDetail, $"core:v3:{articleId}", cancellationToken);
        }

        await httpCacheInvalidator.InvalidateAsync(CacheTag.HotArticles, CacheTag.Stats);
    }

    public async Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default)
    {
        await cache.RemoveByPrefixAsync(CachePolicyId.ArticleHot, string.Empty, cancellationToken);
        await httpCacheInvalidator.InvalidateAsync(CacheTag.HotArticles);
    }
}

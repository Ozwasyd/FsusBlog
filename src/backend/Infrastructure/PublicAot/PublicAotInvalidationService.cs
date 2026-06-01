using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationService(
    IPublicAotShellCache cache,
    IRuntimeKeyScope runtimeKeyScope,
    PublicAotInvalidationTracker invalidationTracker,
    PublicHotReadStore hotReadStore,
    ILogger<PublicAotInvalidationService> logger) : IPublicAotInvalidationService
{
    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        await cache.InvalidateAllAsync(cancellationToken);
        hotReadStore.ClearHtml();
    }

    public async Task InvalidatePageAsync(PublicPageId pageId, CancellationToken cancellationToken = default)
    {
        string prefix = ScopeKey(CacheKeyBuilder.PublicAotDocument(pageId, string.Empty));
        invalidationTracker.MarkPrefix(prefix);
        await cache.RemoveByPrefixAsync(prefix, cancellationToken);
        hotReadStore.ClearHtml();
    }

    public async Task InvalidateRouteAsync(PublicPageId pageId, string routeKey, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            return;
        }

        string cacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(pageId, routeKey.Trim()));
        invalidationTracker.MarkKey(cacheKey);
        await cache.RemoveAsync(cacheKey, cancellationToken);
        hotReadStore.RemoveHtml(routeKey);
    }

    public async Task InvalidateArticleMutationAsync(
        int? articleId,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default)
    {
        await InvalidateListingsAsync(categoryIds, tagIds, cancellationToken);
        if (articleId is > 0)
        {
            await InvalidateRouteAsync(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId.Value), cancellationToken);
        }
    }

    public async Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default)
    {
        await InvalidateListingsAsync(categoryIds, tagIds, cancellationToken);
        foreach (int articleId in articleIds.Distinct())
        {
            if (articleId > 0)
            {
                await InvalidateRouteAsync(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId), cancellationToken);
            }
        }
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        await cache.InvalidateAllAsync(cancellationToken);
        hotReadStore.ClearHtml();
    }

    public async Task InvalidateAboutAsync(CancellationToken cancellationToken = default)
    {
        await InvalidateRouteAsync(PublicPageId.About, "about", cancellationToken);
    }

    private async Task InvalidateListingsAsync(
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken)
    {
        await InvalidatePageAsync(PublicPageId.Home, cancellationToken);
        await InvalidatePageAsync(PublicPageId.Archive, cancellationToken);
        await InvalidatePageAsync(PublicPageId.Filter, cancellationToken);

        foreach (int categoryId in NormalizeIds(categoryIds))
        {
            await InvalidateRouteAsync(PublicPageId.Filter, PublicRouteIdentity.BuildCategoryRouteKey(categoryId), cancellationToken);
        }

        foreach (int tagId in NormalizeIds(tagIds))
        {
            await InvalidateRouteAsync(PublicPageId.Filter, PublicRouteIdentity.BuildTagIdRouteKey(tagId), cancellationToken);
        }

        logger.LogDebug("Public AOT listing caches invalidated.");
    }

    private static IEnumerable<int> NormalizeIds(IEnumerable<int>? ids)
    {
        return ids is null
            ? []
            : ids.Where(static id => id > 0).Distinct();
    }

    private string ScopeKey(string key) => runtimeKeyScope.PrefixKey(key);
}

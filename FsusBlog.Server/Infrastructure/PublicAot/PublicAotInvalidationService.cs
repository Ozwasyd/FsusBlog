using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationService(
    IPublicAotShellCache cache,
    ILogger<PublicAotInvalidationService> logger) : IPublicAotInvalidationService
{
    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        await cache.InvalidateAllAsync(cancellationToken);
    }

    public async Task InvalidatePageAsync(PublicPageId pageId, CancellationToken cancellationToken = default)
    {
        string prefix = CacheKeyBuilder.PublicAotDocument(pageId, string.Empty);
        await cache.RemoveByPrefixAsync(prefix, cancellationToken);
    }

    public async Task InvalidateRouteAsync(PublicPageId pageId, string routeKey, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            return;
        }

        await cache.RemoveAsync(CacheKeyBuilder.PublicAotDocument(pageId, routeKey.Trim()), cancellationToken);
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
            await InvalidateRouteAsync(PublicPageId.ArticleDetail, $"article:{articleId.Value}", cancellationToken);
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
                await InvalidateRouteAsync(PublicPageId.ArticleDetail, $"article:{articleId}", cancellationToken);
            }
        }
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        await cache.InvalidateAllAsync(cancellationToken);
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

        foreach (int categoryId in NormalizeIds(categoryIds))
        {
            await InvalidateRouteAsync(PublicPageId.Filter, $"category:{categoryId}", cancellationToken);
        }

        foreach (int tagId in NormalizeIds(tagIds))
        {
            await InvalidateRouteAsync(PublicPageId.Filter, $"tag:{tagId}", cancellationToken);
        }

        logger.LogDebug("Public AOT listing caches invalidated.");
    }

    private static IEnumerable<int> NormalizeIds(IEnumerable<int>? ids)
    {
        return ids is null
            ? []
            : ids.Where(static id => id > 0).Distinct();
    }
}

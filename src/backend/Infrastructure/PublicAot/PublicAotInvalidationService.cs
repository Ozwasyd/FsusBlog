using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationService(
    IPublicAotShellCache cache,
    IRuntimeKeyScope runtimeKeyScope,
    PublicAotInvalidationTracker invalidationTracker,
    IPublicAotBackfillScheduler backfillScheduler,
    IPublicAotRouteManifestProvider routeManifestProvider,
    PublicHotReadStore hotReadStore,
    ILogger<PublicAotInvalidationService> logger) : IPublicAotInvalidationService
{
    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        await cache.InvalidateAllAsync(cancellationToken);
        hotReadStore.ClearHtml();
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
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
        int[] normalizedCategoryIds = [.. NormalizeIds(categoryIds)];
        int[] normalizedTagIds = [.. NormalizeIds(tagIds)];
        await InvalidateListingsAsync(normalizedCategoryIds, normalizedTagIds, cancellationToken);
        if (articleId is > 0)
        {
            await InvalidateRouteAsync(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId.Value), cancellationToken);
        }

        ScheduleArticleMutationRoutes(articleId, normalizedCategoryIds, normalizedTagIds);
    }

    public async Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default)
    {
        int[] normalizedArticleIds = [.. articleIds.Where(static id => id > 0).Distinct()];
        int[] normalizedCategoryIds = [.. NormalizeIds(categoryIds)];
        int[] normalizedTagIds = [.. NormalizeIds(tagIds)];
        await InvalidateListingsAsync(normalizedCategoryIds, normalizedTagIds, cancellationToken);
        foreach (int articleId in normalizedArticleIds)
        {
            await InvalidateRouteAsync(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId), cancellationToken);
        }

        ScheduleArticleMutationBatchRoutes(normalizedArticleIds, normalizedCategoryIds, normalizedTagIds);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        await cache.InvalidateAllAsync(cancellationToken);
        hotReadStore.ClearHtml();
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
    }

    public async Task InvalidateAboutAsync(CancellationToken cancellationToken = default)
    {
        await InvalidateRouteAsync(PublicPageId.About, "about", cancellationToken);
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.About, 10));
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

    private void ScheduleArticleMutationRoutes(int? articleId, IReadOnlyList<int> categoryIds, IReadOnlyList<int> tagIds)
    {
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Home, 0));
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Archive, 20));
        if (articleId is > 0)
        {
            int categoryId = categoryIds.Count == 1 ? categoryIds[0] : 0;
            ScheduleRoute(PublicAotRouteManifestProvider.CreateArticleRoute(articleId.Value, categoryId, tagIds, 100));
        }

        ScheduleListingRoutes(categoryIds, tagIds);
    }

    private void ScheduleArticleMutationBatchRoutes(IReadOnlyList<int> articleIds, IReadOnlyList<int> categoryIds, IReadOnlyList<int> tagIds)
    {
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Home, 0));
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Archive, 20));
        foreach (int articleId in articleIds)
        {
            ScheduleRoute(PublicAotRouteManifestProvider.CreateArticleRoute(articleId, categoryId: 0, tagIds, 100));
        }

        ScheduleListingRoutes(categoryIds, tagIds);
    }

    private void ScheduleListingRoutes(IReadOnlyList<int> categoryIds, IReadOnlyList<int> tagIds)
    {
        foreach (int categoryId in categoryIds)
        {
            ScheduleRoute(PublicAotRouteManifestProvider.CreateCategoryRoute(categoryId, 200));
        }

        foreach (int tagId in tagIds)
        {
            ScheduleRoute(PublicAotRouteManifestProvider.CreateTagIdRoute(tagId, tagName: null, 210));
        }
    }

    private async Task ScheduleManifestRoutesAsync(PublicAotRouteManifestScope scope, CancellationToken cancellationToken)
    {
        try
        {
            IReadOnlyList<PublicAotRouteDescriptor> routes = await routeManifestProvider
                .ListRoutesAsync(scope, cancellationToken)
                .ConfigureAwait(false);
            foreach (PublicAotRouteDescriptor route in routes)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ScheduleRoute(route);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "public_aot_manifest_pregenerate_schedule_failed {Scope}", scope.Scope);
        }
    }

    private void ScheduleRoute(PublicAotRouteDescriptor route)
    {
        string cacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, route.RouteKey));
        string pagePrefixKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, string.Empty));
        bool scheduled = backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
            route.Kind,
            route.RouteKey,
            route.Path,
            string.Empty,
            cacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = invalidationTracker.GetCurrentVersion(cacheKey, pagePrefixKey)
        });

        logger.LogDebug(
            "public_aot_manifest_pregenerate {RouteKey} {Path} {Scheduled}",
            route.RouteKey,
            route.Path,
            scheduled);
    }

    private static IEnumerable<int> NormalizeIds(IEnumerable<int>? ids)
    {
        return ids is null
            ? []
            : ids.Where(static id => id > 0).Distinct();
    }

    private string ScopeKey(string key) => runtimeKeyScope.PrefixKey(key);
}

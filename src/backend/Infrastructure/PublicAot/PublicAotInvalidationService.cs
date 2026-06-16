using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationService(
    IPublicAotShellCache cache,
    IRuntimeKeyScope runtimeKeyScope,
    PublicAotInvalidationTracker invalidationTracker,
    IPublicAotBackfillScheduler backfillScheduler,
    IPublicAotRouteManifestProvider routeManifestProvider,
    PublicHotReadStore hotReadStore,
    ITestSessionKeyScope testSessionKeyScope,
    PublicAotSsrRuntimeState ssrRuntimeState,
    ILogger<PublicAotInvalidationService> logger) : IPublicAotInvalidationService
{
    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        ssrRuntimeState.ClearAllRouteQuarantines();
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
        await InvalidateRoutesAsync([new RouteInvalidation(pageId, routeKey)], cancellationToken);
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
            await InvalidateRoutesAsync(
                [new RouteInvalidation(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId.Value))],
                cancellationToken);
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
        await InvalidateRoutesAsync(
            [.. normalizedArticleIds.Select(static articleId =>
                new RouteInvalidation(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId)))],
            cancellationToken);

        ScheduleArticleMutationBatchRoutes(normalizedArticleIds, normalizedCategoryIds, normalizedTagIds);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        invalidationTracker.MarkAll();
        ssrRuntimeState.ClearAllRouteQuarantines();
        await cache.InvalidateAllAsync(cancellationToken);
        hotReadStore.ClearHtml();
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
    }

    public async Task InvalidateAboutAsync(CancellationToken cancellationToken = default)
        => await InvalidateStaticPageAsync(PublicPageKind.About, cancellationToken);

    public async Task InvalidateStaticPageAsync(PublicPageKind kind, CancellationToken cancellationToken = default)
    {
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);
        string routeKey = descriptor.FixedRouteKey ?? PublicAotPageIdentity.GetCanonicalSlug(kind);
        await InvalidateRouteAsync(descriptor.PageId, routeKey, cancellationToken);
        ScheduleRoute(PublicAotRouteManifestProvider.CreateStaticRoute(kind, ResolveStaticPagePriority(kind)));
    }

    private static int ResolveStaticPagePriority(PublicPageKind kind)
        => kind switch
        {
            PublicPageKind.Home => 0,
            PublicPageKind.About => 10,
            PublicPageKind.Privacy => 11,
            PublicPageKind.Guidelines => 12,
            PublicPageKind.Copyright => 13,
            PublicPageKind.Archive => 20,
            _ => 50
        };

    private async Task InvalidateListingsAsync(
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken)
    {
        PublicPageId[] pagePrefixes = [PublicPageId.Home, PublicPageId.Archive, PublicPageId.Filter];
        var prefixTasks = new List<Task>(pagePrefixes.Length);
        foreach (PublicPageId pageId in pagePrefixes)
        {
            string prefix = ScopeKey(CacheKeyBuilder.PublicAotDocument(pageId, string.Empty));
            invalidationTracker.MarkPrefix(prefix);
            prefixTasks.Add(cache.RemoveByPrefixAsync(prefix, cancellationToken));
        }

        hotReadStore.ClearHtml();
        await Task.WhenAll(prefixTasks).ConfigureAwait(false);

        RouteInvalidation[] filterRoutes =
        [
            .. NormalizeIds(categoryIds).Select(static categoryId =>
                new RouteInvalidation(PublicPageId.Filter, PublicRouteIdentity.BuildCategoryRouteKey(categoryId))),
            .. NormalizeIds(tagIds).Select(static tagId =>
                new RouteInvalidation(PublicPageId.Filter, PublicRouteIdentity.BuildTagIdRouteKey(tagId)))
        ];
        await InvalidateRoutesAsync(filterRoutes, cancellationToken);

        logger.LogDebug("Public AOT listing caches invalidated.");
    }

    private async Task InvalidateRoutesAsync(
        IEnumerable<RouteInvalidation> routes,
        CancellationToken cancellationToken)
    {
        RouteInvalidation[] normalizedRoutes =
        [
            .. routes
                .Where(static route => !string.IsNullOrWhiteSpace(route.RouteKey))
                .Select(static route => route with { RouteKey = route.RouteKey.Trim() })
                .Distinct()
        ];
        if (normalizedRoutes.Length == 0)
        {
            return;
        }

        string[] cacheKeys = new string[normalizedRoutes.Length];
        for (int i = 0; i < normalizedRoutes.Length; i++)
        {
            RouteInvalidation route = normalizedRoutes[i];
            string cacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, route.RouteKey));
            cacheKeys[i] = cacheKey;
            invalidationTracker.MarkKey(cacheKey);
            ssrRuntimeState.ClearRouteQuarantine(PublicAotPageCatalog.GetRequired(route.PageId).Kind, route.RouteKey);
        }

        await cache.RemoveManyAsync(cacheKeys, cancellationToken).ConfigureAwait(false);
        foreach (RouteInvalidation route in normalizedRoutes)
        {
            hotReadStore.RemoveHtml(route.RouteKey);
        }
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
            ScheduledInvalidationVersion = invalidationTracker.GetCurrentVersion(cacheKey, pagePrefixKey),
            TestSessionId = testSessionKeyScope.SessionId
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

    private readonly record struct RouteInvalidation(PublicPageId PageId, string RouteKey);
}

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Localization;
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
    ISpaAssetManifestService assetManifest,
    PublicAotSsrRuntimeState ssrRuntimeState,
    ILogger<PublicAotInvalidationService> logger) : IPublicAotInvalidationService
{
    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        await invalidationTracker.WithGlobalInvalidationLockAsync(async () =>
        {
            _ = await invalidationTracker.MarkAllAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
            ssrRuntimeState.ClearAllRouteQuarantines();
            await cache.InvalidateAllAsync(cancellationToken).ConfigureAwait(false);
            hotReadStore.ClearHtml();
        }, cancellationToken).ConfigureAwait(false);
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
    }

    public async Task InvalidatePageAsync(PublicPageId pageId, CancellationToken cancellationToken = default)
    {
        string prefix = ScopeKey(CacheKeyBuilder.PublicAotDocument(pageId, string.Empty));
        await invalidationTracker.WithInvalidationLockAsync([prefix], async () =>
        {
            _ = await invalidationTracker.MarkPrefixAsync(prefix, cancellationToken: cancellationToken).ConfigureAwait(false);
            await cache.RemoveByPrefixAsync(prefix, cancellationToken).ConfigureAwait(false);
            hotReadStore.ClearHtml();
        }, cancellationToken).ConfigureAwait(false);
    }

    public async Task InvalidateRouteAsync(PublicPageId pageId, string routeKey, CancellationToken cancellationToken = default)
    {
        await InvalidateRoutesAsync(
            [new RouteInvalidation(pageId, routeKey)],
            mutationId: null,
            cancellationToken);
    }

    public async Task InvalidateFilterRouteFamilyAsync(string filterRouteKey, CancellationToken cancellationToken = default)
        => await InvalidateFilterRouteFamilyAsync(filterRouteKey, mutationId: null, cancellationToken);

    public async Task InvalidateFilterRouteFamilyAsync(
        string filterRouteKey,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(filterRouteKey))
        {
            return;
        }

        PublicRouteIdentity.ParsedFilterRouteIdentity parsed = PublicRouteIdentity.ParseFilterRouteKey(filterRouteKey);
        if (parsed.FilterId <= 0)
        {
            return;
        }

        string familyRouteKey;
        PublicAotRouteDescriptor scheduled;
        if (parsed.CategoryId is > 0)
        {
            familyRouteKey = PublicRouteIdentity.BuildCategoryRouteKey(parsed.FilterId);
            scheduled = PublicAotRouteManifestProvider.CreateCategoryRoute(parsed.FilterId, 200);
        }
        else if (parsed.TagId is > 0)
        {
            familyRouteKey = PublicRouteIdentity.BuildTagIdRouteKey(parsed.FilterId);
            scheduled = PublicAotRouteManifestProvider.CreateTagIdRoute(parsed.FilterId, tagName: null, 210);
        }
        else
        {
            return;
        }

        string exactKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, familyRouteKey));
        string familyPrefix = string.Concat(exactKey, ":");
        string pagePrefixKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty));
        await invalidationTracker.WithInvalidationLockAsync([pagePrefixKey], async () =>
        {
            _ = await invalidationTracker.MarkKeyAsync(exactKey, mutationId, cancellationToken).ConfigureAwait(false);
            _ = await invalidationTracker.MarkPrefixAsync(familyPrefix, mutationId, cancellationToken).ConfigureAwait(false);
            ssrRuntimeState.ClearRouteQuarantine(PublicPageKind.Filter, familyRouteKey);
            await cache.RemoveAsync(exactKey, cancellationToken).ConfigureAwait(false);
            await cache.RemoveByPrefixAsync(familyPrefix, cancellationToken).ConfigureAwait(false);
            hotReadStore.RemoveHtmlFamily(familyRouteKey);
        }, cancellationToken).ConfigureAwait(false);

        ScheduleRoute(scheduled);
    }

    public async Task InvalidateArticleMutationAsync(
        int? articleId,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default)
        => await InvalidateArticleMutationAsync(
            articleId,
            categoryIds,
            tagIds,
            mutationId: null,
            cancellationToken);

    public async Task InvalidateArticleMutationAsync(
        int? articleId,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        string effectiveMutationId = string.IsNullOrWhiteSpace(mutationId)
            ? $"article:{Guid.CreateVersion7():N}"
            : mutationId;
        _ = await invalidationTracker.MarkSitemapAsync(effectiveMutationId, cancellationToken).ConfigureAwait(false);
        int[] normalizedCategoryIds = [.. NormalizeIds(categoryIds)];
        int[] normalizedTagIds = [.. NormalizeIds(tagIds)];
        await InvalidateListingsAsync(normalizedCategoryIds, normalizedTagIds, effectiveMutationId, cancellationToken);
        if (articleId is > 0)
        {
            await InvalidateRoutesAsync(
                [new RouteInvalidation(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId.Value))],
                effectiveMutationId,
                cancellationToken);
        }

        ScheduleArticleMutationRoutes(articleId, normalizedCategoryIds, normalizedTagIds);
    }

    public async Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default)
        => await InvalidateArticleMutationBatchAsync(
            articleIds,
            categoryIds,
            tagIds,
            mutationId: null,
            cancellationToken);

    public async Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        string effectiveMutationId = string.IsNullOrWhiteSpace(mutationId)
            ? $"article-batch:{Guid.CreateVersion7():N}"
            : mutationId;
        _ = await invalidationTracker.MarkSitemapAsync(effectiveMutationId, cancellationToken).ConfigureAwait(false);
        int[] normalizedArticleIds = [.. articleIds.Where(static id => id > 0).Distinct()];
        int[] normalizedCategoryIds = [.. NormalizeIds(categoryIds)];
        int[] normalizedTagIds = [.. NormalizeIds(tagIds)];
        await InvalidateListingsAsync(
            normalizedCategoryIds,
            normalizedTagIds,
            effectiveMutationId,
            cancellationToken);
        await InvalidateRoutesAsync(
            [.. normalizedArticleIds.Select(static articleId =>
                new RouteInvalidation(PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(articleId)))],
            effectiveMutationId,
            cancellationToken);

        ScheduleArticleMutationBatchRoutes(normalizedArticleIds, normalizedCategoryIds, normalizedTagIds);
    }

    public async Task InvalidateSeoAsync(CancellationToken cancellationToken = default)
    {
        await invalidationTracker.WithGlobalInvalidationLockAsync(async () =>
        {
            _ = await invalidationTracker.MarkAllAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
            ssrRuntimeState.ClearAllRouteQuarantines();
            await cache.InvalidateAllAsync(cancellationToken).ConfigureAwait(false);
            hotReadStore.ClearHtml();
        }, cancellationToken).ConfigureAwait(false);
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
    }

    public async Task InvalidateSeoArtifactsAsync(CancellationToken cancellationToken = default)
    {
        await invalidationTracker.WithGlobalInvalidationLockAsync(async () =>
        {
            ssrRuntimeState.ClearAllRouteQuarantines();
            await cache.InvalidateAllAsync(cancellationToken).ConfigureAwait(false);
            hotReadStore.ClearHtml();
        }, cancellationToken).ConfigureAwait(false);
        await ScheduleManifestRoutesAsync(PublicAotRouteManifestScope.All, cancellationToken);
    }

    public async Task InvalidateAboutAsync(CancellationToken cancellationToken = default)
        => await InvalidateStaticPageAsync(PublicPageKind.About, cancellationToken);

    public async Task InvalidateStaticPageAsync(PublicPageKind kind, CancellationToken cancellationToken = default)
        => await InvalidateStaticPageAsync(kind, mutationId: null, cancellationToken);

    public async Task InvalidateStaticPageAsync(
        PublicPageKind kind,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);
        string routeKey = descriptor.FixedRouteKey ?? PublicAotPageIdentity.GetCanonicalSlug(kind);
        await InvalidateRoutesAsync(
            [new RouteInvalidation(descriptor.PageId, routeKey)],
            mutationId,
            cancellationToken);
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
        string? mutationId,
        CancellationToken cancellationToken)
    {
        _ = categoryIds;
        _ = tagIds;
        _ = cancellationToken;
        PublicPageId[] listingPageIds =
        [
            PublicPageId.Home,
            PublicPageId.Archive,
            PublicPageId.Filter
        ];
        string[] prefixes = [.. listingPageIds.Select(pageId => ScopeKey(CacheKeyBuilder.PublicAotDocument(pageId, string.Empty)))];
        await invalidationTracker.WithInvalidationLockAsync(prefixes, async () =>
        {
            foreach (string prefix in prefixes)
            {
                _ = await invalidationTracker.MarkPrefixAsync(prefix, mutationId, cancellationToken).ConfigureAwait(false);
            }

            ssrRuntimeState.ClearAllRouteQuarantines();
            hotReadStore.ClearHtml();
        }, cancellationToken).ConfigureAwait(false);

        logger.LogDebug("Public AOT listing versions bumped.");
    }

    private async Task InvalidateRoutesAsync(
        IEnumerable<RouteInvalidation> routes,
        string? mutationId,
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
        string[] pagePrefixKeys = new string[normalizedRoutes.Length];
        for (int i = 0; i < normalizedRoutes.Length; i++)
        {
            RouteInvalidation route = normalizedRoutes[i];
            string cacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, route.RouteKey));
            cacheKeys[i] = cacheKey;
            pagePrefixKeys[i] = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, string.Empty));
        }
        await invalidationTracker.WithInvalidationLockAsync(pagePrefixKeys, async () =>
        {
            foreach (RouteInvalidation route in normalizedRoutes)
            {
                string cacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, route.RouteKey));
                _ = await invalidationTracker.MarkKeyAsync(cacheKey, mutationId, cancellationToken).ConfigureAwait(false);
                ssrRuntimeState.ClearRouteQuarantine(PublicAotPageCatalog.GetRequired(route.PageId).Kind, route.RouteKey);
            }

            await cache.RemoveManyAsync(cacheKeys, cancellationToken).ConfigureAwait(false);
            foreach (RouteInvalidation route in normalizedRoutes)
            {
                hotReadStore.RemoveHtml(route.RouteKey);
            }
        }, cancellationToken).ConfigureAwait(false);
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
        string baseCacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, route.RouteKey));
        string localizedCacheKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(
            route.PageId,
            route.RouteKey,
            LocaleCatalog.Default.Code));
        string pagePrefixKey = ScopeKey(CacheKeyBuilder.PublicAotDocument(route.PageId, string.Empty));
        string cacheKey = ResolveVersionedDocumentCacheKey(localizedCacheKey, baseCacheKey, pagePrefixKey);
        bool scheduled = backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
            route.Kind,
            route.RouteKey,
            route.Path,
            string.Empty,
            cacheKey)
        {
            InvalidationKey = baseCacheKey,
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = invalidationTracker.GetCurrentVersion(baseCacheKey, pagePrefixKey),
            TestSessionId = testSessionKeyScope.SessionId,
            FrontendAssetVersion = assetManifest.GetFrontendAssetVersion(),
            Locale = LocaleCatalog.Default.Code
        });

        logger.LogDebug(
            "public_aot_manifest_pregenerate {RouteKey} {Path} {Scheduled}",
            route.RouteKey,
            route.Path,
            scheduled);
    }

    private string ResolveVersionedDocumentCacheKey(
        string cacheKey,
        string invalidationKey,
        string pagePrefixKey)
    {
        long version = invalidationTracker.GetCurrentVersion(invalidationKey, pagePrefixKey);
        return string.Concat(cacheKey, ":iv:", version.ToString());
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

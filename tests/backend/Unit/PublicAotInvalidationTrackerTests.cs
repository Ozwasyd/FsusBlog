using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotInvalidationTrackerTests
{
    [Fact]
    public void WasInvalidatedAfter_DetectsExactRouteInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:1");
        string pagePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty);
        var request = new PublicAotBackfillRequest(
            PublicPageKind.Filter,
            "category:1",
            "/category/1",
            string.Empty,
            cacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, pagePrefixKey)
        };

        tracker.MarkKey(cacheKey);

        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public void WasInvalidatedAfter_DetectsPagePrefixInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = "session-1:" + CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "tag:1");
        string pagePrefixKey = "session-1:" + CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty);
        var request = new PublicAotBackfillRequest(
            PublicPageKind.Filter,
            "tag:1",
            "/tag/1",
            string.Empty,
            cacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, pagePrefixKey)
        };

        tracker.MarkPrefix(pagePrefixKey);

        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public void WasInvalidatedAfter_DetectsGlobalInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.About, "about");
        string pagePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.About, string.Empty);
        var request = new PublicAotBackfillRequest(
            PublicPageKind.About,
            "about",
            "/about",
            string.Empty,
            cacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, pagePrefixKey)
        };

        tracker.MarkAll();

        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public async Task InvalidateSeoAsync_MarksGlobalInvalidationForScheduledBackfill()
    {
        var tracker = new PublicAotInvalidationTracker();
        var cache = new RecordingAotCache();
        var scheduler = new RecordingBackfillScheduler();
        var service = new PublicAotInvalidationService(
            cache,
            new DefaultRuntimeKeyScope(),
            tracker,
            scheduler,
            new RecordingRouteManifestProvider(),
            new PublicHotReadStore(),
            new FixedTestSessionKeyScope(null),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home");
        string pagePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, string.Empty);
        var request = new PublicAotBackfillRequest(
            PublicPageKind.Home,
            "home",
            "/",
            string.Empty,
            cacheKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, pagePrefixKey)
        };

        await service.InvalidateSeoAsync();

        Assert.True(cache.InvalidatedAll);
        Assert.True(tracker.WasInvalidatedAfter(request));
        Assert.Contains(scheduler.Requests, scheduled => scheduled.RouteKey == "home");
    }

    [Fact]
    public async Task InvalidateArticleMutationAsync_CarriesCurrentTestSessionToScheduledBackfills()
    {
        var tracker = new PublicAotInvalidationTracker();
        var scheduler = new RecordingBackfillScheduler();
        var service = new PublicAotInvalidationService(
            new RecordingAotCache(),
            new PrefixingRuntimeKeyScope("e2e:pw-0:"),
            tracker,
            scheduler,
            new RecordingRouteManifestProvider(),
            new PublicHotReadStore(),
            new FixedTestSessionKeyScope("pw-0"),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);

        await service.InvalidateArticleMutationAsync(42, [7], [9]);

        Assert.NotEmpty(scheduler.Requests);
        Assert.All(scheduler.Requests, request => Assert.Equal("pw-0", request.TestSessionId));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:9");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "article:42");
    }

    [Fact]
    public async Task InvalidateArticleMutationAsync_BumpsListingVersionsWithoutPrefixScanning()
    {
        var tracker = new PublicAotInvalidationTracker();
        var cache = new RecordingAotCache();
        var scheduler = new RecordingBackfillScheduler();
        var service = new PublicAotInvalidationService(
            cache,
            new DefaultRuntimeKeyScope(),
            tracker,
            scheduler,
            new RecordingRouteManifestProvider(),
            new PublicHotReadStore(),
            new FixedTestSessionKeyScope(null),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);
        string homeKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home");
        string homePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, string.Empty);
        string articleKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, "article:42");
        string articlePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, string.Empty);
        string filterKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7");
        string filterPrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty);
        var homeRequest = new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, homeKey)
        {
            PagePrefixKey = homePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(homeKey, homePrefixKey)
        };
        var articleRequest = new PublicAotBackfillRequest(PublicPageKind.ArticleDetail, "article:42", "/article/42", string.Empty, articleKey)
        {
            PagePrefixKey = articlePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(articleKey, articlePrefixKey)
        };
        var filterRequest = new PublicAotBackfillRequest(PublicPageKind.Filter, "category:7", "/category/7", string.Empty, filterKey)
        {
            PagePrefixKey = filterPrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(filterKey, filterPrefixKey)
        };

        await service.InvalidateArticleMutationAsync(42, [7], [9]);

        Assert.Empty(cache.PrefixesRemoved);
        Assert.Contains(articleKey, cache.KeysRemoved);
        Assert.Contains(filterKey, cache.KeysRemoved);
        Assert.True(tracker.WasInvalidatedAfter(homeRequest));
        Assert.True(tracker.WasInvalidatedAfter(articleRequest));
        Assert.True(tracker.WasInvalidatedAfter(filterRequest));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "home");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "archive");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:9");
    }

    [Fact]
    public void Tracker_DoesNotTreatScopedPrefixAsUnscopedPageInvalidation()
    {
        var tracker = new PublicAotInvalidationTracker();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7");
        string scopedPrefix = "session-42:" + CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty);
        var scoped = new PublicAotBackfillRequest(PublicPageKind.Filter, "category:7", "/category/7", string.Empty, cacheKey)
        {
            PagePrefixKey = scopedPrefix,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, scopedPrefix)
        };
        var unscoped = scoped with
        {
            PagePrefixKey = string.Empty,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(cacheKey, string.Empty)
        };

        tracker.MarkPrefix(scopedPrefix);

        Assert.True(tracker.WasInvalidatedAfter(scoped));
        Assert.False(tracker.WasInvalidatedAfter(unscoped));
        Assert.Equal(0, tracker.GetCurrentVersion(cacheKey, string.Empty));
        Assert.True(tracker.GetCurrentVersion(cacheKey, scopedPrefix) > 0);
    }
    private sealed class RecordingAotCache : IPublicAotShellCache
    {
        public bool InvalidatedAll { get; private set; }

        public List<string> KeysRemoved { get; } = [];

        public List<string> PrefixesRemoved { get; } = [];

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
            => Task.FromResult<PublicAotCacheEntry?>(null);

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
            => Task.FromResult<PublicAotCacheEntry?>(null);

        public Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
        {
            KeysRemoved.Add(cacheKey);
            return Task.CompletedTask;
        }

        public Task RemoveManyAsync(IReadOnlyCollection<string> cacheKeys, CancellationToken cancellationToken = default)
        {
            KeysRemoved.AddRange(cacheKeys);
            return Task.CompletedTask;
        }

        public Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
        {
            PrefixesRemoved.Add(prefix);
            return Task.CompletedTask;
        }

        public Task InvalidateAllAsync(CancellationToken cancellationToken = default)
        {
            InvalidatedAll = true;
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingBackfillScheduler : IPublicAotBackfillScheduler
    {
        public List<PublicAotBackfillRequest> Requests { get; } = [];

        public bool TrySchedule(PublicAotBackfillRequest request)
        {
            Requests.Add(request);
            return true;
        }
    }

    private sealed class RecordingRouteManifestProvider : IPublicAotRouteManifestProvider
    {
        public Task<IReadOnlyList<PublicAotRouteDescriptor>> ListRoutesAsync(
            PublicAotRouteManifestScope scope,
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<PublicAotRouteDescriptor>>(
                [PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Home, 0)]);
    }

    private sealed class FixedTestSessionKeyScope(string? sessionId) : ITestSessionKeyScope
    {
        public string? SessionId { get; } = sessionId;

        public string PrefixKey(string key) => SessionId is { } session ? $"e2e:{session}:{key}" : key;

        public IDisposable BeginScope(string? sessionId) => new NoopScope();

        private sealed class NoopScope : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }

    private sealed class PrefixingRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => prefix + key;
    }
}

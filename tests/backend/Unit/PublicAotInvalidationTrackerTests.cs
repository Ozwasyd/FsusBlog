using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Logging.Abstractions;

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
            NullLogger<PublicAotInvalidationService>.Instance);

        await service.InvalidateArticleMutationAsync(42, [7], [9]);

        Assert.NotEmpty(scheduler.Requests);
        Assert.All(scheduler.Requests, request => Assert.Equal("pw-0", request.TestSessionId));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:9");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "article:42");
    }

    [Fact]
    public void TrackerSource_DoesNotRebuildUnscopedPagePrefix()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Infrastructure", "PublicAot", "PublicAotInvalidationTracker.cs"));

        Assert.DoesNotContain("CacheKeyBuilder.PublicAotDocument", source, StringComparison.Ordinal);
        Assert.Contains("GetCurrentVersion(string cacheKey, string pagePrefixKey)", source, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }

    private sealed class RecordingAotCache : IPublicAotShellCache
    {
        public bool InvalidatedAll { get; private set; }

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
            => Task.FromResult<PublicAotCacheEntry?>(null);

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
            => Task.FromResult<PublicAotCacheEntry?>(null);

        public Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

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

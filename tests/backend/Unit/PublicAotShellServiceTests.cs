using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotShellServiceTests
{
    [Fact]
    public async Task RenderAsync_WhenCacheHit_ReturnsAotDocument_AndDoesNotQueueBackfill()
    {
        var match = HomeMatch();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey);
        var cache = new RecordingAotCache
        {
            Entry = new PublicAotCacheEntry
            {
                CacheKey = cacheKey,
                RouteKey = match.RouteKey,
                PageId = match.PageId,
                Source = PublicAotWriteSource.ServerSsrBackfill,
                RendererVersion = PublicAotShellService.PublicRendererVersion,
                FrontendAssetVersion = "frontend-v1",
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
                Value = "<!doctype html><html><body>aot</body></html>"
            }
        };
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.NotNull(rendered);
        Assert.Same(cache.Entry, rendered);
        Assert.Equal(cache.Entry.Value, rendered.GetHtml());
        Assert.Equal("server-ssr", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("none", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("fresh", context.Items[PublicAotShellService.PublicAotStateContextKey]);
        Assert.Empty(scheduler.Requests);
        Assert.Empty(cache.RemovedKeys);
    }

    [Fact]
    public async Task RenderAsync_WhenCacheMiss_ReturnsEmptySpaFallback_AndQueuesBackfill()
    {
        var match = HomeMatch();
        var cache = new RecordingAotCache();
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Equal("spa-fallback", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("queued", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("fallback", context.Items[PublicAotShellService.PublicAotStateContextKey]);
        PublicAotBackfillRequest request = Assert.Single(scheduler.Requests);
        Assert.Equal(match.Kind, request.Kind);
        Assert.Equal(match.RouteKey, request.RouteKey);
        Assert.Equal(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey), request.CacheKey);
        Assert.Equal(CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty), request.PagePrefixKey);
        Assert.Empty(cache.RemovedKeys);
    }

    [Fact]
    public async Task RenderAsync_WhenTestSessionHeaderIsPresent_CarriesSessionIntoBackfillRequest()
    {
        var match = HomeMatch();
        var cache = new RecordingAotCache();
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler, new PrefixRuntimeKeyScope("e2e:pw-0:"));
        var context = new DefaultHttpContext();
        context.Request.Headers[HttpTestSessionKeyScope.HeaderName] = "pw-0";

        _ = await sut.RenderAsync(context, match);

        PublicAotBackfillRequest request = Assert.Single(scheduler.Requests);
        Assert.Equal("pw-0", request.TestSessionId);
        Assert.Equal($"e2e:pw-0:{CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey)}", request.CacheKey);
        Assert.Equal($"e2e:pw-0:{CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty)}", request.PagePrefixKey);
    }

    [Fact]
    public async Task RenderAsync_WhenCacheEntryIsNotRenderable_RemovesEntry_ReturnsSpaFallback_AndQueuesBackfill()
    {
        var match = HomeMatch();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey);
        var cache = new RecordingAotCache
        {
            Entry = new PublicAotCacheEntry
            {
                CacheKey = cacheKey,
                RouteKey = match.RouteKey,
                PageId = match.PageId,
                Source = PublicAotWriteSource.ServerSsrBackfill,
                RendererVersion = PublicAotShellService.PublicRendererVersion,
                FrontendAssetVersion = "stale-frontend",
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
                Value = "<!doctype html><html><body>stale</body></html>"
            }
        };
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Equal("spa-fallback", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("queued", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Collection(cache.RemovedKeys, removed => Assert.Equal(cacheKey, removed));
        Assert.Single(scheduler.Requests);
    }

    [Fact]
    public async Task RenderAsync_WhenCacheEntryIsExpiredButCompatible_ReturnsStaleDocument_AndQueuesRefresh()
    {
        var match = HomeMatch();
        string cacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey);
        var cache = new RecordingAotCache
        {
            Entry = new PublicAotCacheEntry
            {
                CacheKey = cacheKey,
                RouteKey = match.RouteKey,
                PageId = match.PageId,
                Source = PublicAotWriteSource.ServerSsrBackfill,
                RendererVersion = PublicAotShellService.PublicRendererVersion,
                FrontendAssetVersion = "frontend-v1",
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(-5),
                Value = "<!doctype html><html><body>stale-compatible</body></html>"
            }
        };
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.NotNull(rendered);
        Assert.Same(cache.Entry, rendered);
        Assert.Equal(cache.Entry.Value, rendered.GetHtml());
        Assert.Equal("server-ssr", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("stale-refresh-queued", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("stale", context.Items[PublicAotShellService.PublicAotStateContextKey]);
        Assert.Empty(cache.RemovedKeys);
        Assert.Single(scheduler.Requests);
    }

    [Fact]
    public void IsRenderableCacheEntry_RejectsMismatchedFrontendAssetVersion()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:doc:1:home",
            RouteKey = "home",
            RendererVersion = PublicAotShellService.PublicRendererVersion,
            FrontendAssetVersion = "frontend-v1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
            Value = "<html>cached</html>"
        };

        bool renderable = PublicAotShellService.IsRenderableCacheEntry(entry, "frontend-v2");

        Assert.False(renderable);
    }

    [Fact]
    public void IsRenderableCacheEntry_AcceptsMatchingRendererAndFrontendAssetVersion()
    {
        var entry = new PublicAotCacheEntry
        {
            CacheKey = "public:aot:v2:doc:1:home",
            RouteKey = "home",
            RendererVersion = PublicAotShellService.PublicRendererVersion,
            FrontendAssetVersion = "frontend-v1",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
            Value = "<html>cached</html>"
        };

        bool renderable = PublicAotShellService.IsRenderableCacheEntry(entry, "frontend-v1");

        Assert.True(renderable);
    }

    [Fact]
    public void Constructor_WhenSeoProviderCoverageMissing_Throws()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new PublicAotShellService(
            Substitute.For<IDbConcurrencyGate>(),
            new FixedRouteRegistry(HomeMatch()),
            [],
            Substitute.For<IPublicAotEntryRenderer>(),
            Substitute.For<IPublicAotDocumentService>(),
            Substitute.For<IPublicAotShellCache>(),
            Substitute.For<IPublicAotCacheWriter>(),
            Substitute.For<IPublicAotBackfillScheduler>(),
            new FixedAssetManifestService("frontend-v1"),
            new DefaultRuntimeKeyScope(),
            new PublicAotInvalidationTracker(),
            NullLogger<PublicAotShellService>.Instance));

        Assert.Contains("public_aot_provider_missing", ex.Message, StringComparison.Ordinal);
    }

    private static PublicAotRouteMatch HomeMatch()
        => new(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);

    private static PublicAotShellService CreateService(
        PublicAotRouteMatch match,
        IPublicAotShellCache cache,
        IPublicAotBackfillScheduler scheduler,
        IRuntimeKeyScope? runtimeKeyScope = null)
        => new(
            Substitute.For<IDbConcurrencyGate>(),
            new FixedRouteRegistry(match),
            CreateBootstrapProviders(),
            Substitute.For<IPublicAotEntryRenderer>(),
            Substitute.For<IPublicAotDocumentService>(),
            cache,
            Substitute.For<IPublicAotCacheWriter>(),
            scheduler,
            new FixedAssetManifestService("frontend-v1"),
            runtimeKeyScope ?? new DefaultRuntimeKeyScope(),
            new PublicAotInvalidationTracker(),
            NullLogger<PublicAotShellService>.Instance);

    private static IEnumerable<IPublicAotBootstrapProvider> CreateBootstrapProviders()
    {
        yield return new StubBootstrapProvider(PublicPageKind.Home);
        yield return new StubBootstrapProvider(PublicPageKind.ArticleDetail);
        yield return new StubBootstrapProvider(PublicPageKind.Filter);
        yield return new StubBootstrapProvider(PublicPageKind.About);
        yield return new StubBootstrapProvider(PublicPageKind.Privacy);
        yield return new StubBootstrapProvider(PublicPageKind.Guidelines);
        yield return new StubBootstrapProvider(PublicPageKind.Copyright);
        yield return new StubBootstrapProvider(PublicPageKind.Archive);
    }

    private sealed class FixedRouteRegistry(PublicAotRouteMatch match) : IPublicAotRouteRegistry
    {
        public bool TryResolve(HttpContext context, out PublicAotRouteMatch resolved)
        {
            resolved = match;
            return true;
        }
    }

    private sealed class RecordingAotCache : IPublicAotShellCache
    {
        public PublicAotCacheEntry? Entry { get; init; }
        public List<string> RemovedKeys { get; } = [];

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
            => Task.FromResult(Entry);

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
            => Task.FromResult(Entry);

        public Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
        {
            RemovedKeys.Add(cacheKey);
            return Task.CompletedTask;
        }

        public Task RemoveManyAsync(IReadOnlyCollection<string> cacheKeys, CancellationToken cancellationToken = default)
        {
            RemovedKeys.AddRange(cacheKeys);
            return Task.CompletedTask;
        }

        public Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task InvalidateAllAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;
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

    private sealed class FixedAssetManifestService(string frontendAssetVersion) : ISpaAssetManifestService
    {
        public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null) => [];

        public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
            => new("/assets/public.js", [], [], frontendAssetVersion, UsesSourceAssets: false);

        public string GetFrontendAssetVersion() => frontendAssetVersion;
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class StubBootstrapProvider(PublicPageKind kind) : IPublicAotBootstrapProvider
    {
        public PublicPageKind Kind { get; } = kind;

        public Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
            => Task.FromResult(Result<PublicPageSnapshot>.Success(new PublicHomePageSnapshot(
                new PublicAotSeoSnapshot("Fsus", "Blog", "https://blog.fsus.blog"),
                1,
                8,
                0,
                [],
                [],
                [])));
    }
}

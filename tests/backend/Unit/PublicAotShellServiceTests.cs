using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
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
        Assert.Equal(VersionedListKey(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey)), request.CacheKey);
        Assert.Equal(CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty), request.PagePrefixKey);
        Assert.Empty(cache.RemovedKeys);
    }

    [Fact]
    public async Task RenderAsync_WhenSsrCircuitIsOpen_ReturnsSpaFallback_AndDropsBackfillOnly()
    {
        var match = HomeMatch();
        var cache = new RecordingAotCache();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:SsrCircuitFailureThreshold"] = "1",
                ["PublicAot:SsrCircuitCooldownSeconds"] = "60"
            })
            .Build();
        var runtimeState = new PublicAotSsrRuntimeState(configuration);
        runtimeState.RecordBackfillFailure(
            new PublicAotBackfillRequest(PublicPageKind.Home, "home", "/", string.Empty, "cache:failed"),
            PublicAotSsrFailureClass.WorkerTimeout,
            "public AOT pooled SSR worker timed out",
            TimeSpan.FromSeconds(1));
        var scheduler = new PublicAotBackfillScheduler(configuration, runtimeState);
        PublicAotShellService sut = CreateService(match, cache, scheduler, runtimeState: runtimeState);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Equal("spa-fallback", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("dropped", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("fallback", context.Items[PublicAotShellService.PublicAotStateContextKey]);
        PublicAotSsrRuntimeSnapshot snapshot = runtimeState.CreateSnapshot(scheduler.InFlightCount, scheduler.QueueCapacity);
        Assert.Equal("circuit-open", snapshot.LastDropReason);
    }

    [Fact]
    public async Task GenerateAndStoreAsync_RepeatedRendererContractFailure_QuarantinesRoute()
    {
        var match = HomeMatch();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["PublicAot:SsrCircuitFailureThreshold"] = "99",
                ["PublicAot:SsrRouteQuarantineFailureThreshold"] = "2",
                ["PublicAot:SsrRouteQuarantineTtlSeconds"] = "60"
            })
            .Build();
        var runtimeState = new PublicAotSsrRuntimeState(configuration);
        var renderer = new FailingRenderer("public_aot_worker_invalid_aeds");
        PublicAotShellService sut = CreateService(
            match,
            new RecordingAotCache(),
            new RecordingBackfillScheduler(),
            runtimeState: runtimeState,
            entryRenderer: renderer,
            dbConcurrencyGate: new ImmediateDbConcurrencyGate());
        var request = new PublicAotBackfillRequest(match.Kind, match.RouteKey, match.Path, match.QueryString, "cache:home");

        await sut.GenerateAndStoreAsync(request);
        await sut.GenerateAndStoreAsync(request);

        PublicAotRouteQuarantineSnapshot quarantine = Assert.Single(runtimeState.CreateSnapshot(0, 32).RouteQuarantines);
        Assert.Equal(match.Kind, quarantine.Kind);
        Assert.Equal(match.RouteKey, quarantine.RouteKey);
        Assert.Equal("public_aot_worker_invalid_aeds", quarantine.LastFailureReason);
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
        Assert.Equal(VersionedListKey($"e2e:pw-0:{CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey)}"), request.CacheKey);
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
        Assert.Collection(cache.RemovedKeys, removed => Assert.Equal(VersionedListKey(cacheKey), removed));
        Assert.Single(scheduler.Requests);
    }

    [Fact]
    public async Task RenderAsync_DevelopmentViteProxy_DoesNotServeProductionManifestAotCache()
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
                FrontendAssetVersion = "prod-manifest",
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
                Value = "<!doctype html><html><body><script src=\"/assets/full-app-core-prod.js\"></script></body></html>"
            }
        };
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(
            match,
            cache,
            scheduler,
            assetManifest: new FixedAssetManifestService("prod-manifest", "dev-source-assets"));
        var context = new DefaultHttpContext();
        context.Request.Host = new HostString("127.0.0.1:7568");
        context.Request.Headers["X-Forwarded-Host"] = "127.0.0.1:3000";

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Equal("spa-fallback", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("dev-source-assets", context.Items[PublicAotShellService.PublicAotAssetModeContextKey]);
        Assert.Equal("dev-source-bypass", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Empty(cache.RemovedKeys);
        Assert.Empty(scheduler.Requests);
    }

    [Fact]
    public async Task RenderAsync_WhenCacheEntryIsExpiredButCompatible_RemovesEntry_ReturnsSpaFallback_AndQueuesBackfill()
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
                Value = "<!doctype html><html><body>expired-compatible</body></html>"
            }
        };
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Equal("spa-fallback", context.Items[PublicAotShellService.PublicAotSourceContextKey]);
        Assert.Equal("queued", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("fallback", context.Items[PublicAotShellService.PublicAotStateContextKey]);
        Assert.Collection(cache.RemovedKeys, removed => Assert.Equal(VersionedListKey(cacheKey), removed));
        Assert.Single(scheduler.Requests);
    }

    [Fact]
    public async Task RenderAsync_WhenListVersionBumps_UsesVersionedDocumentKeyInsteadOfOldKey()
    {
        var match = HomeMatch();
        string baseCacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey);
        var cache = new RecordingAotCache
        {
            EntriesByKey =
            {
                [VersionedListKey(baseCacheKey, 0)] = new PublicAotCacheEntry
                {
                    CacheKey = VersionedListKey(baseCacheKey, 0),
                    RouteKey = match.RouteKey,
                    PageId = match.PageId,
                    Source = PublicAotWriteSource.ServerSsrBackfill,
                    RendererVersion = PublicAotShellService.PublicRendererVersion,
                    FrontendAssetVersion = "frontend-v1",
                    ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
                    Value = "<!doctype html><html><body>old-list</body></html>"
                }
            }
        };
        var tracker = new PublicAotInvalidationTracker();
        tracker.MarkKey(baseCacheKey);
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(match, cache, scheduler, invalidationTracker: tracker);
        var context = new DefaultHttpContext();

        PublicAotCacheEntry? rendered = await sut.RenderAsync(context, match);

        Assert.Null(rendered);
        Assert.Contains(VersionedListKey(baseCacheKey, 1), cache.RequestedKeys);
        Assert.DoesNotContain(baseCacheKey, cache.RequestedKeys);
        PublicAotBackfillRequest request = Assert.Single(scheduler.Requests);
        Assert.Equal(VersionedListKey(baseCacheKey, 1), request.CacheKey);
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
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotShellService>.Instance));

        Assert.Contains("public_aot_provider_missing", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RenderClassifiedAsync_NotFound_DoesNotQueueBackfillOrWriteSuccessState()
    {
        var match = HomeMatch();
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(
            match,
            new RecordingAotCache(),
            scheduler,
            dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            bootstrapProviders: CreateBootstrapProviders(new FailingBootstrapProvider(
                PublicPageKind.Home,
                ErrorCode.NotFound,
                "public_aot_home_not_found")));
        var context = new DefaultHttpContext();

        PublicAotRenderOutcome result = await sut.RenderClassifiedAsync(context, match);

        Assert.Equal(PublicAotRenderStatus.NotFound, result.Status);
        Assert.Null(result.Entry);
        Assert.Empty(scheduler.Requests);
        Assert.Equal("none", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
        Assert.Equal("not-found", context.Items[PublicAotShellService.PublicAotStateContextKey]);
    }

    [Fact]
    public async Task RenderClassifiedAsync_TransientProviderFailure_DoesNotQueueBackfill()
    {
        var match = HomeMatch();
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(
            match,
            new RecordingAotCache(),
            scheduler,
            dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            bootstrapProviders: CreateBootstrapProviders(new FailingBootstrapProvider(
                PublicPageKind.Home,
                ErrorCode.InfraFailure,
                "db-unavailable")));
        var context = new DefaultHttpContext();

        PublicAotRenderOutcome result = await sut.RenderClassifiedAsync(context, match);

        Assert.Equal(PublicAotRenderStatus.TransientFailure, result.Status);
        Assert.Empty(scheduler.Requests);
        Assert.Equal("transient-failure", context.Items[PublicAotShellService.PublicAotStateContextKey]);
    }

    [Fact]
    public async Task RenderClassifiedAsync_ValidColdRoute_QueuesBackfillAfterClassification()
    {
        var match = HomeMatch();
        var scheduler = new RecordingBackfillScheduler();
        PublicAotShellService sut = CreateService(
            match,
            new RecordingAotCache(),
            scheduler,
            dbConcurrencyGate: new ImmediateDbConcurrencyGate());
        var context = new DefaultHttpContext();

        PublicAotRenderOutcome result = await sut.RenderClassifiedAsync(context, match);

        Assert.Equal(PublicAotRenderStatus.Success, result.Status);
        Assert.Single(scheduler.Requests);
        Assert.Equal("queued", context.Items[PublicAotShellService.PublicAotBackfillContextKey]);
    }

    [Fact]
    public async Task BuildNavigationSnapshotAsync_UsesRendererEntryPayloads_AndAddsEnvelopeMetadata()
    {
        var match = new PublicAotRouteMatch(
            PublicPageKind.Archive,
            PublicPageId.Archive,
            "archive",
            "/archive",
            "/archive",
            string.Empty);
        var renderer = new NavigationSnapshotRenderer();
        PublicAotShellService sut = CreateService(
            match,
            new RecordingAotCache(),
            new RecordingBackfillScheduler(),
            assetManifest: new FixedAssetManifestService("frontend-v1"),
            entryRenderer: renderer,
            dbConcurrencyGate: new ImmediateDbConcurrencyGate());
        var context = new DefaultHttpContext();

        Result<PublicAotNavigationSnapshot> result = await sut.BuildNavigationSnapshotAsync(context, match);

        Assert.True(result.IsSuccess, result.Error.Message);
        PublicAotNavigationSnapshot snapshot = result.Value!;
        Assert.Equal("Archive", snapshot.PageKind);
        Assert.Equal(PublicPageId.Archive, snapshot.PageId);
        Assert.Equal("archive", snapshot.RouteKey);
        Assert.Equal("/archive", snapshot.Path);
        Assert.Equal("/archive", snapshot.CanonicalPath);
        Assert.Equal(PublicAotShellService.PublicRendererVersion, snapshot.RendererVersion);
        Assert.Equal("frontend-v1", snapshot.FrontendAssetVersion);
        Assert.NotEmpty(snapshot.PayloadHash);
        Assert.NotEmpty(snapshot.BootstrapPayload);
        Assert.NotEmpty(snapshot.HydrationPropsPayload);
        Assert.Single(renderer.Requests);

        byte[] frame = snapshot.EncodeFrame();
        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> payload));
        Assert.Equal("public-navigation-snapshot", payload["kind"]);
        Assert.Equal("Archive", payload["pageKind"]);
        Assert.Equal("archive", payload["routeKey"]);
        Assert.Equal(snapshot.PayloadHash, payload["payloadHash"]);
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
        IRuntimeKeyScope? runtimeKeyScope = null,
        ISpaAssetManifestService? assetManifest = null,
        PublicAotSsrRuntimeState? runtimeState = null,
        IPublicAotEntryRenderer? entryRenderer = null,
        IDbConcurrencyGate? dbConcurrencyGate = null,
        PublicAotInvalidationTracker? invalidationTracker = null,
        IEnumerable<IPublicAotBootstrapProvider>? bootstrapProviders = null)
        => new(
            dbConcurrencyGate ?? Substitute.For<IDbConcurrencyGate>(),
            new FixedRouteRegistry(match),
            bootstrapProviders ?? CreateBootstrapProviders(),
            entryRenderer ?? Substitute.For<IPublicAotEntryRenderer>(),
            Substitute.For<IPublicAotDocumentService>(),
            cache,
            Substitute.For<IPublicAotCacheWriter>(),
            scheduler,
            assetManifest ?? new FixedAssetManifestService("frontend-v1"),
            runtimeKeyScope ?? new DefaultRuntimeKeyScope(),
            invalidationTracker ?? new PublicAotInvalidationTracker(),
            runtimeState ?? new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotShellService>.Instance);

    private static string VersionedListKey(string cacheKey, long version = 0)
        => string.Concat(cacheKey, ":lv:", version.ToString());

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

    private static IEnumerable<IPublicAotBootstrapProvider> CreateBootstrapProviders(
        IPublicAotBootstrapProvider replacement)
        => CreateBootstrapProviders().Select(provider => provider.Kind == replacement.Kind ? replacement : provider);

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
        public Dictionary<string, PublicAotCacheEntry> EntriesByKey { get; } = new(StringComparer.Ordinal);
        public List<string> RequestedKeys { get; } = [];
        public List<string> RemovedKeys { get; } = [];

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
        {
            RequestedKeys.Add(cacheKey);
            return Task.FromResult(EntriesByKey.TryGetValue(cacheKey, out PublicAotCacheEntry? entry) ? entry : Entry);
        }

        public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
        {
            RequestedKeys.Add(cacheKey);
            return Task.FromResult(EntriesByKey.TryGetValue(cacheKey, out PublicAotCacheEntry? entry) ? entry : Entry);
        }

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

    private sealed class FixedAssetManifestService(
        string frontendAssetVersion,
        string? viteProxyFrontendAssetVersion = null) : ISpaAssetManifestService
    {
        public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null) => [];

        public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
            => new("/assets/public.js", [], [], frontendAssetVersion, UsesSourceAssets: false);

        public string GetFrontendAssetVersion(HttpContext? context = null)
            => viteProxyFrontendAssetVersion is not null
                && context?.Request.Headers["X-Forwarded-Host"].ToString().Contains(":3000", StringComparison.Ordinal) == true
                    ? viteProxyFrontendAssetVersion
                    : frontendAssetVersion;
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

    private sealed class FailingBootstrapProvider(
        PublicPageKind kind,
        ErrorCode code,
        string message) : IPublicAotBootstrapProvider
    {
        public PublicPageKind Kind { get; } = kind;

        public Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(
            PublicAotRouteMatch match,
            CancellationToken cancellationToken = default)
            => Task.FromResult(Result<PublicPageSnapshot>.Failure(code, message));
    }

    private sealed class FailingRenderer(string message) : IPublicAotEntryRenderer
    {
        public Task<Result<PublicAotShellEntryContract>> BuildEntryAsync(
            PublicAotRenderRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(Result<PublicAotShellEntryContract>.Failure(ErrorCode.InfraFailure, message));

        public Task<Result> ValidateBundleAsync(PublicAotShellBundleContract bundle, CancellationToken cancellationToken = default)
            => Task.FromResult(Result.Failure(ErrorCode.InfraFailure, message));
    }

    private sealed class NavigationSnapshotRenderer : IPublicAotEntryRenderer
    {
        public List<PublicAotRenderRequest> Requests { get; } = [];

        public Task<Result<PublicAotShellEntryContract>> BuildEntryAsync(
            PublicAotRenderRequest request,
            CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            var bootstrapPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["kind"] = request.Match.Kind.ToString(),
                ["pageKind"] = request.Match.Kind.ToString(),
                ["routeKey"] = request.Match.RouteKey,
                ["rendererVersion"] = PublicAotShellService.PublicRendererVersion
            });
            var hydrationPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["pageKind"] = request.Match.Kind.ToString(),
                ["routeKey"] = request.Match.RouteKey,
                ["rendererVersion"] = PublicAotShellService.PublicRendererVersion,
                ["title"] = request.Match.Kind.ToString()
            });

            return Task.FromResult(Result<PublicAotShellEntryContract>.Success(new PublicAotShellEntryContract
            {
                PageId = request.Match.PageId,
                RouteKey = request.Match.RouteKey,
                Html = """<div id="fsus-aot-shell">snapshot</div>""",
                BootstrapPayload = bootstrapPayload,
                HydrationPropsPayload = hydrationPayload,
                RendererVersion = PublicAotShellService.PublicRendererVersion,
                Title = request.Match.Kind.ToString()
            }));
        }

        public Task<Result> ValidateBundleAsync(PublicAotShellBundleContract bundle, CancellationToken cancellationToken = default)
            => Task.FromResult(Result.Success());
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public async Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => await action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
    }
}

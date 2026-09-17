using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotInvalidationTrackerTests
{
    [Fact]
    public async Task DurableAuthority_PreservesGenerationAcrossTrackerRestart()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var beforeRestart = new PublicAotInvalidationTracker(authority);
        await beforeRestart.InitializeAsync(CancellationToken.None);
        long marked = await beforeRestart.MarkKeyAsync("scope:public-aot:home");

        var afterRestart = new PublicAotInvalidationTracker(authority);
        await afterRestart.InitializeAsync(CancellationToken.None);

        Assert.Equal(marked, afterRestart.GetCurrentVersion("scope:public-aot:home", "scope:public-aot:"));
    }

    [Fact]
    public async Task DurableAuthorityFailure_DoesNotFallBackToGenerationZero()
    {
        var tracker = new PublicAotInvalidationTracker(new FailingGenerationAuthority());

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => tracker.InitializeAsync(CancellationToken.None));
    }

    [Fact]
    public async Task DurableAuthorityFailure_FailsStartupValidation()
    {
        var validator = new PublicAotInvalidationGenerationStartupValidator(
            new PublicAotInvalidationTracker(new FailingGenerationAuthority()));

        InvalidOperationException failure =
            await Assert.ThrowsAsync<InvalidOperationException>(
                () => validator.StartAsync(CancellationToken.None));

        Assert.Equal("generation-store-unavailable", failure.Message);
    }

    [Fact]
    public async Task TamperedDurableState_FailsClosedBeforeLookup()
    {
        PublicAotInvalidationGenerationState valid = await new InMemoryPublicAotInvalidationGenerationAuthority()
            .LoadAsync(CancellationToken.None);
        var tracker = new PublicAotInvalidationTracker(new FixedGenerationAuthority(valid with
        {
            ContentDigest = "tampered"
        }));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => tracker.InitializeAsync(CancellationToken.None));
    }

    [Fact]
    public void DurableState_RejectsOutOfRangeCoordinatesEvenWithMatchingDigest()
    {
        PublicAotInvalidationGenerationState negative =
            PublicAotInvalidationGenerationStateCodec.SealForTests(
                "scope",
                5,
                new Dictionary<string, long>(StringComparer.Ordinal)
                {
                    ["scope:key"] = -1
                },
                new Dictionary<string, long>(StringComparer.Ordinal));
        PublicAotInvalidationGenerationState aboveWatermark =
            PublicAotInvalidationGenerationStateCodec.SealForTests(
                "scope",
                5,
                new Dictionary<string, long>(StringComparer.Ordinal)
                {
                    ["scope:key"] = 6
                },
                new Dictionary<string, long>(StringComparer.Ordinal));

        Assert.Throws<InvalidOperationException>(
            () => PublicAotInvalidationGenerationStateCodec.Validate(negative));
        Assert.Throws<InvalidOperationException>(
            () => PublicAotInvalidationGenerationStateCodec.Validate(aboveWatermark));
    }

    [Fact]
    public void DurableState_RejectsReservedAllCoordinateInPrefixMap()
    {
        PublicAotInvalidationGenerationState invalid =
            PublicAotInvalidationGenerationStateCodec.SealForTests(
                "scope",
                1,
                new Dictionary<string, long>(StringComparer.Ordinal),
                new Dictionary<string, long>(StringComparer.Ordinal)
                {
                    [PublicAotInvalidationGenerationStateCodec.AllCoordinate] = 1
                });

        Assert.Throws<InvalidOperationException>(
            () => PublicAotInvalidationGenerationStateCodec.Validate(invalid));
    }

    [Fact]
    public async Task Compaction_PreservesCurrentArtifactAndPrefixWatermarks()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        await authority.MarkAsync("key", "scope:article:42", null, CancellationToken.None);
        await authority.MarkAsync("prefix", "scope:article:", null, CancellationToken.None);
        long watermark = (await authority.LoadAsync(CancellationToken.None)).AllGeneration;

        PublicAotInvalidationGenerationState compacted = await authority.CompactAsync(
            new HashSet<string>(StringComparer.Ordinal) { "scope:article:42" },
            new HashSet<string>(StringComparer.Ordinal) { "scope:article:" },
            CancellationToken.None);

        Assert.Equal(watermark, compacted.AllGeneration);
        Assert.Equal(watermark, compacted.Current("scope:article:42", "scope:article:"));
    }

    [Fact]
    public async Task Compaction_AlwaysPreservesGlobalCoordinate()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        long global = (await authority.MarkAsync(
            "all",
            PublicAotInvalidationGenerationStateCodec.AllCoordinate,
            null,
            CancellationToken.None)).AllGeneration;
        _ = await authority.MarkAsync("key", "retired:key", null, CancellationToken.None);

        PublicAotInvalidationGenerationState compacted = await authority.CompactAsync(
            new HashSet<string>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal),
            CancellationToken.None);

        Assert.Equal(2, compacted.AllGeneration);
        Assert.Equal(
            global,
            compacted.KeyGenerations[
                PublicAotInvalidationGenerationStateCodec.AllCoordinate]);
        Assert.Equal(global, compacted.Current("unknown:key", "unknown:prefix"));
    }

    [Fact]
    public async Task CompactionAndRestart_AlwaysPreserveSitemapCoordinate()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var tracker = new PublicAotInvalidationTracker(authority);
        _ = await tracker.MarkSitemapAsync("taxonomy:durable");
        long expected = tracker.GetSitemapGeneration();
        _ = await authority.MarkAsync("key", "retired:key", null, CancellationToken.None);

        PublicAotInvalidationGenerationState compacted = await authority.CompactAsync(
            new HashSet<string>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal),
            CancellationToken.None);
        var restarted = new PublicAotInvalidationTracker(authority);
        await restarted.InitializeAsync(CancellationToken.None);

        Assert.Equal(
            expected,
            compacted.KeyGenerations[PublicAotInvalidationGenerationStateCodec.SitemapCoordinate]);
        Assert.Equal(expected, restarted.GetSitemapGeneration());
    }

    [Fact]
    public async Task ProductionCompaction_MissingArtifactRegistryDoesNotMutateAuthority()
    {
        IPublicAotInvalidationGenerationAuthority authority =
            Substitute.For<IPublicAotInvalidationGenerationAuthority>();
        authority.LoadAsync(Arg.Any<CancellationToken>()).Returns(
            Task.FromResult(PublicAotInvalidationGenerationStateCodec.CreateEmpty("scope")));
        var database = Substitute.For<IDatabase>();
        database.KeyExistsAsync(
                PublicAotCacheRegistry.GlobalRegistryKey,
                CommandFlags.DemandMaster)
            .Returns(Task.FromResult(false));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var worker = new PublicAotInvalidationGenerationCompactionWorker(
            authority,
            RedisOperationExecutor.ForTestConnection(redis),
            NullLogger<PublicAotInvalidationGenerationCompactionWorker>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => worker.CompactOnceAsync(CancellationToken.None));
        _ = authority.DidNotReceive().CompactAsync(
            Arg.Any<IReadOnlySet<string>>(),
            Arg.Any<IReadOnlySet<string>>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConcurrentNodes_AdvanceOneSharedAuthorityWithoutLostUpdates()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var firstNode = new PublicAotInvalidationTracker(authority);
        var secondNode = new PublicAotInvalidationTracker(authority);
        await firstNode.InitializeAsync(CancellationToken.None);
        await secondNode.InitializeAsync(CancellationToken.None);

        await Task.WhenAll(
            Enumerable.Range(0, 32).Select(index =>
                (index & 1) == 0
                    ? firstNode.MarkKeyAsync($"scope:key:{index}")
                    : secondNode.MarkPrefixAsync($"scope:prefix:{index}")));

        Assert.Equal(32, (await authority.LoadAsync(CancellationToken.None)).AllGeneration);
        await firstNode.InitializeAsync(CancellationToken.None);
        await secondNode.InitializeAsync(CancellationToken.None);
        Assert.Equal(
            firstNode.GetCurrentVersion("scope:key:30", "scope:prefix:31"),
            secondNode.GetCurrentVersion("scope:key:30", "scope:prefix:31"));
    }

    [Fact]
    public async Task DistributedMutationIdentity_IsPersistedAndImmediateReplayIsIdempotent()
    {
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var tracker = new PublicAotInvalidationTracker(authority);
        await tracker.InitializeAsync(CancellationToken.None);

        long first = await tracker.MarkAllAsync("distributed-event-a");
        long replay = await tracker.MarkAllAsync("distributed-event-a");

        Assert.Equal(first, replay);
        Assert.Equal("distributed-event-a", (await authority.LoadAsync(CancellationToken.None)).LastMutationId);
        Assert.Equal(1, (await authority.LoadAsync(CancellationToken.None)).AllGeneration);
    }

    [Fact]
    public void BootstrapGuard_RetainedReleaseWitnessBlocksGenerationZeroReinitialization()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsus-public-aot-bootstrap-{Guid.NewGuid():N}");
        try
        {
            string firstRoot = Path.Combine(root, "release-a", "public-aot");
            string nextRoot = Path.Combine(root, "release-b", "public-aot");
            var first = new FilePublicAotInvalidationGenerationBootstrapGuard(
                firstRoot,
                root,
                "scope");
            first.PrepareInitialBootstrap();
            first.RecordInitialized(
                PublicAotInvalidationGenerationStateCodec.CreateEmpty("scope"));

            var next = new FilePublicAotInvalidationGenerationBootstrapGuard(
                nextRoot,
                root,
                "scope");
            InvalidOperationException failure = Assert.Throws<InvalidOperationException>(
                next.PrepareInitialBootstrap);

            Assert.Contains(
                "state-missing-after-initialization",
                failure.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void BootstrapGuard_InterruptedBootstrapRefusesArtifactsBeforeRetry()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsus-public-aot-bootstrap-{Guid.NewGuid():N}");
        try
        {
            var first = new FilePublicAotInvalidationGenerationBootstrapGuard(
                root,
                releaseDerivedBase: null,
                "scope");
            first.PrepareInitialBootstrap();
            File.WriteAllBytes(
                Path.Combine(root, "old-artifact.aeds"),
                [0x41, 0x45, 0x44, 0x53]);

            var restarted = new FilePublicAotInvalidationGenerationBootstrapGuard(
                root,
                releaseDerivedBase: null,
                "scope");
            InvalidOperationException failure = Assert.Throws<InvalidOperationException>(
                restarted.PrepareInitialBootstrap);

            Assert.Contains(
                "bootstrap-refused-existing-artifacts",
                failure.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async Task WasInvalidatedAfter_DetectsExactRouteInvalidation()
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

        _ = await tracker.MarkKeyAsync(cacheKey);

        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public async Task WasInvalidatedAfter_DetectsPagePrefixInvalidation()
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

        _ = await tracker.MarkPrefixAsync(pagePrefixKey);

        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public async Task WasInvalidatedAfter_DetectsGlobalInvalidation()
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

        _ = await tracker.MarkAllAsync();

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
            AssetManifest(),
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
            AssetManifest(),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);

        await service.InvalidateArticleMutationAsync(42, [7], [9]);

        Assert.NotEmpty(scheduler.Requests);
        Assert.All(scheduler.Requests, request => Assert.Equal("pw-0", request.TestSessionId));
        Assert.All(scheduler.Requests, request => Assert.Equal("frontend-test-v1", request.FrontendAssetVersion));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:9");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "article:42");
    }

    [Fact]
    public async Task InvalidateArticleMutationAsync_InvalidatesEveryPaginatedListingIdentity()
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
            AssetManifest(),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);
        string homeKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home");
        string homePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, string.Empty);
        string articleKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, "article:42");
        string articlePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, string.Empty);
        string filterKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7");
        string filterPageTwoKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7:page:2");
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
        var filterPageTwoRequest = new PublicAotBackfillRequest(PublicPageKind.Filter, "category:7:page:2", "/category/7", "?page=2", filterPageTwoKey)
        {
            PagePrefixKey = filterPrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(filterPageTwoKey, filterPrefixKey)
        };

        await service.InvalidateArticleMutationAsync(42, [7], [9]);

        Assert.Empty(cache.PrefixesRemoved);
        Assert.Contains(articleKey, cache.KeysRemoved);
        Assert.True(tracker.WasInvalidatedAfter(homeRequest));
        Assert.True(tracker.WasInvalidatedAfter(articleRequest));
        Assert.True(tracker.WasInvalidatedAfter(filterRequest));
        Assert.True(tracker.WasInvalidatedAfter(filterPageTwoRequest));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "home");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "archive");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:9");
    }

    [Fact]
    public async Task InvalidateFilterRouteFamilyAsync_RemovesFamilyAndPagination_WithoutTouchingSiblingIdentities()
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
            AssetManifest(),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);
        string familyKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7");
        string familyPrefix = familyKey + ":";
        string familyPageTwoKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:7:page:2");
        string siblingKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:70");
        string tagKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "tag:7");
        string pagePrefixKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, string.Empty);
        var familyRequest = new PublicAotBackfillRequest(
            PublicPageKind.Filter, "category:7", "/category/7", string.Empty, familyKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(familyKey, pagePrefixKey)
        };
        var siblingRequest = new PublicAotBackfillRequest(
            PublicPageKind.Filter, "category:70", "/category/70", string.Empty, siblingKey)
        {
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = tracker.GetCurrentVersion(siblingKey, pagePrefixKey)
        };

        await service.InvalidateFilterRouteFamilyAsync("category:7");

        Assert.Contains(familyKey, cache.KeysRemoved);
        Assert.Contains(familyPrefix, cache.PrefixesRemoved);
        Assert.DoesNotContain(siblingKey, cache.KeysRemoved);
        Assert.DoesNotContain(tagKey, cache.KeysRemoved);
        Assert.DoesNotContain(cache.PrefixesRemoved, prefix => prefix == siblingKey + ":" || prefix == pagePrefixKey);
        Assert.StartsWith(familyPrefix, familyPageTwoKey, StringComparison.Ordinal);
        Assert.False(siblingKey.StartsWith(familyPrefix, StringComparison.Ordinal));
        Assert.True(tracker.WasInvalidatedAfter(familyRequest));
        Assert.False(tracker.WasInvalidatedAfter(siblingRequest));
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "category:7");
        Assert.DoesNotContain(scheduler.Requests, request => request.RouteKey == "category:70");
        Assert.DoesNotContain(scheduler.Requests, request => request.RouteKey == "tag:7");
        Assert.DoesNotContain(scheduler.Requests, request => request.RouteKey == "home");
        Assert.DoesNotContain(scheduler.Requests, request => request.RouteKey == "archive");
    }

    [Fact]
    public async Task InvalidateFilterRouteFamilyAsync_TagIdentity_DoesNotInvalidateCategoryFamily()
    {
        var cache = new RecordingAotCache();
        var scheduler = new RecordingBackfillScheduler();
        var service = new PublicAotInvalidationService(
            cache,
            new DefaultRuntimeKeyScope(),
            new PublicAotInvalidationTracker(),
            scheduler,
            new RecordingRouteManifestProvider(),
            new PublicHotReadStore(),
            new FixedTestSessionKeyScope(null),
            AssetManifest(),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotInvalidationService>.Instance);

        await service.InvalidateFilterRouteFamilyAsync("tag:11");

        string tagKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "tag:11");
        string categoryKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:11");
        Assert.Contains(tagKey, cache.KeysRemoved);
        Assert.Contains(tagKey + ":", cache.PrefixesRemoved);
        Assert.DoesNotContain(categoryKey, cache.KeysRemoved);
        Assert.Contains(scheduler.Requests, request => request.RouteKey == "tag:11");
        Assert.DoesNotContain(scheduler.Requests, request => request.RouteKey == "category:11");
    }

    [Fact]
    public async Task Tracker_DoesNotTreatScopedPrefixAsUnscopedPageInvalidation()
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

        _ = await tracker.MarkPrefixAsync(scopedPrefix);

        Assert.True(tracker.WasInvalidatedAfter(scoped));
        Assert.False(tracker.WasInvalidatedAfter(unscoped));
        Assert.Equal(0, tracker.GetCurrentVersion(cacheKey, string.Empty));
        Assert.True(tracker.GetCurrentVersion(cacheKey, scopedPrefix) > 0);
    }
    private sealed class RecordingAotCache : IPublicAotShellCache
    {
        public bool InvalidatedAll
        {
            get; private set;
        }

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

    private sealed class FailingGenerationAuthority : IPublicAotInvalidationGenerationAuthority
    {
        public Task<PublicAotInvalidationGenerationState> LoadAsync(CancellationToken cancellationToken)
            => Task.FromException<PublicAotInvalidationGenerationState>(
                new InvalidOperationException("generation-store-unavailable"));

        public Task<PublicAotInvalidationGenerationState> MarkAsync(
            string kind,
            string key,
            string? mutationId,
            CancellationToken cancellationToken)
            => Task.FromException<PublicAotInvalidationGenerationState>(
                new InvalidOperationException("generation-store-unavailable"));

        public Task<PublicAotInvalidationGenerationState> CompactAsync(
            IReadOnlySet<string> artifactKeys,
            IReadOnlySet<string> prefixKeys,
            CancellationToken cancellationToken)
            => Task.FromException<PublicAotInvalidationGenerationState>(
                new InvalidOperationException("generation-store-unavailable"));
    }

    private sealed class FixedGenerationAuthority(PublicAotInvalidationGenerationState state) : IPublicAotInvalidationGenerationAuthority
    {
        public Task<PublicAotInvalidationGenerationState> LoadAsync(CancellationToken cancellationToken)
            => Task.FromResult(state);

        public Task<PublicAotInvalidationGenerationState> MarkAsync(
            string kind,
            string key,
            string? mutationId,
            CancellationToken cancellationToken)
            => Task.FromResult(state);

        public Task<PublicAotInvalidationGenerationState> CompactAsync(
            IReadOnlySet<string> artifactKeys,
            IReadOnlySet<string> prefixKeys,
            CancellationToken cancellationToken)
            => Task.FromResult(state);
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

    private static ISpaAssetManifestService AssetManifest()
    {
        ISpaAssetManifestService manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-test-v1");
        return manifest;
    }

    private sealed class FixedTestSessionKeyScope(string? sessionId) : ITestSessionKeyScope
    {
        public string? SessionId { get; } = sessionId;

        public string PrefixKey(string key)
        {
            return SessionId is { } session ? $"e2e:{session}:{key}" : key;
        }

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

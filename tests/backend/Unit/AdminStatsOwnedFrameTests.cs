using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminStatsOwnedFrameTests
{
    [Fact]
    public async Task Rebuild_WhenGenerationChanges_DiscardsOldSourceAndOnlyInstallsFreshIdentity()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.AdminStats,
                AdminStatsFrameVersioning.CounterIdentity,
                0,
                Arg.Any<CancellationToken>())
            .Returns(
                Task.FromResult(0L),
                Task.FromResult(1L),
                Task.FromResult(1L),
                Task.FromResult(1L));
        var ownedCache = new RecordingOwnedFrameCache();
        var core = Substitute.For<IStatsCoreService>();
        core.GetAdminStatsAsync(0).Returns(
            Task.FromResult(Result<SiteStatsCoreModel>.Success(Stats(totalArticles: 10))));
        core.GetAdminStatsAsync(1).Returns(
            Task.FromResult(Result<SiteStatsCoreModel>.Success(Stats(totalArticles: 20))));

        IResult result = await BinaryEndpoints.HandleAdminStatsFrameAsync(
            core,
            cache,
            ownedCache,
            new AedsEncoder(),
            CancellationToken.None);

        Assert.Equal(["core:v0:main", "core:v1:main"], ownedCache.ReadIdentities);
        Assert.Equal(["core:v1:main"], ownedCache.SetIdentities);
        await core.Received(1).GetAdminStatsAsync(0);
        await core.Received(1).GetAdminStatsAsync(1);

        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new MemoryStream();
        await result.ExecuteAsync(context);
        byte[] wire = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(wire);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.AdminStats, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeSiteStats(decoded.Value.Payload, out SiteStatsCoreModel stats));
        Assert.Equal(20, stats.TotalArticles);
    }

    [Fact]
    public async Task Invalidation_IncrementsGenerationBeforeRemovingPreviousIdentity()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.AdminStats,
                AdminStatsFrameVersioning.CounterIdentity,
                1,
                Arg.Any<CancellationToken>())
            .Returns(8L);
        var invalidator = Substitute.For<IHttpCacheInvalidator>();
        var dispatcher = new CacheInvalidationDispatcher(cache, invalidator);

        await dispatcher.InvalidateStatsAsync();

        await cache.Received(1).IncrementAsync(
            CachePolicyId.AdminStats,
            AdminStatsFrameVersioning.CounterIdentity,
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                keys.Any(key => key.PolicyId == CachePolicyId.AdminStatsFrame && key.Identity == "core:v7:main")
                && keys.Any(key => key.PolicyId == CachePolicyId.AdminStats && key.Identity == "core:v7:main")
                && keys.Any(key => key.PolicyId == CachePolicyId.AdminStatsOverview && key.Identity == "v7:main")
                && keys.Any(key => key.PolicyId == CachePolicyId.AdminStatsRecentComments && key.Identity == "v7:main")
                && keys.Any(key => key.PolicyId == CachePolicyId.AdminStatsRegions && key.Identity == "v7:main")),
            Arg.Any<CancellationToken>());
        Received.InOrder(() =>
        {
            _ = cache.IncrementAsync(
                CachePolicyId.AdminStats,
                AdminStatsFrameVersioning.CounterIdentity,
                1,
                Arg.Any<CancellationToken>());
            _ = cache.RemoveManyAsync(
                Arg.Any<IReadOnlyList<CacheKeyIdentity>>(),
                Arg.Any<CancellationToken>());
        });
    }

    [Fact]
    public async Task ResolveGeneration_AcrossCacheInstances_IgnoresOtherNodeStaleL1()
    {
        long sharedVersion = 0;
        object versionGate = new();
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                lock (versionGate)
                {
                    sharedVersion = long.Parse(call.ArgAt<RedisValue>(1).ToString());
                    return Task.FromResult(true);
                }
            });
        db.StringIncrementAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<long>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                lock (versionGate)
                {
                    sharedVersion += call.ArgAt<long>(1);
                    return Task.FromResult(sharedVersion);
                }
            });

        using var memoryA = new MemoryCache(new MemoryCacheOptions());
        using var memoryB = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cacheA = CreateCache(memoryA, db);
        using UnifiedCache cacheB = CreateCache(memoryB, db);

        await cacheB.SetStringAsync(CachePolicyId.AdminStats, AdminStatsFrameVersioning.CounterIdentity, "0");
        Assert.Equal("0", await cacheB.GetStringAsync(CachePolicyId.AdminStats, AdminStatsFrameVersioning.CounterIdentity));

        Assert.Equal(1, await cacheA.IncrementAsync(CachePolicyId.AdminStats, AdminStatsFrameVersioning.CounterIdentity));
        Assert.Equal(1, await AdminStatsFrameVersioning.ResolveAsync(cacheB));
    }

    [Fact]
    public async Task GenerationScopedSources_UseOnlyThePublishedGenerationIdentities()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.TryGetAsync(
                CachePolicyId.AdminStats,
                "core:v9:main",
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, SiteStatsCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<SiteStatsCoreModel?>(true, Stats(totalArticles: 9))));
        var coreCache = new StatsCoreQueryCache(cache);

        SiteStatsCoreModel coreResult = await coreCache.GetOrLoadAdminStatsAsync(
            9,
            () => throw new InvalidOperationException("generation-scoped core cache should hit"));

        Assert.Equal(9, coreResult.TotalArticles);
        var coordinator = new RecordingIdentityCoordinator();
        var service = new StatsService(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<IUnifiedCache>(),
            coordinator,
            Substitute.For<IDbConcurrencyGate>(),
            Substitute.For<IReadAnalyticsPrivacyPolicy>(),
            NullLogger<StatsService>.Instance);

        _ = await service.GetAdminStatsForGenerationAsync(9);

        Assert.Equal(
            [
                (CachePolicyId.AdminStatsOverview, "v9:main"),
                (CachePolicyId.AdminStatsRecentComments, "v9:main"),
                (CachePolicyId.AdminStatsRegions, "v9:main")
            ],
            coordinator.Identities);
    }

    private static SiteStatsCoreModel Stats(int totalArticles)
        => new(
            PodProjector.ProjectSiteStats(
                totalArticles,
                totalComments: 0,
                trashCount: 0,
                totalReads: 0,
                humanVerifiedReads: 0,
                uniqueViewerKeyEstimate: 0,
                articleReads: 0,
                siteReads: 0,
                popularCount: 0,
                recentCount: 0,
                regionCount: 0),
            totalArticles,
            TotalComments: 0,
            TrashCount: 0,
            TotalReads: 0,
            HumanVerifiedReads: 0,
            UniqueViewerKeyEstimate: 0,
            ArticleReads: 0,
            SiteReads: 0,
            PopularArticles: [],
            RecentComments: [],
            RegionDistributions: []);

    private sealed class RecordingOwnedFrameCache : IOwnedFrameCache
    {
        internal List<string> ReadIdentities { get; } = [];
        internal List<string> SetIdentities { get; } = [];

        public Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken = default)
        {
            ReadIdentities.Add(identity);
            return Task.FromResult(default(OwnedFrameCacheReadResult));
        }

        public Task SetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            OwnedAedsFrame frame,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            SetIdentities.Add(identity);
            frame.Retire();
            return Task.CompletedTask;
        }

        public OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot() => default;
    }

    private sealed class RecordingIdentityCoordinator : ICacheMissCoordinator
    {
        internal List<(CachePolicyId PolicyId, string Identity)> Identities { get; } = [];

        public Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
        {
            Identities.Add((policyId, identity));
            return Task.FromResult<T?>(default);
        }
    }

    private static UnifiedCache CreateCache(IMemoryCache memory, IDatabase db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(db);
        return new UnifiedCache(
            memory,
            redis,
            new CachePolicyRegistry(),
            new DefaultRuntimeKeyScope(),
            NullLogger<UnifiedCache>.Instance);
    }
}

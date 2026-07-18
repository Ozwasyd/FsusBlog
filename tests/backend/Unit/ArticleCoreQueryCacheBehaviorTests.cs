using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleCoreQueryCacheBehaviorTests
{
    [Fact]
    public void IdentityHelpers_PreserveStableSemanticFormats()
    {
        Assert.Equal(
            "core:v4:public:42:3:20:0:7:0:-1:fsus",
            ArticleCoreQueryCache.BuildArticleListIdentity("public", 42, 3, 20, null, 7, false, null, "fsus"));
        Assert.Equal("core:v3:99", ArticleCoreQueryCache.BuildArticleDetailIdentity(99));
        Assert.Equal("core:v2:12", ArticleCoreQueryCache.BuildHotArticlesBaseIdentity(12));
        Assert.Equal("core:v2:featured:6", ArticleCoreQueryCache.BuildFeaturedArticlesIdentity(6));
    }

    [Fact]
    public async Task GetOrLoadPageListAsync_CacheHitUsesResolvedVersionIdentityWithoutCallingLoader()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        var cachedPage = new CorePageResult<ArticleListCoreModel>([], 7, "next", true);
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns("42");
        cache.TryGetAsync<CorePageResult<ArticleListCoreModel>?>(
                CachePolicyId.ArticleList,
                Arg.Any<string>(),
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, CorePageResult<ArticleListCoreModel>? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<CorePageResult<ArticleListCoreModel>?>(true, cachedPage)));
        var subject = Create(cache);
        bool loaderCalled = false;

        CorePageResult<ArticleListCoreModel> result = await subject.GetOrLoadPageListAsync(
            page: 3,
            size: 20,
            categoryId: null,
            tagId: 7,
            isDeleted: false,
            status: null,
            includePrivate: false,
            keyword: "fsus",
            listCacheVersion: null,
            _ =>
            {
                loaderCalled = true;
                return Task.FromResult(new CorePageResult<ArticleListCoreModel>([], 0));
            });

        Assert.False(loaderCalled);
        Assert.Equal(cachedPage, result);
        await cache.Received(1).TryGetAsync<CorePageResult<ArticleListCoreModel>?>(
            CachePolicyId.ArticleList,
            "core:v4:public:42:3:20:0:7:0:-1:fsus",
            Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, CorePageResult<ArticleListCoreModel>? Value)>>(),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().SetRawAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<byte[]>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetOrLoadPageListAsync_DoubleMissLoadsOnceAndCachesUnderTheSameVersionIdentity()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns("9");
        cache.AcquireSingleFlightAsync(
                CachePolicyId.ArticleList,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IAsyncDisposable>(NoopLease.Instance));
        var subject = Create(cache);
        var loaded = new CorePageResult<ArticleListCoreModel>([], 3);
        int loaderCalls = 0;

        CorePageResult<ArticleListCoreModel> result = await subject.GetOrLoadPageListAsync(
            page: 1,
            size: 10,
            categoryId: 4,
            tagId: null,
            isDeleted: false,
            status: 2,
            includePrivate: true,
            keyword: string.Empty,
            listCacheVersion: null,
            _ =>
            {
                loaderCalls++;
                return Task.FromResult(loaded);
            });

        Assert.Equal(loaded, result);
        Assert.Equal(1, loaderCalls);
        var calls = cache.ReceivedCalls().ToArray();
        string[] readIdentities = calls
            .Where(call => call.GetMethodInfo().Name == nameof(IUnifiedCache.TryGetAsync))
            .Select(call => Assert.IsType<string>(call.GetArguments()[1]))
            .ToArray();
        Assert.Equal(2, readIdentities.Length);
        string resolvedIdentity = Assert.Single(readIdentities.Distinct());
        Assert.False(string.IsNullOrWhiteSpace(resolvedIdentity));
        var singleFlightCall = Assert.Single(
            calls,
            call => call.GetMethodInfo().Name == nameof(IUnifiedCache.AcquireSingleFlightAsync));
        Assert.Equal(resolvedIdentity, Assert.IsType<string>(singleFlightCall.GetArguments()[1]));
        var writeCall = Assert.Single(
            calls,
            call => call.GetMethodInfo().Name == nameof(IUnifiedCache.SetRawAsync));
        Assert.Equal(resolvedIdentity, Assert.IsType<string>(writeCall.GetArguments()[1]));
        Assert.NotEmpty(Assert.IsType<byte[]>(writeCall.GetArguments()[2]));
        Assert.Equal(TimeSpan.FromMinutes(10), Assert.IsType<TimeSpan>(writeCall.GetArguments()[3]));
        await cache.Received(1).GetStringAsync(
            CachePolicyId.ArticleListVersion,
            "main",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetOrLoadSearchAsync_LeavesSearchCacheOwnershipToTheCallingService()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        var subject = Create(cache);
        IReadOnlyList<ArticleListCoreModel> expected = Array.Empty<ArticleListCoreModel>();
        int loaderCalls = 0;

        IReadOnlyList<ArticleListCoreModel> result = await subject.GetOrLoadSearchAsync(
            "cache owner",
            _ =>
            {
                loaderCalls++;
                return Task.FromResult(expected);
            });

        Assert.Same(expected, result);
        Assert.Equal(1, loaderCalls);
        Assert.Empty(cache.ReceivedCalls());
    }

    private static ArticleCoreQueryCache Create(IUnifiedCache cache)
    {
        IHotArticlesCacheVersionProvider hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
        hotVersion.BuildVersionedHotArticlesIdentity(Arg.Any<string>())
            .Returns(call => $"v1:{call.Arg<string>()}");
        return new ArticleCoreQueryCache(cache, hotVersion);
    }

    private sealed class NoopLease : IAsyncDisposable
    {
        public static readonly NoopLease Instance = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

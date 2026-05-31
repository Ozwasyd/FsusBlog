using FsusBlog.Server.Infrastructure.Cache;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CacheInvalidationDispatcherTests
{
    [Fact]
    public async Task InvalidateArticleMutationAsync_ClearsDistributionAndListVersionCaches()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator);

        await sut.InvalidateArticleMutationAsync(42);

        await cache.Received(1).RemoveAsync(CachePolicyId.ArticleDetail, "42", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.ArticleDetail, "core:v2:42", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.ArticleDetail, "core:v3:42", Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.ArticleRss, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "core:main", Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(Arg.Is<CacheTag[]>(tags =>
            tags.Contains(CacheTag.Category)
            && tags.Contains(CacheTag.ArticleList)
            && tags.Contains(CacheTag.HotArticles)
            && tags.Contains(CacheTag.Stats)));
    }

    [Fact]
    public async Task InvalidateStatsAsync_RemovesJsonAndCoreStatsCache()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator);

        await sut.InvalidateStatsAsync();

        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "core:main", Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
    }

    [Fact]
    public async Task InvalidateCommentMutationAsync_RemovesCursorAndOutputCaches()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator);

        await sut.InvalidateCommentMutationAsync();

        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.CommentCursor, string.Empty, Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.UserCommentCursor, string.Empty, Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "core:main", Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Comment);
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
    }
}

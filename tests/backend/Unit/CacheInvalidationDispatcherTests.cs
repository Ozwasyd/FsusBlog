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
    public async Task InvalidateHotArticlesAsync_PublishesVersionWithoutPrefixDelete()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var versionPublisher = Substitute.For<IHotArticlesCacheVersionPublisher>();
        versionPublisher.PublishNextHotArticlesVersion("direct-invalidation").Returns(8L);
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator, hotArticlesVersionPublisher: versionPublisher);

        await sut.InvalidateHotArticlesAsync();

        versionPublisher.Received(1).PublishNextHotArticlesVersion("direct-invalidation");
        await cache.DidNotReceive().RemoveByPrefixAsync(CachePolicyId.ArticleHot, Arg.Any<string>(), Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixAsync(CachePolicyId.ArticleHotFrame, Arg.Any<string>(), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
    }

    [Fact]
    public async Task InvalidateCommentMutationAsync_WithoutScope_RemovesCommentCursorFamiliesAndStats()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator);

        await sut.InvalidateCommentMutationAsync();

        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.CommentCursor, "article:", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.UserCommentCursor, "user:", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "core:main", Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
    }

    [Fact]
    public async Task InvalidateCommentMutationAsync_WithScope_RemovesOnlyAffectedArticleAndUser()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, httpCacheInvalidator);

        await sut.InvalidateCommentMutationAsync(new CommentCacheInvalidationScope(
            ArticleId: 42,
            RootId: 99,
            UserId: 7,
            PublicArticleChanged: true,
            UserCommentsChanged: true));

        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.CommentCursor, "article:42:", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.CommentCursor, "article:42:root:99:", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(CachePolicyId.UserCommentCursor, "user:7:", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.AdminStats, "core:main", Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
    }
}

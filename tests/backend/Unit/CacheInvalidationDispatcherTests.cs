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

        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.ArticleDetail, "42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v2:42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v3:42")
            && HasKey(keys, CachePolicyId.ArticleDetailFrame, "core:v3:42")), Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.ArticleRss, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")
            && HasKey(keys, CachePolicyId.CategoryFrame, "all")
            && HasKey(keys, CachePolicyId.TagFrame, "all")), Arg.Any<CancellationToken>());
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

        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")), Arg.Any<CancellationToken>());
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

        await cache.Received(1).RemoveByPrefixManyAsync(Arg.Is<IReadOnlyList<CachePrefixIdentity>>(prefixes =>
            HasPrefix(prefixes, CachePolicyId.CommentCursor, "article:")
            && HasPrefix(prefixes, CachePolicyId.UserCommentCursor, "user:")
            && HasPrefix(prefixes, CachePolicyId.CommentCursorFrame, "article:")
            && HasPrefix(prefixes, CachePolicyId.UserCommentCursorFrame, "user:")), Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")), Arg.Any<CancellationToken>());
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

        await cache.Received(1).RemoveByPrefixManyAsync(Arg.Is<IReadOnlyList<CachePrefixIdentity>>(prefixes =>
            HasPrefix(prefixes, CachePolicyId.CommentCursor, "article:42:")
            && HasPrefix(prefixes, CachePolicyId.CommentCursorFrame, "article:42:")
            && HasPrefix(prefixes, CachePolicyId.CommentCursor, "article:42:root:99:")
            && HasPrefix(prefixes, CachePolicyId.CommentCursorFrame, "article:42:root:99:")
            && HasPrefix(prefixes, CachePolicyId.UserCommentCursor, "user:7:")
            && HasPrefix(prefixes, CachePolicyId.UserCommentCursorFrame, "user:7:")), Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
    }

    private static bool HasKey(IReadOnlyList<CacheKeyIdentity> keys, CachePolicyId policyId, string identity)
        => keys.Any(key => key.PolicyId == policyId && key.Identity == identity);

    private static bool HasPrefix(IReadOnlyList<CachePrefixIdentity> prefixes, CachePolicyId policyId, string identityPrefix)
        => prefixes.Any(prefix => prefix.PolicyId == policyId && prefix.IdentityPrefix == identityPrefix);
}

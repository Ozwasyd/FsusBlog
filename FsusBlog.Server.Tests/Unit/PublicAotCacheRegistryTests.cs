using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotCacheRegistryTests
{
    [Fact]
    public void TryResolveRegistryScope_PagePrefix_UsesPageBucketWithoutAdditionalFiltering()
    {
        string prefix = CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, string.Empty);

        bool resolved = PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out bool requiresPrefixFilter);

        Assert.True(resolved);
        Assert.Equal(PublicAotCacheRegistry.BuildPageRegistryKey(PublicPageId.Home), registryKey);
        Assert.False(requiresPrefixFilter);
    }

    [Fact]
    public void TryResolveRegistryScope_FilterCategoryPrefix_UsesRouteBucket()
    {
        string prefix = CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, "category:");

        bool resolved = PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out bool requiresPrefixFilter);

        Assert.True(resolved);
        Assert.Equal(PublicAotCacheRegistry.BuildRouteRegistryKey(PublicPageId.Filter, "category"), registryKey);
        Assert.True(requiresPrefixFilter);
    }

    [Fact]
    public void TryResolveRegistryScope_ArticlePrefix_UsesArticleRouteBucket()
    {
        string prefix = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, "article:");

        bool resolved = PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out bool requiresPrefixFilter);

        Assert.True(resolved);
        Assert.Equal(PublicAotCacheRegistry.BuildRouteRegistryKey(PublicPageId.ArticleDetail, "article"), registryKey);
        Assert.True(requiresPrefixFilter);
    }

    [Fact]
    public void TryParseCacheKey_ParsesPageIdAndRouteKey()
    {
        string cacheKey = CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, "article:42");

        bool parsed = PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey);

        Assert.True(parsed);
        Assert.Equal(PublicPageId.ArticleDetail, pageId);
        Assert.Equal("article:42", routeKey);
    }

    [Theory]
    [InlineData("public:aot:v2:doc:bad:article:42")]
    [InlineData("public:aot:v2:other:1:home")]
    [InlineData("not-a-cache-key")]
    public void TryParseCacheKey_InvalidInput_ReturnsFalse(string cacheKey)
    {
        bool parsed = PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out _, out _);

        Assert.False(parsed);
    }
}

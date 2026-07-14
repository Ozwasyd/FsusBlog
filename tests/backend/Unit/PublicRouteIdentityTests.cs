using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class PublicRouteIdentityTests
{
    [Theory]
    [InlineData("article:7", 7)]
    [InlineData("ARTICLE:8", 8)]
    [InlineData("article:bad", 0)]
    [InlineData("about", 0)]
    public void ParseArticleRouteKey_UsesSharedRouteIdentityRules(string routeKey, int expectedArticleId)
    {
        int articleId = PublicRouteIdentity.ParseArticleRouteKey(routeKey);

        Assert.Equal(expectedArticleId, articleId);
    }

    [Theory]
    [InlineData("category:7", "category", "category:7", 7, null, 7, null)]
    [InlineData("tag:8", "tag", "tag:8", 8, null, null, 8)]
    [InlineData("tag-name:C%23", "tag", "tag-name:C#", 0, "C#", null, null)]
    [InlineData("search", "search", "search", 0, null, null, null)]
    public void ParseFilterRouteKey_UsesSharedRouteIdentityRules(
        string routeKey,
        string expectedFilterType,
        string expectedFilterKey,
        int expectedFilterId,
        string? expectedFilterName,
        int? expectedCategoryId,
        int? expectedTagId)
    {
        PublicRouteIdentity.ParsedFilterRouteIdentity parsed = PublicRouteIdentity.ParseFilterRouteKey(routeKey);

        Assert.Equal(expectedFilterType, parsed.FilterType);
        Assert.Equal(expectedFilterKey, parsed.FilterKey);
        Assert.Equal(expectedFilterId, parsed.FilterId);
        Assert.Equal(expectedFilterName, parsed.FilterName);
        Assert.Equal(expectedCategoryId, parsed.CategoryId);
        Assert.Equal(expectedTagId, parsed.TagId);
    }

    [Theory]
    [InlineData("/", PublicPageKind.Home)]
    [InlineData("/article/42", PublicPageKind.ArticleDetail)]
    [InlineData("/category/7", PublicPageKind.Filter)]
    [InlineData("/tag/demo", PublicPageKind.Filter)]
    [InlineData("/about", PublicPageKind.About)]
    [InlineData("/privacy", PublicPageKind.Privacy)]
    [InlineData("/guidelines", PublicPageKind.Guidelines)]
    [InlineData("/copyright", PublicPageKind.Copyright)]
    [InlineData("/archive", PublicPageKind.Archive)]
    public void TryResolveKind_UsesSharedPathRules(string path, PublicPageKind expectedKind)
    {
        bool resolved = PublicRouteIdentity.TryResolveKind(new PathString(path), out PublicPageKind kind);

        Assert.True(resolved);
        Assert.Equal(expectedKind, kind);
    }

    [Theory]
    [InlineData("/route-that-does-not-exist")]
    [InlineData("/article/0")]
    [InlineData("/article/-1")]
    [InlineData("/article/123/extra")]
    [InlineData("/article/123/")]
    [InlineData("/category/0")]
    [InlineData("/category/8/extra")]
    [InlineData("/tag/0")]
    [InlineData("/tag/-1")]
    [InlineData("/tag/vue/extra")]
    [InlineData("/tag/%2F")]
    [InlineData("/tag/%ZZ")]
    public void TryResolveKind_RejectsInvalidOrPrefixOnlyDynamicPaths(string path)
    {
        bool resolved = PublicRouteIdentity.TryResolveKind(new PathString(path), out PublicPageKind kind);

        Assert.False(resolved);
        Assert.Equal(PublicPageKind.Unknown, kind);
    }

    [Theory]
    [InlineData("/tag/C%23")]
    [InlineData("/tag/vue-router")]
    [InlineData("/tag/%E4%B8%AD%E6%96%87")]
    public void TryResolveKind_AcceptsSingleValidTagSlug(string path)
    {
        Assert.True(PublicRouteIdentity.TryResolveKind(new PathString(path), out PublicPageKind kind));
        Assert.Equal(PublicPageKind.Filter, kind);
    }
}

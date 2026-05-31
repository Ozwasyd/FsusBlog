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
    [InlineData("/archive", PublicPageKind.Archive)]
    public void TryResolveKind_UsesSharedPathRules(string path, PublicPageKind expectedKind)
    {
        bool resolved = PublicRouteIdentity.TryResolveKind(new PathString(path), out PublicPageKind kind);

        Assert.True(resolved);
        Assert.Equal(expectedKind, kind);
    }
}
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotRouteRegistryTests
{
    private readonly PublicAotRouteRegistry _registry = new();

    [Theory]
    [InlineData("/", PublicPageKind.Home, PublicPageId.Home, "home", "/")]
    [InlineData("/article/42", PublicPageKind.ArticleDetail, PublicPageId.ArticleDetail, "article:42", "/article/42")]
    [InlineData("/category/7", PublicPageKind.Filter, PublicPageId.Filter, "category:7", "/category/7")]
    [InlineData("/tag/9", PublicPageKind.Filter, PublicPageId.Filter, "tag:9", "/tag/9")]
    [InlineData("/tag/CSharp", PublicPageKind.Filter, PublicPageId.Filter, "tag-name:CSharp", "/tag/CSharp")]
    [InlineData("/about", PublicPageKind.About, PublicPageId.About, "about", "/about")]
    [InlineData("/privacy", PublicPageKind.Privacy, PublicPageId.Privacy, "privacy", "/privacy")]
    [InlineData("/guidelines", PublicPageKind.Guidelines, PublicPageId.Guidelines, "guidelines", "/guidelines")]
    [InlineData("/copyright", PublicPageKind.Copyright, PublicPageId.Copyright, "copyright", "/copyright")]
    [InlineData("/archive", PublicPageKind.Archive, PublicPageId.Archive, "archive", "/archive")]
    public void TryResolve_PublicRoutes_ReturnsStableIdentity(
        string path,
        PublicPageKind expectedKind,
        PublicPageId expectedPageId,
        string expectedRouteKey,
        string expectedCanonicalPath)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;

        bool resolved = _registry.TryResolve(context, out PublicAotRouteMatch match);

        Assert.True(resolved);
        Assert.Equal(expectedKind, match.Kind);
        Assert.Equal(expectedPageId, match.PageId);
        Assert.Equal(expectedRouteKey, match.RouteKey);
        Assert.Equal(expectedCanonicalPath, match.CanonicalPath);
    }

    [Fact]
    public void TryResolve_UnknownRoute_ReturnsFalse()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/not-a-public-route";

        bool resolved = _registry.TryResolve(context, out _);

        Assert.False(resolved);
    }

    [Theory]
    [InlineData("/search")]
    [InlineData("/search?q=test")]
    [InlineData("/user/profile")]
    [InlineData("/user/profile/messages")]
    public void TryResolve_NonAotRoutes_ReturnsFalse(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path.Split('?')[0];
        if (path.Contains('?', StringComparison.Ordinal))
        {
            context.Request.QueryString = new QueryString(path[path.IndexOf('?', StringComparison.Ordinal)..]);
        }

        bool resolved = _registry.TryResolve(context, out _);

        Assert.False(resolved);
    }
}

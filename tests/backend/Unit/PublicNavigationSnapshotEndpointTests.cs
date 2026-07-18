using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicNavigationSnapshotEndpointTests
{
    [Theory]
    [InlineData("/", "/", "")]
    [InlineData("/archive", "/archive", "")]
    [InlineData("/article/42", "/article/42", "")]
    [InlineData("/category/7?page=2", "/category/7", "?page=2")]
    [InlineData("/tag/vue", "/tag/vue", "")]
    public void TryCreateNavigationSnapshotTargetContext_AllowsRelativePublicPaths(
        string rawPath,
        string expectedPath,
        string expectedQuery)
    {
        var source = new DefaultHttpContext();

        bool ok = PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            rawPath,
            out DefaultHttpContext target,
            out _);

        Assert.True(ok);
        Assert.Equal(expectedPath, target.Request.Path.Value);
        Assert.Equal(expectedQuery, target.Request.QueryString.Value);
        Assert.Same(source.RequestServices, target.RequestServices);
    }

    [Theory]
    [InlineData("")]
    [InlineData("archive")]
    [InlineData("//evil.test/archive")]
    [InlineData("https://evil.test/archive")]
    [InlineData("/account")]
    [InlineData("/search?q=test")]
    [InlineData("/?page=1")]
    [InlineData("/?page=0")]
    [InlineData("/category/7?page=2&utm_source=test")]
    [InlineData("/admin")]
    public void TryCreateNavigationSnapshotTargetContext_FailsClosedForUnsupportedOrPrivatePaths(string rawPath)
    {
        var source = new DefaultHttpContext();

        bool ok = PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            rawPath,
            out _,
            out string error);

        Assert.False(ok);
        Assert.False(string.IsNullOrWhiteSpace(error));
    }
}

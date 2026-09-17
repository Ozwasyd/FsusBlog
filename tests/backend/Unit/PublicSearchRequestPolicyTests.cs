using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests;

public sealed class PublicSearchRequestPolicyTests
{
    [Theory]
    [InlineData("/search", "", null)]
    [InlineData("/search", "?q=test", null)]
    [InlineData("/search", "?q=test&sort=latest&page=100", null)]
    [InlineData("/SEARCH/", "?q=%20Cafe%CC%81%20%20&sort=LATEST&page=01&junk=x&q=ignored", "/search?q=Caf%C3%A9&sort=latest")]
    [InlineData("/search", "?q=&sort=hot&page=4", "/search")]
    [InlineData("/search", "?q=test&sort=unknown&page=-1", "/search?q=test")]
    [InlineData("/search", "?q=test&sort=relevance&page=1", "/search?q=test")]
    [InlineData("/search", "?page=2&q=test&sort=hot", "/search?q=test&sort=hot&page=2")]
    [InlineData("/search", "?q=test&page=101", "/search?q=test")]
    public void Resolve_ProducesOneBoundedCanonicalSearchUrl(string path, string query, string? expectedRedirect)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.QueryString = new QueryString(query);

        PublicSearchRequestResolution result = PublicSearchRequestPolicy.Resolve(context.Request);

        Assert.False(result.IsBadRequest);
        Assert.Equal(expectedRedirect, result.RedirectLocation);
    }

    [Fact]
    public void Resolve_PreservesPathBaseInRedirect()
    {
        var context = new DefaultHttpContext();
        context.Request.PathBase = "/blog";
        context.Request.Path = "/search/";
        context.Request.QueryString = new QueryString("?q=test&page=01");

        PublicSearchRequestResolution result = PublicSearchRequestPolicy.Resolve(context.Request);

        Assert.Equal("/blog/search?q=test", result.RedirectLocation);
    }

    [Fact]
    public void Resolve_RejectsOversizedOrControlCharacterKeywords()
    {
        var oversized = new DefaultHttpContext();
        oversized.Request.Path = "/search";
        oversized.Request.QueryString = new QueryString($"?q={new string('x', PublicSearchRoutePolicy.MaxKeywordChars + 1)}");
        Assert.True(PublicSearchRequestPolicy.Resolve(oversized.Request).IsBadRequest);

        var control = new DefaultHttpContext();
        control.Request.Path = "/search";
        control.Request.QueryString = new QueryString("?q=test%00value");
        Assert.True(PublicSearchRequestPolicy.Resolve(control.Request).IsBadRequest);
    }

    [Fact]
    public void Resolve_RejectsOversizedRawQueryBeforeExpandingUrlSpace()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/search";
        context.Request.QueryString = new QueryString("?unknown=" + new string('x', PublicSearchRoutePolicy.MaxQueryStringChars));

        Assert.True(PublicSearchRequestPolicy.Resolve(context.Request).IsBadRequest);
    }

    [Theory]
    [InlineData("/search", true)]
    [InlineData("/SEARCH/", true)]
    [InlineData("/search/index.bin", false)]
    [InlineData("/article/1", false)]
    public void IsSearchPath_OnlyMatchesTheHtmlRoute(string path, bool expected)
        => Assert.Equal(expected, PublicSearchRequestPolicy.IsSearchPath(new PathString(path)));
}

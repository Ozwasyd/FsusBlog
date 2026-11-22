using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminDocumentRouteTests
{
    private static readonly PasskeyConfiguration Configuration = new(new Uri("https://blog.example.test"), "blog.example.test");

    [Theory]
    [InlineData("/admin")]
    [InlineData("/admin/articles")]
    [InlineData("/admin/articles/write")]
    [InlineData("/admin/articles/workspace")]
    [InlineData("/admin/articles/edit/42")]
    [InlineData("/admin/canvas")]
    [InlineData("/admin/canvas/00000000-0000-0000-0000-000000000001")]
    [InlineData("/admin/assets")]
    [InlineData("/admin/interaction")]
    [InlineData("/admin/site")]
    [InlineData("/admin/identity")]
    public void DocumentsRequireConfiguredAdministratorOrigin(string path)
    {
        foreach (var candidate in new[] { path, path + "/" })
        {
            Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "other.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("http", "blog.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test:444", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", candidate), null));
        }
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/archive")]
    [InlineData("/article/1")]
    [InlineData("/login")]
    [InlineData("/register")]
    [InlineData("/administrator")]
    [InlineData("/api/v2/identity/session.aeds")]
    public void PublicRoutesCoexistOnUnifiedOriginAndWhenAdminIsDisabled(string path)
    {
        Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", path), Configuration));
        Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "other.example.test", path), Configuration));
        Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", path), null));
    }

    [Theory]
    [InlineData("/api/v2/admin/identity/session.aeds")]
    [InlineData("/api/v2/admin/identity/passkey/begin.aeds")]
    [InlineData("/api/v2/authoring/session.aeds")]
    [InlineData("/api/v2/authoring/save.aeds")]
    [InlineData("/api/v2/media/upload.aeds")]
    [InlineData("/admin/system")]
    [InlineData("/admin/unknown")]
    [InlineData("/admin/articles/extra")]
    public void AdministratorAndAuthoringRoutesFailClosedOutsideConfiguredOrigin(string path)
    {
        Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", path), Configuration));
        Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "other.example.test", path), Configuration));
        Assert.False(AdminIdentityEndpoints.IsAllowed(Request("http", "blog.example.test", path), Configuration));
        Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "blog.example.test", path), null));
    }

    private static DefaultHttpContext Request(string scheme, string host, string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = scheme;
        context.Request.Host = new HostString(host);
        context.Request.Path = path;
        return context;
    }
}

using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminDocumentRouteTests
{
    private static readonly PasskeyConfiguration Configuration = new(new Uri("https://admin.example.test"), "admin.example.test");

    [Theory]
    [InlineData("/admin")]
    [InlineData("/admin/articles")]
    [InlineData("/admin/interaction")]
    [InlineData("/admin/site")]
    [InlineData("/admin/system")]
    [InlineData("/admin/identity")]
    public void DocumentsAreExclusiveToConfiguredAdministratorOrigin(string path)
    {
        foreach (var candidate in new[] { path, path + "/" })
        {
            Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "admin.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "public.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("http", "admin.example.test", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "admin.example.test:444", candidate), Configuration));
            Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "admin.example.test", candidate), null));
        }
    }

    [Theory]
    [InlineData("/admin/unknown")]
    [InlineData("/admin/articles/extra")]
    [InlineData("/administrator")]
    [InlineData("/")]
    [InlineData("/login")]
    [InlineData("/user/manage/article/list")]
    [InlineData("/api/v2/identity/session.aeds")]
    public void AdministratorOriginDoesNotBecomeAnApplicationCatchAll(string path) =>
        Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "admin.example.test", path), Configuration));

    [Theory]
    [InlineData("/api/v2/admin/identity/session.aeds")]
    [InlineData("/api/v2/admin/identity/passkey/login/begin.aeds")]
    public void AdministratorApiOriginSeparationIsUnchanged(string path)
    {
        Assert.True(AdminIdentityEndpoints.IsAllowed(Request("https", "admin.example.test", path), Configuration));
        Assert.False(AdminIdentityEndpoints.IsAllowed(Request("https", "public.example.test", path), Configuration));
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

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthCookieServiceSecurityTests
{
    [Fact]
    public void SetTokenCookies_Production_UsesHostPrefixedSecureHttpOnlyStrictCookies()
    {
        var service = new AuthCookieService(CreateConfiguration());
        var context = new DefaultHttpContext();
        string accessToken = CreateAccessTokenWithSession("session-123");

        service.SetTokenCookies(context, ProductionEnv(), accessToken, "refresh-token", DateTime.UtcNow.AddDays(7));

        string[] setCookies = ReadSetCookieHeaders(context);

        Assert.Contains(setCookies, static cookie => cookie.StartsWith("__Host-AccessToken=", StringComparison.Ordinal));
        Assert.Contains(setCookies, static cookie => cookie.StartsWith("__Host-RefreshToken=", StringComparison.Ordinal));
        Assert.Contains(setCookies, static cookie => cookie.StartsWith("__Host-SessionId=session-123", StringComparison.Ordinal));
        Assert.All(setCookies, AssertProductionCookieAttributes);
    }

    [Fact]
    public void ClearTokenCookies_DeletesPlainAndHostPrefixedCookies()
    {
        var service = new AuthCookieService(CreateConfiguration());
        var context = new DefaultHttpContext();

        service.ClearTokenCookies(context);

        string[] setCookies = ReadSetCookieHeaders(context);

        foreach (string cookieName in new[]
        {
            "AccessToken",
            "RefreshToken",
            "SessionId",
            "__Host-AccessToken",
            "__Host-RefreshToken",
            "__Host-SessionId"
        })
        {
            Assert.Contains(setCookies, cookie => cookie.StartsWith(cookieName + "=", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void ReadRefreshToken_PrefersHostPrefixedCookieOverPlainCookie()
    {
        var service = new AuthCookieService(CreateConfiguration());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = "RefreshToken=plain; __Host-RefreshToken=host";

        string? token = service.ReadRefreshToken(context);

        Assert.Equal("host", token);
    }

    private static void AssertProductionCookieAttributes(string cookie)
    {
        Assert.Contains("; path=/", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("; domain=", cookie, StringComparison.OrdinalIgnoreCase);
    }

    private static string[] ReadSetCookieHeaders(DefaultHttpContext context)
        => context.Response.Headers.SetCookie
            .Where(static value => value is not null)
            .Select(static value => value!)
            .ToArray();

    private static string CreateAccessTokenWithSession(string sessionId)
    {
        var token = new JwtSecurityToken(claims: [new Claim("sid", sessionId)]);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection()
            .Build();

    private static IWebHostEnvironment ProductionEnv() => new FakeWebHostEnvironment("Production");

    private sealed class FakeWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "Test";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

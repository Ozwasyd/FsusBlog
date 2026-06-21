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
    public void SetTokenCookies_Production_IgnoresInsecureCookieBypass()
    {
        var service = new AuthCookieService(CreateConfiguration(new Dictionary<string, string?>
        {
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        }));
        var context = new DefaultHttpContext();

        service.SetTokenCookies(context, ProductionEnv(), CreateAccessTokenWithSession("session-123"), "refresh-token", DateTime.UtcNow.AddDays(7));

        string[] setCookies = ReadSetCookieHeaders(context);
        Assert.Contains(setCookies, static cookie => cookie.StartsWith("__Host-RefreshToken=", StringComparison.Ordinal));
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
    public void ClearTokenCookies_HostPrefixedDeletesUsePrefixCompatibleAttributes()
    {
        var service = new AuthCookieService(CreateConfiguration());
        var context = new DefaultHttpContext();

        service.ClearTokenCookies(context);

        string[] setCookies = ReadSetCookieHeaders(context);

        AssertHostPrefixedDeleteCookieAttributes(setCookies, "__Host-AccessToken");
        AssertHostPrefixedDeleteCookieAttributes(setCookies, "__Host-RefreshToken");
        AssertHostPrefixedDeleteCookieAttributes(setCookies, "__Host-SessionId");
    }

    [Fact]
    public void ReadRefreshToken_PrefersHostPrefixedCookieOverPlainCookie()
    {
        var service = new AuthCookieService(CreateConfiguration(), ProductionEnv());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = "RefreshToken=plain; __Host-RefreshToken=host";

        string? token = service.ReadRefreshToken(context);

        Assert.Equal("host", token);
    }

    [Fact]
    public void ReadTokenCookies_ProductionRejectsLegacyPlainCookies()
    {
        var service = new AuthCookieService(CreateConfiguration(new Dictionary<string, string?>
        {
            ["AuthCookies:AllowLegacyPlainCookieRead"] = "true"
        }), ProductionEnv());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = string.Join("; ", [
            "AccessToken=plain-access",
            "RefreshToken=plain-refresh",
            "SessionId=plain-session",
            "AdminAccessToken=plain-admin",
            "AdminSessionId=plain-admin-session"
        ]);

        Assert.Null(service.ReadAccessToken(context));
        Assert.Null(service.ReadRefreshToken(context));
        Assert.Null(service.ReadSessionId(context));
        Assert.False(service.TryReadAdminAccessToken(context, out string adminToken));
        Assert.Equal(string.Empty, adminToken);
    }

    [Fact]
    public void ReadTokenCookies_ProductionAcceptsHostPrefixedCookies()
    {
        var service = new AuthCookieService(CreateConfiguration(), ProductionEnv());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = string.Join("; ", [
            "__Host-AccessToken=host-access",
            "__Host-RefreshToken=host-refresh",
            "__Host-SessionId=host-session",
            "__Host-AdminAccessToken=host-admin",
            "__Host-AdminSessionId=host-admin-session"
        ]);

        Assert.Equal("host-access", service.ReadAccessToken(context));
        Assert.Equal("host-refresh", service.ReadRefreshToken(context));
        Assert.Equal("host-session", service.ReadSessionId(context));
        Assert.True(service.TryReadAdminAccessToken(context, out string adminToken));
        Assert.Equal("host-admin", adminToken);
    }

    [Fact]
    public void ReadTokenCookies_DevelopmentRequiresExplicitLegacyPlainCookieFlag()
    {
        var disabled = new AuthCookieService(CreateConfiguration(new Dictionary<string, string?>
        {
            ["AuthCookies:AllowLegacyPlainCookieRead"] = "false"
        }), DevelopmentEnv());
        var disabledContext = new DefaultHttpContext();
        disabledContext.Request.Headers.Cookie = "AccessToken=plain-access; RefreshToken=plain-refresh; SessionId=plain-session";

        Assert.Null(disabled.ReadAccessToken(disabledContext));
        Assert.Null(disabled.ReadRefreshToken(disabledContext));
        Assert.Null(disabled.ReadSessionId(disabledContext));

        var enabled = new AuthCookieService(CreateConfiguration(new Dictionary<string, string?>
        {
            ["AuthCookies:AllowLegacyPlainCookieRead"] = "true"
        }), DevelopmentEnv());
        var enabledContext = new DefaultHttpContext();
        enabledContext.Request.Headers.Cookie = "AccessToken=plain-access; RefreshToken=plain-refresh; SessionId=plain-session; AdminAccessToken=plain-admin";

        Assert.Equal("plain-access", enabled.ReadAccessToken(enabledContext));
        Assert.Equal("plain-refresh", enabled.ReadRefreshToken(enabledContext));
        Assert.Equal("plain-session", enabled.ReadSessionId(enabledContext));
        Assert.False(enabled.TryReadAdminAccessToken(enabledContext, out _));
    }

    private static void AssertProductionCookieAttributes(string cookie)
    {
        Assert.Contains("; path=/", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("; domain=", cookie, StringComparison.OrdinalIgnoreCase);
    }

    private static void AssertHostPrefixedDeleteCookieAttributes(string[] setCookies, string cookieName)
    {
        string cookie = Assert.Single(setCookies, cookie => cookie.StartsWith(cookieName + "=", StringComparison.Ordinal));
        Assert.Contains("; path=/", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("; samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("expires=", cookie, StringComparison.OrdinalIgnoreCase);
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

    private static IConfiguration CreateConfiguration(Dictionary<string, string?>? values = null)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values ?? [])
            .Build();

    private static IWebHostEnvironment ProductionEnv() => new FakeWebHostEnvironment("Production");

    private static IWebHostEnvironment DevelopmentEnv() => new FakeWebHostEnvironment("Development");

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

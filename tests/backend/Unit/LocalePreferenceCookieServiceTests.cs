using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Localization;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LocalePreferenceCookieServiceTests
{
    [Fact]
    public void CookieName_MatchesPublicAotContract()
    {
        Assert.Equal("fsusblog.locale", LocalePreferenceCookieService.CookieName);
        Assert.True(LocalePreferenceCookieService.IsLocalePreferenceCookieName("fsusblog.locale"));
        Assert.False(LocalePreferenceCookieService.IsLocalePreferenceCookieName("FsusLocalePreference"));
    }

    [Fact]
    public void SetFixed_WritesCanonicalCodeOnly_WithoutIdentity()
    {
        LocalePreferenceCookieService service = CreateService(production: true);
        var context = new DefaultHttpContext();
        LocaleDescriptor locale = LocaleCatalog.Enabled.Single(static item => item.Code == "ja-JP");

        service.SetFixed(context, locale);

        string setCookie = Assert.Single(ReadSetCookieHeaders(context));
        Assert.StartsWith("fsusblog.locale=ja-JP", setCookie, StringComparison.Ordinal);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("account", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("v1:", setCookie, StringComparison.Ordinal);
    }

    [Fact]
    public void Read_RejectsAliasAndForgedValues()
    {
        LocalePreferenceCookieService service = CreateService(production: false);
        var aliasContext = new DefaultHttpContext();
        aliasContext.Request.Headers.Cookie = "fsusblog.locale=en";
        Assert.Null(service.Read(aliasContext));

        var forgedContext = new DefaultHttpContext();
        forgedContext.Request.Headers.Cookie = "fsusblog.locale=xx-YY";
        Assert.Null(service.Read(forgedContext));

        var validContext = new DefaultHttpContext();
        validContext.Request.Headers.Cookie = "fsusblog.locale=de-DE";
        Assert.Equal("de-DE", service.Read(validContext)?.Code);
    }

    [Fact]
    public void Clear_EmitsExpiryDeletesForSecureAndInsecureVariants()
    {
        LocalePreferenceCookieService service = CreateService(production: true);
        var context = new DefaultHttpContext();

        service.Clear(context);

        string[] headers = ReadSetCookieHeaders(context);
        Assert.NotEmpty(headers);
        Assert.All(headers, static header =>
        {
            Assert.StartsWith("fsusblog.locale=", header, StringComparison.Ordinal);
            Assert.Contains("expires=", header, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("path=/", header, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public void SetFixed_RejectsNonCanonicalDescriptor()
    {
        LocalePreferenceCookieService service = CreateService(production: false);
        var context = new DefaultHttpContext();
        LocaleDescriptor alias = LocaleCatalog.Enabled.Single(static item => item.Code == "en-US") with
        {
            Code = "en"
        };

        Assert.Throws<ArgumentException>(() => service.SetFixed(context, alias));
        Assert.Empty(ReadSetCookieHeaders(context));
    }

    private static LocalePreferenceCookieService CreateService(bool production)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AuthCookies:AllowInsecureTransportCookies"] = production ? "false" : "true"
            })
            .Build();
        return new LocalePreferenceCookieService(configuration, production ? ProductionEnv() : DevelopmentEnv());
    }

    private static string[] ReadSetCookieHeaders(HttpContext context)
        => context.Response.Headers.SetCookie
            .Where(static value => value is not null)
            .Select(static value => value!)
            .ToArray();

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

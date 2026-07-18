using System.Net;
using System.Net.Http.Headers;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Distribution;

using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
namespace FsusBlog.Server.Tests.SecurityHardening;

public sealed class PublicResponseCompressionPolicyTests
{
    private static readonly string s_payload = string.Concat(Enumerable.Repeat("public-response-compression-payload-", 256));

    [Fact]
    public async Task TestServer_AnonymousExplicitPublicResponseCompressesAndPreservesVary()
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync("/public", configure: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("br", response.Content.Headers.ContentEncoding);
        string vary = string.Join(",", response.Headers.Vary);
        Assert.Contains("CF-IPCountry", vary, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Accept-Encoding", vary, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task TestServer_AnonymousExplicitPublicResponseSupportsGzip()
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync(
            "/public",
            configure: null,
            acceptedEncoding: "gzip");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("gzip", response.Content.Headers.ContentEncoding);
    }

    [Fact]
    public async Task RegisteredWhitelist_IsLimitedToDistributionAndPublicIntegrityEndpoints()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production
        });
        builder.Services.AddFsusRuntimeDomainServices();
        builder.Services.AddScoped<BlogDistributionService>();
        await using WebApplication app = builder.Build();
        app.MapDistributionEndpoints();
        app.MapIntegrityVerificationEndpoints();

        RouteEndpoint[] endpoints = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .ToArray();
        RouteEndpoint[] allowed = endpoints
            .Where(static endpoint => endpoint.Metadata.GetMetadata<PublicResponseCompressionMetadata>() is not null)
            .ToArray();

        Assert.Equal(endpoints.Length, allowed.Length);
        Assert.Equal(18, allowed.Length);
        Assert.Equal(7, allowed.Count(static endpoint =>
            endpoint.RoutePattern.RawText is "/feed/rss.xml"
                or "/api/Article/rss"
                or "/feed/atom.xml"
                or "/feed/feed.json"
                or "/sitemap.xml"
                or "/sitemap/{page:int}.xml"
                or "/robots.txt"));
        Assert.Equal(11, allowed.Count(static endpoint =>
            endpoint.RoutePattern.RawText?.StartsWith("/integrity/", StringComparison.Ordinal) == true));
        Assert.All(allowed, static endpoint =>
            Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>()));
    }

    [Theory]
    [InlineData("/unmarked")]
    [InlineData("/account/profile")]
    [InlineData("/admin/panel")]
    [InlineData("/auth/login")]
    [InlineData("/notification")]
    [InlineData("/binary")]
    [InlineData("/logged-in")]
    public async Task TestServer_ProtectedPersonalizedAndBinaryBoundariesNeverCompress(string path)
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync(path, configure: null);

        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    [Fact]
    public void Policy_AuthorizationAndAntiforgeryMetadataFailClosed()
    {
        DefaultHttpContext authorization = CreatePolicyContext(new AuthorizeAttribute());
        DefaultHttpContext antiforgery = CreatePolicyContext(TestAntiforgeryMetadata.Instance);
        var options = new PublicResponseCompressionPolicyOptions { Enabled = true };

        Assert.False(PublicResponseCompressionPolicy.IsRequestEligible(authorization, options));
        Assert.False(PublicResponseCompressionPolicy.IsRequestEligible(antiforgery, options));
    }

    [Theory]
    [InlineData("Cookie", "fsus-access=secret")]
    [InlineData("Authorization", "Bearer reflected-secret")]
    [InlineData("X-Fsus-Csrf-Token", "csrf-secret")]
    public async Task TestServer_SensitiveRequestHeadersDisableCompression(string headerName, string headerValue)
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync(
            "/public",
            request => request.Headers.TryAddWithoutValidation(headerName, headerValue));

        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    [Fact]
    public async Task TestServer_InvalidAuthenticationPostWithCookieAndReflectedInputNeverCompresses()
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync(
            "/auth/login-failure?value=attacker-controlled",
            request => request.Headers.TryAddWithoutValidation("Cookie", "fsus-antiforgery=secret"),
            method: HttpMethod.Post);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    [Theory]
    [InlineData("/set-cookie")]
    [InlineData("/private-cache")]
    [InlineData("/private-field-cache")]
    [InlineData("/no-store")]
    [InlineData("/no-cache-field")]
    [InlineData("/vary-cookie")]
    [InlineData("/reflected-error?value=secret")]
    [InlineData("/html-with-nonce")]
    public async Task TestServer_ResponseHeadersStatusAndMediaTypeFailClosed(string path)
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync(path, configure: null);

        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    [Fact]
    public async Task TestServer_RuntimeRollbackDisablesAndReenablesCompressionWithoutRestart()
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage before = await site.SendAsync("/public", configure: null);
        Assert.Contains("br", before.Content.Headers.ContentEncoding);

        site.SetEnabled(false);
        using HttpResponseMessage disabled = await site.SendAsync("/public", configure: null);
        Assert.Empty(disabled.Content.Headers.ContentEncoding);

        site.SetEnabled(true);
        using HttpResponseMessage restored = await site.SendAsync("/public", configure: null);
        Assert.Contains("br", restored.Content.Headers.ContentEncoding);
    }

    [Fact]
    public async Task TestServer_PlainHttpNeverCompresses()
    {
        await using CompressionTestSite site = await CompressionTestSite.CreateAsync();

        using HttpResponseMessage response = await site.SendAsync("/public", configure: null, useHttps: false);

        Assert.Empty(response.Content.Headers.ContentEncoding);
    }

    private sealed class CompressionTestSite : IAsyncDisposable
    {
        private readonly WebApplication _app;
        private readonly HttpClient _client;
        private readonly IConfigurationRoot _configuration;

        private CompressionTestSite(WebApplication app, HttpClient client, IConfigurationRoot configuration)
        {
            _app = app;
            _client = client;
            _configuration = configuration;
        }

        public static async Task<CompressionTestSite> CreateAsync()
        {
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = "Test"
            });
            builder.WebHost.UseTestServer();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{PublicResponseCompressionPolicyOptions.SectionName}:Enabled"] = "true"
            });
            builder.Services.AddRouting();
            builder.Services.AddFsusPublicResponseCompression(builder.Configuration);

            WebApplication app = builder.Build();
            app.UseRouting();
            app.UseResponseCompression();

            MapPublic(app, "/public");
            app.MapGet("/unmarked", WritePublicResponse).AllowAnonymous();
            MapPublic(app, "/account/profile");
            MapPublic(app, "/auth/login");
            app.MapPost("/auth/login-failure", (HttpContext context, string? value) =>
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                context.Response.Headers.CacheControl = "no-store";
                return Results.Text($"invalid-auth:{value}:{s_payload}", "application/json");
            })
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            MapPublic(app, "/admin/panel");
            MapPublic(app, "/notification", "application/json")
                .WithMetadata(new FsusRouteKindMetadata("notification-stream"));
            MapPublic(app, "/binary", "application/octet-stream")
                .WithMetadata(new FsusRouteKindMetadata("binary"));
            app.MapGet("/logged-in", (HttpContext context) =>
            {
                context.User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim(ClaimTypes.NameIdentifier, "42")],
                    authenticationType: "test"));
                return WritePublicResponse(context);
            })
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/set-cookie", (HttpContext context) =>
            {
                context.Response.Headers.SetCookie = "fsus-access=secret; Secure; HttpOnly";
                return WritePublicResponse(context);
            })
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/private-cache", (HttpContext context) => WritePublicResponse(context, "private, max-age=60"))
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/private-field-cache", (HttpContext context) => WritePublicResponse(context, "public, private=\"Set-Cookie\""))
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/no-store", (HttpContext context) => WritePublicResponse(context, "no-store"))
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/no-cache-field", (HttpContext context) => WritePublicResponse(context, "public, no-cache=\"Set-Cookie\""))
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/vary-cookie", (HttpContext context) => WritePublicResponse(context, vary: "Cookie"))
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/reflected-error", (HttpContext context, string? value) =>
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                context.Response.Headers.CacheControl = "no-store";
                return Results.Text($"invalid:{value}:{s_payload}", "application/json");
            })
                .AllowAnonymous()
                .AllowPublicResponseCompression();
            app.MapGet("/html-with-nonce", (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = "public, max-age=60";
                return Results.Text($"<html><script nonce=\"secret\">{s_payload}</script></html>", "text/html");
            })
                .AllowAnonymous()
                .AllowPublicResponseCompression();

            await app.StartAsync();
            HttpClient client = app.GetTestClient();
            return new CompressionTestSite(app, client, (IConfigurationRoot)builder.Configuration);
        }

        public async Task<HttpResponseMessage> SendAsync(
            string path,
            Action<HttpRequestMessage>? configure,
            bool useHttps = true,
            string acceptedEncoding = "br",
            HttpMethod? method = null)
        {
            using var request = new HttpRequestMessage(
                method ?? HttpMethod.Get,
                new Uri($"{(useHttps ? "https" : "http")}://localhost{path}"));
            request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue(acceptedEncoding));
            configure?.Invoke(request);
            return await _client.SendAsync(request);
        }

        public void SetEnabled(bool enabled)
        {
            _configuration[$"{PublicResponseCompressionPolicyOptions.SectionName}:Enabled"] = enabled.ToString();
            _configuration.Reload();
        }

        public async ValueTask DisposeAsync()
        {
            _client.Dispose();
            await _app.DisposeAsync();
        }

        private static RouteHandlerBuilder MapPublic(
            IEndpointRouteBuilder endpoints,
            string path,
            string contentType = "application/json")
            => endpoints.MapGet(path, (HttpContext context) => WritePublicResponse(context, contentType: contentType))
                .AllowAnonymous()
                .AllowPublicResponseCompression();

        private static IResult WritePublicResponse(
            HttpContext context,
            string cacheControl = "public, max-age=60",
            string vary = "CF-IPCountry",
            string contentType = "application/json")
        {
            context.Response.Headers.CacheControl = cacheControl;
            context.Response.Headers.Vary = vary;
            return Results.Text(s_payload, contentType);
        }
    }

    private static DefaultHttpContext CreatePolicyContext(object boundaryMetadata)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = Uri.UriSchemeHttps;
        context.Request.Method = HttpMethods.Get;
        context.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new AllowAnonymousAttribute(),
                PublicResponseCompressionMetadata.Instance,
                boundaryMetadata),
            "compression-policy-test"));
        return context;
    }

    private sealed class TestAntiforgeryMetadata : IAntiforgeryMetadata
    {
        public static TestAntiforgeryMetadata Instance { get; } = new();

        public bool RequiresValidation => true;
    }
}

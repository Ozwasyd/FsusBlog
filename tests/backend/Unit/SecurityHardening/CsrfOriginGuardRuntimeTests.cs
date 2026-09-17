using System.Net;

using FsusBlog.Server.Infrastructure.Security;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class CsrfOriginGuardRuntimeTests
{
    private const string TrustedOrigin = "https://trusted.example.test";
    private const string EndpointResponse = "endpoint-reached";

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("DELETE")]
    [InlineData("PATCH")]
    public async Task CredentialedUnsafeRequest_RejectsMissingTrustedOrigin(string method)
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(app, method, cookie: "AccessToken=credential");

        await AssertRejectedBeforeEndpointAsync(response);
    }

    [Fact]
    public async Task CredentialedUnsafeRequest_RejectsCrossSiteOrigin()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(
            app,
            "POST",
            cookie: "AccessToken=credential",
            origin: "https://attacker.invalid",
            referer: "https://attacker.invalid/form");

        await AssertRejectedBeforeEndpointAsync(response);
    }

    [Fact]
    public async Task CredentialedUnsafeRequest_DoesNotAllowCsrfHeaderToBypassOrigin()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(
            app,
            "POST",
            cookie: "AccessToken=credential",
            origin: "https://attacker.invalid",
            csrfToken: "forged-token");

        await AssertRejectedBeforeEndpointAsync(response);
    }

    [Fact]
    public async Task CredentialedUnsafeRequest_RejectsUntrustedOriginEvenWhenRefererTrusted()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(
            app,
            "POST",
            cookie: "AccessToken=credential",
            origin: "https://attacker.invalid",
            referer: $"{TrustedOrigin}/form");

        await AssertRejectedBeforeEndpointAsync(response);
    }

    [Fact]
    public async Task CredentialedUnsafeRequest_AllowsTrustedOrigin()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(
            app,
            "POST",
            cookie: "AccessToken=credential",
            origin: TrustedOrigin);

        await AssertReachedEndpointAsync(response);
    }

    [Fact]
    public async Task CredentialedUnsafeRequest_AllowsTrustedRefererWhenOriginMissing()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(
            app,
            "POST",
            cookie: "AccessToken=credential",
            referer: $"{TrustedOrigin}/form");

        await AssertReachedEndpointAsync(response);
    }

    [Fact]
    public async Task SafeCookieRequest_BypassesOriginGuard()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(app, "GET", cookie: "AccessToken=credential");

        await AssertReachedEndpointAsync(response);
    }

    [Fact]
    public async Task UnsafeCookielessRequest_BypassesOriginGuard()
    {
        await using WebApplication app = await StartServerAsync();
        using HttpResponseMessage response = await SendAsync(app, "POST");

        await AssertReachedEndpointAsync(response);
    }

    private static async Task<WebApplication> StartServerAsync()
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Production };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CORS_ALLOWED_HOSTS"] = TrustedOrigin
        });
        builder.Services.AddRouting();

        WebApplication app = builder.Build();
        app.UseFsusCsrfOriginGuard();
        app.MapMethods(
            "/mutation",
            ["GET", "POST", "PUT", "DELETE", "PATCH"],
            static () => Results.Text(EndpointResponse));
        await app.StartAsync();
        return app;
    }

    private static async Task<HttpResponseMessage> SendAsync(
        WebApplication app,
        string method,
        string? cookie = null,
        string? origin = null,
        string? referer = null,
        string? csrfToken = null)
    {
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), "/mutation");
        AddHeader(request, "Cookie", cookie);
        AddHeader(request, "Origin", origin);
        AddHeader(request, "Referer", referer);
        AddHeader(request, "X-Fsus-Csrf-Token", csrfToken);
        return await client.SendAsync(request);
    }

    private static void AddHeader(HttpRequestMessage request, string name, string? value)
    {
        if (value is not null)
        {
            Assert.True(request.Headers.TryAddWithoutValidation(name, value));
        }
    }

    private static async Task AssertRejectedBeforeEndpointAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Empty(await response.Content.ReadAsStringAsync());
    }

    private static async Task AssertReachedEndpointAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(EndpointResponse, await response.Content.ReadAsStringAsync());
    }
}

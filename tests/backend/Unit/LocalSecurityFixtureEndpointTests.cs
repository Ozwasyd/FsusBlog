using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LocalSecurityFixtureEndpointTests
{
    private const string Secret = "security-fixture-secret";

    [Theory]
    [InlineData("Production", "true", false)]
    [InlineData("Development", null, false)]
    [InlineData("Development", "false", false)]
    [InlineData("Development", "true", true)]
    [InlineData("Test", "true", true)]
    public async Task Routes_RequireDevelopmentOrTestAndExplicitGate(
        string environment,
        string? allow,
        bool expected)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment
        });
        if (allow is not null)
        {
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey] = allow
            });
        }
        await using WebApplication app = builder.Build();
        app.MapLocalSecurityFixtureEndpoints();

        string[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();
        Assert.Equal(expected, routes.Contains("/__local/security-fixture/apply", StringComparer.Ordinal));
        Assert.Equal(expected, routes.Contains("/__local/security-fixture/observe-cleanup", StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("", "127.0.0.1", HttpStatusCode.Unauthorized)]
    [InlineData("wrong", "127.0.0.1", HttpStatusCode.Unauthorized)]
    [InlineData(Secret, "192.0.2.20", HttpStatusCode.NotFound)]
    public async Task Apply_RequiresExactSecretAndLoopback(
        string providedSecret,
        string remoteIp,
        HttpStatusCode expected)
    {
        ISecurityFixtureCompositionRoot root = Substitute.For<ISecurityFixtureCompositionRoot>();
        await using WebApplication app = await CreateAppAsync(root, IPAddress.Parse(remoteIp));
        using var request = Request("apply", providedSecret);

        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);

        Assert.Equal(expected, response.StatusCode);
        await root.DidNotReceiveWithAnyArgs().ApplyAsync(default, default!, default);
    }

    [Fact]
    public async Task Apply_BindsRunNamespaceAndProfileBeforeCompositionRoot()
    {
        ISecurityFixtureCompositionRoot root = Substitute.For<ISecurityFixtureCompositionRoot>();
        root.ApplyAsync(
                Arg.Any<JsonElement>(),
                Arg.Any<SecurityFixtureRequestBinding>(),
                Arg.Any<CancellationToken>())
            .Returns(new
            {
                status = "applied"
            });
        await using WebApplication app = await CreateAppAsync(root, IPAddress.Loopback);
        using var request = Request("apply", Secret);

        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await root.Received(1).ApplyAsync(
            Arg.Any<JsonElement>(),
            Arg.Is<SecurityFixtureRequestBinding>(binding =>
                binding.RunId == "run-1"
                && binding.Namespace == "namespace-1"
                && binding.ProfileId == "profile-1"),
            Arg.Any<CancellationToken>());
    }

    private static HttpRequestMessage Request(string action, string secret)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/__local/security-fixture/{action}")
        {
            Content = JsonContent.Create(new { schema = "fixture" })
        };
        if (secret.Length > 0)
        {
            request.Headers.Add(LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretHeaderName, secret);
        }
        request.Headers.Add(LocalPublicContentFixtureEndpoints.TestRunIdHeaderName, "run-1");
        request.Headers.Add(LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName, "namespace-1");
        request.Headers.Add(LocalSecurityFixtureEndpoints.TestProfileIdHeaderName, "profile-1");
        return request;
    }

    private static async Task<WebApplication> CreateAppAsync(
        ISecurityFixtureCompositionRoot root,
        IPAddress remoteAddress)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Development"
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey] = "true",
            [LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretConfigurationKey] = Secret
        });
        builder.Services.AddSingleton(root);
        WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = remoteAddress;
            await next();
        });
        app.MapLocalSecurityFixtureEndpoints();
        await app.StartAsync();
        return app;
    }
}

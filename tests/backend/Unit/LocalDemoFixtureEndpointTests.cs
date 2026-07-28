using System.Net;
using System.Net.Http.Json;

using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LocalDemoFixtureEndpointTests
{
    private const string FixtureSecret = "local-demo-fixture-endpoint-test-secret";

    [Theory]
    [InlineData("Production", "true", "true", false, false)]
    [InlineData("Development", null, null, false, false)]
    [InlineData("Development", "false", "false", false, false)]
    [InlineData("Development", "true", "false", true, true)]
    [InlineData("Development", "false", "true", false, true)]
    public async Task Routes_RegisterOnlyForDevelopmentWithExplicitOperationGate(
        string environmentName,
        string? allowPrepare,
        string? allowCleanup,
        bool shouldRegisterPrepare,
        bool shouldRegisterCleanup)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environmentName
        });
        Dictionary<string, string?> configuration = new();
        if (allowPrepare is not null)
        {
            configuration[LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey] = allowPrepare;
        }
        if (allowCleanup is not null)
        {
            configuration[LocalDemoFixtureEndpoints.AllowLocalDemoFixtureCleanupConfigurationKey] = allowCleanup;
        }
        builder.Configuration.AddInMemoryCollection(configuration);

        await using WebApplication app = builder.Build();
        app.MapLocalDemoFixtureEndpoints();

        string[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();
        Assert.Equal(
            shouldRegisterPrepare,
            routes.Contains("/api/local/demo-fixture/prepare", StringComparer.Ordinal));
        Assert.Equal(
            shouldRegisterCleanup,
            routes.Contains("/api/local/demo-fixture/cleanup", StringComparer.Ordinal));
    }

    [Fact]
    public async Task Routes_DoNotReuseLocalAuthFixtureFlag()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        });
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
            [LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey] = "false",
            [LocalDemoFixtureEndpoints.AllowLocalDemoFixtureCleanupConfigurationKey] = "false"
        });

        await using WebApplication app = builder.Build();
        app.MapLocalDemoFixtureEndpoints();

        Assert.DoesNotContain(
            ((IEndpointRouteBuilder)app).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>(),
            endpoint => endpoint.RoutePattern.RawText == "/api/local/demo-fixture/prepare");
    }

    [Fact]
    public async Task Cleanup_RequiresLoopbackAndExactSecretBeforeCallingSeeder()
    {
        IDemoFixtureSeeder seeder = Substitute.For<IDemoFixtureSeeder>();
        await using WebApplication app = await CreateAppAsync(seeder, IPAddress.Loopback);
        HttpClient client = app.GetTestClient();

        using HttpResponseMessage missingSecret = await client.PostAsJsonAsync(
            "/api/local/demo-fixture/cleanup",
            new
            {
                entityIdentities = Array.Empty<object>()
            });
        Assert.Equal(HttpStatusCode.Unauthorized, missingSecret.StatusCode);

        using var wrongSecretRequest = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/demo-fixture/cleanup")
        {
            Content = JsonContent.Create(new { entityIdentities = Array.Empty<object>() })
        };
        wrongSecretRequest.Headers.Add(
            LocalDemoFixtureEndpoints.LocalDemoFixtureSecretHeaderName,
            "wrong-secret");
        using HttpResponseMessage wrongSecret = await client.SendAsync(wrongSecretRequest);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongSecret.StatusCode);
        await seeder.DidNotReceiveWithAnyArgs().CleanupAsync(default!, default);

        using var exactSecretRequest = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/demo-fixture/cleanup")
        {
            Content = JsonContent.Create(new { entityIdentities = Array.Empty<object>() })
        };
        exactSecretRequest.Headers.Add(
            LocalDemoFixtureEndpoints.LocalDemoFixtureSecretHeaderName,
            FixtureSecret);
        using HttpResponseMessage accepted = await client.SendAsync(exactSecretRequest);
        Assert.Equal(HttpStatusCode.NoContent, accepted.StatusCode);
        await seeder.Received(1).CleanupAsync(
            Arg.Is<IReadOnlyList<DemoEntityIdentity>>(items => items.Count == 0),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Cleanup_ReturnsNotFoundForNonLoopbackEvenWithExactSecret()
    {
        IDemoFixtureSeeder seeder = Substitute.For<IDemoFixtureSeeder>();
        await using WebApplication app = await CreateAppAsync(
            seeder,
            IPAddress.Parse("192.0.2.10"));
        HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/demo-fixture/cleanup")
        {
            Content = JsonContent.Create(new { entityIdentities = Array.Empty<object>() })
        };
        request.Headers.Add(
            LocalDemoFixtureEndpoints.LocalDemoFixtureSecretHeaderName,
            FixtureSecret);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        await seeder.DidNotReceiveWithAnyArgs().CleanupAsync(default!, default);
    }

    private static async Task<WebApplication> CreateAppAsync(
        IDemoFixtureSeeder seeder,
        IPAddress remoteAddress)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey] = "true",
            [LocalDemoFixtureEndpoints.LocalDemoFixtureSecretConfigurationKey] = FixtureSecret
        });
        builder.Services.AddSingleton(seeder);

        WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = remoteAddress;
            await next();
        });
        app.MapLocalDemoFixtureEndpoints();
        await app.StartAsync();
        return app;
    }
}

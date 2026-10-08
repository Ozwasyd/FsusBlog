using System.Net;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicCacheChurnBoundaryTests
{
    private const string Secret = "cache-churn-boundary-test-secret";
    private const string Namespace = "churn-dedicated-run";

    [Theory]
    [InlineData("Development")]
    [InlineData("Test")]
    public async Task AuthenticatedScopedObserver_PreservesOwnerCoordinatesWithoutFabricatingBinding(string environment)
    {
        await using WebApplication app = await CreateAsync(environment, Secret);
        using HttpClient client = app.GetTestClient();
        using HttpRequestMessage request = Request(Namespace, Secret);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        JsonElement root = body.RootElement;
        Assert.Equal(Namespace, root.GetProperty("scopeToken").GetString());
        Assert.Equal(17, root.GetProperty("taxonomyFrameCounter").GetInt64());
        Assert.Equal(0, root.GetProperty("hotReadSnapshotVersion").GetInt64());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("databaseGeneration").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("mutationReceiptBinding").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("commonGenerationBinding").ValueKind);
        await app.Services.GetRequiredService<ICacheStringReader>().Received(1)
            .GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("other-run", Secret)]
    [InlineData(Namespace, "wrong-secret")]
    public async Task WrongScopeOrSecret_IsRejectedBeforeOwnerReads(string testNamespace, string providedSecret)
    {
        await using WebApplication app = await CreateAsync("Test", Secret);
        using HttpClient client = app.GetTestClient();
        using HttpRequestMessage request = Request(testNamespace, providedSecret);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        await app.Services.GetRequiredService<ICacheStringReader>().DidNotReceiveWithAnyArgs()
            .GetStringAsync(default, default!);
    }

    [Theory]
    [InlineData("Production", Secret)]
    [InlineData("Test", "")]
    public async Task ProductionOrDisabledObserver_DoesNotRegisterRoute(string environment, string configuredSecret)
    {
        await using WebApplication app = await CreateAsync(environment, configuredSecret);
        using HttpClient client = app.GetTestClient();
        using HttpRequestMessage request = Request(Namespace, Secret);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Observer_HasNoMutationTransport()
    {
        await using WebApplication app = await CreateAsync("Test", Secret);
        using HttpClient client = app.GetTestClient();
        using HttpRequestMessage request = Request(Namespace, Secret);
        request.Method = HttpMethod.Post;
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
        await app.Services.GetRequiredService<ICacheStringReader>().DidNotReceiveWithAnyArgs()
            .GetStringAsync(default, default!);
    }

    private static HttpRequestMessage Request(string testNamespace, string secret)
    {
        var request = new HttpRequestMessage(HttpMethod.Get,
            $"{RuntimeCacheChurnEvidenceEndpoints.BoundaryRoute}?namespace={testNamespace}&runId=soak-current-run");
        request.Headers.Add(RuntimeCacheEvidenceMiddleware.SecretHeader, secret);
        return request;
    }

    private static async Task<WebApplication> CreateAsync(string environment, string secret)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = secret,
            ["AllowedHosts"] = "localhost"
        });
        IRuntimeKeyScope scope = Substitute.For<IRuntimeKeyScope>();
        scope.ScopeToken.Returns(Namespace);
        ICacheStringReader cache = Substitute.For<ICacheStringReader>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>()).Returns("17");
        builder.Services.AddSingleton(scope);
        builder.Services.AddSingleton(cache);
        builder.Services.AddSingleton(Substitute.For<IPublicHotArtifactObligationStore>());
        builder.Services.AddSingleton(new PublicHotReadStore());
        builder.Services.AddSingleton(new PublicAotInvalidationTracker(new InMemoryPublicAotInvalidationGenerationAuthority()));
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();
        WebApplication app = builder.Build();
        app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
        app.MapRuntimeCacheChurnEvidenceEndpoints();
        await app.StartAsync();
        return app;
    }
}

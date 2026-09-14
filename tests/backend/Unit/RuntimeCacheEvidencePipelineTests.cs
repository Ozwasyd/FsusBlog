using System.Net;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheEvidencePipelineTests
{
    private const string Secret = "runtime-cache-evidence-pipeline-secret";

    [Theory]
    [InlineData("Development")]
    [InlineData("Test")]
    public async Task ProductionOrderPipeline_AuthenticatedEvidenceHeadersReachTargetAndCapture(
        string environmentName)
    {
        await using WebApplication app = await CreatePipelineAsync(environmentName, Secret);
        using HttpClient client = app.GetTestClient();
        const string RequestId = "pipeline-valid-0001";

        using HttpResponseMessage response = await SendAsync(client, RequestId, Secret);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        RuntimeCacheEvidenceStore store = app.Services.GetRequiredService<RuntimeCacheEvidenceStore>();
        Assert.True(store.TryTake(RequestId, out RuntimeCacheRequestObservation? observation));
        Assert.NotNull(observation);
        Assert.Equal(StatusCodes.Status200OK, observation.Status);
        Assert.Equal("/probe", observation.Path);
    }

    [Fact]
    public async Task AuthenticatedEvidenceHeaders_DoNotForcePublicHotReadCredentialBypass()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = Secret
            })
            .Build();
        IHostEnvironment environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns("Test");
        bool classified = false;
        bool credentialBypass = true;
        var middleware = new RuntimeCacheEvidenceMiddleware(
            context =>
            {
                classified = PublicHotReadFastPath.TryCreateRequestFeatureForTests(
                    context,
                    out _,
                    out _,
                    out credentialBypass);
                return Task.CompletedTask;
            },
            configuration,
            environment,
            new RuntimeCacheEvidenceStore());
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/hot/10.aeds";
        context.Request.Headers[RuntimeCacheEvidenceMiddleware.RequestIdHeader] = "pipeline-fast-path-0001";
        context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader] = Secret;

        await middleware.InvokeAsync(context);

        Assert.True(classified);
        Assert.False(credentialBypass);
    }

    [Theory]
    [InlineData("wrong-secret", true)]
    [InlineData(null, false)]
    public async Task ProductionOrderPipeline_WrongOrMissingSecretIsRejectedWithoutEvidence(
        string? providedSecret,
        bool includeSecretHeader)
    {
        await using WebApplication app = await CreatePipelineAsync("Test", Secret);
        using HttpClient client = app.GetTestClient();
        string requestId = $"pipeline-invalid-{Guid.NewGuid():N}";

        using HttpResponseMessage response = await SendAsync(
            client,
            requestId,
            providedSecret,
            includeSecretHeader);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        RuntimeCacheEvidenceStore store = app.Services.GetRequiredService<RuntimeCacheEvidenceStore>();
        Assert.False(store.TryTake(requestId, out _));
    }

    [Fact]
    public async Task ProductionOrderPipeline_ProductionRejectsEvidenceHeadersEvenWhenSecretIsConfigured()
    {
        await using WebApplication app = await CreatePipelineAsync(Environments.Production, Secret);
        using HttpClient client = app.GetTestClient();
        const string RequestId = "pipeline-production-0001";

        using HttpResponseMessage response = await SendAsync(client, RequestId, Secret);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        RuntimeCacheEvidenceStore store = app.Services.GetRequiredService<RuntimeCacheEvidenceStore>();
        Assert.False(store.TryTake(RequestId, out _));
    }

    [Fact]
    public async Task ProductionOrderPipeline_AuthenticatedEvidenceDoesNotAllowAnyOtherFsusHeader()
    {
        await using WebApplication app = await CreatePipelineAsync("Test", Secret);
        using HttpClient client = app.GetTestClient();
        const string RequestId = "pipeline-extra-header-0001";
        using var request = CreateRequest(RequestId, Secret);
        request.Headers.TryAddWithoutValidation("X-Fsus-Runtime-Evidence-Extra", "must-not-pass");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task ProductionOrderPipeline_DevelopmentWithoutConfiguredSecretKeepsFailClosedGuard()
    {
        await using WebApplication app = await CreatePipelineAsync(Environments.Development, string.Empty);
        using HttpClient client = app.GetTestClient();
        const string RequestId = "pipeline-no-config-0001";

        using HttpResponseMessage response = await SendAsync(client, RequestId, Secret);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        RuntimeCacheEvidenceStore store = app.Services.GetRequiredService<RuntimeCacheEvidenceStore>();
        Assert.False(store.TryTake(RequestId, out _));
    }

    private static async Task<WebApplication> CreatePipelineAsync(
        string environmentName,
        string configuredSecret)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environmentName
        });
        builder.WebHost.UseTestServer();
        builder.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = configuredSecret;
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();

        WebApplication app = builder.Build();
        app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
        app.UseRouting();
        app.UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>();
        app.MapGet("/probe", static () => Results.Text("observed"));
        await app.StartAsync();
        return app;
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        string requestId,
        string? secret,
        bool includeSecretHeader = true)
    {
        using var request = CreateRequest(requestId, secret, includeSecretHeader);
        return await client.SendAsync(request);
    }

    private static HttpRequestMessage CreateRequest(
        string requestId,
        string? secret,
        bool includeSecretHeader = true)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/probe");
        request.Headers.TryAddWithoutValidation(RuntimeCacheEvidenceMiddleware.RequestIdHeader, requestId);
        if (includeSecretHeader)
        {
            request.Headers.TryAddWithoutValidation(RuntimeCacheEvidenceMiddleware.SecretHeader, secret);
        }
        return request;
    }
}

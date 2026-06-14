using FsusBlog.Server.Infrastructure.Observability;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using System.Diagnostics;

namespace FsusBlog.Server.Tests;

public sealed class ObservabilityTests
{
    [Theory]
    [InlineData("/api/binary/article/list/home/1/10.aeds", "binary")]
    [InlineData("/api/notifications/stream", "notification-stream")]
    [InlineData("/api/author/analytics", "api")]
    [InlineData("/health/ready", "health")]
    [InlineData("/search/index.bin", "static")]
    [InlineData("/article/42", "public")]
    public void ClassifyRoute_MapsRuntimeSurfacesWithoutRawPathTags(string path, string expected)
    {
        Assert.Equal(expected, FsusObservability.ClassifyRoute(path));
    }

    [Fact]
    public void ResolveRouteKind_UsesEndpointMetadataBeforePathClassification()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(new FsusRouteKindMetadata("public")),
            "metadata-route"));

        Assert.Equal("public", FsusObservability.ResolveRouteKind(context));
    }

    [Fact]
    public void CustomAttributes_DoNotExposePiiOrRequestBodies()
    {
        string[] forbiddenFragments =
        [
            "authorization",
            "body",
            "clientip",
            "cookie",
            "email",
            "password",
            "token",
            "user.id",
            "username"
        ];

        foreach (string attribute in FsusObservability.CustomAttributeNames)
        {
            string normalized = attribute.Replace("_", ".", StringComparison.Ordinal).ToLowerInvariant();
            Assert.DoesNotContain(forbiddenFragments, fragment => normalized.Contains(fragment, StringComparison.Ordinal));
        }
    }

    [Fact]
    public void AddFsusObservability_RegistersCollectorSwitchAndRuntimeState()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Observability:Enabled"] = "true",
                ["Observability:ExporterEnabled"] = "true",
                ["Observability:OtlpEndpoint"] = "http://127.0.0.1:4317",
                ["Observability:HttpMetricsSampleRate"] = "16",
                ["Observability:SlowRequestThresholdMilliseconds"] = "250"
            })
            .Build();
        var services = new ServiceCollection();

        services.AddFsusObservability(configuration, new FakeEnvironment());
        using ServiceProvider provider = services.BuildServiceProvider();

        ObservabilityRuntimeState state = provider.GetRequiredService<ObservabilityRuntimeState>();
        Assert.True(state.Enabled);
        Assert.True(state.ExporterEnabled);
        Assert.Equal("http://127.0.0.1:4317", state.OtlpEndpoint);
        FsusObservabilityOptions options = provider.GetRequiredService<IOptions<FsusObservabilityOptions>>().Value;
        Assert.Equal(16, options.HttpMetricsSampleRate);
        Assert.Equal(250, options.SlowRequestThresholdMilliseconds);
    }

    [Fact]
    public async Task CorrelationMiddleware_DoesNotMaterializeTraceIdWhenActivityIsNotRecording()
    {
        using var activity = new Activity("unit-http-hot-path");
        activity.Start();
        activity.IsAllDataRequested = false;
        Activity.Current = activity;
        try
        {
            var context = new DefaultHttpContext();
            context.TraceIdentifier = "request-local";
            var middleware = new ObservabilityCorrelationMiddleware(
                _ => Task.CompletedTask,
                Options.Create(new FsusObservabilityOptions
                {
                    HttpMetricsSampleRate = 4096,
                    SlowRequestThresholdMilliseconds = 60_000
                }));

            await middleware.InvokeAsync(context);

            Assert.Equal("request-local", context.TraceIdentifier);
        }
        finally
        {
            activity.Stop();
            Activity.Current = null;
        }
    }

    private sealed class FakeEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = "UnitTest";
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

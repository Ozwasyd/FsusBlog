using FsusBlog.Server.Infrastructure.Observability;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Tests;

public sealed class ObservabilityTests
{
    [Theory]
    [InlineData("/api/binary/article", "binary")]
    [InlineData("/api/notifications/stream", "sse")]
    [InlineData("/api/author/analytics", "api")]
    [InlineData("/health/ready", "health")]
    [InlineData("/search/index.bin", "static")]
    [InlineData("/article/42", "public")]
    public void ClassifyRoute_MapsRuntimeSurfacesWithoutRawPathTags(string path, string expected)
    {
        Assert.Equal(expected, FsusObservability.ClassifyRoute(path));
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
                ["Observability:OtlpEndpoint"] = "http://127.0.0.1:4317"
            })
            .Build();
        var services = new ServiceCollection();

        services.AddFsusObservability(configuration, new FakeEnvironment());
        using ServiceProvider provider = services.BuildServiceProvider();

        ObservabilityRuntimeState state = provider.GetRequiredService<ObservabilityRuntimeState>();
        Assert.True(state.Enabled);
        Assert.True(state.ExporterEnabled);
        Assert.Equal("http://127.0.0.1:4317", state.OtlpEndpoint);
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

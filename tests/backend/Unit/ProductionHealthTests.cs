using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Background;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class ProductionHealthTests
{
    [Fact]
    public void LivenessReport_ReturnsLiveWithoutReadinessDependencies()
    {
        IReadOnlyDictionary<string, object?> report = ProductionLivenessProbe.CreateReport();

        Assert.Equal("live", report["status"]);
        Assert.True(report.ContainsKey("checkedAt"));
    }

    [Fact]
    public void ResourcePathResolver_FindsIp2LocationBinUnderWwwrootResources()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        string resourceDir = Path.Combine(tempRoot, "wwwroot", "resources");
        Directory.CreateDirectory(resourceDir);
        string binPath = Path.Combine(resourceDir, "IP2LOCATION.BIN");
        File.WriteAllBytes(binPath, [1, 2, 3]);

        try
        {
            string? resolved = ProductionResourcePaths.ResolveIp2LocationBinPath(tempRoot);

            Assert.Equal(binPath, resolved);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ReadinessProbe_RuntimeCheck_ExposesStartupTaskSnapshot()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var runtimeState = new StartupRuntimeState
            {
                SystemCachesClearedOnStartup = true
            };
            runtimeState.ReportStartupTask("schemaMigration", "ok");
            runtimeState.ReportStartupTask("aotDiskCache", "skipped", "disabled");
            runtimeState.ReportStartupTask("bootstrapRollback", "ok", "restored:1");
            var scheduledPublishState = new ScheduledPublishRuntimeState();
            scheduledPublishState.ReportResult(2, 1, 1, "one_or_more_articles_failed");

            var services = new ServiceCollection()
                .AddSingleton(runtimeState)
                .AddSingleton(scheduledPublishState)
                .BuildServiceProvider();
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var probe = new ProductionReadinessProbe(
                configuration,
                new TestWebHostEnvironment(tempRoot, Environments.Development),
                services,
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var runtime = Assert.IsType<RuntimeHealthSnapshot>(report.Checks["runtime"]);
            Assert.NotNull(runtime.Startup);
            StartupRuntimeSnapshot startup = runtime.Startup!;
            Assert.True(startup.SystemCachesClearedOnStartup);

            IReadOnlyDictionary<string, StartupLifecycleTaskReport> tasks = startup.Tasks;
            Assert.Equal("ok", tasks["schemaMigration"].Status);
            Assert.Equal("disabled", tasks["aotDiskCache"].Detail);
            Assert.Equal("ok", tasks["bootstrapRollback"].Status);
            Assert.Equal("restored:1", tasks["bootstrapRollback"].Detail);

            Assert.NotNull(runtime.ScheduledPublish);
            Assert.Equal("degraded", runtime.ScheduledPublish!.Status);
            Assert.Equal(2, runtime.ScheduledPublish.LastPublishedCount);
            Assert.Equal(1, runtime.ScheduledPublish.LastFailedCount);
            Assert.Equal(1, runtime.ScheduledPublish.DueBacklog);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

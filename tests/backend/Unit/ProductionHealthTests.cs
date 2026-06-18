using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
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
    public void PublicReadinessReport_ContainsOnlyStatusAndCheckedAt()
    {
        var detailed = new ProductionHealthReport(
            "not_ready",
            DateTimeOffset.UtcNow,
            new Dictionary<string, object?>
            {
                ["postgres"] = new ProductionDependencyHealthCheck("failed", Error: "PostgresException"),
                ["redis"] = new ProductionDependencyHealthCheck("ok", LatencyMs: 1),
                ["runtime"] = new RuntimeHealthSnapshot("ok", null, 5, 10, null, null, null, null),
                ["resources"] = new ProductionResourceHealthCheck("failed", false, false, false, new PublicAotSsrWorkerResourceStatus("failed", true, false, null, null, null, "path"))
            });

        IReadOnlyDictionary<string, object?> report = ProductionReadinessPublicReport.Create(detailed);

        Assert.Equal(["checkedAt", "status"], report.Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray());
        Assert.Equal("not_ready", report["status"]);
        Assert.Equal(detailed.CheckedAt, report["checkedAt"]);
    }

    [Fact]
    public void ProductionHealthEndpoints_PublicReadyIsMinimalAndDetailRequiresAdmin()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string publicReady = ExtractBetween(
            source,
            "endpoints.MapGet(\"/health/ready\"",
            "endpoints.MapGet(\"/api/ops/health/ready-detail\"");
        string readyDetail = ExtractBetween(
            source,
            "endpoints.MapGet(\"/api/ops/health/ready-detail\"",
            "endpoints.MapGet(\"/api/ops/crawler-ranges/status\"");

        Assert.Contains("ProductionReadinessPublicReport.Create(report)", publicReady, StringComparison.Ordinal);
        Assert.DoesNotContain("TypedResults.Json(report", publicReady, StringComparison.Ordinal);
        Assert.Contains("TypedResults.Json(report", readyDetail, StringComparison.Ordinal);
        Assert.Contains(".RequireAdminPermission(AdminPermissions.AuditRead)", readyDetail, StringComparison.Ordinal);
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
            var publicHotStore = new PublicHotReadStore();
            publicHotStore.Publish(PublicHotReadSnapshot.Empty);

            var services = new ServiceCollection()
                .AddSingleton(runtimeState)
                .AddSingleton(scheduledPublishState)
                .AddSingleton(publicHotStore)
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

            Assert.NotNull(runtime.PublicHotRead);
            Assert.Equal(nameof(PublicHotReadState.Ready), runtime.PublicHotRead!.State);
            Assert.Equal("ok", runtime.PublicHotRead.LastBuildStatus);
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

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}

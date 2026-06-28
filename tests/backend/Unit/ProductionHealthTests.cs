using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Security;
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
    public void ProductionReadiness_UsesShortTtlSnapshotCacheForPublicProbe()
    {
        string health = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string serviceCollection = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimePublicAotServiceCollectionExtensions.cs");
        string observability = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string publicReady = ExtractBetween(
            health,
            "endpoints.MapGet(\"/health/ready\"",
            "endpoints.MapGet(\"/api/ops/health/ready-detail\"");
        string readyDetail = ExtractBetween(
            health,
            "endpoints.MapGet(\"/api/ops/health/ready-detail\"",
            "endpoints.MapGet(\"/api/ops/crawler-ranges/status\"");

        Assert.Contains("ProductionReadinessSnapshotCache", health, StringComparison.Ordinal);
        Assert.Contains("ReadinessSnapshotTtl", health, StringComparison.Ordinal);
        Assert.Contains("SemaphoreSlim", health, StringComparison.Ordinal);
        Assert.Contains("GetSnapshotAsync", health, StringComparison.Ordinal);

        Assert.Contains("ProductionReadinessSnapshotCache snapshotCache", publicReady, StringComparison.Ordinal);
        Assert.Contains("snapshotCache.GetSnapshotAsync(forceRefresh: false", publicReady, StringComparison.Ordinal);
        Assert.DoesNotContain("probe.CheckAsync", publicReady, StringComparison.Ordinal);

        Assert.Contains("bool forceRefresh", readyDetail, StringComparison.Ordinal);
        Assert.Contains("snapshotCache.GetSnapshotAsync(forceRefresh", readyDetail, StringComparison.Ordinal);
        Assert.Contains(".RequireAdminPermission(AdminPermissions.AuditRead)", readyDetail, StringComparison.Ordinal);

        Assert.Contains("AddSingleton<ProductionReadinessSnapshotCache>", serviceCollection, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.snapshot.cache_access", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.snapshot.fresh_check_elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.snapshot.dependency_check_count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.snapshot.age_ms", observability, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadinessSnapshotCache_ReturnsSameSnapshotInsideTtl()
    {
        int refreshCount = 0;
        var cache = new ProductionReadinessSnapshotCache(
            _ => Task.FromResult(CreateReadinessReport(Interlocked.Increment(ref refreshCount))),
            TimeSpan.FromMinutes(1));

        ProductionHealthReport first = await cache.GetSnapshotAsync(forceRefresh: false, CancellationToken.None);
        ProductionHealthReport second = await cache.GetSnapshotAsync(forceRefresh: false, CancellationToken.None);

        Assert.Same(first, second);
        Assert.Equal(1, refreshCount);
    }

    [Fact]
    public async Task ReadinessSnapshotCache_CoalescesConcurrentColdRefreshes()
    {
        int refreshCount = 0;
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cache = new ProductionReadinessSnapshotCache(
            async _ =>
            {
                Interlocked.Increment(ref refreshCount);
                await releaseRefresh.Task;
                return CreateReadinessReport(refreshCount);
            },
            TimeSpan.FromMinutes(1));

        Task<ProductionHealthReport>[] requests = Enumerable.Range(0, 8)
            .Select(_ => cache.GetSnapshotAsync(forceRefresh: false, CancellationToken.None))
            .ToArray();
        await WaitUntilAsync(() => Volatile.Read(ref refreshCount) == 1);

        releaseRefresh.SetResult();
        ProductionHealthReport[] reports = await Task.WhenAll(requests);

        Assert.Equal(1, refreshCount);
        Assert.All(reports, report => Assert.Same(reports[0], report));
    }

    [Fact]
    public void RuntimeHealth_DegradesWhenPublicHotArticleFrameLimitIsExceeded()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string runtime = ExtractBetween(
            source,
            "private RuntimeHealthSnapshot CheckRuntime()",
            "    private async Task<ProductionRiskControlHealthCheck>");

        Assert.Contains("publicHotRead.ArticleFrameLimitExceeded", runtime, StringComparison.Ordinal);
        Assert.Contains("&& !publicHotRead.ArticleFrameLimitExceeded", runtime, StringComparison.Ordinal);
        Assert.Contains("? \"ok\"", runtime, StringComparison.Ordinal);
        Assert.Contains(": \"degraded\"", runtime, StringComparison.Ordinal);
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

    [Fact]
    public async Task ReadinessProbe_RiskControlCheck_ValidatesPolicyProvidersAndConsumeOnce()
    {
        FsusObservability.ResetSecurityChallengeV2RuntimeMetricsForTests();
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var services = new ServiceCollection()
                .AddSingleton<ISecurityRiskPolicyProvider>(new FixedRiskPolicyProvider(CreateRiskPolicy()))
                .AddSingleton<IUnifiedCache, ConsumeOnceHealthCache>();
            foreach (SecurityChallengeKind kind in SecurityChallengeContracts.SupportedKinds)
            {
                services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(SecurityChallengeContracts.ToWireName(kind)));
            }

            using ServiceProvider provider = services.BuildServiceProvider();
            var probe = new ProductionReadinessProbe(
                CreatePerceptionReadyConfiguration(),
                new TestWebHostEnvironment(tempRoot, Environments.Development),
                provider,
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var riskControl = Assert.IsType<ProductionRiskControlHealthCheck>(report.Checks["riskControl"]);
            Assert.Equal("ok", riskControl.Status);
            Assert.True(riskControl.ActivePolicy);
            Assert.True(riskControl.LastKnownGoodPolicy);
            Assert.True(riskControl.RedisConsumeOnce);
            Assert.True(riskControl.ChallengeProviderRegistry);
            Assert.True(riskControl.PerceptionAeadKey);
            Assert.Equal("enforce", riskControl.PerceptionMode);
            Assert.Empty(riskControl.PerceptionPerformanceBudget.Warnings);
            Assert.Equal(SecurityChallengeContracts.SupportedKinds.Count, riskControl.Providers.Count);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ReadinessProbe_RiskControlCheck_FailsWhenActivePolicyMissing()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var services = new ServiceCollection()
                .AddSingleton<IUnifiedCache, ConsumeOnceHealthCache>();
            foreach (SecurityChallengeKind kind in SecurityChallengeContracts.SupportedKinds)
            {
                services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(SecurityChallengeContracts.ToWireName(kind)));
            }

            using ServiceProvider provider = services.BuildServiceProvider();
            var probe = new ProductionReadinessProbe(
                CreatePerceptionReadyConfiguration(),
                new TestWebHostEnvironment(tempRoot, Environments.Development),
                provider,
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var riskControl = Assert.IsType<ProductionRiskControlHealthCheck>(report.Checks["riskControl"]);
            Assert.Equal("failed", riskControl.Status);
            Assert.False(riskControl.ActivePolicy);
            Assert.False(riskControl.LastKnownGoodPolicy);
            Assert.True(riskControl.RedisConsumeOnce);
            Assert.True(riskControl.ChallengeProviderRegistry);
            Assert.True(riskControl.PerceptionAeadKey);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ReadinessProbe_RiskControlCheck_FailsWhenPerceptionAeadKeyMissing()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var services = new ServiceCollection()
                .AddSingleton<ISecurityRiskPolicyProvider>(new FixedRiskPolicyProvider(CreateRiskPolicy()))
                .AddSingleton<IUnifiedCache, ConsumeOnceHealthCache>();
            foreach (SecurityChallengeKind kind in SecurityChallengeContracts.SupportedKinds)
            {
                services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(SecurityChallengeContracts.ToWireName(kind)));
            }

            using ServiceProvider provider = services.BuildServiceProvider();
            var probe = new ProductionReadinessProbe(
                new ConfigurationBuilder().Build(),
                new TestWebHostEnvironment(tempRoot, Environments.Development),
                provider,
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var riskControl = Assert.IsType<ProductionRiskControlHealthCheck>(report.Checks["riskControl"]);
            Assert.Equal("failed", riskControl.Status);
            Assert.False(riskControl.PerceptionAeadKey);
            Assert.True(riskControl.ActivePolicy);
            Assert.True(riskControl.LastKnownGoodPolicy);
            Assert.True(riskControl.RedisConsumeOnce);
            Assert.True(riskControl.ChallengeProviderRegistry);
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

    private static SecurityRiskPolicySnapshotV2 CreateRiskPolicy()
        => new(
            "risk-policy-snapshot-1",
            "risk-policy-v2",
            DateTimeOffset.UtcNow,
            SecuritySystemModes.Enforce,
            100,
            125,
            "risk-policy-snapshot-1",
            new SecurityRiskActionPolicy(
                "*",
                new SecurityRiskActionThresholds(10, 25, 50, 75, 90),
                SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1),
                1,
                null,
                AnonymousWriteAllowed: true),
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.AntiCrawler] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.Pow] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled
            });

    private static IConfiguration CreatePerceptionReadyConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k1",
                ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64)
            })
            .Build();

    private static ProductionHealthReport CreateReadinessReport(int sequence)
        => new(
            "ready",
            DateTimeOffset.UtcNow.AddTicks(sequence),
            new Dictionary<string, object?>
            {
                ["postgres"] = new ProductionDependencyHealthCheck("ok", LatencyMs: 1),
                ["redis"] = new ProductionDependencyHealthCheck("ok", LatencyMs: 1),
                ["riskControl"] = new ProductionRiskControlHealthCheck(
                    "ok",
                    ActivePolicy: true,
                    LastKnownGoodPolicy: true,
                    RedisConsumeOnce: true,
                    ChallengeProviderRegistry: true,
                    PolicyVersion: "test",
                    Providers: [],
                    PerceptionAeadKey: true,
                    PerceptionMode: "enforce",
                    PerceptionPerformanceBudget: FsusObservability.CreateSecurityChallengeV2PerformanceBudgetSnapshot())
            });

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        for (int attempt = 0; attempt < 100; attempt++)
        {
            if (predicate())
            {
                return;
            }

            await Task.Delay(10);
        }

        Assert.True(predicate(), "Condition was not met before timeout.");
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicySnapshotV2 policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicySnapshot CurrentRiskPolicy => SecurityRiskPolicySnapshotV2Adapter.ToLegacy(policy);

        public SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 => policy;
    }

    private sealed class HealthChallengeProvider(string kind) : ISecurityChallengeProvider
    {
        public string Kind { get; } = kind;

        public Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class ConsumeOnceHealthCache : IUnifiedCache
    {
        private readonly HashSet<(CachePolicyId PolicyId, string Identity)> _keys = [];

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            _keys.Add((policyId, identity));
            return Task.CompletedTask;
        }

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_keys.Remove((policyId, identity)));

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";
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

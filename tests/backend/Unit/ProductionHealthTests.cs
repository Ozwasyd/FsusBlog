using System.Collections.Frozen;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
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
    public void PublicReadinessReport_ExposesOnlyStableSchemaIncompatibleCode()
    {
        var detailed = new ProductionHealthReport(
            "not_ready",
            DateTimeOffset.Parse("2026-07-11T02:00:00Z"),
            new Dictionary<string, object?>
            {
                ["schemaCompatibility"] = new ProductionOnlineSchemaCompatibilityHealthCheck(
                    "failed",
                    "schema_incompatible",
                    "20260720-current",
                    "20260801-schema",
                    [new OnlineSchemaCompatibilityIssue(
                        "schema_release_outside_manifest",
                        OnlineSchemaCompatibilitySeverity.Error,
                        Detail: "protected detail")],
                    "schema_incompatible")
            });

        IReadOnlyDictionary<string, object?> report = ProductionReadinessPublicReport.Create(detailed);
        string json = System.Text.Json.JsonSerializer.Serialize(report);

        Assert.Equal(["checkedAt", "code", "status"], report.Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray());
        Assert.Equal("schema_incompatible", report["code"]);
        Assert.DoesNotContain("schema_release_outside_manifest", json, StringComparison.Ordinal);
        Assert.DoesNotContain("20260801-schema", json, StringComparison.Ordinal);
    }

    [Fact]
    public void ReleaseStorageReadiness_BindsSharedKeyRingAndMaterializedAssetsToRuntimeIdentity()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-release-storage-health-" + Guid.NewGuid().ToString("N"));
        string keyRing = Path.Combine(root, "keyring");
        string assets = Path.Combine(root, "assets");
        const string ReleaseId = "release-health-001";
        const string Slot = "green";
        Directory.CreateDirectory(keyRing);
        Directory.CreateDirectory(Path.Combine(assets, ReleaseId));
        File.WriteAllText(
            Path.Combine(assets, ReleaseId, "asset-manifest.json"),
            $$"""
            {
              "schema": "fsusblog.release-assets.v1",
              "releaseId": "{{ReleaseId}}",
              "slot": "{{Slot}}",
              "frontendBuildId": "{{ReleaseId}}",
              "files": [{ "path": "index.html" }]
            }
            """);

        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["DataProtection:KeyRingPath"] = keyRing,
                    ["DataProtection:ApplicationName"] = "FsusBlog",
                    ["FSUSBLOG_RELEASE_ASSET_ROOT"] = assets
                })
                .Build();
            var identity = new ReleaseIdentitySnapshot(
                ReleaseId,
                Slot,
                new string('a', 40),
                $"registry.example/fsusblog@sha256:{new string('b', 64)}",
                $"sha256:{new string('b', 64)}",
                Configured: true);

            ProductionReleaseStorageHealthCheck result = ProductionReleaseStorageReadiness.Evaluate(
                configuration,
                new TestWebHostEnvironment(root, Environments.Production),
                identity);

            Assert.Equal("ok", result.Status);
            Assert.True(result.Required);
            Assert.True(result.DataProtectionReady);
            Assert.True(result.DataProtectionCanRead);
            Assert.True(result.DataProtectionCanWrite);
            Assert.True(result.AssetManifestExists);
            Assert.True(result.AssetIdentityMatches);
            Assert.Equal(1, result.AssetCount);
            Assert.Empty(result.Errors);
            Assert.Empty(Directory.EnumerateFiles(keyRing, ".fsus-probe-*.tmp"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ReleaseStorageReadiness_FailsClosedWhenMaterializedSlotDoesNotMatchRuntime()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-release-storage-health-" + Guid.NewGuid().ToString("N"));
        string keyRing = Path.Combine(root, "keyring");
        string assets = Path.Combine(root, "assets");
        const string ReleaseId = "release-health-002";
        Directory.CreateDirectory(keyRing);
        Directory.CreateDirectory(Path.Combine(assets, ReleaseId));
        File.WriteAllText(
            Path.Combine(assets, ReleaseId, "asset-manifest.json"),
            $$"""
            {
              "schema": "fsusblog.release-assets.v1",
              "releaseId": "{{ReleaseId}}",
              "slot": "blue",
              "frontendBuildId": "{{ReleaseId}}",
              "files": [{ "path": "index.html" }]
            }
            """);

        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["DataProtection:KeyRingPath"] = keyRing,
                    ["DataProtection:ApplicationName"] = "FsusBlog",
                    ["FSUSBLOG_RELEASE_ASSET_ROOT"] = assets
                })
                .Build();
            var identity = new ReleaseIdentitySnapshot(
                ReleaseId,
                "green",
                new string('a', 40),
                $"registry.example/fsusblog@sha256:{new string('b', 64)}",
                $"sha256:{new string('b', 64)}",
                Configured: true);

            ProductionReleaseStorageHealthCheck result = ProductionReleaseStorageReadiness.Evaluate(
                configuration,
                new TestWebHostEnvironment(root, Environments.Production),
                identity);

            Assert.Equal("failed", result.Status);
            Assert.False(result.AssetIdentityMatches);
            Assert.Contains("release_asset_identity_mismatch", result.Errors);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ProductionHealthEndpoints_PublicReadyIsMinimalAndDetailRequiresAdmin()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        await using WebApplication app = builder.Build();
        app.MapProductionHealthEndpoints();
        RouteEndpoint publicReady = FindRoute(app, "/health/ready");
        RouteEndpoint readyDetail = FindRoute(app, "/api/ops/health/ready-detail");
        MethodInfo publicHandler = publicReady.Metadata.GetMetadata<MethodInfo>()!;
        MethodInfo detailHandler = readyDetail.Metadata.GetMetadata<MethodInfo>()!;
        MethodBase[] publicCalls = ReadCalledMethods(AsyncMoveNext(publicHandler)).ToArray();
        MethodBase[] detailCalls = ReadCalledMethods(AsyncMoveNext(detailHandler)).ToArray();

        Assert.Contains(publicCalls, static method =>
            method.DeclaringType == typeof(ProductionReadinessPublicReport)
            && method.Name == nameof(ProductionReadinessPublicReport.Create));
        Assert.DoesNotContain(detailCalls, static method => method.DeclaringType == typeof(ProductionReadinessPublicReport));
        Assert.Contains(detailCalls, static method => method.Name == "Json");
        AuthorizationPolicy policy = Assert.Single(readyDetail.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
        ClaimsAuthorizationRequirement permission = Assert.Single(
            policy.Requirements.OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(AdminPermissions.AuditRead, permission.AllowedValues ?? []);
    }

    [Fact]
    public async Task ProductionReadiness_UsesShortTtlSnapshotCacheForPublicProbe()
    {
        FieldInfo ttlField = typeof(ProductionReadinessSnapshotCache).GetField(
            "ReadinessSnapshotTtl",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Equal(TimeSpan.FromSeconds(5), ttlField.GetValue(null));
        Assert.Equal(typeof(SemaphoreSlim), typeof(ProductionReadinessSnapshotCache)
            .GetField("_refreshGate", BindingFlags.NonPublic | BindingFlags.Instance)!.FieldType);
        Assert.Equal(typeof(bool), typeof(ProductionReadinessSnapshotCache)
            .GetMethod(nameof(ProductionReadinessSnapshotCache.GetSnapshotAsync))!
            .GetParameters()[0].ParameterType);

        var services = new ServiceCollection();
        services.AddFsusRuntimePublicAotServices();
        ServiceDescriptor registration = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(ProductionReadinessSnapshotCache));
        Assert.Equal(ServiceLifetime.Singleton, registration.Lifetime);

        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.readiness.snapshot.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        int refreshCount = 0;
        var cache = new ProductionReadinessSnapshotCache(
            _ => Task.FromResult(CreateReadinessReport(Interlocked.Increment(ref refreshCount))),
            TimeSpan.FromMinutes(1));
        await cache.GetSnapshotAsync(forceRefresh: false, CancellationToken.None);
        await cache.GetSnapshotAsync(forceRefresh: false, CancellationToken.None);

        Assert.Equal(1, refreshCount);
        Assert.Contains("fsus.readiness.snapshot.cache_access", measurements);
        Assert.Contains("fsus.readiness.snapshot.fresh_check_elapsed_ms", measurements);
        Assert.Contains("fsus.readiness.snapshot.dependency_check_count", measurements);
        Assert.Contains("fsus.readiness.snapshot.age_ms", measurements);

        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        await using WebApplication app = builder.Build();
        app.MapProductionHealthEndpoints();
        MethodInfo publicHandler = FindRoute(app, "/health/ready").Metadata.GetMetadata<MethodInfo>()!;
        MethodInfo detailHandler = FindRoute(app, "/api/ops/health/ready-detail").Metadata.GetMetadata<MethodInfo>()!;
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider()
        };
        object? publicTarget = publicHandler.IsStatic
            ? null
            : Activator.CreateInstance(publicHandler.DeclaringType!, nonPublic: true);
        object? detailTarget = detailHandler.IsStatic
            ? null
            : Activator.CreateInstance(detailHandler.DeclaringType!, nonPublic: true);
        _ = await (Task<IResult>)publicHandler.Invoke(publicTarget, [cache, context, CancellationToken.None])!;
        Assert.Equal(1, refreshCount);
        _ = await (Task<IResult>)detailHandler.Invoke(detailTarget, [cache, context, CancellationToken.None, true])!;
        Assert.Equal(2, refreshCount);
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
    public async Task RuntimeHealth_DegradesWhenPublicHotArticleFrameLimitIsExceeded()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-health-frame-limit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        File.WriteAllText(Path.Combine(root, "wwwroot", "index.html"), "<html></html>");
        try
        {
            var store = new PublicHotReadStore();
            store.Publish(new PublicHotReadSnapshot(
                1,
                FrozenDictionary<int, PublicBinaryArtifact>.Empty,
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
                default,
                default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow),
                publicArticleCount: 2,
                articleFrameLimit: 1));
            using ServiceProvider services = new ServiceCollection()
                .AddSingleton(store)
                .BuildServiceProvider();
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var environment = new TestWebHostEnvironment(root, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                services,
                CreateConfigurationSnapshot(configuration, environment, services),
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var runtime = Assert.IsType<RuntimeHealthSnapshot>(report.Checks["runtime"]);
            Assert.Equal("degraded", runtime.Status);
            Assert.NotNull(runtime.PublicHotRead);
            Assert.True(runtime.PublicHotRead.ArticleFrameLimitExceeded);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
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
            publicHotStore.Publish(new PublicHotReadSnapshot(
                1,
                FrozenDictionary<int, PublicBinaryArtifact>.Empty,
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
                default,
                default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow)));

            var services = new ServiceCollection()
                .AddSingleton(runtimeState)
                .AddSingleton(scheduledPublishState)
                .AddSingleton(publicHotStore)
                .BuildServiceProvider();
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                services,
                CreateConfigurationSnapshot(configuration, environment, services),
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
            services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(
                SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1)));

            using ServiceProvider provider = services.BuildServiceProvider();
            IConfiguration configuration = CreatePerceptionReadyConfiguration();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                CreateConfigurationSnapshot(configuration, environment, provider),
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
            Assert.NotNull(riskControl.PerceptionPerformanceBudget.Warnings);
            Assert.Single(riskControl.Providers);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ReadinessProbe_RiskControlCheck_FailsWhenActivePolicyProviderIsMissing()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var services = new ServiceCollection()
                .AddSingleton<ISecurityRiskPolicyProvider>(new FixedRiskPolicyProvider(CreateRiskPolicy()))
                .AddSingleton<IUnifiedCache, ConsumeOnceHealthCache>()
                .AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(
                    SecurityChallengeContracts.ToWireName(SecurityChallengeKind.CaptchaV1)));
            using ServiceProvider provider = services.BuildServiceProvider();
            IConfiguration configuration = CreatePerceptionReadyConfiguration();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                CreateConfigurationSnapshot(configuration, environment, provider),
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var riskControl = Assert.IsType<ProductionRiskControlHealthCheck>(report.Checks["riskControl"]);
            Assert.Equal("failed", riskControl.Status);
            Assert.False(riskControl.ChallengeProviderRegistry);
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
            IConfiguration configuration = CreatePerceptionReadyConfiguration();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                CreateConfigurationSnapshot(configuration, environment, provider),
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
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                CreateConfigurationSnapshot(configuration, environment, provider),
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

    [Fact]
    public async Task ReadinessProbe_RiskControlCheck_FailsClosedWhenConsumeOnceThrows()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            var services = new ServiceCollection()
                .AddSingleton<ISecurityRiskPolicyProvider>(new FixedRiskPolicyProvider(CreateRiskPolicy()))
                .AddSingleton<IUnifiedCache, ThrowingConsumeOnceHealthCache>();
            foreach (SecurityChallengeKind kind in SecurityChallengeContracts.SupportedKinds)
            {
                services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(SecurityChallengeContracts.ToWireName(kind)));
            }

            using ServiceProvider provider = services.BuildServiceProvider();
            IConfiguration configuration = CreatePerceptionReadyConfiguration();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                CreateConfigurationSnapshot(configuration, environment, provider),
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var riskControl = Assert.IsType<ProductionRiskControlHealthCheck>(report.Checks["riskControl"]);
            Assert.Equal("failed", riskControl.Status);
            Assert.False(riskControl.RedisConsumeOnce);
            Assert.True(riskControl.ActivePolicy);
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

    private static ConfigurationHealthSnapshot CreateConfigurationSnapshot(
        IConfiguration configuration,
        IWebHostEnvironment environment,
        IServiceProvider provider)
    {
        var snapshot = new ConfigurationHealthSnapshot(
            configuration,
            environment,
            provider,
            NullLogger<ConfigurationHealthSnapshot>.Instance);
        snapshot.Refresh();
        return snapshot;
    }

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

    private sealed class ThrowingConsumeOnceHealthCache : IUnifiedCache
    {
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("redis consume-once unavailable");

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("redis consume-once unavailable");

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

    private static RouteEndpoint FindRoute(WebApplication app, string route)
        => Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>(),
            endpoint => string.Equals(
                endpoint.RoutePattern.RawText?.TrimStart('/'),
                route.TrimStart('/'),
                StringComparison.Ordinal));

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return called;
        }
    }
}

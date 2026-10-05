using System.Collections.Frozen;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
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
    [Theory]
    [InlineData(1, 0, "failed")]
    [InlineData(0, 1, "failed")]
    [InlineData(0, 0, "ok")]
    public async Task DistributedConvergenceSnapshot_IsFailClosedForPendingOrTerminalObligations(int pending, int terminal, string expectedStatus)
    {
        string root = Path.GetTempPath();
        var services = new ServiceCollection()
            .AddSingleton<IDistributedInvalidationObligationStore>(new FixedConvergenceObligationStore(new DistributedInvalidationConvergenceSnapshot(pending, terminal, pending > 0 ? TimeSpan.FromSeconds(5) : null, pending > 0 || terminal > 0)));
        using ServiceProvider provider = services.BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var environment = new TestWebHostEnvironment(root, Environments.Development);
        var probe = new ProductionReadinessProbe(configuration, environment, provider, CreateConfigurationSnapshot(configuration, environment, provider), NullLogger<ProductionReadinessProbe>.Instance);

        ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

        DistributedConvergenceHealthCheck convergence = Assert.IsType<DistributedConvergenceHealthCheck>(report.Checks["distributedConvergence"]);
        Assert.Equal(expectedStatus, convergence.Status);
        Assert.Equal(pending, convergence.PendingCount);
        Assert.Equal(terminal, convergence.TerminalFailedCount);
    }

    [Fact]
    public async Task DistributedConvergenceSnapshot_ExposesAckGapAndLedgerAvailability()
    {
        string root = Path.GetTempPath();
        var snapshot = new DistributedInvalidationConvergenceSnapshot(
            0,
            0,
            TimeSpan.FromSeconds(7),
            true,
            AckGapCount: 3,
            LedgerAvailable: false);
        var services = new ServiceCollection()
            .AddSingleton<IDistributedInvalidationObligationStore>(
                new FixedConvergenceObligationStore(snapshot));
        using ServiceProvider provider = services.BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var environment = new TestWebHostEnvironment(root, Environments.Development);
        var probe = new ProductionReadinessProbe(
            configuration,
            environment,
            provider,
            CreateConfigurationSnapshot(configuration, environment, provider),
            NullLogger<ProductionReadinessProbe>.Instance);

        ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

        DistributedConvergenceHealthCheck convergence =
            Assert.IsType<DistributedConvergenceHealthCheck>(report.Checks["distributedConvergence"]);
        Assert.Equal("failed", convergence.Status);
        Assert.Equal(3, convergence.AckGapCount);
        Assert.False(convergence.LedgerAvailable);
        Assert.Equal(TimeSpan.FromSeconds(7), convergence.OldestPendingAge);
    }
    [Fact]
    public async Task ReadinessProbe_ExposesStableSpaAssetsFailureSnapshot()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-spa-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        File.WriteAllText(Path.Combine(root, "wwwroot", "index.html"), "<html></html>");
        try
        {
            var spaReadiness = new SpaAssetManifestReadiness(
                "failed",
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                "spa_manifest_descriptor_invalid_json");
            using ServiceProvider services = new ServiceCollection()
                .AddSingleton<ISpaAssetManifestService>(new FixedSpaAssetManifestService(spaReadiness))
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

            SpaAssetManifestReadiness snapshot = Assert.IsType<SpaAssetManifestReadiness>(report.Checks["spaAssets"]);
            Assert.Equal("failed", snapshot.Status);
            Assert.Equal("spa_manifest_descriptor_invalid_json", snapshot.Error);
            Assert.Null(snapshot.DescriptorPath);
            Assert.Null(snapshot.DescriptorContentDigest);
            Assert.Null(snapshot.BuildReceiptPath);
            Assert.Null(snapshot.BuildReceiptDigest);
            Assert.Null(snapshot.SourceCommit);
            Assert.Null(snapshot.WorktreeFingerprint);
            Assert.Null(snapshot.ReleaseId);
            Assert.Null(snapshot.AssetRoot);
            Assert.Null(snapshot.IndexPath);
            Assert.Null(snapshot.ManifestPath);
            Assert.Null(snapshot.ManifestDigest);
            Assert.Null(snapshot.AssetInventoryPath);
            Assert.Null(snapshot.AssetInventoryDigest);
            Assert.Equal("not_ready", report.Status);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ReadinessProbe_ExposesCompleteResolvedSpaAssetsSnapshot()
    {
        string digest = "sha256:" + new string('a', 64);
        var spaReadiness = new SpaAssetManifestReadiness(
            "ok",
            "/app/release-assets/release/spa-manifest-descriptor.json",
            digest,
            "/app/release-assets/release/production-build-receipt.json",
            "sha256:" + new string('b', 64),
            new string('c', 40),
            "sha256:" + new string('d', 64),
            "release",
            "/app/release-assets/release",
            "/app/release-assets/release/index.html",
            "/app/release-assets/release/.vite/manifest.json",
            "sha256:" + new string('e', 64),
            "/app/release-assets/release/asset-manifest.json",
            "sha256:" + new string('f', 64),
            null);
        using ServiceProvider services = new ServiceCollection()
            .AddSingleton<ISpaAssetManifestService>(new FixedSpaAssetManifestService(spaReadiness))
            .BuildServiceProvider();
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-spa-health-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        File.WriteAllText(Path.Combine(root, "wwwroot", "index.html"), "<html></html>");
        try
        {
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var environment = new TestWebHostEnvironment(root, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                services,
                CreateConfigurationSnapshot(configuration, environment, services),
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            SpaAssetManifestReadiness snapshot = Assert.IsType<SpaAssetManifestReadiness>(report.Checks["spaAssets"]);
            Assert.Equal(spaReadiness, snapshot);
            Assert.Equal("/app/release-assets/release/spa-manifest-descriptor.json", snapshot.DescriptorPath);
            Assert.Equal(digest, snapshot.DescriptorContentDigest);
            Assert.Equal("/app/release-assets/release/production-build-receipt.json", snapshot.BuildReceiptPath);
            Assert.Equal("sha256:" + new string('b', 64), snapshot.BuildReceiptDigest);
            Assert.Equal(new string('c', 40), snapshot.SourceCommit);
            Assert.Equal("sha256:" + new string('d', 64), snapshot.WorktreeFingerprint);
            Assert.Equal("release", snapshot.ReleaseId);
            Assert.Equal("/app/release-assets/release", snapshot.AssetRoot);
            Assert.Equal("/app/release-assets/release/index.html", snapshot.IndexPath);
            Assert.Equal("/app/release-assets/release/.vite/manifest.json", snapshot.ManifestPath);
            Assert.Equal("sha256:" + new string('e', 64), snapshot.ManifestDigest);
            Assert.Equal("/app/release-assets/release/asset-manifest.json", snapshot.AssetInventoryPath);
            Assert.Equal("sha256:" + new string('f', 64), snapshot.AssetInventoryDigest);
            Assert.Null(snapshot.Error);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

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
                ["resources"] = new ProductionResourceHealthCheck("failed", false, false, new PublicAotSsrWorkerResourceStatus("failed", true, false, null, null, null, "path"))
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
                ["currentSchema"] = new ProductionCurrentSchemaAdmissionHealthCheck(
                    "failed",
                    "schema_incompatible",
                    new string('a', 64),
                    new string('b', 40),
                    new string('c', 64),
                    new string('d', 64),
                    "current_schema_admission_observation_changed")
            });

        IReadOnlyDictionary<string, object?> report = ProductionReadinessPublicReport.Create(detailed);
        string json = System.Text.Json.JsonSerializer.Serialize(report);

        Assert.Equal(["checkedAt", "code", "status"], report.Keys.OrderBy(static key => key, StringComparer.Ordinal).ToArray());
        Assert.Equal("schema_incompatible", report["code"]);
        Assert.DoesNotContain("current_schema_admission_observation_changed", json, StringComparison.Ordinal);
        Assert.DoesNotContain(new string('a', 64), json, StringComparison.Ordinal);
        Assert.DoesNotContain(new string('b', 40), json, StringComparison.Ordinal);
        Assert.DoesNotContain(new string('c', 64), json, StringComparison.Ordinal);
        Assert.DoesNotContain(new string('d', 64), json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentSchemaReadiness_RejectsMissingStartupAdmissionEvenWhenLegacyReportIsReady(bool registerEmptyCurrentState)
    {
        // Untrusted status metadata cannot substitute for the current startup
        // admission. No retired production compatibility publisher is retained.
        var legacy = new
        {
            Status = "ready", ReleaseId = "legacy-release", SchemaCoordinate = "legacy-coordinate"
        };
        var registrations = new ServiceCollection().AddSingleton(legacy);
        if (registerEmptyCurrentState)
        {
            registrations.AddSingleton<CurrentSchemaAdmissionState>();
        }
        using ServiceProvider provider = registrations.BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var environment = new TestWebHostEnvironment(Path.GetTempPath(), Environments.Production);
        var probe = new ProductionReadinessProbe(
            configuration, environment, provider, CreateConfigurationSnapshot(configuration, environment, provider),
            NullLogger<ProductionReadinessProbe>.Instance);

        ProductionCurrentSchemaAdmissionHealthCheck check = await probe.CheckCurrentSchemaAdmissionAsync(CancellationToken.None);

        Assert.Equal("failed", check.Status);
        Assert.Equal("schema_incompatible", check.PublicErrorCode);
        Assert.Equal("current_schema_admission_unavailable", check.Error);
        Assert.Null(check.ArtifactSha256);
        Assert.Null(check.CandidateSourceRevision);
        Assert.Null(check.TargetContentDigest);
        Assert.Null(check.ActualSchemaDigest);
    }

    [Theory]
    [InlineData("candidate", "current_schema_admission_binding_mismatch")]
    [InlineData("configured-source", "current_schema_admission_binding_mismatch")]
    [InlineData("artifact", "current_schema_admission_binding_mismatch")]
    [InlineData("missing-release", "current_schema_admission_binding_mismatch")]
    [InlineData("missing-observer", "current_schema_admission_failed")]
    public async Task CurrentSchemaReadiness_MetadataOrUnissuedStateNeverSubstitutesForFreshObserver(string invalid, string expectedError)
    {
        string source = new('a', 40);
        string artifact = new('b', 64);
        var values = new Dictionary<string, string?>
        {
            ["Release:Id"] = "20261003010101-aaaaaaaaaaaa",
            ["Release:Slot"] = "green",
            ["Release:CommitSha"] = source,
            ["Release:ImageRef"] = "registry.example/fsusblog@sha256:" + new string('c', 64),
            ["Release:ImageDigest"] = "sha256:" + new string('c', 64),
            ["SchemaMigration:CurrentReceipt:CandidateSourceRevision"] = source,
            ["SchemaMigration:CurrentReceipt:Sha256"] = artifact,
            ["SchemaMigration:CurrentReceipt:Path"] = Path.Combine(Path.GetTempPath(), "unissued.json")
        };
        if (invalid == "configured-source")
        {
            values["SchemaMigration:CurrentReceipt:CandidateSourceRevision"] = new string('d', 40);
        }
        if (invalid == "artifact")
        {
            values["SchemaMigration:CurrentReceipt:Sha256"] = new string('d', 64);
        }
        if (invalid == "missing-release")
        {
            values["Release:Id"] = null;
        }
        var startup = new CurrentSchemaAdmissionState();
        // Deliberately unissued/corrupt test input, never a production receipt or positive readiness proof.
        startup.Publish(new CurrentSchemaAdmissionResult(null!, invalid == "candidate" ? new string('d', 40) : source, artifact));
        using ServiceProvider provider = new ServiceCollection().AddSingleton(startup).BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var environment = new TestWebHostEnvironment(Path.GetTempPath(), Environments.Production);
        var probe = new ProductionReadinessProbe(
            configuration, environment, provider, CreateConfigurationSnapshot(configuration, environment, provider),
            NullLogger<ProductionReadinessProbe>.Instance);

        ProductionCurrentSchemaAdmissionHealthCheck check = await probe.CheckCurrentSchemaAdmissionAsync(CancellationToken.None);

        Assert.Equal("failed", check.Status);
        Assert.Equal("schema_incompatible", check.PublicErrorCode);
        Assert.Equal(expectedError, check.Error);
        Assert.Null(check.ArtifactSha256);
    }

    [Fact]
    public async Task CurrentSchemaReadiness_CancellationPrecedesStateOrDatabaseObservation()
    {
        using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        IConfiguration configuration = new ConfigurationBuilder().Build();
        var environment = new TestWebHostEnvironment(Path.GetTempPath(), Environments.Production);
        var probe = new ProductionReadinessProbe(
            configuration, environment, provider, CreateConfigurationSnapshot(configuration, environment, provider),
            NullLogger<ProductionReadinessProbe>.Instance);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => probe.CheckCurrentSchemaAdmissionAsync(cancellation.Token));
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
            "s_readinessSnapshotTtl",
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
    public async Task ResourceReadiness_RequiresOnlyRuntimeOwnedResources()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        string resourceDir = Path.Combine(tempRoot, "wwwroot", "resources");
        Directory.CreateDirectory(resourceDir);
        File.WriteAllText(Path.Combine(tempRoot, "wwwroot", "index.html"), "<html></html>");

        try
        {
            using ServiceProvider services = new ServiceCollection().BuildServiceProvider();
            IConfiguration configuration = new ConfigurationBuilder().Build();
            var environment = new TestWebHostEnvironment(tempRoot, Environments.Development);
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                services,
                CreateConfigurationSnapshot(configuration, environment, services),
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);
            ProductionResourceHealthCheck resources =
                Assert.IsType<ProductionResourceHealthCheck>(report.Checks["resources"]);
            string json = System.Text.Json.JsonSerializer.Serialize(resources);

            Assert.Equal("ok", resources.Status);
            Assert.True(resources.WebRootExists);
            Assert.True(resources.IndexExists);
            Assert.DoesNotContain("ip2", json, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void RuntimeSourceAndDependencies_HaveNoUnownedIpGeolocationResource()
    {
        string backendRoot = Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend");
        IEnumerable<string> runtimeFiles = Directory
            .EnumerateFiles(backendRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Append(Path.Combine(backendRoot, "FsusBlog.Server.csproj"))
            .Append(Path.Combine(backendRoot, "packages.lock.json"));

        foreach (string path in runtimeFiles)
        {
            string content = File.ReadAllText(path);
            Assert.DoesNotContain("IP2Location", content, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("IP2LOCATION.BIN", content, StringComparison.OrdinalIgnoreCase);
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
                .AddReadinessCache<ConsumeOnceHealthCache>();
            services.AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(
                SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3)));

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
                .AddReadinessCache<ConsumeOnceHealthCache>()
                .AddSingleton<ISecurityChallengeProvider>(new HealthChallengeProvider(
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
                .AddReadinessCache<ConsumeOnceHealthCache>();
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
                .AddReadinessCache<ConsumeOnceHealthCache>();
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
                .AddReadinessCache<ThrowingConsumeOnceHealthCache>();
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

    [Fact]
    public void ChallengeProviderRegistryReady_AcceptsOrderedTwoMemberAndSingleMemberPolicies()
    {
        string pow = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1);
        string poSpace = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1);
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);

        SecurityRiskPolicySnapshotV2 ordered = CreateRiskPolicyWithChallengeSet(
            SecurityChallengeCapabilityCatalog.NotificationSubscribeAction,
            [pow, poSpace]);

        Assert.True(ProductionReadinessProbe.ChallengeProviderRegistryReady([pow, poSpace], ordered));
        Assert.True(ProductionReadinessProbe.ChallengeProviderRegistryReady([characterChallenge], CreateRiskPolicy()));
    }

    [Fact]
    public void ChallengeProviderRegistryReady_FailsWhenAnyOrderedMemberIsUnavailable()
    {
        string pow = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1);
        string poSpace = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1);
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);
        string unavailable = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1);
        SecurityRiskPolicySnapshotV2 missingProvider = CreateRiskPolicyWithChallengeSet(
            SecurityChallengeCapabilityCatalog.NotificationSubscribeAction,
            [pow, poSpace]);
        SecurityRiskPolicySnapshotV2 unavailableCapability = CreateRiskPolicyWithChallengeSet(
            RiskActionNames.CommentCreate,
            [characterChallenge, unavailable]);

        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady([pow], missingProvider));
        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady([characterChallenge, unavailable], unavailableCapability));
    }

    [Fact]
    public void ChallengeProviderRegistryReady_RejectsDuplicateOverLimitAndNoncanonicalSets()
    {
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);
        string pow = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1);
        SecurityRiskPolicySnapshotV2 duplicate = CreateRiskPolicyWithChallengeSet(
            RiskActionNames.CommentCreate,
            [characterChallenge, characterChallenge]);
        SecurityRiskPolicySnapshotV2 overLimit = CreateRiskPolicyWithChallengeSet(
            RiskActionNames.CommentCreate,
            Enumerable.Repeat(characterChallenge, SecurityChallengeContracts.MaxAssignmentsPerEnvelope + 1).ToArray());
        SecurityRiskPolicySnapshotV2 noncanonical = CreateRiskPolicyWithChallengeSet(
            SecurityChallengeCapabilityCatalog.NotificationSubscribeAction,
            ["security.pow"]);

        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady([characterChallenge], duplicate));
        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady([characterChallenge], overLimit));
        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady([pow], noncanonical));
    }

    [Fact]
    public void ChallengeProviderRegistryReady_DefaultPolicyMatchesCharacterProviderRegistration()
    {
        string[] providersWithoutCharacter =
        [
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.HumanReadProofV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PasskeyStepUpV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionLocalizationV2),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionMicroInteractionV2)
        ];
        var disabled = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var enabled = new SecurityAdminPolicyService(
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Security:PerceptionCharacterV3:Enabled"] = SecuritySystemModes.Enforce
                })
                .Build());

        Assert.True(ProductionReadinessProbe.ChallengeProviderRegistryReady(
            providersWithoutCharacter,
            disabled.CurrentRiskPolicyV2));
        Assert.False(ProductionReadinessProbe.ChallengeProviderRegistryReady(
            providersWithoutCharacter,
            enabled.CurrentRiskPolicyV2));
        string[] providersWithCharacter =
        [
            .. providersWithoutCharacter,
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3)
        ];
        foreach (SecurityRiskActionPolicy action in enabled.CurrentRiskPolicyV2.ActionOverrides.Values
            .Prepend(enabled.CurrentRiskPolicyV2.DefaultAction))
        {
            Assert.True(
                ProductionReadinessProbe.ChallengeProviderRegistryReady(
                    providersWithCharacter,
                    enabled.CurrentRiskPolicyV2 with
                    {
                        DefaultAction = action,
                        ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
                    }),
                action.ActionName);
        }

        Assert.True(ProductionReadinessProbe.ChallengeProviderRegistryReady(
            providersWithCharacter,
            enabled.CurrentRiskPolicyV2));
    }

    [Fact]
    public void ChallengeProviderRegistryReady_DisabledCharacterPolicyRemainsExecutableAcrossPolicyLifecycle()
    {
        string[] providersWithoutCharacter =
        [
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.HumanReadProofV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PasskeyStepUpV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionLocalizationV2),
            SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionMicroInteractionV2)
        ];
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        AssertExecutable(service.CurrentRiskPolicyV2);
        service.UpdateRiskControlPolicy(
            new RiskControlPolicyUpdateRequest(
                SecuritySystemModes.Observe,
                PoSpaceV1Enabled: false,
                PublicReadChallengeEnabled: true,
                CommentRiskControlEnabled: true,
                AuthRiskControlEnabled: true,
                StrictRiskMultiplierPercent: 125,
                Reason: "lifecycle-test"),
            "test");
        AssertExecutable(service.CurrentRiskPolicyV2);
        service.RollbackRiskControlPolicy("test");
        AssertExecutable(service.CurrentRiskPolicyV2);
        service.UpdatePerceptionSealedV2Policy(
            new PerceptionSealedV2PolicyUpdateRequest(
                Enabled: true,
                LocalizationEnabled: true,
                MicroInteractionEnabled: true,
                PoSpaceFallbackEnabled: false,
                EarlyRejectThreshold: 85,
                MaxAttempts: 4,
                MinSolveDurationMs: 1000,
                MaxSolveDurationMs: 45000,
                Reason: "lifecycle-test"),
            "test");
        AssertExecutable(service.CurrentRiskPolicyV2);
        service.RollbackPerceptionSealedV2Policy("test");
        AssertExecutable(service.CurrentRiskPolicyV2);

        void AssertExecutable(SecurityRiskPolicySnapshotV2 policy)
        {
            Assert.True(ProductionReadinessProbe.ChallengeProviderRegistryReady(
                providersWithoutCharacter,
                policy));
            Assert.DoesNotContain(
                policy.ActionOverrides.Values.Prepend(policy.DefaultAction)
                    .SelectMany(static action => action.DecisionBands)
                    .SelectMany(static band => band.ChallengeKinds),
                static kind => string.Equals(
                    kind,
                    SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3),
                    StringComparison.Ordinal));
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
                SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3),
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

    private static SecurityRiskPolicySnapshotV2 CreateRiskPolicyWithChallengeSet(
        string actionName,
        IReadOnlyList<string> challengeKinds)
    {
        SecurityRiskPolicySnapshotV2 policy = CreateRiskPolicy();
        SecurityRiskActionPolicy action = policy.DefaultAction with
        {
            ActionName = actionName,
            ChallengeKind = challengeKinds[0],
            HardChallengeKinds = challengeKinds
        };
        return policy with
        {
            DefaultAction = action
        };
    }

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

    private sealed class FixedConvergenceObligationStore(DistributedInvalidationConvergenceSnapshot snapshot) : IDistributedInvalidationObligationStore
    {
        public Task<DistributedInvalidationConvergenceObligation> UpsertAsync(DistributedInvalidationPublishResult publishResult, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
        public Task<DistributedInvalidationConvergenceSnapshot> SnapshotAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);
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

    private sealed class FixedSpaAssetManifestService(SpaAssetManifestReadiness readiness) : ISpaAssetManifestService
    {
        public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null) => [];

        public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
            => new("/assets/fsus-spa-entry.js", [], [], "missing-manifest", UsesSourceAssets: false);

        public string GetFrontendAssetVersion(HttpContext? context = null) => "missing-manifest";

        public SpaAssetManifestReadiness GetReadiness() => readiness;
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

internal static class ReadinessCacheTestServiceCollectionExtensions
{
    internal static IServiceCollection AddReadinessCache<T>(this IServiceCollection services)
        where T : class, ICacheStringWriter, ICacheOneTimeStore
    {
        services.AddSingleton<T>();
        services.AddSingleton<ICacheStringWriter>(static provider => provider.GetRequiredService<T>());
        services.AddSingleton<ICacheOneTimeStore>(static provider => provider.GetRequiredService<T>());
        return services;
    }
}

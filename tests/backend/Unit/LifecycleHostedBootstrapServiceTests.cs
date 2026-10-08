using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

using NSubstitute;
namespace FsusBlog.Server.Tests;

public sealed class LifecycleHostedBootstrapServiceTests
{
    [Theory]
    [InlineData("Development", "")]
    [InlineData("Development", "relative/receipt.json")]
    [InlineData("Production", "")]
    [InlineData("Production", "relative/receipt.json")]
    public async Task RealHost_DoesNotStartBusinessServicesAfterActualReceiptRefusal(string environmentName, string receiptPath)
    {
        string root = CreateTempRoot();
        try
        {
            // A real host is the oracle for Development exception swallowing. The
            // normal control keeps the original non-receipt bootstrap behavior;
            // it is not a valid native-schema/receipt acceptance fixture.
            using ServiceProvider controlServices = CreateServices(out _, out _, out _);
            var controlProbe = new BusinessHostProbe();
            var controlBootstrap = new LifecycleHostedBootstrapService(controlServices,
                new TestWebHostEnvironment(root) { EnvironmentName = environmentName }, new StartupRuntimeState(),
                Options.Create(new LifecycleBootstrapOptions()), Substitute.For<ILogger<LifecycleHostedBootstrapService>>());
            using (IHost controlHost = new HostBuilder().ConfigureServices((_, services) =>
            {
                services.AddSingleton<IHostedService>(controlBootstrap);
                services.AddSingleton<IHostedService>(controlProbe);
            }).Build())
            {
                await controlHost.StartAsync();
                Assert.Equal(1, controlProbe.Starts);
                await controlHost.StopAsync();
            }

            // Confirm the production refusal precondition through its real API.
            // No DB client exists: these explicit-path cases must fail before access.
            InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchemaReceiptAdmission.VerifyAsync(receiptPath, new string('a', 64), new string('a', 40),
                    null!, null!, CancellationToken.None));
            Assert.Equal("current_schema_explicit_receipt_required", refusal.Message);
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["SchemaMigration:CurrentReceipt:Path"] = receiptPath }).Build();
            var admissionState = new CurrentSchemaAdmissionState();
            var actualRunner = new CurrentSchemaStartupVerifier(null!, null!, configuration, admissionState);
            var downstreamGate = Substitute.For<IAccountSubjectHashInvariantGate>();
            using ServiceProvider refusingServices = new ServiceCollection()
                .AddSingleton<ISchemaMigrationRunner>(actualRunner)
                .AddSingleton(downstreamGate)
                .BuildServiceProvider();
            var runtimeState = new StartupRuntimeState();
            var businessProbe = new BusinessHostProbe();
            var bootstrap = new LifecycleHostedBootstrapService(refusingServices,
                new TestWebHostEnvironment(root) { EnvironmentName = environmentName }, runtimeState,
                Options.Create(new LifecycleBootstrapOptions()), Substitute.For<ILogger<LifecycleHostedBootstrapService>>());
            using IHost host = new HostBuilder().ConfigureServices((_, services) =>
            {
                services.AddSingleton<IHostedService>(bootstrap);
                services.AddSingleton<IHostedService>(businessProbe);
            }).Build();

            CurrentSchemaAdmissionException error = await Assert.ThrowsAsync<CurrentSchemaAdmissionException>(() => host.StartAsync());

            Assert.Equal("current_schema_receipt_admission_failed", error.Message);
            Assert.Equal(0, businessProbe.Starts);
            Assert.Null(admissionState.Current);
            await downstreamGate.DidNotReceive().EnsureAsync(Arg.Any<CancellationToken>());
            Assert.Equal("failed", runtimeState.GetStartupTasks()["schemaMigration"].Status);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["bootstrap"].Status);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_DoesNotClearAotDiskCache_WhenOptionDisabled()
    {
        string root = CreateTempRoot();
        try
        {
            string aotCacheDir = CreateAotCacheDir(root, "stale.txt");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer);
            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions()),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.True(File.Exists(Path.Combine(aotCacheDir, "stale.txt")));
            Assert.False(runtimeState.SystemCachesClearedOnStartup);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["schemaMigration"].Status);
            Assert.Equal("compatibility_check", runtimeState.GetStartupTasks()["schemaMigration"].Detail);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["accountSubjectHashInvariant"].Status);
            Assert.Equal("physical_projection_complete", runtimeState.GetStartupTasks()["accountSubjectHashInvariant"].Detail);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["passkeyProjectionInvariant"].Status);
            Assert.Equal("credential_fact_projection_consistent", runtimeState.GetStartupTasks()["passkeyProjectionInvariant"].Detail);
            Assert.Equal("skipped", runtimeState.GetStartupTasks()["bootstrapRollback"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["searchIndex"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["cacheInitializer"].Status);
            Assert.Equal("no_entries", runtimeState.GetStartupTasks()["cacheInitializer"].Detail);
            Assert.Equal("skipped", runtimeState.GetStartupTasks()["aotDiskCache"].Status);
            Assert.Equal("disabled", runtimeState.GetStartupTasks()["aotDiskCache"].Detail);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["bootstrap"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_ClearsAotDiskCache_WhenOptionEnabled()
    {
        string root = CreateTempRoot();
        try
        {
            string aotCacheDir = CreateAotCacheDir(root, "stale.txt");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer);
            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions { ClearAotDiskCacheOnStartup = true }),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.True(Directory.Exists(aotCacheDir));
            Assert.Empty(Directory.GetFileSystemEntries(aotCacheDir));
            Assert.True(runtimeState.SystemCachesClearedOnStartup);
            Assert.Equal("skipped", runtimeState.GetStartupTasks()["bootstrapRollback"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["aotDiskCache"].Status);
            Assert.Equal("cleared", runtimeState.GetStartupTasks()["aotDiskCache"].Detail);
            Assert.Equal("compatibility_check", runtimeState.GetStartupTasks()["schemaMigration"].Detail);
            Assert.Equal("no_entries", runtimeState.GetStartupTasks()["cacheInitializer"].Detail);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["bootstrap"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_ChecksPhysicalAccountSubjectProjectionAfterSchemaMigration()
    {
        string root = CreateTempRoot();
        try
        {
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer);
            var invariantGate = services.GetRequiredService<IAccountSubjectHashInvariantGate>();
            var passkeyProjection = services.GetRequiredService<IPasskeyProjectionConsistencyService>();
            var order = new List<string>();
            migrationRunner.RunAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                order.Add("migration");
                return Task.CompletedTask;
            });
            invariantGate.EnsureAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                order.Add("invariant");
                return Task.CompletedTask;
            });
            passkeyProjection.EnsureAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                order.Add("passkey-projection");
                return Task.CompletedTask;
            });

            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions()),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.Equal("ok", runtimeState.GetStartupTasks()["schemaMigration"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["accountSubjectHashInvariant"].Status);
            Assert.Equal("physical_projection_complete", runtimeState.GetStartupTasks()["accountSubjectHashInvariant"].Detail);
            Assert.Equal(["migration", "invariant", "passkey-projection"], order);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["searchIndex"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await invariantGate.Received(1).EnsureAsync(Arg.Any<CancellationToken>());
            await passkeyProjection.Received(1).EnsureAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_RestoresAotDiskCache_WhenLaterTaskFails()
    {
        string root = CreateTempRoot();
        try
        {
            string aotCacheDir = CreateAotCacheDir(root, "stale.txt");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer,
                failCacheInitializer: true);
            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions { ClearAotDiskCacheOnStartup = true }),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.True(File.Exists(Path.Combine(aotCacheDir, "stale.txt")));
            Assert.False(runtimeState.SystemCachesClearedOnStartup);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["schemaMigration"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["searchIndex"].Status);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["cacheInitializer"].Status);
            Assert.Equal("InvalidOperationException", runtimeState.GetStartupTasks()["cacheInitializer"].Detail);
            Assert.Equal("rolled_back", runtimeState.GetStartupTasks()["aotDiskCache"].Status);
            Assert.Equal("restored_after_failure", runtimeState.GetStartupTasks()["aotDiskCache"].Detail);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["bootstrapRollback"].Status);
            Assert.Equal("restored:1", runtimeState.GetStartupTasks()["bootstrapRollback"].Detail);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["bootstrap"].Status);
            Assert.Equal("InvalidOperationException", runtimeState.GetStartupTasks()["bootstrap"].Detail);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_RestoresSearchIndexArtifacts_WhenLaterTaskFails()
    {
        string root = CreateTempRoot();
        try
        {
            string searchRoot = CreateSearchIndexDir(root, "stale.manifest", "old-index");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer,
                failCacheInitializer: true);
            searchIndexService.BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>()).Returns(_ =>
            {
                Directory.CreateDirectory(searchRoot);
                File.WriteAllText(Path.Combine(searchRoot, "fresh.manifest"), "new-index");
                return Task.CompletedTask;
            });

            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions()),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.True(File.Exists(Path.Combine(searchRoot, "stale.manifest")));
            Assert.False(File.Exists(Path.Combine(searchRoot, "fresh.manifest")));
            Assert.Equal("ok", runtimeState.GetStartupTasks()["schemaMigration"].Status);
            Assert.Equal("rolled_back", runtimeState.GetStartupTasks()["searchIndex"].Status);
            Assert.Equal("restored_after_failure", runtimeState.GetStartupTasks()["searchIndex"].Detail);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["cacheInitializer"].Status);
            Assert.Equal("ok", runtimeState.GetStartupTasks()["bootstrapRollback"].Status);
            Assert.Equal("restored:1", runtimeState.GetStartupTasks()["bootstrapRollback"].Detail);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["bootstrap"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_KeepsExistingSearchArtifactsVisible_DuringSearchIndexBuild()
    {
        string root = CreateTempRoot();
        try
        {
            string searchRoot = CreateSearchIndexDir(root, "index.manifest.aeds", "stale-manifest");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer);

            searchIndexService.BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>()).Returns(_ =>
            {
                Assert.True(File.Exists(Path.Combine(searchRoot, "index.manifest.aeds")));
                return Task.CompletedTask;
            });

            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions()),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.Equal("ok", runtimeState.GetStartupTasks()["searchIndex"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.Received(1).BuildIndexAsync(Arg.Is<List<FsusBlog.Server.Entities.Article>>(items => items.Count == 0));
            await cacheInitializer.Received(1).InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_StopsRemainingTasks_WhenSchemaMigrationFails()
    {
        string root = CreateTempRoot();
        try
        {
            string aotCacheDir = CreateAotCacheDir(root, "stale.txt");
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer,
                failMigrationRunner: true);
            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions { ClearAotDiskCacheOnStartup = true }),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            Assert.True(File.Exists(Path.Combine(aotCacheDir, "stale.txt")));
            Assert.False(runtimeState.SystemCachesClearedOnStartup);

            IReadOnlyDictionary<string, StartupLifecycleTaskReport> tasks = runtimeState.GetStartupTasks();
            Assert.Equal("failed", tasks["schemaMigration"].Status);
            Assert.Equal("InvalidOperationException", tasks["schemaMigration"].Detail);
            Assert.False(tasks.ContainsKey("aotDiskCache"));
            Assert.False(tasks.ContainsKey("searchIndex"));
            Assert.False(tasks.ContainsKey("cacheInitializer"));
            Assert.Equal("skipped", tasks["bootstrapRollback"].Status);
            Assert.Equal("none_registered", tasks["bootstrapRollback"].Detail);
            Assert.Equal("failed", tasks["bootstrap"].Status);
            Assert.Equal("InvalidOperationException", tasks["bootstrap"].Detail);

            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.DidNotReceive().BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>());
            await cacheInitializer.DidNotReceive().InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_StopsRemainingTasks_WhenAccountSubjectProjectionIsIncomplete()
    {
        string root = CreateTempRoot();
        try
        {
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out ISchemaMigrationRunner migrationRunner,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer);
            var invariantGate = services.GetRequiredService<IAccountSubjectHashInvariantGate>();
            invariantGate.EnsureAsync(Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromException(new InvalidOperationException("projection incomplete")));
            var service = new LifecycleHostedBootstrapService(
                services,
                new TestWebHostEnvironment(root),
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions { ClearAotDiskCacheOnStartup = true }),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>());

            await service.StartAsync(CancellationToken.None);

            IReadOnlyDictionary<string, StartupLifecycleTaskReport> tasks = runtimeState.GetStartupTasks();
            Assert.Equal("ok", tasks["schemaMigration"].Status);
            Assert.Equal("failed", tasks["accountSubjectHashInvariant"].Status);
            Assert.Equal("InvalidOperationException", tasks["accountSubjectHashInvariant"].Detail);
            Assert.False(tasks.ContainsKey("aotDiskCache"));
            Assert.False(tasks.ContainsKey("searchIndex"));
            Assert.False(tasks.ContainsKey("cacheInitializer"));
            Assert.Equal("failed", tasks["bootstrap"].Status);
            await migrationRunner.Received(1).RunAsync(Arg.Any<CancellationToken>());
            await searchIndexService.DidNotReceive().BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>());
            await cacheInitializer.DidNotReceive().InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task StartAsync_ProductionRejectsConflictingConfiguredAndStoredPublicOrigins()
    {
        string root = CreateTempRoot();
        try
        {
            var runtimeState = new StartupRuntimeState();
            ServiceProvider services = CreateServices(
                out _,
                out ISearchIndexService searchIndexService,
                out ICacheInitializer cacheInitializer,
                storedBaseUrl: "https://stored.example");
            var environment = new TestWebHostEnvironment(root)
            {
                EnvironmentName = Environments.Production
            };
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Seo:BaseUrl"] = "https://public.example"
                })
                .Build();
            var service = new LifecycleHostedBootstrapService(
                services,
                environment,
                runtimeState,
                Options.Create(new LifecycleBootstrapOptions()),
                Substitute.For<ILogger<LifecycleHostedBootstrapService>>(),
                configuration: configuration);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                service.StartAsync(CancellationToken.None));

            Assert.StartsWith("public_origin_conflict:", error.Message, StringComparison.Ordinal);
            Assert.Equal("failed", runtimeState.GetStartupTasks()["publicOrigin"].Status);
            Assert.False(runtimeState.GetStartupTasks().ContainsKey("searchIndex"));
            await searchIndexService.DidNotReceive().BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>());
            await cacheInitializer.DidNotReceive().InitializeAsync();
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static ServiceProvider CreateServices(
        out ISchemaMigrationRunner migrationRunner,
        out ISearchIndexService searchIndexService,
        out ICacheInitializer cacheInitializer,
        bool failCacheInitializer = false,
        bool failMigrationRunner = false,
        string storedBaseUrl = FsusBlog.Shared.Contracts.Outputs.PublicSiteIdentityDefaults.SiteBaseUrl)
    {
        migrationRunner = Substitute.For<ISchemaMigrationRunner>();
        migrationRunner.RunAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            if (failMigrationRunner)
            {
                throw new InvalidOperationException("migration failed");
            }

            return Task.CompletedTask;
        });

        searchIndexService = Substitute.For<ISearchIndexService>();
        searchIndexService.BuildIndexAsync(Arg.Any<List<FsusBlog.Server.Entities.Article>>()).Returns(Task.CompletedTask);

        cacheInitializer = Substitute.For<ICacheInitializer>();
        cacheInitializer.InitializeAsync().Returns(_ =>
        {
            if (failCacheInitializer)
            {
                throw new InvalidOperationException("cache init failed");
            }

            return Task.FromResult(CacheInitializationResult.Empty);
        });
        cacheInitializer.RollbackAsync(Arg.Any<CacheInitializationResult>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var invariantGate = Substitute.For<IAccountSubjectHashInvariantGate>();
        invariantGate.EnsureAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        var passkeyProjection = Substitute.For<IPasskeyProjectionConsistencyService>();
        passkeyProjection.EnsureAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        var systemService = Substitute.For<ISystemService>();
        systemService.GetSeoConfigAsync().Returns(Task.FromResult(new FsusBlog.Server.Models.ReadModels.SeoConfigReadModel
        {
            BaseUrl = storedBaseUrl
        }));

        var services = new ServiceCollection();
        services.AddSingleton(migrationRunner);
        services.AddSingleton(invariantGate);
        services.AddSingleton(passkeyProjection);
        services.AddSingleton(searchIndexService);
        services.AddSingleton(cacheInitializer);
        services.AddSingleton(systemService);
        return services.BuildServiceProvider();
    }

    private static string CreateTempRoot()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-lifecycle-bootstrap-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        return root;
    }

    private static string CreateAotCacheDir(string root, string fileName)
    {
        string aotCacheDir = Path.Combine(root, "wwwroot", "aot-cache");
        Directory.CreateDirectory(aotCacheDir);
        File.WriteAllText(Path.Combine(aotCacheDir, fileName), "stale");
        return aotCacheDir;
    }

    private static string CreateSearchIndexDir(string root, string fileName, string content)
    {
        string searchRoot = Path.Combine(root, "wwwroot", "search");
        Directory.CreateDirectory(searchRoot);
        File.WriteAllText(Path.Combine(searchRoot, fileName), content);
        return searchRoot;
    }

    private sealed class BusinessHostProbe : IHostedService
    {
        public int Starts { get; private set; }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            Starts++;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = Environments.Development;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

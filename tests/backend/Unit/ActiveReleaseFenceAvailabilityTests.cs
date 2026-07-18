using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ActiveReleaseFenceAvailabilityTests
{
    private static readonly DateTimeOffset s_baseline = new(2026, 7, 15, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ProductionStartup_UnreachableDurableWitness_FailsBeforeServing()
    {
        ActiveReleaseFenceRuntimeSnapshot unavailable = Unavailable(s_baseline);
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.Current.Returns(unavailable);
        fence.RefreshAsync(true, Arg.Any<CancellationToken>()).Returns(unavailable);
        IWebHostEnvironment environment = Environment(Environments.Production);
        var runtime = new StartupRuntimeState();
        var service = new ActiveReleaseFenceStartupValidationHostedService(
            fence,
            environment,
            runtime,
            NullLogger<ActiveReleaseFenceStartupValidationHostedService>.Instance);

        ActiveReleaseFenceStartupException error = await Assert.ThrowsAsync<ActiveReleaseFenceStartupException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Equal("active_release_fence_durable_witness_unavailable", error.ErrorCode);
        Assert.Equal(
            "failed",
            runtime.CreateSnapshot().Tasks[ActiveReleaseFenceStartupValidationHostedService.TaskName].Status);
    }

    [Fact]
    public async Task ProductionStartup_DurableWitnessReachable_AllowsRedisDegradedRead()
    {
        ActiveReleaseFenceRuntimeSnapshot reachable = Reachable(s_baseline);
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.Current.Returns(reachable);
        fence.RefreshAsync(true, Arg.Any<CancellationToken>()).Returns(reachable);
        var runtime = new StartupRuntimeState();
        var service = new ActiveReleaseFenceStartupValidationHostedService(
            fence,
            Environment(Environments.Production),
            runtime,
            NullLogger<ActiveReleaseFenceStartupValidationHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);

        Assert.Equal(
            "completed",
            runtime.CreateSnapshot().Tasks[ActiveReleaseFenceStartupValidationHostedService.TaskName].Status);
    }

    [Fact]
    public async Task RefreshWorker_ConfiguredSixFailures_RequestsGracefulProductionShutdown()
    {
        var clock = new ManualTimeProvider(s_baseline);
        ActiveReleaseFenceRuntimeSnapshot current = Reachable(s_baseline);
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.Current.Returns(_ => current);
        fence.RefreshAsync(true, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            current = Unavailable(clock.GetUtcNow());
            return Task.FromResult(current);
        });
        IConfiguration configuration = Configuration(refreshIntervalMs: 5000, staleThresholdSeconds: 30);
        IWebHostEnvironment environment = Environment(Environments.Production);
        IHostApplicationLifetime lifetime = Substitute.For<IHostApplicationLifetime>();
        var worker = new ActiveReleaseFenceRefreshWorker(
            fence,
            configuration,
            clock,
            environment,
            lifetime,
            NullLogger<ActiveReleaseFenceRefreshWorker>.Instance);

        for (int failure = 1; failure < 6; failure++)
        {
            clock.Advance(TimeSpan.FromSeconds(5));
            Assert.True(await worker.RefreshOnceAsync(CancellationToken.None));
            lifetime.DidNotReceive().StopApplication();
        }
        clock.Advance(TimeSpan.FromSeconds(5));

        Assert.False(await worker.RefreshOnceAsync(CancellationToken.None));
        lifetime.Received(1).StopApplication();
    }

    [Fact]
    public void ProductionValidation_RequiresBoundedCoherentFenceAvailabilitySettings()
    {
        IReadOnlyList<string> missing = ProductionStartupValidator.ValidateCore(
            new ConfigurationBuilder().AddInMemoryCollection().Build(),
            enforceProductionRules: true);
        IReadOnlyList<string> outOfRange = ProductionStartupValidator.ValidateCore(
            Configuration(refreshIntervalMs: 99, staleThresholdSeconds: 4),
            enforceProductionRules: true);
        IReadOnlyList<string> incoherent = ProductionStartupValidator.ValidateCore(
            Configuration(refreshIntervalMs: 30_000, staleThresholdSeconds: 5),
            enforceProductionRules: true);

        Assert.Contains(missing, error => error.Contains(
            $"{ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey} is required",
            StringComparison.Ordinal));
        Assert.Contains(missing, error => error.Contains(
            $"{ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey} is required",
            StringComparison.Ordinal));
        Assert.Contains(outOfRange, error => error.Contains(
            $"{ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey} must be an integer",
            StringComparison.Ordinal));
        Assert.Contains(outOfRange, error => error.Contains(
            $"{ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey} must be an integer",
            StringComparison.Ordinal));
        Assert.Contains(incoherent, error => error.Contains("must not be shorter", StringComparison.Ordinal));
        Assert.True(ProductionStartupValidator.HasSecurityCriticalStartupError(
            [$"{ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey} is required."]));
    }

    [Fact]
    public void AvailabilityWindow_ReloadsDynamicConfigurationWithoutFixedFailureCount()
    {
        IConfigurationRoot configuration = Configuration(
            refreshIntervalMs: 5000,
            staleThresholdSeconds: 30);

        Assert.Equal(6, ActiveReleaseFenceAvailabilityPolicy.FailuresBeforeShutdown(configuration));

        configuration[ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey] = "10";

        Assert.Equal(2, ActiveReleaseFenceAvailabilityPolicy.FailuresBeforeShutdown(configuration));
    }

    [Fact]
    public void Hosting_OrdersStartupProbeBeforePeriodicRefresh()
    {
        var services = new ServiceCollection();

        services.AddActiveReleaseFencing();

        List<Type?> hostedTypes = services
            .Where(static descriptor => descriptor.ServiceType == typeof(IHostedService))
            .Select(static descriptor => descriptor.ImplementationType)
            .ToList();
        int startupIndex = hostedTypes.IndexOf(typeof(ActiveReleaseFenceStartupValidationHostedService));
        int refreshIndex = hostedTypes.IndexOf(typeof(ActiveReleaseFenceRefreshWorker));
        Assert.True(startupIndex >= 0);
        Assert.True(refreshIndex > startupIndex);
    }

    [Fact]
    public void MetricsContract_ExportsRefreshFailureStalenessAndShutdownInstruments()
    {
        Assert.Equal("fsus.active_release_fence.refresh_failures", ActiveReleaseFenceMetricNames.RefreshFailures);
        Assert.Equal(
            "fsus.active_release_fence.refresh_consecutive_failures",
            ActiveReleaseFenceMetricNames.ConsecutiveRefreshFailures);
        Assert.Equal("fsus.active_release_fence.refresh_stale_seconds", ActiveReleaseFenceMetricNames.RefreshStaleSeconds);
        Assert.Equal("fsus.active_release_fence.refresh_shutdowns", ActiveReleaseFenceMetricNames.RefreshShutdowns);
    }

    private static IConfigurationRoot Configuration(int refreshIntervalMs, int staleThresholdSeconds)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey] = refreshIntervalMs.ToString(),
                [ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey] = staleThresholdSeconds.ToString()
            })
            .Build();

    private static IWebHostEnvironment Environment(string environmentName)
    {
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        return environment;
    }

    private static ActiveReleaseFenceRuntimeSnapshot Reachable(DateTimeOffset now)
        => new(
            new ActiveReleaseFenceSnapshot(
                true,
                ActiveReleaseFenceStatuses.Active,
                "release-42",
                "green",
                42,
                $"sha256:{new string('a', 64)}",
                now,
                null),
            StoreReachable: true,
            LocalReleaseIsActive: true,
            RefreshedAtUtc: now,
            ErrorCode: null);

    private static ActiveReleaseFenceRuntimeSnapshot Unavailable(DateTimeOffset now)
        => new(
            new ActiveReleaseFenceSnapshot(
                false,
                ActiveReleaseFenceStatuses.Unavailable,
                string.Empty,
                string.Empty,
                0,
                string.Empty,
                null,
                null),
            StoreReachable: false,
            LocalReleaseIsActive: false,
            RefreshedAtUtc: now,
            ErrorCode: "active_release_fence_durable_witness_unavailable");

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan elapsed) => now += elapsed;
    }
}

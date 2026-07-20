using FsusBlog.Server.Infrastructure.RuntimeModes;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeModeRegistrationTests
{
    [Fact]
    public void Single_RemovesDistributedSubscriberButKeepsLocalWorkers()
    {
        RuntimeModePlan plan = Plan(FsusRuntimeModes.Single);

        Assert.False(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(
            plan, "PublicAotFileShellCacheInvalidationSubscriber"));
        Assert.True(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(
            plan, "ArticleMutationOutboxDispatcher"));
    }

    [Fact]
    public void StaticRole_KeepsOnlyWorkersOwnedByConfiguredRoles()
    {
        RuntimeModePlan plan = Plan(FsusRuntimeModes.StaticRole, FsusRuntimeRoles.Web, FsusRuntimeRoles.Audit);

        Assert.True(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(plan, "NotificationStreamLocalFanoutWorker"));
        Assert.True(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(plan, "AuditLogWriterWorker"));
        Assert.False(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(plan, "ArticleMutationOutboxDispatcher"));
        Assert.False(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(plan, "LogCleanupService"));
        Assert.True(RuntimeModeServiceCollectionExtensions.ShouldKeepHostedService(plan, "LifecycleHostedBootstrapService"));
    }

    [Theory]
    [InlineData("single", false)]
    [InlineData("static-role", false)]
    [InlineData("adaptive", true)]
    public void RegistrationMatrix_StartsClusterFoundationOnlyForAdaptive(string mode, bool expectedFoundation)
    {
        var services = new ServiceCollection();
        IConfiguration configuration = mode == FsusRuntimeModes.StaticRole
            ? Configuration(("RuntimeMode:Mode", mode), ("RuntimeMode:StaticRoles:0", "web"))
            : Configuration(("RuntimeMode:Mode", mode));

        services.ApplyFsusRuntimeModeGates(configuration);

        Assert.Equal(expectedFoundation, services.Any(static descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationType?.Name == "ClusterRuntimeFoundationHostedService"));
        Assert.Contains(services, static descriptor => descriptor.ServiceType == typeof(RuntimeModeRuntimeState));
    }

    [Fact]
    public void StaticRole_ActuallyRemovesHostedServiceDescriptorsForDisabledRoles()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IHostedService, AuditLogWriterWorker>();
        services.AddSingleton<IHostedService, LogCleanupService>();

        services.ApplyFsusRuntimeModeGates(Configuration(
            ("RuntimeMode:Mode", "static-role"),
            ("RuntimeMode:StaticRoles:0", "audit")));

        Assert.Contains(services, static descriptor => descriptor.ImplementationType == typeof(AuditLogWriterWorker));
        Assert.DoesNotContain(services, static descriptor => descriptor.ImplementationType == typeof(LogCleanupService));
    }

    [Fact]
    public async Task HealthSnapshot_TracksAdaptiveFoundationLifecycle()
    {
        RuntimeModePlan plan = Plan(FsusRuntimeModes.Adaptive);
        var state = new RuntimeModeRuntimeState(plan);
        var service = new ClusterRuntimeFoundationHostedService(
            state,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ClusterRuntimeFoundationHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);
        RuntimeModeHealthSnapshot active = state.Capture();
        await service.StopAsync(CancellationToken.None);

        Assert.Equal(FsusRuntimeModes.Adaptive, active.Mode);
        Assert.True(active.ClusterFoundationActive);
        Assert.False(state.Capture().ClusterFoundationActive);
    }

    [Fact]
    public async Task StartupLog_SingleExplicitlyReportsDistributedFeaturesDisabled()
    {
        var state = new RuntimeModeRuntimeState(Plan(FsusRuntimeModes.Single));
        var logger = new ListLogger<RuntimeModeStartupLogService>();
        var service = new RuntimeModeStartupLogService(state, logger);

        await service.StartAsync(CancellationToken.None);

        string message = Assert.Single(logger.Messages);
        Assert.Contains("runtime-mode single", message, StringComparison.Ordinal);
        Assert.Contains("ClusterMembership=disabled", message, StringComparison.Ordinal);
        Assert.Contains("AdaptiveScheduler=disabled", message, StringComparison.Ordinal);
        Assert.Contains("DistributedInvalidation=disabled", message, StringComparison.Ordinal);
    }

    private static RuntimeModePlan Plan(string mode, params string[] roles)
        => new(
            mode,
            new HashSet<string>(roles, StringComparer.Ordinal),
            mode != FsusRuntimeModes.Single,
            mode == FsusRuntimeModes.Adaptive,
            mode != FsusRuntimeModes.Single,
            true);

    private static IConfiguration Configuration(params (string Key, string Value)[] values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(static item => item.Key, static item => (string?)item.Value))
            .Build();

    private sealed class AuditLogWriterWorker : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class LogCleanupService : IHostedService
    {
        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class ListLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }
}

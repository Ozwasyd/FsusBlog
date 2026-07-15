using System.Diagnostics;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests;

public sealed class DependencyGraphValidationTests
{
    [Fact]
    public void Validator_DetectsTransitiveSingletonToScopedCapture()
    {
        var services = new ServiceCollection();
        services.AddScoped<ScopedDependency>();
        services.AddTransient<TransientBridge>();
        services.AddSingleton<SingletonRoot>();

        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);

        string violation = Assert.Single(snapshot.CaptiveDependencies);
        Assert.Contains(nameof(SingletonRoot), violation, StringComparison.Ordinal);
        Assert.Contains(nameof(TransientBridge), violation, StringComparison.Ordinal);
        Assert.Contains(nameof(ScopedDependency), violation, StringComparison.Ordinal);
    }

    [Fact]
    public void Validator_DetectsSingletonChainToScopedCapture()
    {
        var services = new ServiceCollection();
        services.AddScoped<ScopedDependency>();
        services.AddSingleton<SingletonBridge>();
        services.AddSingleton<SingletonChainRoot>();

        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);

        string violation = Assert.Single(
            snapshot.CaptiveDependencies,
            static path => path.Contains(nameof(SingletonChainRoot), StringComparison.Ordinal));
        Assert.Contains(nameof(SingletonChainRoot), violation, StringComparison.Ordinal);
        Assert.Contains(nameof(SingletonBridge), violation, StringComparison.Ordinal);
        Assert.Contains(nameof(ScopedDependency), violation, StringComparison.Ordinal);
    }

    [Fact]
    public void Validator_DetectsScopedRegistrationInsideMixedEnumerable()
    {
        var services = new ServiceCollection();
        services.AddSingleton<GraphParticipant, SingletonParticipant>();
        services.AddScoped<GraphParticipant, ScopedParticipant>();
        services.AddSingleton<EnumerableSingletonRoot>();

        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);

        string violation = Assert.Single(snapshot.CaptiveDependencies);
        Assert.Contains(nameof(EnumerableSingletonRoot), violation, StringComparison.Ordinal);
        Assert.Contains(nameof(GraphParticipant), violation, StringComparison.Ordinal);
    }

    [Fact]
    public void Validator_AllowsSingletonToCreateExplicitScope()
    {
        var services = new ServiceCollection();
        services.AddScoped<ScopedDependency>();
        services.AddSingleton<ScopeOwningSingleton>();

        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);

        Assert.Empty(snapshot.CaptiveDependencies);
    }

    [Fact]
    public void RuntimeGraph_HasNoStaticallyVisibleCaptiveDependencies()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeServices(new ConfigurationBuilder().AddInMemoryCollection().Build());

        DependencyGraphRuntimeSnapshot snapshot = DependencyGraphValidator.Analyze(services);

        Assert.True(snapshot.RegistrationCount >= 200, $"Expected the full runtime graph, observed {snapshot.RegistrationCount} registrations.");
        Assert.True(snapshot.HostedServiceCount >= 10);
        Assert.True(snapshot.SingletonCount > 0);
        Assert.True(snapshot.ScopedCount > 0);
        Assert.Empty(snapshot.CaptiveDependencies);
    }

    [Fact]
    public void ServiceProviderValidation_IsEnabledForEveryEnvironment()
    {
        var options = new ServiceProviderOptions();

        FsusServiceProviderValidation.Configure(options);

        Assert.True(options.ValidateOnBuild);
        Assert.True(options.ValidateScopes);
    }

    [Fact]
    public async Task FullApplicationGraph_BuildsWithScopeValidationAndPublishesDashboardSnapshot()
    {
        string dataRoot = Path.Combine(Path.GetTempPath(), "fsusblog-di-graph-tests", Guid.NewGuid().ToString("N"));
        try
        {
            WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                EnvironmentName = Environments.Development,
                ContentRootPath = BackendTestPaths.RepositoryRoot
            });
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = Environments.Development,
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false,connectTimeout=50",
                ["Jwt:SecretKey"] = "issue-1123-jwt-signing-key-with-at-least-thirty-two-bytes",
                ["Jwt:Issuer"] = "FsusBlog.Tests",
                ["Jwt:Audience"] = "FsusBlog.Tests",
                ["FSUSBLOG_DATA_ROOT"] = dataRoot,
                ["DataProtection:KeyRingPath"] = Path.Combine(dataRoot, "keyring"),
                ["DataProtection:ApplicationName"] = "FsusBlog"
            });

            builder.ConfigureFsusApplication();
            await using WebApplication application = builder.Build();

            DependencyGraphRuntimeSnapshot snapshot = application.Services
                .GetRequiredService<DependencyGraphRuntimeState>()
                .Snapshot;
            Assert.True(snapshot.RegistrationCount >= 300, $"Expected the final application graph, observed {snapshot.RegistrationCount} registrations.");
            Assert.Empty(snapshot.CaptiveDependencies);
        }
        finally
        {
            if (Directory.Exists(dataRoot))
            {
                Directory.Delete(dataRoot, recursive: true);
            }
        }
    }

    [Fact]
    public async Task HostedServiceScope_DisposesScopedDependencyAndClosesActivity()
    {
        Activity? stopped = null;
        using var listener = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == FsusObservability.ActivitySourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = activity =>
            {
                if (activity.OperationName == "di.scope"
                    && string.Equals(activity.GetTagItem("fsus.operation") as string, "hosted_scope_probe", StringComparison.Ordinal))
                {
                    stopped = activity;
                }
            }
        };
        ActivitySource.AddActivityListener(listener);

        var disposal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var services = new ServiceCollection();
        services.AddSingleton(disposal);
        services.AddScoped<ScopeDisposalProbe>();
        services.AddHostedService<ScopeProbeHostedService>();
        await using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        IHostedService hostedService = provider.GetRequiredService<IEnumerable<IHostedService>>().Single();
        await hostedService.StartAsync(CancellationToken.None);

        await disposal.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotNull(stopped);
        Assert.Equal("hosted_scope_probe", stopped!.GetTagItem("fsus.operation"));
    }

    private sealed class ScopedDependency;

    private sealed class TransientBridge(ScopedDependency dependency)
    {
        public ScopedDependency Dependency { get; } = dependency;
    }

    private sealed class SingletonRoot(TransientBridge bridge)
    {
        public TransientBridge Bridge { get; } = bridge;
    }

    private sealed class SingletonBridge(ScopedDependency dependency)
    {
        public ScopedDependency Dependency { get; } = dependency;
    }

    private sealed class SingletonChainRoot(SingletonBridge bridge)
    {
        public SingletonBridge Bridge { get; } = bridge;
    }

    private abstract class GraphParticipant;

    private sealed class SingletonParticipant : GraphParticipant;

    private sealed class ScopedParticipant : GraphParticipant;

    private sealed class EnumerableSingletonRoot(IEnumerable<GraphParticipant> participants)
    {
        public IEnumerable<GraphParticipant> Participants { get; } = participants;
    }

    private sealed class ScopeOwningSingleton(IServiceScopeFactory scopeFactory)
    {
        public IServiceScopeFactory ScopeFactory { get; } = scopeFactory;
    }

    private sealed class ScopeDisposalProbe(TaskCompletionSource disposal) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            disposal.TrySetResult();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ScopeProbeHostedService(IServiceScopeFactory scopeFactory) : IHostedService
    {
        public async Task StartAsync(CancellationToken cancellationToken)
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                scopeFactory,
                "hosted_scope_probe");
            _ = scope.ServiceProvider.GetRequiredService<ScopeDisposalProbe>();
        }

        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}

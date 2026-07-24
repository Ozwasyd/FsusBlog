using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class AdaptiveSchedulerServiceCollectionExtensions
{
    public static IServiceCollection AddFsusAdaptiveScheduler(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ClusterMembershipOptions cluster = ClusterMembershipOptions.FromConfiguration(configuration);
        services.TryAddSingleton(cluster);
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);
        services.TryAddSingleton<IAdaptiveSchedulerRuntimeOptionsSource,
            ConfigurationAdaptiveSchedulerRuntimeOptionsSource>();
        services.TryAddSingleton<ResponsibilityAssignmentState>();
        services.TryAddSingleton<IResponsibilityAssignmentSnapshotProvider>(
            static provider => provider.GetRequiredService<ResponsibilityAssignmentState>());
        services.TryAddSingleton<LeasedModuleResponsibilityRuntime>();
        services.TryAddSingleton<IResponsibilityRuntime>(
            static provider => provider.GetRequiredService<LeasedModuleResponsibilityRuntime>());
        services.TryAddSingleton<IResponsibilityActivationView>(
            static provider => provider.GetRequiredService<LeasedModuleResponsibilityRuntime>());
        services.TryAddSingleton<IResponsibilityAssignmentPlanner, AdaptiveResponsibilityScheduler>();
        if (cluster.Mode != ClusterRuntimeMode.Single
            && !OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService<ResponsibilityAssignmentHostedService>();
        }
        return services;
    }
}

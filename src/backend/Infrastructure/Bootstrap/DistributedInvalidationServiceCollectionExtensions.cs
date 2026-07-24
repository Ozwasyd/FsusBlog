using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class DistributedInvalidationServiceCollectionExtensions
{
    public static IServiceCollection AddFsusDistributedStateControl(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ClusterMembershipOptions cluster = ClusterMembershipOptions.FromConfiguration(configuration);
        services.TryAddSingleton(TimeProvider.System);
        if (cluster.Mode == ClusterRuntimeMode.Single)
        {
            services.TryAdd(ServiceDescriptor.Singleton(
                typeof(IDistributedStateControlStore),
                typeof(InMemoryDistributedStateControlStore)));
        }
        else
        {
            services.TryAdd(ServiceDescriptor.Singleton(
                typeof(IDistributedStateControlStore),
                typeof(RedisDistributedStateControlStore)));
        }
        services.TryAddSingleton<ILeaseManager>(
            static provider => provider.GetRequiredService<IDistributedStateControlStore>());
        services.TryAddSingleton<IDistributedTaskStateStore>(
            static provider => provider.GetRequiredService<IDistributedStateControlStore>());
        return services;
    }

    public static IServiceCollection AddFsusClusterMembership(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddFsusDistributedStateControl(configuration);
        ClusterMembershipOptions options = ClusterMembershipOptions.FromConfiguration(configuration);
        services.AddSingleton(options);
        if (!options.Enabled)
        {
            services.AddSingleton<IClusterMembershipStore, InMemoryClusterMembershipStore>();
            return services;
        }

        services.AddSingleton<IClusterMembershipStore, RedisClusterMembershipStore>();
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService<ClusterMembershipHostedService>();
        }
        return services;
    }

    public static IServiceCollection AddFsusDistributedInvalidation(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        DistributedInvalidationOptions options = DistributedInvalidationOptions.FromConfiguration(configuration);
        services.AddSingleton(options);
        services.AddSingleton<DistributedInvalidationRuntimeState>();
        services.AddSingleton<DistributedInvalidationEventFactory>();
        services.AddSingleton<IDistributedInvalidationLocalApplier, DistributedInvalidationLocalApplier>();
        if (!options.Enabled)
        {
            services.AddSingleton<IDistributedInvalidationPublisher, SingleNodeDistributedInvalidationPublisher>();
            return services;
        }

        services.AddSingleton<IDistributedInvalidationTransport, RedisDistributedInvalidationTransport>();
        services.AddSingleton<DistributedInvalidationBus>();
        services.AddSingleton<IDistributedInvalidationPublisher>(
            sp => sp.GetRequiredService<DistributedInvalidationBus>());
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService(sp => sp.GetRequiredService<DistributedInvalidationBus>());
        }
        return services;
    }
}

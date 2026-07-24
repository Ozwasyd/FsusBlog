using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class DistributedInvalidationServiceCollectionExtensions
{
    public static IServiceCollection AddFsusClusterMembership(
        this IServiceCollection services,
        IConfiguration configuration)
    {
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

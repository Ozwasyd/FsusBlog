using FsusBlog.Server.Infrastructure.Distributed;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class DistributedInvalidationServiceCollectionExtensions
{
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
            static provider => provider.GetRequiredService<DistributedInvalidationBus>());
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService(
                static provider => provider.GetRequiredService<DistributedInvalidationBus>());
        }
        return services;
    }
}

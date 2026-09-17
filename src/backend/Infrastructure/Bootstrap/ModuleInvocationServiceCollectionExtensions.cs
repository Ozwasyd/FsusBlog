using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Modules;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class ModuleInvocationServiceCollectionExtensions
{
    public static IServiceCollection AddFsusModuleInvocation(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ClusterMembershipOptions cluster = ClusterMembershipOptions.FromConfiguration(configuration);
        services.TryAddSingleton(cluster);
        services.TryAddSingleton<IModuleRouteResolver, ClusterModuleRouteResolver>();
        services.TryAddScoped<IModuleInvoker, ModuleInvoker>();
        services.TryAddEnumerable(
            ServiceDescriptor.Scoped<IModuleInvocationPath, LocalModuleInvocationPath>());
        return services;
    }

    public static IServiceCollection AddFsusRemoteModuleTransport<TTransport>(
        this IServiceCollection services,
        RemoteModuleInvocationOptions? options = null)
        where TTransport : class, IRemoteModuleTransport
    {
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);
        services.TryAddSingleton<IRemoteModuleTransport, TTransport>();
        services.AddSingleton<IModuleInvocationPath>(provider =>
            new ResilientRemoteModuleInvocationPath(
                provider.GetRequiredService<IRemoteModuleTransport>(),
                options ?? RemoteModuleInvocationOptions.Default,
                provider.GetRequiredService<TimeProvider>()));
        return services;
    }

    public static IServiceCollection AddFsusQueueModuleTransport<TTransport>(
        this IServiceCollection services)
        where TTransport : class, IModuleQueueTransport
    {
        services.TryAddSingleton<IModuleQueueTransport, TTransport>();
        services.AddSingleton<IModuleInvocationPath, QueueModuleInvocationPath>();
        return services;
    }

    public static IServiceCollection AddFsusEventModuleTransport<TTransport>(
        this IServiceCollection services)
        where TTransport : class, IModuleEventTransport
    {
        services.TryAddSingleton<IModuleEventTransport, TTransport>();
        services.AddSingleton<IModuleInvocationPath, EventModuleInvocationPath>();
        return services;
    }
}

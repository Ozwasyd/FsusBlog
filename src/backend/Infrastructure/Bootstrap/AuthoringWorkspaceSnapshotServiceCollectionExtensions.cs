using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class AuthoringWorkspaceSnapshotServiceCollectionExtensions
{
    internal static IServiceCollection AddAuthoringWorkspaceSnapshotServices(this IServiceCollection services)
    {
        services.AddSingleton<AuthoringWorkspaceSnapshotSourceIdentity>();
        services.AddScoped<IAuthoringWorkspaceSnapshotPersistence, AuthoringWorkspaceSnapshotPostgresPersistence>();
        services.AddScoped(provider => new AuthoringWorkspaceSnapshotStore(
            provider.GetRequiredService<IAuthoringWorkspaceSnapshotPersistence>(),
            provider.GetRequiredService<TimeProvider>(),
            provider.GetRequiredService<AuthoringWorkspaceSnapshotSourceIdentity>().SourceDigest));
        services.AddScoped<AuthoringWorkspaceSnapshotTransport>();
        return services;
    }
}

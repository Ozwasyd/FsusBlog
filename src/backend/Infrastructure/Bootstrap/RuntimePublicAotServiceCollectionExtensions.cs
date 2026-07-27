using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimePublicAotServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimePublicAotServices(this IServiceCollection services)
    {
        services.AddSingleton<PublicAotSsrRuntimeState>();
        services.AddSingleton<IPublicAotRuntimeState, PublicAotRuntimeState>();
        services.AddSingleton<IAotSeoConfigSnapshot, AotSeoConfigSnapshot>();
        services.AddSingleton<PublicAotBackfillScheduler>();
        services.AddSingleton<IPublicAotBackfillScheduler>(sp => sp.GetRequiredService<PublicAotBackfillScheduler>());
        services.AddSingleton<
            IPublicAotInvalidationGenerationBootstrapGuard,
            FilePublicAotInvalidationGenerationBootstrapGuard>();
        services.AddSingleton<IPublicAotInvalidationGenerationAuthority, RedisPublicAotInvalidationGenerationAuthority>();
        services.AddSingleton(sp =>
        {
            IPublicAotInvalidationGenerationAuthority authority = sp.GetRequiredService<IPublicAotInvalidationGenerationAuthority>();
            _ = authority.Load();
            return new PublicAotInvalidationTracker(authority);
        });
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<PublicAotInvalidationGenerationStartupValidator>();
            services.AddHostedService<PublicAotInvalidationGenerationCompactionWorker>();
        }
        services.AddSingleton(PublicAotBackfillLeaseOptions.FromEnvironment());
        services.AddSingleton<IPublicAotBackfillLease, PublicAotBackfillLease>();
        services.AddSingleton<PublicAotFileShellCache>();
        services.AddSingleton<IPublicAotShellCache>(sp => sp.GetRequiredService<PublicAotFileShellCache>());
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<PublicAotArtifactRecoveryService>();
            services.AddHostedService<PublicAotFileShellCacheInvalidationSubscriber>();
            services.AddHostedService<PublicAotBackfillWorker>();
        }

        services.AddSingleton<IContentFilterService, ContentFilterService>();
        services.AddSingleton<IReleaseIdentityProvider, ReleaseIdentityProvider>();
        services.AddSingleton<IAssemblyReleaseIdentityProvider, EntryAssemblyReleaseIdentityProvider>();
        services.AddHostedService<ReleaseIdentityStartupLogger>();
        services.AddScoped<ProductionReadinessProbe>();
        services.AddSingleton<ConfigurationHealthSnapshot>();
        services.AddSingleton<IConfigurationHealthSnapshot>(sp => sp.GetRequiredService<ConfigurationHealthSnapshot>());
        services.AddSingleton<ProductionReadinessSnapshotCache>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<ConfigurationHealthSnapshotRefreshWorker>();
        }
        services.AddScoped<IPublicAotCacheWriter, PublicAotCacheWriter>();
        services.AddScoped<IPublicAotArtifactStore, PublicAotArtifactStore>();
        services.AddSingleton<IPublicAotRouteRegistry, PublicAotRouteRegistry>();
        services.AddSingleton<IPublicAotRouteIdentity, PublicAotRouteIdentity>();
        services.AddScoped<IPublicAotRouteManifestProvider, PublicAotRouteManifestProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotHomeBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotArticleDetailBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotFilterBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotAboutBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotArchiveBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotPrivacyBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotGuidelinesBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotCopyrightBootstrapProvider>();
        services.AddScoped<IPublicAotDocumentService, PublicAotDocumentService>();
        services.AddScoped<IPublicAotDocumentComposition, PublicAotDocumentComposition>();
        services.AddSingleton<IPublicAotEntryRenderer, PublicAotNodeSsrRenderer>();
        services.AddScoped<PublicAotSsrHealthService>();
        services.AddScoped<PublicAotShellService>();
        services.AddScoped<IPublicAotShellService>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotBackfillGenerator>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotInvalidationService, PublicAotInvalidationService>();

        return services;
    }
}

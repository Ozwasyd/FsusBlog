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
        services.AddSingleton<PublicAotBackfillScheduler>();
        services.AddSingleton<IPublicAotBackfillScheduler>(sp => sp.GetRequiredService<PublicAotBackfillScheduler>());
        services.AddSingleton<PublicAotInvalidationTracker>();
        services.AddHostedService<PublicAotBackfillWorker>();

        services.AddSingleton<IContentFilterService, ContentFilterService>();
        services.AddScoped<ProductionReadinessProbe>();
        services.AddSingleton<IPublicAotShellCache, PublicAotFileShellCache>();
        services.AddScoped<IPublicAotCacheWriter, PublicAotCacheWriter>();
        services.AddSingleton<IPublicAotRouteRegistry, PublicAotRouteRegistry>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotHomeBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotArticleDetailBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotFilterBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotAboutBootstrapProvider>();
        services.AddScoped<IPublicAotBootstrapProvider, PublicAotArchiveBootstrapProvider>();
        services.AddScoped<IPublicAotDocumentService, PublicAotDocumentService>();
        services.AddSingleton<IPublicAotEntryRenderer, PublicAotNodeSsrRenderer>();
        services.AddScoped<PublicAotShellService>();
        services.AddScoped<IPublicAotShellService>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotBackfillGenerator>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotInvalidationService, PublicAotInvalidationService>();

        return services;
    }
}

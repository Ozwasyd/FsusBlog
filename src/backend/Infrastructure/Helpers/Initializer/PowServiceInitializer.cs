using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

public static class PowServiceInitializer
{
    public static IServiceCollection AddPowServices(this IServiceCollection services)
    {
        services.AddSingleton<IPowService, RedisPowService>();
        services.AddSingleton<AdaptivePowGovernor>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<PowLoadResetWorker>();
        }

        return services;
    }
}

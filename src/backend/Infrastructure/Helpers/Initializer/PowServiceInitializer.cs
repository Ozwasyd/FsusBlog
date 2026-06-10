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

        // [修复 2026-02-24] P1 修复：将 MVC 过滤器的实现注册为 Scoped 服务
        // 允许通过构造函数注入依赖，彻底消除服务定位反模式
        services.AddScoped<RequiresPowAttribute.RequiresPowFilterImpl>();

        return services;
    }
}

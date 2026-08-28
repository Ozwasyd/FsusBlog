using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Middlewares;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public static class PublicHotReadFastPathExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadFastPath(this IApplicationBuilder app)
    {
        var store = app.ApplicationServices.GetRequiredService<PublicHotReadStore>();
        var options = app.ApplicationServices.GetRequiredService<IOptions<PublicHotReadOptions>>().Value;
        var counters = app.ApplicationServices.GetRequiredService<PublicHotReadCounters>();
        var env = app.ApplicationServices.GetRequiredService<IWebHostEnvironment>();
        var configuration = app.ApplicationServices.GetService<IConfiguration>();

        return app.Use((ctx, next) =>
        {
            bool isDevelopment = PublicWebRuntime
                .ShouldUseDevelopmentCspPolicy(env, configuration);
            PublicHotReadRequestFeature? feature = ctx.Features.Get<PublicHotReadRequestFeature>();
            return feature is null
                ? next(ctx)
                : PublicHotReadFastPath.TryServeClassifiedAsync(
                    ctx,
                    next,
                    store,
                    options,
                    counters,
                    feature,
                    isDevelopment);
        });
    }
}

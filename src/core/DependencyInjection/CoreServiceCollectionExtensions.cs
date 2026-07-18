using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Implementations;

namespace FsusBlog.Core.DependencyInjection;

public static class CoreServiceCollectionExtensions
{
    public static IServiceCollection AddFsusBlogCore(this IServiceCollection services, IConfiguration configuration)
    {
        _ = configuration;
        services.AddScoped<IArticleCoreService, ArticleCoreService>();
        services.AddScoped<ICommentCoreService, CommentCoreService>();
        services.AddScoped<IUserCoreService, UserCoreService>();
        services.AddScoped<ISystemCoreService, SystemCoreService>();
        services.AddScoped<IStatsCoreService, StatsCoreService>();
        services.AddSingleton<IAedsEncoder, AedsEncoder>();
        services.AddSingleton<AedsDecoderValidator>();
        return services;
    }
}

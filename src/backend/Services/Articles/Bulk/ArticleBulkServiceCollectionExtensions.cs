using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal static class ArticleBulkServiceCollectionExtensions
{
    internal static IServiceCollection AddArticleBulkPlanning(this IServiceCollection services)
    {
        services.TryAddScoped<IArticleBulkQuerySelectionAuthority, UnavailableArticleBulkQuerySelectionAuthority>();
        services.TryAddScoped<IArticleBulkSelectionAuthority, ArticleBulkSelectionAuthority>();
        services.TryAddScoped<IArticleBulkPreflightAuthority, UnavailableArticleBulkPreflightAuthority>();
        services.TryAddScoped<ArticleBulkPlanAuthority>();
        return services;
    }
}

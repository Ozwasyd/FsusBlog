using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Telemetry;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeDomainServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeDomainServices(this IServiceCollection services)
    {
        services.AddScoped<ArticleService>();
        services.AddScoped<CommentService>();
        services.AddScoped<UserService>();
        services.AddScoped<SystemService>();
        services.AddScoped<StatsService>();
        services.AddScoped<AuthoringWorkflowService>();
        services.AddScoped<BlogDistributionService>();
        services.AddScoped<RelatedReadingService>();
        services.AddScoped<RumTelemetryService>();
        services.AddScoped<ArticleCoreQueryCache>();
        services.AddScoped<CommentCoreQueryCache>();
        services.AddScoped<StatsCoreQueryCache>();
        services.AddScoped<IArticleEndpointService, ArticleEndpointService>();
        services.AddScoped<ICommentEndpointService>(sp => sp.GetRequiredService<CommentService>());
        services.AddScoped<IUserAuthService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserAccountReader>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserRegistrationService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserLoginWorkflowService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserProfileCommandService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserSessionCommandService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserMfaCommandService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserAdminModerationService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IHumanReadProofService, HumanReadProofService>();

        services.AddScoped<FsusBlog.Core.Services.Gateways.IArticleCoreGateway, ArticleCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.ICommentCoreGateway, CommentCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.IUserCoreGateway, UserCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.ISystemCoreGateway, SystemCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.IStatsCoreGateway, StatsCoreGateway>();

        services.AddScoped<IArticleService, ArticleServiceCoreAdapter>();
        services.AddScoped<ICommentService, CommentServiceCoreAdapter>();
        services.AddScoped<IUserService, UserServiceCoreAdapter>();
        services.AddScoped<ISystemService, SystemServiceCoreAdapter>();
        services.AddScoped<IStatsService, StatsServiceCoreAdapter>();

        return services;
    }
}

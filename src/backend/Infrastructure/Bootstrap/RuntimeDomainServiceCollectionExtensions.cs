using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeDomainServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeDomainServices(this IServiceCollection services)
    {
        services.AddContentRuntimeServices();
        services.AddUserRuntimePorts();
        services.AddGeneralDomainServices();
        services.AddCoreBridgeServices();

        return services;
    }

    private static IServiceCollection AddContentRuntimeServices(this IServiceCollection services)
    {
        services.AddScoped<ArticleService>();
        services.AddScoped<CommentService>();
        services.AddScoped<IRegionLegalModerationService, RegionLegalModerationService>();
        services.AddScoped<IClientRegionResolver, ClientRegionResolver>();
        services.AddScoped<ArticleSearchProjector>();
        services.AddScoped<ArticleRealtimeNotifier>();
        services.AddScoped<ArticleAssetCleanupPolicy>();
        services.AddScoped<IArticleMutationSideEffectCoordinator, ArticleMutationSideEffectCoordinator>();
        services.AddScoped<IArticleEndpointService, ArticleEndpointService>();
        services.AddScoped<ICommentEndpointService>(sp => sp.GetRequiredService<CommentService>());
        return services;
    }

    private static IServiceCollection AddUserRuntimePorts(this IServiceCollection services)
    {
        services.AddScoped<UserService>();
        services.AddScoped<AuthBinaryApplicationFacade>();
        services.AddScoped<IUserAuthService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserAccountReader, UserAccountReader>();
        services.AddScoped<IUserRegistrationService, UserRegistrationService>();
        services.AddScoped<IUserLoginWorkflowService, UserLoginWorkflowService>();
        services.AddScoped<IUserProfileCommandService, UserProfileCommandService>();
        services.AddScoped<IUserSessionCommandService, UserSessionCommandService>();
        services.AddScoped<IUserMfaCommandService, UserMfaCommandService>();
        services.AddScoped<IUserAdminModerationService, UserAdminModerationService>();
        return services;
    }

    private static IServiceCollection AddGeneralDomainServices(this IServiceCollection services)
    {
        services.AddScoped<SystemService>();
        services.AddScoped<StatsService>();
        services.AddScoped<AuthoringWorkflowService>();
        services.AddScoped<BlogDistributionService>();
        services.AddScoped<RelatedReadingService>();
        services.AddScoped<RumTelemetryService>();
        services.AddScoped<ArticleCoreQueryCache>();
        services.AddScoped<CommentCoreQueryCache>();
        services.AddScoped<StatsCoreQueryCache>();
        services.AddScoped<IHumanReadProofService, HumanReadProofService>();
        return services;
    }

    private static IServiceCollection AddCoreBridgeServices(this IServiceCollection services)
    {
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

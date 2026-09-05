using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Subscriptions;
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
        services.AddHostedService<DeploymentLifecycleHostedService>();

        return services;
    }

    private static IServiceCollection AddContentRuntimeServices(this IServiceCollection services)
    {
        services.AddSingleton<IArticleViewWriteBuffer, ArticleViewWriteBuffer>();
        services.AddScoped<IArticleViewFlushSink, ArticleServiceViewFlushSink>();
        services.AddHostedService<ArticleViewFlushWorker>();
        services.AddScoped<ArticleService>();
        services.AddScoped<IArticlePublicationValidator, ArticlePublicationValidator>();
        services.AddScoped<CommentCommandService>();
        services.AddScoped<ICommentMutationOutbox, CommentMutationOutboxWriter>();
        services.AddScoped<ICommentNotificationService, CommentNotificationService>();
        services.AddScoped<ICommentModerationService, CommentModerationService>();
        services.AddScoped<ICommentManagementCapabilityService, CommentManagementCapabilityService>();
        services.AddScoped<ICommentAuthorManagementService, CommentAuthorManagementService>();
        services.AddScoped<ICommentGovernanceService, CommentGovernanceService>();
        services.AddScoped<IArticleCommentPolicyService, ArticleCommentPolicyService>();
        services.AddScoped<ICommentAttributionPrivacyService, CommentAttributionPrivacyService>();
        services.AddSingleton<ICommentCursorPolicyResolver, ConfigurationCommentCursorPolicyResolver>();
        services.AddSingleton<IModerationRuntimeStateService, ModerationRuntimeStateService>();
        services.AddScoped<IAntiSpamModerationService, AntiSpamModerationService>();
        services.AddScoped<ICommentModerationDispositionPolicy, CommentModerationDispositionPolicy>();
        services.AddSingleton<IModerationDictionaryService, ModerationDictionaryService>();
        services.AddSingleton<IModerationRegionCatalogService, ModerationRegionCatalogService>();
        services.AddScoped<IRegionLegalModerationService, RegionLegalModerationService>();
        services.AddScoped<IClientRegionResolver, ClientRegionResolver>();
        services.AddScoped<ArticleAssetCleanupPolicy>();
        services.AddScoped<ArticleMutationProjectionInvalidator>();
        services.AddScoped<ArticleMutationDelivery>();
        services.AddScoped<IArticlePublicMutationFence, ArticlePublicMutationFence>();
        services.AddScoped<IPublishProofTransparencyLog, PublishProofTransparencyLog>();
        services.AddScoped<IIntegrityProofScheduler, IntegrityProofScheduler>();
        services.AddScoped<IIntegrityVerificationManifestService, IntegrityVerificationManifestService>();
        services.AddScoped<IArticleResponsibilityManifestService, ArticleResponsibilityManifestService>();
        services.AddScoped<IArticleResponsibilityAuthoringService, ArticleResponsibilityAuthoringService>();
        services.AddScoped<IIntegrityAdminConsoleService, IntegrityAdminConsoleService>();
        services.AddScoped<IPublicMutationFenceLease, PostgresPublicMutationFenceLease>();
        services.AddScoped<IArticleMutationSideEffectCoordinator, ArticleMutationSideEffectCoordinator>();
        services.AddScoped<IArticleMutationCommandService>(sp => sp.GetRequiredService<ArticleService>());
        services.AddScoped<IArticleEndpointService, ArticleEndpointService>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IPublicContentFixtureSeeder, FsusBlog.Server.Services.Fixtures.PublicContentFixtureSeeder>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IMessagingFixtureSeeder, FsusBlog.Server.Services.Fixtures.MessagingFixtureSeeder>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IDemoFixtureSeeder, FsusBlog.Server.Services.Fixtures.DemoFixtureSeeder>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IAuditFixtureProducer, FsusBlog.Server.Services.Fixtures.AuditFixtureProducer>();
        services.AddScoped<ICommentQueryService, CommentQueryService>();
        services.AddScoped<ICommentEndpointService>(sp => sp.GetRequiredService<CommentCommandService>());
        services.AddScoped<ICommentCommandService>(sp => sp.GetRequiredService<CommentCommandService>());
        services.AddSingleton<CommentMutationOutboxRuntimeState>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<CommentMutationOutboxWorker>();
        }
        return services;
    }

    private static IServiceCollection AddUserRuntimePorts(this IServiceCollection services)
    {
        services.AddScoped<UserService>();
        services.AddScoped<AuthBinaryApplicationFacade>();
        services.AddScoped<IUserAccountReader, UserAccountReader>();
        services.AddScoped<UserLocalePreferenceService>();
        services.AddScoped<IUserLocalePreferenceReader>(sp => sp.GetRequiredService<UserLocalePreferenceService>());
        services.AddScoped<IUserLocalePreferenceCommand>(sp => sp.GetRequiredService<UserLocalePreferenceService>());
        services.AddScoped<IAnonymousAccountBootstrapService, AnonymousAccountBootstrapService>();
        services.AddScoped<IAccountEnrollmentService, AccountEnrollmentService>();
        services.AddHostedService<AccountEnrollmentCleanupWorker>();
        services.AddScoped<IUserLoginWorkflowService, UserLoginWorkflowService>();
        services.AddScoped<IUserProfileCommandService, UserProfileCommandService>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IAccountProfilePreferenceFixtureStateReader, FsusBlog.Server.Services.Fixtures.AccountProfilePreferenceFixtureStateReader>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IAccountPreferenceFixtureCommand, FsusBlog.Server.Services.Fixtures.AccountPreferenceFixtureCommand>();
        services.AddScoped<FsusBlog.Server.Services.Fixtures.IAccountProfilePreferenceFixtureService, FsusBlog.Server.Services.Fixtures.AccountProfilePreferenceFixtureService>();
        services.AddScoped<IUserSessionCommandService, UserSessionCommandService>();
        services.AddScoped<IUserMfaCommandService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserMfaVerificationService>(sp => sp.GetRequiredService<UserService>());
        services.AddScoped<IUserAdminModerationService, UserAdminModerationService>();
        return services;
    }

    private static IServiceCollection AddGeneralDomainServices(this IServiceCollection services)
    {
        services.AddScoped<SystemService>();
        services.AddSingleton<IReadAnalyticsPrivacyPolicy, ReadAnalyticsPrivacyPolicy>();
        services.AddScoped<StatsService>();
        services.AddScoped<AuthoringAnalyticsReadService>();
        services.AddScoped<IAuthoringAnalyticsReader>(sp => sp.GetRequiredService<AuthoringAnalyticsReadService>());
        services.AddScoped<AuthoringAssetLibraryService>();
        services.AddScoped<IAuthoringAssetQuery>(sp => sp.GetRequiredService<AuthoringAssetLibraryService>());
        services.AddScoped<IAuthoringAssetCommands>(sp => sp.GetRequiredService<AuthoringAssetLibraryService>());
        services.AddScoped<AuthoringDraftLifecycleService>();
        services.AddScoped<IAuthoringDraftLifecycle>(sp => sp.GetRequiredService<AuthoringDraftLifecycleService>());
        services.AddScoped<IAuthoringPrepublishPolicy>(sp => sp.GetRequiredService<AuthoringDraftLifecycleService>());
        services.AddScoped<IAuthoringCanvasDocumentStore, AuthoringCanvasDocumentStore>();
        services.AddScoped<IAuthorSavedViewDependencyCatalog, AuthorSavedViewDependencyCatalog>();
        services.AddScoped<IAuthorSavedViewQueryValidator, AuthorSavedViewQueryValidator>();
        services.AddScoped<AuthoringContentTransferService>();
        services.AddScoped<IAuthoringContentExport>(sp => sp.GetRequiredService<AuthoringContentTransferService>());
        services.AddScoped<IAuthoringContentImport>(sp => sp.GetRequiredService<AuthoringContentTransferService>());
        services.AddScoped<IAuthoringAiAssist>(sp => sp.GetRequiredService<AuthoringContentTransferService>());
        services.AddScoped<AuthoringModerationWorkflowService>();
        services.AddScoped<CommentModerationQueueService>();
        services.AddScoped<CommentModerationQueueStore>();
        services.AddScoped<IAuthoringModerationQueue>(sp => sp.GetRequiredService<AuthoringModerationWorkflowService>());
        services.AddScoped<IAuthoringModerationCommands>(sp => sp.GetRequiredService<AuthoringModerationWorkflowService>());
        services.AddScoped<IAuthoringAuditWriter, AuthoringAuditWriter>();
        services.AddScoped<BlogDistributionService>();
        services.AddScoped<RelatedReadingService>();
        services.AddSingleton<RumTelemetryChannel>();
        services.AddScoped<RumTelemetryService>();
        services.AddScoped<IRumTelemetryService>(sp => sp.GetRequiredService<RumTelemetryService>());
        services.AddScoped<CommentCoreQueryCache>();
        services.AddScoped<StatsCoreQueryCache>();
        services.AddScoped<IHumanReadProofService, HumanReadProofService>();
        services.AddScoped<ISiteSubscriptionProofService, SiteSubscriptionProofService>();
        return services;
    }

    private static IServiceCollection AddCoreBridgeServices(this IServiceCollection services)
    {
        services.AddScoped<FsusBlog.Core.Services.Gateways.IArticleCoreGateway>(sp => sp.GetRequiredService<ArticleService>());
        services.AddScoped<FsusBlog.Core.Services.Gateways.ICommentCoreGateway, CommentCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.IUserCoreGateway, UserCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.ISystemCoreGateway, SystemCoreGateway>();
        services.AddScoped<FsusBlog.Core.Services.Gateways.IStatsCoreGateway, StatsCoreGateway>();

        services.AddScoped<ICommentService, CommentServiceCoreAdapter>();
        services.AddScoped<IUserService, UserServiceCoreAdapter>();
        services.AddScoped<ISystemService, SystemServiceCoreAdapter>();
        services.AddScoped<IStatsService, StatsServiceCoreAdapter>();

        return services;
    }
}

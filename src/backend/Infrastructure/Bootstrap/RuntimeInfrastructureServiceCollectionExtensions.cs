using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Customization;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Plugins;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Infrastructure.Themes;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.PrivateAssets;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Services.VisitLog;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeInfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeInfrastructureServices(this IServiceCollection services, IConfiguration configuration)
    {
        services.TryAddSingleton(sp => ReleaseStorageComposition.Create(
            configuration,
            sp.GetRequiredService<IWebHostEnvironment>()));
        services.TryAddSingleton(sp => sp.GetRequiredService<ReleaseStorageLayout>().Paths);
        services.AddSingleton<StartupRuntimeState>();
        services.AddSingleton<DeploymentRuntimeState>();
        services.AddSingleton<DeploymentDrainCoordinator>();
        services.AddBinaryRuntime();
        services.AddCustomizationRuntime();
        services.AddNotificationRuntime();
        services.AddCrawlerAndSearchRuntime(configuration);
        services.AddFileAndAuthRuntime();
        services.AddAuditRuntime();
        services.AddMessagingRuntime();
        services.AddCacheRuntime();
        services.AddPublicReadArtifactRuntime(configuration);
        services.AddThemeRuntime(configuration);
        services.AddFsusDistributedInvalidation(configuration);
        services.AddFsusDistributedStateControl(configuration);
        services.AddFsusClusterMembership(configuration);
        services.AddFsusModuleInvocation(configuration);
        services.AddFsusAdaptiveScheduler(configuration);
        services.AddPluginFoundation(configuration);
        services.AddIdentityRuntime();
        services.AddBackgroundRuntime();
        services.AddFontRuntime(configuration);
        services.AddScoped<IArticleRevisionContentBlockMaintenance, ArticleRevisionContentBlockMaintenance>();
        services.AddSpaRuntime();

        return services;
    }

    private static IServiceCollection AddPluginFoundation(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        string configuredVersion = configuration["PluginCompatibility:HostVersion"] ?? "1.3.0";
        if (!Version.TryParse(configuredVersion, out Version? hostVersion)
            || hostVersion.Major < 1)
        {
            throw new InvalidOperationException(
                "PluginCompatibility:HostVersion must be a stable dotted host version.");
        }

        services.AddSingleton(sp => new PluginPackageReader(
            hostVersion,
            sp.GetService<IPluginPackageSignatureVerifier>()));
        services.AddScoped<IPluginRegistryStore, PostgresPluginRegistryStore>();
        services.AddScoped<IPluginRegistry, PluginRegistry>();
        services.AddScoped<IPluginLifecycle, PluginLifecycle>();
        services.AddSingleton<IPluginPermissionGrantStore, InMemoryPluginPermissionGrantStore>();
        services.AddSingleton<PluginPermissionManager>();
        services.AddSingleton<PluginIsolationController>();
        services.AddSingleton<PluginObservabilityStore>();
        services.AddSingleton<PluginAdminConfigStore>();
        services.AddSingleton<IPluginHookRegistry, PluginHookRegistry>();
        services.AddSingleton<ILuaScriptEngineAdapter, UnavailableLuaScriptEngineAdapter>();
        services.AddSingleton<ILuaPluginRuntime, LuaPluginRuntime>();
        services.AddSingleton(JavaScriptPluginRuntimeOptions.FromConfiguration(configuration));
        services.AddSingleton<IJavaScriptPluginHostApi, DefaultJavaScriptPluginHostApi>();
        services.AddSingleton<JavaScriptPluginRuntime>();
        services.AddSingleton<IJavaScriptPluginRuntime>(
            static sp => sp.GetRequiredService<JavaScriptPluginRuntime>());
        services.AddSingleton<IPluginHookRuntimeInvoker>(
            static sp => new ScriptPluginHookRuntimeInvoker(
                sp.GetRequiredService<IJavaScriptPluginRuntime>(),
                sp.GetRequiredService<ILuaPluginRuntime>()));
        services.AddSingleton<IPluginHookScopeCoordinator, PluginHookScopeCoordinator>();
        services.AddSingleton<IPluginHookDispatcher, PluginHookDispatcher>();
        services.AddScoped<PluginSecurityAdministrativeSnapshotService>();
        services.AddScoped<PluginAdminService>();
        return services;
    }

    private static IServiceCollection AddThemeRuntime(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        string configuredVersion = configuration["Themes:FsusBlogVersion"] ?? "1.3.0";
        if (!Version.TryParse(configuredVersion, out Version? fsusBlogVersion))
        {
            throw new InvalidOperationException(
                "Themes:FsusBlogVersion must be a numeric major.minor.patch version.");
        }

        services.AddSingleton<ThemeCssSafetyScanner>();
        services.AddSingleton<ThemePackageValidator>();
        services.AddSingleton<ThemeTokenCompiler>();
        string packageStoreRoot = configuration["Themes:PackageStoreRoot"]
            ?? Path.Combine(AppContext.BaseDirectory, "data", "themes");
        services.AddSingleton<IThemePackageStore>(new LocalThemePackageStore(packageStoreRoot));
        services.AddScoped<IThemeRegistry, PostgresThemeRegistry>();
        services.AddSingleton<ThemeRuntimeState>();
        services.AddScoped<IThemeActivationEffects, ThemeActivationEffects>();
        services.AddScoped(serviceProvider => new ThemeActivationRuntimeService(
            serviceProvider.GetRequiredService<ThemePackageValidator>(),
            serviceProvider.GetRequiredService<IThemeRegistry>(),
            fsusBlogVersion,
            serviceProvider.GetRequiredService<TimeProvider>(),
            serviceProvider.GetRequiredService<IThemePackageStore>(),
            serviceProvider.GetRequiredService<IThemeActivationEffects>()));
        services.AddScoped(serviceProvider => new ThemeLifecycleService(
            serviceProvider.GetRequiredService<ThemePackageValidator>(),
            serviceProvider.GetRequiredService<IThemeRegistry>(),
            fsusBlogVersion,
            serviceProvider.GetRequiredService<TimeProvider>(),
            serviceProvider.GetRequiredService<IThemePackageStore>()));
        return services;
    }

    private static IServiceCollection AddBinaryRuntime(this IServiceCollection services)
    {
        services.AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>();
        services.AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>();
        services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
        return services;
    }

    private static IServiceCollection AddNotificationRuntime(this IServiceCollection services)
    {
        services.AddSingleton<INotificationFrameCodec, NotificationFrameCodec>();
        services.AddSingleton<NotificationStreamOriginSnapshotProvider>();
        services.AddSingleton<NotificationStreamAccountAdmissionCache>();
        services.AddScoped<INotificationStreamAdmissionService, NotificationStreamAdmissionService>();
        services.AddScoped<INotificationStreamAudienceResolver, NotificationStreamAudienceResolver>();
        services.AddScoped<INotificationStreamHandshakeRequestValidator, NotificationStreamHandshakeRequestValidator>();
        services.AddScoped<INotificationStreamRiskProofPolicy, NotificationStreamRiskProofPolicy>();
        services.AddScoped<INotificationStreamConnectionAdmission, NotificationStreamConnectionAdmission>();
        services.AddScoped<INotificationStreamHandshakeService, NotificationStreamHandshakeService>();
        services.AddScoped<INotificationStreamPreflightGrantService, NotificationStreamPreflightGrantService>();
        services.AddSingleton<INotificationStreamSessionService, NotificationStreamSessionService>();
        services.AddScoped<INotificationStreamHandler, NotificationStreamHandler>();
        services.AddSingleton<NotificationStreamConnectionManager>();
        services.AddSingleton<NotificationStreamBacklogStore>();
        services.AddSingleton<NotificationStreamLocalFanoutQueue>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<NotificationStreamLocalFanoutWorker>();
        }
        services.AddSingleton<INotificationStreamPublisher, RedisNotificationStreamPublisher>();
        return services;
    }

    private static IServiceCollection AddCrawlerAndSearchRuntime(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<SecurityRiskEventWriterOptions>(configuration.GetSection(SecurityRiskEventWriterOptions.SectionName));
        services.AddSingleton<ISecurityAdminPolicyService, SecurityAdminPolicyService>();
        services.AddSingleton<IAntiCrawlerPolicyProvider>(sp => sp.GetRequiredService<ISecurityAdminPolicyService>());
        services.AddSingleton<IPowPolicyProvider>(sp => sp.GetRequiredService<ISecurityAdminPolicyService>());
        services.AddSingleton<ISecurityRiskPolicyProvider>(sp => sp.GetRequiredService<ISecurityAdminPolicyService>());
        services.AddSingleton<CrawlerDetectorService>();
        services.AddSingleton<CrawlerRiskService>();
        services.AddSingleton<ICrawlerRiskService>(sp => sp.GetRequiredService<CrawlerRiskService>());
        services.AddSingleton<IReadProofRateLimitPartitioner, ReadProofRateLimitPartitioner>();
        services.AddSingleton<ISecurityRiskPseudonymizer, SecurityRiskPseudonymizer>();
        services.Configure<PublicHotReadRiskProjectionOptions>(configuration.GetSection(PublicHotReadRiskProjectionOptions.SectionName));
        services.AddSingleton<PublicHotReadRiskProjection>();
        services.AddSingleton<IPublicHotReadRiskProjection>(sp => sp.GetRequiredService<PublicHotReadRiskProjection>());
        services.AddSingleton<IPublicHotReadRiskProjectionPublisher, RedisPublicHotReadRiskProjectionPublisher>();
        services.AddSingleton<IVisitLogIpPseudonymizer, VisitLogIpPseudonymizer>();
        services.AddScoped<ISecurityRiskEventStore, SecurityRiskEventStore>();
        services.AddScoped<IRiskScoreEngine, RiskScoreEngine>();
        services.AddSingleton<SecurityRiskEventWriteQueue>();
        services.AddSingleton<SecurityRiskEventSink>();
        services.AddSingleton<ISecurityRiskSignalSink>(sp => sp.GetRequiredService<SecurityRiskEventSink>());
        services.AddSingleton<ISecurityRiskScoreReader>(sp => sp.GetRequiredService<SecurityRiskEventSink>());
        services.AddSingleton<CrawlerUpdateWorker>();
        services.AddSingleton<ICrawlerRangeSyncService>(sp => sp.GetRequiredService<CrawlerUpdateWorker>());
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<SecurityRiskEventWriterWorker>();
            services.AddHostedService<PublicHotReadRiskProjectionWorker>();
            services.AddHostedService(sp => sp.GetRequiredService<CrawlerUpdateWorker>());
        }
        services.AddSingleton<ISearchIndexService, SearchIndexService>();
        return services;
    }

    private static IServiceCollection AddFileAndAuthRuntime(this IServiceCollection services)
    {
        services.AddSingleton<UploadSessionCleanupQueue>();
        services.AddSingleton<FileService>();
        services.AddSingleton<IFileService>(sp => sp.GetRequiredService<FileService>());
        services.AddScoped<IAssetStore, LocalContentAssetStore>();
        services.AddScoped<SqlPrivateAssetRecordSource>();
        services.AddScoped<IPrivateAssetRecordSource>(sp => sp.GetRequiredService<SqlPrivateAssetRecordSource>());
        services.AddScoped<IPrivateAssetMetadataSource>(sp => sp.GetRequiredService<SqlPrivateAssetRecordSource>());
        services.AddSingleton<IPrivateAssetWritePolicy, PrivateAssetWritePolicy>();
        services.AddScoped<LocalPrivateAssetStore>();
        services.AddScoped<IPrivateAssetStore>(sp => sp.GetRequiredService<LocalPrivateAssetStore>());
        services.AddScoped<IPrivateAssetExistenceProbe>(sp => sp.GetRequiredService<LocalPrivateAssetStore>());
        services.AddOptions<PrivateAssetTicketOptions>()
            .BindConfiguration("PrivateAssets")
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<PrivateAssetTicketOptions>, PrivateAssetTicketOptionsValidator>();
        services.AddSingleton<PrivateAssetTicketService>();
        services.AddScoped<PrivateAssetAccessService>();
        services.AddScoped<IPrivateAssetAccessService>(sp => sp.GetRequiredService<PrivateAssetAccessService>());
        services.AddScoped<IPrivateAssetTicketRedemptionService>(sp => sp.GetRequiredService<PrivateAssetAccessService>());
        services.AddScoped<IPrivateAssetResponseWriter>(static sp => PrivateAssetResponseWriterFactory.Create(
            sp.GetRequiredService<IHostEnvironment>(),
            sp.GetRequiredService<IPrivateAssetStore>()));
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<UploadSessionCleanupWorker>();
        }
        services.AddSingleton<AuthCookieService>();
        services.AddScoped<IHumanReadProofEndpointAdapter, HumanReadProofEndpointAdapter>();
        return services;
    }

    private static IServiceCollection AddAuditRuntime(this IServiceCollection services)
    {
        services.AddSingleton<AuditLogEventMapper>();
        services.AddSingleton<AuditSerilogEnricher>();
        services.AddSingleton<AuditLogChannel>(sp => new AuditLogChannel(
            sp.GetRequiredService<IServiceScopeFactory>(),
            sp.GetRequiredService<ILogger<AuditLogChannel>>()));
        services.AddSingleton<AuditLogRuntimeState>();
        services.AddSingleton<AuditSerilogSink>();
        services.AddSingleton<IAuditFallbackWriter, AuditFallbackWriter>();
        services.AddSingleton<AdminAuditLogChannel>();
        services.AddSingleton<IAdminAuditLogChannel>(sp => sp.GetRequiredService<AdminAuditLogChannel>());
        services.AddScoped<IAuditEventService, AuditEventService>();
        services.AddSingleton<IAuditRetentionEpochKeyStore, LocalAuditRetentionEpochKeyStore>();
        services.AddSingleton<AuditRetentionPayloadProtector>();
        services.AddSingleton<AuditLegalHoldRegistry>();
        services.AddSingleton<AuditRetentionErasureService>();
        services.AddSingleton<AuditFallbackRetentionPurger>();
        services.AddScoped<AuditQueryService>();
        services.AddScoped<IAuditLogStore, AuditLogStore>();
        services.AddScoped<IAdminAuditLogStore, AdminAuditLogStore>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<AuditLogWriterWorker>();
            services.AddHostedService<AdminAuditLogWriterWorker>();
        }
        return services;
    }

    private static IServiceCollection AddMessagingRuntime(this IServiceCollection services)
    {
        services.AddScoped<MessageCacheService>();
        services.AddScoped<IMessageNotificationStreamPort, MessageNotificationStreamPort>();
        services.AddScoped<MessageCenterService>();
        services.AddScoped<IMessageQueryService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageCommandService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageRealtimePublisher>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageAdminQueueMaintenance>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageMutationOutboxDelivery>(sp => sp.GetRequiredService<MessageCenterService>());
        return services;
    }

    private static IServiceCollection AddCacheRuntime(this IServiceCollection services)
    {
        services.AddSingleton<ICachePolicyRegistry, CachePolicyRegistry>();
        services.AddSingleton<CacheLocalStore>();
        services.AddSingleton<CacheKeyResolver>();
        services.AddSingleton<ICacheKeyResolver>(sp => sp.GetRequiredService<CacheKeyResolver>());
        services.AddSingleton<CacheSingleFlightCoordinator>();
        services.AddSingleton<ICacheSingleFlightCoordinator>(sp => sp.GetRequiredService<CacheSingleFlightCoordinator>());
        services.AddSingleton<ICacheTelemetry, CacheTelemetry>();
        services.AddSingleton<UnifiedCache>();
        services.AddSingleton<ICacheTypedReader>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheRawReader>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheStringReader>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheRawWriter>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheStringWriter>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheCompareExchangeStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheCounterStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheOneTimeStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheOneTimeExchangeStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheInvalidationStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheLocalInvalidator>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheLeaseStore>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<ICacheDiagnostics>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton<IOwnedFrameCache>(sp => sp.GetRequiredService<UnifiedCache>());
        services.AddSingleton(new BackgroundWorkerLeaseOptions(
            TimeSpan.FromSeconds(5),
            TimeSpan.FromSeconds(2),
            $"{Environment.MachineName}:{Environment.ProcessId}"));
        services.AddSingleton<IBackgroundWorkerLease, BackgroundWorkerLease>();
        services.AddSingleton<ICacheMissCoordinator, CacheMissCoordinator>();
        services.AddSingleton<IDbConcurrencyGate, DbConcurrencyGate>();
        services.AddSingleton<CacheInvalidationRuntimeState>();
        services.AddSingleton<HotStatsInvalidationCoalescer>();
        services.AddSingleton<IHotStatsInvalidationCoalescer>(sp => sp.GetRequiredService<HotStatsInvalidationCoalescer>());
        services.AddSingleton<IHotArticlesCacheVersionProvider>(sp => sp.GetRequiredService<HotStatsInvalidationCoalescer>());
        services.AddSingleton<IHotArticlesCacheVersionPublisher>(sp => sp.GetRequiredService<HotStatsInvalidationCoalescer>());
        services.AddScoped<ITaxonomyCountProjectionService, TaxonomyCountProjectionService>();
        services.AddScoped<IHttpCacheInvalidator, HttpCacheInvalidator>();
        services.AddScoped<ICacheInvalidationDispatcher, CacheInvalidationDispatcher>();
        services.AddSingleton<DistributedInvalidationConvergenceRuntimeState>();
        services.AddScoped<IDistributedInvalidationObligationStore, DistributedInvalidationConvergenceObligationStore>();
        services.AddScoped<IDistributedInvalidationDeliveryLedger, DistributedInvalidationConvergenceObligationStore>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService(sp => sp.GetRequiredService<HotStatsInvalidationCoalescer>());
        }
        services.AddSingleton<IAdminBackupStatusReader, AdminBackupStatusReader>();
        services.AddScoped<IAdminArtifactOperations, AdminArtifactOperations>();
        services.AddScoped<IAdminCacheDiagnosticsReader, AdminCacheDiagnosticsReader>();
        services.AddScoped<IAdminOperationsHealthReader, AdminOperationsHealthReader>();
        services.AddSingleton<IAdminDangerousOperationPolicyReader, AdminDangerousOperationPolicyReader>();
        services.AddScoped<IAdminIntegrityOperations, AdminIntegrityOperations>();
        return services;
    }

    private static IServiceCollection AddPublicReadArtifactRuntime(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<PublicHotReadOptions>(configuration.GetSection("PublicHotRead"));
        services.AddOptions<PublicArtifactRevocationOptions>()
            .Bind(configuration.GetSection("PublicArtifactRevocation"))
            .Validate(static options => options.IsValid(), "PublicArtifactRevocation CDN provider configuration is invalid")
            .ValidateOnStart();
        services.Configure<PublicAotHtmlArtifactOptions>(configuration.GetSection("PublicAot"));
        services.AddSingleton<PublicHotReadEarlyDataPlaneRuntimeState>();
        services.AddSingleton<PublicHotReadClassifierCounters>();
        services.AddSingleton<PublicHotReadStore>();
        services.AddSingleton<PublicHotReadCounters>();
        services.AddSingleton<PublicArtifactRevocationRegistry>();
        services.AddSingleton<LocalPublicArtifactStorage>();
        services.AddSingleton<IPublicArtifactStorage>(sp => sp.GetRequiredService<LocalPublicArtifactStorage>());
        services.AddSingleton<IPublicArtifactRevocationStateStore, RedisPublicArtifactRevocationStateStore>();
        services.AddSingleton<RedisPublicHotArtifactDeliveryStateStore>();
        services.AddSingleton<IPublicHotArtifactDeliveryStateStore>(static sp => sp.GetRequiredService<RedisPublicHotArtifactDeliveryStateStore>());
        services.AddSingleton<IPublicHotArtifactObligationStore>(static sp => sp.GetRequiredService<RedisPublicHotArtifactDeliveryStateStore>());
        services.AddSingleton<IPublicArtifactCdnPurger, HttpPublicArtifactCdnPurger>();
        services.AddSingleton<IPublicArtifactRevocationCoordinator, PublicArtifactRevocationCoordinator>();
        services.AddScoped<PublicReadSecurityGate>();
        services.AddSingleton<PublicHotArtifactUpdateQueue>();
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService<PublicHotReadMetricFlushWorker>();
            services.AddHostedService<PublicHotReadStartupWarmupService>();
            services.AddHostedService<PublicArtifactRevocationSubscriber>();
            services.AddHostedService<PublicMutationFenceRecoveryWorker>();
            services.AddHostedService<PublicHotArtifactUpdateWorker>();
        }
        services.AddScoped<IPublicHotArtifactProjector, PublicHotArtifactProjector>();
        services.AddSingleton<IArticleDetailAedsArtifactStore, ArticleDetailAedsFileArtifactStore>();
        services.AddSingleton<PublicArticleProjectionRuntimeState>();
        services.AddSingleton<PublicArticleProjectionNegativeCache>();
        services.AddSingleton<PublicArticleProjectionDataSourceProvider>();
        services.AddScoped<IPublicArticleProjectionStore, PublicArticleProjectionStore>();
        services.AddSingleton<ArticleDetailAedsArtifactBackfillScheduler>();
        services.AddSingleton<IArticleDetailAedsArtifactBackfillScheduler>(sp => sp.GetRequiredService<ArticleDetailAedsArtifactBackfillScheduler>());
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService<ArticleDetailAedsArtifactBackfillWorker>();
        }
        services.AddScoped<IArticleDetailAedsArtifactProjector, ArticleDetailAedsArtifactProjector>();
        services.AddScoped<IArticleDetailAedsArtifactMaintenanceService, ArticleDetailAedsArtifactMaintenanceService>();
        return services;
    }

    private static IServiceCollection AddIdentityRuntime(this IServiceCollection services)
    {
        services.AddScoped<IBlacklistService, BlacklistService>();
        return services;
    }

    private static IServiceCollection AddFontRuntime(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        string fontRoot = Path.Combine(Path.GetFullPath(dataRoot), "fonts");
        services.AddSingleton<IFontRegistry>(provider => new LocalFontRegistry(
            fontRoot,
            provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<IFontStackRuntime, FontStackRuntime>();
        services.AddSingleton<IFontLoadingPlanner, FontLoadingPlanner>();
        return services;
    }

    private static IServiceCollection AddBackgroundRuntime(this IServiceCollection services)
    {
        services.AddSingleton<VisitLogChannel>();
        services.AddSingleton<ArticleAssetCleanupQueue>();
        services.AddSingleton<ArticleBodyRepairQueue>();
        services.AddScoped<ArticleAssetCleanupService>();
        services.AddScoped<ArticleBodyRepairService>();
        services.AddScoped<MessageRetentionCleanupService>();
        services.AddScoped<IArticleViewProjectionService, ArticleViewProjectionService>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<VisitLogProcessorService>();
        }
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService<LogCleanupService>();
            services.AddHostedService<ArticleMutationOutboxDispatcher>();
            services.AddHostedService<ArticleAssetCleanupWorker>();
            services.AddHostedService<ArticleBodyRepairWorker>();
            services.AddHostedService<RumTelemetryFlushWorker>();
        }
        services.AddSingleton<ScheduledPublishRuntimeState>();
        services.AddSingleton<MessageMutationOutboxRuntimeState>();
        services.AddSingleton<MessageMutationOutboxWorker>();
        if (!OpenApiExportMode.IsEnabled())
        {
            services.AddHostedService(static provider => provider.GetRequiredService<MessageMutationOutboxWorker>());
            services.AddHostedService<ScheduledPublishWorker>();
        }
        return services;
    }

    private static IServiceCollection AddSpaRuntime(this IServiceCollection services)
    {
        services.AddSingleton<ISpaAssetManifestService, SpaAssetManifestService>();
        return services;
    }

    private static IServiceCollection AddCustomizationRuntime(this IServiceCollection services)
    {
        services.AddSingleton<InMemoryCustomizationProfileStore>();
        services.AddScoped<ICustomizationProfileStore, PostgresCustomizationProfileStore>();
        return services;
    }

}

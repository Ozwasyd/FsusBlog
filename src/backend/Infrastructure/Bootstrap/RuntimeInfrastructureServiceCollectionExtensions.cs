using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Sse;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.ObjectPool;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeInfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeInfrastructureServices(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<StartupRuntimeState>();
        services.AddBinaryRuntime();
        services.AddNotificationRuntime();
        services.AddCrawlerAndSearchRuntime();
        services.AddFileAndAuthRuntime();
        services.AddAuditRuntime();
        services.AddMessagingRuntime();
        services.AddCacheRuntime();
        services.AddPublicReadArtifactRuntime(configuration);
        services.AddIdentityRuntime();
        services.AddBackgroundRuntime();
        services.AddSpaRuntime();
        services.AddObjectPools();

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
        services.AddScoped<INotificationStreamAdmissionService, NotificationStreamAdmissionService>();
        services.AddScoped<INotificationStreamAudienceResolver, NotificationStreamAudienceResolver>();
        services.AddScoped<INotificationStreamHandshakeService, NotificationStreamHandshakeService>();
        services.AddSingleton<INotificationStreamSessionService, NotificationStreamSessionService>();
        services.AddScoped<INotificationStreamHandler, NotificationStreamHandler>();
        services.AddSingleton<SseConnectionManager>();
        services.AddSingleton<SseBacklogStore>();
        services.AddSingleton<SseLocalFanoutQueue>();
        services.AddHostedService<SseLocalFanoutWorker>();
        services.AddSingleton<ISsePublisher, RedisSsePublisher>();
        return services;
    }

    private static IServiceCollection AddCrawlerAndSearchRuntime(this IServiceCollection services)
    {
        services.AddSingleton<CrawlerDetectorService>();
        services.AddSingleton<ICrawlerRiskService, CrawlerRiskService>();
        services.AddHostedService<CrawlerUpdateWorker>();
        services.AddSingleton<ISearchIndexService, SearchIndexService>();
        return services;
    }

    private static IServiceCollection AddFileAndAuthRuntime(this IServiceCollection services)
    {
        services.AddSingleton<UploadSessionCleanupQueue>();
        services.AddScoped<FileService>();
        services.AddScoped<IFileService>(sp => sp.GetRequiredService<FileService>());
        services.AddHostedService<UploadSessionCleanupWorker>();
        services.AddSingleton<AuthCookieService>();
        services.AddScoped<IHumanReadProofEndpointAdapter, HumanReadProofEndpointAdapter>();
        return services;
    }

    private static IServiceCollection AddAuditRuntime(this IServiceCollection services)
    {
        services.AddSingleton<AuditLogEventMapper>();
        services.AddSingleton<AuditSerilogEnricher>();
        services.AddSingleton<AuditLogChannel>();
        services.AddSingleton<AuditSerilogSink>();
        services.AddScoped<IAuditLogStore, AuditLogStore>();
        services.AddHostedService<AuditLogWriterWorker>();
        return services;
    }

    private static IServiceCollection AddMessagingRuntime(this IServiceCollection services)
    {
        services.AddScoped<MessageCacheService>();
        services.AddScoped<IMessageSsePort, MessageSsePort>();
        services.AddScoped<MessageCenterService>();
        services.AddScoped<IMessageQueryService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageCommandService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageRealtimePublisher>(sp => sp.GetRequiredService<MessageCenterService>());
        return services;
    }

    private static IServiceCollection AddCacheRuntime(this IServiceCollection services)
    {
        services.AddSingleton<ICachePolicyRegistry, CachePolicyRegistry>();
        services.AddSingleton<IUnifiedCache, UnifiedCache>();
        services.AddSingleton<ICacheMissCoordinator, CacheMissCoordinator>();
        services.AddSingleton<IDbConcurrencyGate, DbConcurrencyGate>();
        services.AddScoped<IHttpCacheInvalidator, HttpCacheInvalidator>();
        services.AddScoped<ICacheInvalidationDispatcher, CacheInvalidationDispatcher>();
        return services;
    }

    private static IServiceCollection AddPublicReadArtifactRuntime(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<PublicHotReadOptions>(configuration.GetSection("PublicHotRead"));
        services.AddSingleton<PublicHotReadStore>();
        services.AddSingleton<PublicHotReadCounters>();
        services.AddSingleton<PublicHotArtifactUpdateQueue>();
        services.AddHostedService<PublicHotReadMetricFlushWorker>();
        services.AddHostedService<PublicHotReadStartupWarmupService>();
        services.AddHostedService<PublicHotArtifactUpdateWorker>();
        services.AddScoped<IPublicHotArtifactProjector, PublicHotArtifactProjector>();
        services.AddSingleton<IArticleDetailAedsArtifactStore, ArticleDetailAedsFileArtifactStore>();
        services.AddSingleton<ArticleDetailAedsArtifactBackfillScheduler>();
        services.AddSingleton<IArticleDetailAedsArtifactBackfillScheduler>(sp => sp.GetRequiredService<ArticleDetailAedsArtifactBackfillScheduler>());
        services.AddHostedService<ArticleDetailAedsArtifactBackfillWorker>();
        services.AddScoped<IArticleDetailAedsArtifactProjector, ArticleDetailAedsArtifactProjector>();
        return services;
    }

    private static IServiceCollection AddIdentityRuntime(this IServiceCollection services)
    {
        services.AddScoped<IBlacklistService, BlacklistService>();
        services.AddSingleton<IUserIdProvider, SnowflakeUserIdProvider>();
        return services;
    }

    private static IServiceCollection AddBackgroundRuntime(this IServiceCollection services)
    {
        services.AddSingleton<VisitLogChannel>();
        services.AddScoped<IArticleViewProjectionService, ArticleViewProjectionService>();
        services.AddHostedService<VisitLogProcessorService>();
        services.AddHostedService<ArticleViewProjectionRepairWorker>();
        services.AddSingleton(TimeProvider.System);
        services.AddHostedService<LogCleanupService>();
        services.AddHostedService<ArticleMutationOutboxDispatcher>();
        services.AddSingleton<ScheduledPublishRuntimeState>();
        services.AddHostedService<ScheduledPublishWorker>();
        return services;
    }

    private static IServiceCollection AddSpaRuntime(this IServiceCollection services)
    {
        services.AddSingleton<ISpaAssetManifestService, SpaAssetManifestService>();
        return services;
    }

    private static IServiceCollection AddObjectPools(this IServiceCollection services)
    {
        services.TryAddSingleton<ObjectPoolProvider, DefaultObjectPoolProvider>();
        services.AddSingleton(CreateIp2LocationPool);
        return services;
    }

    private static ObjectPool<IP2Location.Component> CreateIp2LocationPool(IServiceProvider sp)
    {
        var logger = sp.GetRequiredService<ILogger<IP2LocationPooledObjectPolicy>>();

        string baseDir = AppContext.BaseDirectory;
        string? binPath = ProductionResourcePaths.ResolveIp2LocationBinPath(baseDir);

        if (string.IsNullOrEmpty(binPath))
        {
            string[] allFiles = Directory.GetFiles(baseDir, "IP2LOCATION.BIN", SearchOption.AllDirectories);
            throw new FileNotFoundException($"[严重] 找不到数据库文件。BaseDir: {baseDir}。 实际发现于: {string.Join(", ", allFiles)}");
        }

        var policy = new IP2LocationPooledObjectPolicy(binPath, logger);
        return sp.GetRequiredService<ObjectPoolProvider>().Create(policy);
    }
}

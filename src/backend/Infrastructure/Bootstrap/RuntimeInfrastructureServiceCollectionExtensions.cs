using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Sse;
using FsusBlog.Server.Services.VistitLog;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.ObjectPool;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeInfrastructureServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeInfrastructureServices(this IServiceCollection services)
    {
        services.AddSingleton<StartupRuntimeState>();
        services.AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>();
        services.AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>();
        services.AddScoped<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>();
        services.AddSingleton<INotificationFrameCodec, NotificationFrameCodec>();
        services.AddScoped<INotificationStreamAdmissionService, NotificationStreamAdmissionService>();
        services.AddScoped<INotificationStreamAudienceResolver, NotificationStreamAudienceResolver>();
        services.AddScoped<INotificationStreamHandshakeService, NotificationStreamHandshakeService>();
        services.AddSingleton<INotificationStreamSessionService, NotificationStreamSessionService>();
        services.AddScoped<INotificationStreamHandler, NotificationStreamHandler>();
        services.AddSingleton<SseConnectionManager>();
        services.AddSingleton<SseBacklogStore>();
        services.AddSingleton<ISsePublisher, RedisSsePublisher>();
        services.AddSingleton<CrawlerDetectorService>();
        services.AddHostedService<CrawlerUpdateWorker>();
        services.AddSingleton<ISearchIndexService, SearchIndexService>();

        services.AddScoped<IFileService, FileService>();
        services.AddSingleton<AuthCookieService>();
        services.AddScoped<IHumanReadProofEndpointAdapter, HumanReadProofEndpointAdapter>();
        services.AddSingleton<AuditLogEventMapper>();
        services.AddSingleton<AuditSerilogEnricher>();
        services.AddSingleton<AuditLogChannel>();
        services.AddSingleton<AuditSerilogSink>();
        services.AddScoped<IAuditLogStore, AuditLogStore>();
        services.AddHostedService<AuditLogWriterWorker>();

        services.AddScoped<MessageCacheService>();
        services.AddScoped<IMessageSsePort, MessageSsePort>();
        services.AddScoped<MessageCenterService>();
        services.AddScoped<IMessageQueryService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageCommandService>(sp => sp.GetRequiredService<MessageCenterService>());
        services.AddScoped<IMessageRealtimePublisher>(sp => sp.GetRequiredService<MessageCenterService>());

        services.AddSingleton<ICachePolicyRegistry, CachePolicyRegistry>();
        services.AddSingleton<IUnifiedCache, UnifiedCache>();
        services.AddSingleton<ICacheMissCoordinator, CacheMissCoordinator>();
        services.AddSingleton<IDbConcurrencyGate, DbConcurrencyGate>();
        services.AddScoped<IHttpCacheInvalidator, HttpCacheInvalidator>();
        services.AddScoped<ICacheInvalidationDispatcher, CacheInvalidationDispatcher>();

        services.AddScoped<IBlacklistService, BlacklistService>();
        services.AddSingleton<IUserIdProvider, SnowflakeUserIdProvider>();

        services.AddSingleton<VisitLogChannel>();
        services.AddScoped<IArticleViewProjectionService, ArticleViewProjectionService>();
        services.AddHostedService<VisitLogProcessorService>();
        services.AddSingleton(TimeProvider.System);
        services.AddHostedService<LogCleanupService>();
        services.AddSingleton<ScheduledPublishRuntimeState>();
        services.AddHostedService<ScheduledPublishWorker>();
        services.AddSingleton<ISpaAssetManifestService, SpaAssetManifestService>();
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

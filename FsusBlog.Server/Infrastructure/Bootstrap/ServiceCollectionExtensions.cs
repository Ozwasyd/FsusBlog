using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Hosting;
using FsusBlog.Core.DependencyInjection;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Sse;
using FsusBlog.Server.Services.VistitLog;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddFsusApiFoundation(this IServiceCollection services, IConfiguration configuration)
    {
        var origins = ResolveCorsOrigins(configuration);

        services.AddCors(options =>
        {
            options.AddDefaultPolicy(policy =>
            {
                policy.WithOrigins(origins)
                    .AllowAnyHeader()
                    .AllowAnyMethod()
                    .AllowCredentials();
            });
        });

        services.AddControllers()
            .AddJsonOptions(options => options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
        services.AddOutputCache();
        services.AddHttpContextAccessor();
        services.AddEndpointsApiExplorer();

        services.AddRedis(configuration);
        services.AddSqlSugar();
        services.AddJwtAuthentication(configuration);
        services.AddFsusBlogCore(configuration);
        services.AddPowServices();
        services.AddDataProtection();
        services.AddMemoryCache();
        services.AddHttpClient();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        });

        return services;
    }

    private static string[] ResolveCorsOrigins(IConfiguration configuration)
    {
        var configured = configuration["CORS_ALLOWED_HOSTS"];
        bool isDevelopment = string.Equals(
            configuration["ASPNETCORE_ENVIRONMENT"],
            Environments.Development,
            StringComparison.OrdinalIgnoreCase);

        HashSet<string> origins = [];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            string[] rawOrigins = configured.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            for (int i = 0; i < rawOrigins.Length; i++)
            {
                string raw = rawOrigins[i];
                if (!Uri.TryCreate(raw, UriKind.Absolute, out Uri? uri)
                    || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                    || !string.IsNullOrEmpty(uri.AbsolutePath.Trim('/'))
                    || !string.IsNullOrEmpty(uri.Query)
                    || !string.IsNullOrEmpty(uri.Fragment))
                {
                    throw new InvalidOperationException($"CORS_ALLOWED_HOSTS 存在非法 origin：{raw}");
                }

                origins.Add(uri.GetLeftPart(UriPartial.Authority));
            }
        }

        if (origins.Count == 0)
        {
            if (!isDevelopment)
            {
                throw new InvalidOperationException("CORS_ALLOWED_HOSTS 未配置。生产环境启用 AllowCredentials 时必须显式声明可信 origin。");
            }

            origins.Add("http://localhost:3000");
            origins.Add("http://127.0.0.1:3000");
        }

        return [.. origins];
    }

    public static IServiceCollection AddFsusRuntimeServices(this IServiceCollection services)
    {
        services.AddSingleton<SseConnectionManager>();
        services.AddSingleton<SseBacklogStore>();
        services.AddSingleton<ISsePublisher, RedisSsePublisher>();
        services.AddSingleton<CrawlerDetectorService>();
        services.AddHostedService<CrawlerUpdateWorker>();

        services.AddScoped<IFileService, FileService>();
        services.AddSingleton<AuthCookieService>();
        services.AddSingleton<AuditLogEventMapper>();
        services.AddSingleton<AuditSerilogEnricher>();
        services.AddSingleton<AuditLogChannel>();
        services.AddSingleton<AuditSerilogSink>();
        services.AddScoped<IAuditLogStore, AuditLogStore>();
        services.AddHostedService<AuditLogWriterWorker>();
        services.AddScoped<MessageCacheService>();
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
        services.AddScoped<ITotpService, TotpService>();
        services.AddScoped<IMfaChallengeService, MfaChallengeService>();
        services.AddScoped<IAuthRiskService, AuthRiskService>();

        services.AddSingleton<VisitLogChannel>();
        services.AddHostedService<VisitLogProcessorService>();
        services.AddHostedService<LogCleanupService>();
        services.AddSingleton<PublicAotBackfillScheduler>();
        services.AddSingleton<IPublicAotBackfillScheduler>(sp => sp.GetRequiredService<PublicAotBackfillScheduler>());
        services.AddHostedService<PublicAotBackfillWorker>();
        services.AddSingleton<IContentFilterService, ContentFilterService>();
        services.AddScoped<ProductionReadinessProbe>();
        services.AddScoped<IPublicAotShellCache, PublicAotFileShellCache>();
        services.AddScoped<IPublicAotCacheWriter, PublicAotCacheWriter>();
        services.AddSingleton<IPublicAotSsrRenderer, PublicAotNodeSsrRenderer>();
        services.AddScoped<PublicAotShellService>();
        services.AddScoped<IPublicAotShellService>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotBackfillGenerator>(sp => sp.GetRequiredService<PublicAotShellService>());
        services.AddScoped<IPublicAotInvalidationService, PublicAotInvalidationService>();

        services.AddScoped<ArticleService>();
        services.AddScoped<CommentService>();
        services.AddScoped<UserService>();
        services.AddScoped<SystemService>();
        services.AddScoped<StatsService>();

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

        services.AddScoped<CacheInitializer>();
        services.AddSingleton<ISchemaMigrationRegistry, SchemaMigrationRegistry>();
        services.AddSingleton<ISchemaModelInspector, SchemaModelInspector>();
        services.AddSingleton<ISchemaMigrationLock, SchemaMigrationLock>();
        services.AddScoped<ISchemaMigrationRunner, SchemaMigrationRunner>();
        return services;
    }

    public static IServiceCollection AddFsusRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            options.AddPolicy("fixed_ip", httpContext =>
            {
                string clientIp = httpContext.GetClientIp();

                if (httpContext.User.IsInRole("admin") || clientIp == "127.0.0.1" || clientIp == "::1")
                {
                    return RateLimitPartition.GetNoLimiter("admin");
                }

                return RateLimitPartition.GetFixedWindowLimiter(clientIp, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 100,
                    Window = TimeSpan.FromMinutes(1),
                    AutoReplenishment = true,
                    QueueLimit = 2,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst
                });
            });
        });

        return services;
    }
}

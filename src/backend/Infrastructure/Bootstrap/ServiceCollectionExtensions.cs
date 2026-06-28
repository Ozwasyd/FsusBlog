using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using FsusBlog.Core.DependencyInjection;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
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

        services.AddOutputCache();
        services.AddHttpContextAccessor();
        services.AddSingleton<ITestSessionKeyScope, HttpTestSessionKeyScope>();
        services.AddScoped<ITestSessionContext, TestSessionContext>();
        services.AddSingleton<IRuntimeKeyScope, TestAwareRuntimeKeyScope>();
        services.AddEndpointsApiExplorer();
        services.AddOpenApi();

        services.AddRedis(configuration);
        services.AddSqlSugar();
        services.AddJwtAuthentication(configuration);
        services.AddAuthorization();
        services.AddFsusBlogCore(configuration);
        services.AddPowServices();
        services.AddFsusDataProtection(configuration);
        services.AddMemoryCache();
        services.AddHttpClient();

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

    private static IServiceCollection AddFsusDataProtection(this IServiceCollection services, IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        string keyRingPath = configuration["DataProtection:KeyRingPath"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_PROTECTION_KEY_RING")
            ?? Path.Combine(dataRoot, "data-protection-keys");
        string applicationName = configuration["DataProtection:ApplicationName"] ?? "FsusBlog";

        Directory.CreateDirectory(keyRingPath);
        services.AddDataProtection()
            .SetApplicationName(applicationName)
            .PersistKeysToFileSystem(new DirectoryInfo(keyRingPath));

        return services;
    }

    public static IServiceCollection AddFsusRuntimeServices(this IServiceCollection services, IConfiguration configuration)
    {
        return services
            .AddFsusRuntimeSecurityAndLifecycleServices(configuration)
            .AddFsusRuntimeInfrastructureServices(configuration)
            .AddFsusRuntimePublicAotServices()
            .AddFsusRuntimeDomainServices();
    }

    public static IServiceCollection AddFsusRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = async (context, cancellationToken) =>
            {
                context.HttpContext.Response.Headers["Retry-After"] = "60";
                FsusObservability.RecordSecurityEvent("rate_limited", "rate_limited", "rejected");
                var risk = context.HttpContext.RequestServices.GetService<ISecurityRiskSignalSink>();
                if (risk is not null)
                {
                    await risk.AddRiskAsync(new SecurityRiskSignal(
                        context.HttpContext,
                        SecurityRiskReason.RateLimited,
                        10,
                        TimeSpan.FromMinutes(10),
                        SecurityRiskSources.RateLimiter,
                        "rate_limited",
                        "fixed_window_rejected"), cancellationToken);
                }
            };

            options.AddPolicy("fixed_ip", httpContext =>
            {
                string clientIp = httpContext.GetClientIp();
                var policy = httpContext.RequestServices.GetRequiredService<IAntiCrawlerPolicyProvider>().Current.Options;
                var configuration = httpContext.RequestServices.GetRequiredService<IConfiguration>();

                if (httpContext.User.IsAdminPrincipal() && httpContext.User.TryGetAdminPrincipalId(out _))
                {
                    int adminPermitLimit = Math.Clamp(
                        configuration.GetValue("RateLimiting:AdminPermitLimit", 300),
                        1,
                        100_000);
                    int adminQueueLimit = Math.Clamp(
                        configuration.GetValue("RateLimiting:AdminQueueLimit", 0),
                        0,
                        10_000);

                    return CreateFixedWindowPartition($"fixed-ip:admin:{clientIp}", adminPermitLimit, adminQueueLimit);
                }

                if (clientIp == "127.0.0.1" || clientIp == "::1")
                {
                    return RateLimitPartition.GetNoLimiter("loopback");
                }

                if (IsVerifiedCrawlerPublicRead(httpContext))
                {
                    return CreateFixedWindowPartition($"verified-crawler:{clientIp}", policy.VerifiedCrawlerFixedIpPermitLimit, 0);
                }

                return RateLimitPartition.GetFixedWindowLimiter(clientIp, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = policy.FixedIpPermitLimit,
                    Window = TimeSpan.FromMinutes(1),
                    AutoReplenishment = true,
                    QueueLimit = policy.FixedIpQueueLimit,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst
                });
            });

            options.AddPolicy("read_proof", httpContext =>
            {
                var policy = httpContext.RequestServices.GetRequiredService<IAntiCrawlerPolicyProvider>().Current.Options;
                string deviceFp = httpContext.Request.Headers["X-Fsus-Device-Fp"].ToString();
                string key = string.IsNullOrWhiteSpace(deviceFp)
                    ? $"{httpContext.GetClientIp()}:{httpContext.Request.Path}"
                    : $"{httpContext.GetClientIp()}:{deviceFp}:{httpContext.Request.Path}";
                return CreateFixedWindowPartition($"read-proof:{key}", policy.ReadProofPermitLimit, 0);
            });

            options.AddPolicy("notification_stream", httpContext =>
            {
                var configuration = httpContext.RequestServices.GetRequiredService<IConfiguration>();
                string clientIp = httpContext.GetClientIp();
                string account = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                    ?? httpContext.User.FindFirst("nameid")?.Value
                    ?? "anonymous";
                string path = httpContext.Request.Path.Value ?? "/api/notifications/stream";
                int permitLimit = Math.Clamp(
                    configuration.GetValue("RateLimiting:NotificationStreamPermitLimit", 120),
                    1,
                    100_000);
                int queueLimit = Math.Clamp(
                    configuration.GetValue("RateLimiting:NotificationStreamQueueLimit", 0),
                    0,
                    10_000);

                return CreateFixedWindowPartition($"notification-stream:{clientIp}:{account}:{path}", permitLimit, queueLimit);
            });

            options.AddPolicy("public_read", httpContext =>
            {
                string clientIp = httpContext.GetClientIp();
                string path = GetPublicReadPartitionPath(httpContext);
                var policy = httpContext.RequestServices.GetRequiredService<IAntiCrawlerPolicyProvider>().Current.Options;

                if (IsVerifiedCrawlerPublicRead(httpContext))
                {
                    return CreateFixedWindowPartition($"public-read:verified-crawler:{clientIp}:{path}", policy.VerifiedCrawlerPublicReadPermitLimit, 0);
                }

                if (httpContext.Items.TryGetValue("SocialPreviewBot", out object? socialPreview) && socialPreview is true)
                {
                    return CreateFixedWindowPartition($"public-read:social:{clientIp}:{path}", policy.SocialPreviewPublicReadPermitLimit, 0);
                }

                return CreateFixedWindowPartition($"public-read:{clientIp}:{path}", policy.PublicReadPermitLimit, policy.PublicReadQueueLimit);
            });
        });

        return services;
    }

    private static bool IsVerifiedCrawlerPublicRead(HttpContext httpContext)
        => httpContext.Items.TryGetValue("VerifiedCrawler", out object? value)
            && value is true
            && (HttpMethods.IsGet(httpContext.Request.Method) || HttpMethods.IsHead(httpContext.Request.Method));

    private static string GetPublicReadPartitionPath(HttpContext httpContext)
    {
        Endpoint? endpoint = httpContext.GetEndpoint();
        if (!string.IsNullOrWhiteSpace(endpoint?.DisplayName))
        {
            return endpoint.DisplayName;
        }

        return httpContext.Request.Path.Value ?? "/";
    }

    private static RateLimitPartition<string> CreateFixedWindowPartition(string key, int permitLimit, int queueLimit)
        => RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permitLimit,
            Window = TimeSpan.FromMinutes(1),
            AutoReplenishment = true,
            QueueLimit = queueLimit,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst
        });
}

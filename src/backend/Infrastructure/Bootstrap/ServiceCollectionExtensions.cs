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
                var risk = context.HttpContext.RequestServices.GetService<ICrawlerRiskService>();
                if (risk is not null)
                {
                    await risk.AddRiskAsync(context.HttpContext, CrawlerRiskReason.RateLimited, 10, TimeSpan.FromMinutes(10), cancellationToken);
                }
            };

            options.AddPolicy("fixed_ip", httpContext =>
            {
                string clientIp = httpContext.GetClientIp();

                if (httpContext.User.IsInRole("admin") || clientIp == "127.0.0.1" || clientIp == "::1")
                {
                    return RateLimitPartition.GetNoLimiter("admin");
                }

                if (IsVerifiedCrawlerPublicRead(httpContext))
                {
                    return CreateFixedWindowPartition($"verified-crawler:{clientIp}", 1000, 0);
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

            options.AddPolicy("read_proof", httpContext =>
            {
                string deviceFp = httpContext.Request.Headers["X-Fsus-Device-Fp"].ToString();
                string key = string.IsNullOrWhiteSpace(deviceFp)
                    ? $"{httpContext.GetClientIp()}:{httpContext.Request.Path}"
                    : $"{httpContext.GetClientIp()}:{deviceFp}:{httpContext.Request.Path}";
                return CreateFixedWindowPartition($"read-proof:{key}", 30, 0);
            });

            options.AddPolicy("public_read", httpContext =>
            {
                string clientIp = httpContext.GetClientIp();
                string path = GetPublicReadPartitionPath(httpContext);

                if (IsVerifiedCrawlerPublicRead(httpContext))
                {
                    return CreateFixedWindowPartition($"public-read:verified-crawler:{clientIp}:{path}", 1000, 0);
                }

                if (httpContext.Items.TryGetValue("SocialPreviewBot", out object? socialPreview) && socialPreview is true)
                {
                    return CreateFixedWindowPartition($"public-read:social:{clientIp}:{path}", 30, 0);
                }

                return CreateFixedWindowPartition($"public-read:{clientIp}:{path}", 120, 2);
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

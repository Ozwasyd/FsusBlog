using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.SignalR;
using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

public static class SignalRInitializer
{
    public static void AddSignalR(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Redis");
        if (string.IsNullOrEmpty(connectionString))
        {
            throw new InvalidOperationException("致命错误：appsettings.json 中未配置 Redis 连接字符串。");
        }

        // 预定义配置选项，优化高并发性能
        var redisOptions = ConfigurationOptions.Parse(connectionString);
        redisOptions.ClientName = "SignalR_Backplane"; // 方便在 Redis 中监控
        redisOptions.AbortOnConnectFail = false;      // 关键：防止 Redis 闪断导致整个应用启动失败
        redisOptions.ConnectTimeout = 5000;           // 针对单机环境优化连接超时
        redisOptions.SyncTimeout = 5000;

        services.AddSignalR(hubOptions =>
        {
            // 高性能设置：增加单个消息的最大长度限制
            hubOptions.MaximumReceiveMessageSize = 16384;
            hubOptions.HandshakeTimeout = TimeSpan.FromSeconds(5);
            hubOptions.EnableDetailedErrors = false; // 生产环境关闭详细错误以提升安全和性能
            hubOptions.AddFilter<SignalRPoWFilter>();
        })
            .AddStackExchangeRedis(options =>
            {
                options.Configuration = redisOptions;
                options.Configuration.ChannelPrefix = RedisChannel.Literal("Site_Notice_Pipe");

            });
    }
}

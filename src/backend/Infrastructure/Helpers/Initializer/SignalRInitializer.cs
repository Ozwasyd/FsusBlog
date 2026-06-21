using FsusBlog.Server.Infrastructure.Filters;
using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// SignalR 初始化器
/// 修复日期: 2026-02-23 (修正DI容器注入Bug，采用舱壁模式隔离Redis连接，注入极速用户ID解析器)
/// </summary>
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

        // 性能与稳定性加固：为 Pub/Sub 专属连接配置更优的保活机制。
        // 默认 60 秒，改为 30 秒，有效防止各种云服务商的 NAT 防火墙因长时间无数据而静默丢弃 TCP 连接。
        redisOptions.KeepAlive = 30;

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

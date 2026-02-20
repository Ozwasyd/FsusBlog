using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// Redis 基础设施注册
/// </summary>
public static class RedisInitializer
{
    public static void AddRedis(this IServiceCollection services, IConfiguration configuration)
    {
        // 1. 获取并校验连接字符串
        var connectionString = configuration.GetConnectionString("Redis");
        if (string.IsNullOrEmpty(connectionString))
        {
            throw new InvalidOperationException("致命错误：appsettings.json 中未配置 Redis 连接字符串。");
        }

        // 2. 解析配置选项 (支持更多高级设置，如密码、连接池等)
        var redisOptions = ConfigurationOptions.Parse(connectionString);
        redisOptions.AbortOnConnectFail = false; // 允许在 Redis 暂时不可用时启动，以便触发 Fallback 降级逻辑

        // 3. 注册单例连接器，供全站共享
        var multiplexer = ConnectionMultiplexer.Connect(redisOptions);
        services.AddSingleton<IConnectionMultiplexer>(multiplexer);

        // 4. 配置分布式缓存 (共享上面的单例连接)
        var instanceName = configuration.GetSection("RedisOptions:InstanceName").Value ?? "FsusBlog_";

        services.AddStackExchangeRedisCache(options =>
        {
            // 通过 ConnectionMultiplexerFactory 共享连接，避免创建第二个物理连接
            options.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(multiplexer);
            options.InstanceName = instanceName;
        });
    }
}
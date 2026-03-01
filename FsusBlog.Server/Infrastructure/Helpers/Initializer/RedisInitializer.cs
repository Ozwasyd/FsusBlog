using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// Redis 基础设施注册
/// 修复日期: 2026-02-23 (引入延迟异步连接以消除启动阻塞，配置高并发连接池与保活策略，提升极限抗压能力)
/// </summary>
public static class RedisInitializer
{
    public static void AddRedis(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Redis");
        if (string.IsNullOrEmpty(connectionString))
        {
            throw new InvalidOperationException("致命错误：appsettings.json 中未配置 Redis 连接字符串。");
        }

        var redisOptions = ConfigurationOptions.Parse(connectionString);

        // 核心稳定性配置：
        redisOptions.AbortOnConnectFail = false;

        // 极限抗压优化：自动重连机制增强。在线上环境，Redis 可能发生短暂的主从切换或网络抖动
        redisOptions.ConnectRetry = 5;

        // 保活优化：解决云服务器环境（如 AWS/Aliyun）由于 NAT 会话超时导致的长连接静默断开问题
        redisOptions.KeepAlive = 15;

        // 增加吞吐量：在单实例连接下，适当调高异步操作的超时容忍度，配合外部的限流保护
        redisOptions.AsyncTimeout = 15000;
        redisOptions.SyncTimeout = 15000;

        // 核心性能优化：延迟+异步连接。
        // 不要在 ConfigureServices 阶段同步阻塞主线程。使用 Lazy 包装异步连接，
        // 确保应用能瞬间启动并响应 K8s 的 Liveness 探针，直到第一次实际调用才建立连接。
        var lazyMultiplexer = new Lazy<Task<IConnectionMultiplexer>>(
            async () => await ConnectionMultiplexer.ConnectAsync(redisOptions)
        );

        // 注册工厂方法，解析时解包 Task
        services.AddSingleton(sp => lazyMultiplexer.Value.GetAwaiter().GetResult());

        var instanceName = configuration.GetSection("RedisOptions:InstanceName").Value ?? "FsusBlog_";

        services.AddStackExchangeRedisCache(options =>
        {
            // 通过 ConnectionMultiplexerFactory 共享底层被延迟创建的连接实例
            options.ConnectionMultiplexerFactory = () => lazyMultiplexer.Value;
            options.InstanceName = instanceName;
        });
    }
}
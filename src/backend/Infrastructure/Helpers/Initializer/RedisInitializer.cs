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

        var multiplexerHolder = new RedisConnectionMultiplexerHolder();
        services.AddSingleton(multiplexerHolder);
        services.AddSingleton<IRedisConnectionMultiplexerConnector, StackExchangeRedisConnectionMultiplexerConnector>();
        services.AddHostedService(sp => new RedisMultiplexerHostedService(
            redisOptions,
            multiplexerHolder,
            sp.GetRequiredService<IRedisConnectionMultiplexerConnector>(),
            sp.GetRequiredService<ILogger<RedisMultiplexerHostedService>>()));
        services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisOptions));

        var instanceName = configuration.GetSection("RedisOptions:InstanceName").Value ?? "FsusBlog_";

        services.AddStackExchangeRedisCache(options =>
        {
            options.ConnectionMultiplexerFactory = () => multiplexerHolder.WaitAsync();
            options.InstanceName = instanceName;
        });
    }
}

internal interface IRedisConnectionMultiplexerConnector
{
    Task<IConnectionMultiplexer> ConnectAsync(ConfigurationOptions options);
}

internal sealed class StackExchangeRedisConnectionMultiplexerConnector : IRedisConnectionMultiplexerConnector
{
    public async Task<IConnectionMultiplexer> ConnectAsync(ConfigurationOptions options)
        => await ConnectionMultiplexer.ConnectAsync(options);
}

internal sealed class RedisConnectionMultiplexerHolder : IDisposable
{
    private readonly TaskCompletionSource<IConnectionMultiplexer> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IConnectionMultiplexer? _multiplexer;

    public IConnectionMultiplexer Current
        => _multiplexer ?? throw new InvalidOperationException("redis_multiplexer_not_initialized");

    public Task<IConnectionMultiplexer> WaitAsync()
        => _ready.Task;

    public void Set(IConnectionMultiplexer multiplexer)
    {
        _multiplexer = multiplexer;
        _ready.TrySetResult(multiplexer);
    }

    public void SetException(Exception exception)
        => _ready.TrySetException(exception);

    public void Dispose()
        => _multiplexer?.Dispose();
}

internal sealed partial class RedisMultiplexerHostedService(
    ConfigurationOptions options,
    RedisConnectionMultiplexerHolder holder,
    IRedisConnectionMultiplexerConnector connector,
    ILogger<RedisMultiplexerHostedService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            IConnectionMultiplexer multiplexer = await connector.ConnectAsync(options);
            cancellationToken.ThrowIfCancellationRequested();
            holder.Set(multiplexer);
        }
        catch (Exception ex)
        {
            holder.SetException(ex);
            LogRedisConnectFailed(logger, ex);
            throw;
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        holder.Dispose();
        return Task.CompletedTask;
    }

    [LoggerMessage(EventId = 3101, Level = LogLevel.Critical, Message = "Redis multiplexer startup connection failed")]
    private static partial void LogRedisConnectFailed(ILogger logger, Exception exception);
}

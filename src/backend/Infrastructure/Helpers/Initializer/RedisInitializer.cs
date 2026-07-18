using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// Registers Redis connection startup, retry, keepalive, and timeout policy.
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

        // Startup remains available for the hosted connector to perform delayed retries.
        redisOptions.AbortOnConnectFail = false;

        // Redis failover and transient network faults may require several reconnect attempts.
        redisOptions.ConnectRetry = 5;

        // Keepalive prevents idle NAT mappings from silently dropping the connection.
        redisOptions.KeepAlive = 15;

        // The external rate limiter bounds admission while Redis operations use the same timeout budget.
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

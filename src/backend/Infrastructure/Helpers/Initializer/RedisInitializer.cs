using FsusBlog.Server.Infrastructure.Cache;

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

        services.AddSingleton<RedisConnectionMultiplexerHolder>();
        services.AddSingleton<IRedisConnectionMultiplexerFactory, StackExchangeRedisConnectionMultiplexerFactory>();
        services.AddHostedService(sp => new RedisMultiplexerHostedService(
            redisOptions,
            sp.GetRequiredService<RedisConnectionMultiplexerHolder>(),
            sp.GetRequiredService<IRedisConnectionMultiplexerFactory>(),
            sp,
            sp.GetRequiredService<ILogger<RedisMultiplexerHostedService>>()));
        services.AddSingleton<IConnectionMultiplexer>(sp =>
        {
            RedisConnectionMultiplexerHolder holder = sp.GetRequiredService<RedisConnectionMultiplexerHolder>();
            return holder
                .GetOrCreateAsync(
                    sp.GetRequiredService<IRedisConnectionMultiplexerFactory>(),
                    redisOptions)
                .GetAwaiter()
                .GetResult();
        });

        var instanceName = configuration.GetSection("RedisOptions:InstanceName").Value ?? "FsusBlog_";
        services.AddSingleton(new SharedRedisDistributedCacheOptions(instanceName));
        services.AddSingleton<Microsoft.Extensions.Caching.Distributed.IDistributedCache, SharedRedisDistributedCache>();
    }
}

internal interface IRedisConnectionMultiplexerFactory
{
    Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options);
}

internal sealed class StackExchangeRedisConnectionMultiplexerFactory : IRedisConnectionMultiplexerFactory
{
    public async Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
        => await ConnectionMultiplexer.ConnectAsync(options).ConfigureAwait(false);
}

internal sealed class RedisConnectionMultiplexerHolder
{
    private readonly object _creationGate = new();
    private Task<IConnectionMultiplexer>? _creationTask;
    private IConnectionMultiplexer? _multiplexer;

    public IConnectionMultiplexer Current
        => Volatile.Read(ref _multiplexer) ?? throw new InvalidOperationException("redis_multiplexer_not_initialized");

    public Task<IConnectionMultiplexer> WaitAsync()
    {
        lock (_creationGate)
        {
            return _creationTask
                ?? Task.FromException<IConnectionMultiplexer>(
                    new InvalidOperationException("redis_multiplexer_creation_not_started"));
        }
    }

    public Task<IConnectionMultiplexer> GetOrCreateAsync(
        IRedisConnectionMultiplexerFactory factory,
        ConfigurationOptions options)
    {
        lock (_creationGate)
        {
            return _creationTask ??= CreateAndPublishAsync(factory, options);
        }
    }

    private async Task<IConnectionMultiplexer> CreateAndPublishAsync(
        IRedisConnectionMultiplexerFactory factory,
        ConfigurationOptions options)
    {
        IConnectionMultiplexer multiplexer = await factory.CreateAsync(options).ConfigureAwait(false);
        ArgumentNullException.ThrowIfNull(multiplexer);
        if (Interlocked.CompareExchange(ref _multiplexer, multiplexer, null) is not null)
        {
            throw new InvalidOperationException("redis_multiplexer_already_published");
        }

        return multiplexer;
    }
}

internal sealed partial class RedisMultiplexerHostedService(
    ConfigurationOptions options,
    RedisConnectionMultiplexerHolder holder,
    IRedisConnectionMultiplexerFactory factory,
    IServiceProvider services,
    ILogger<RedisMultiplexerHostedService> logger) : IHostedService
{
    private readonly object _startGate = new();
    private Task? _startTask;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        lock (_startGate)
        {
            return _startTask ??= StartCoreAsync(cancellationToken);
        }
    }

    private async Task StartCoreAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            IConnectionMultiplexer multiplexer = await holder
                .GetOrCreateAsync(factory, options)
                .ConfigureAwait(false);

            IConnectionMultiplexer registered = services.GetRequiredService<IConnectionMultiplexer>();
            if (!ReferenceEquals(multiplexer, registered))
            {
                throw new InvalidOperationException("redis_multiplexer_identity_mismatch");
            }

            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception ex)
        {
            LogRedisConnectFailed(logger, ex);
            throw;
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
        => Task.CompletedTask;

    [LoggerMessage(EventId = 3101, Level = LogLevel.Critical, Message = "Redis multiplexer startup connection failed")]
    private static partial void LogRedisConnectFailed(ILogger logger, Exception exception);
}

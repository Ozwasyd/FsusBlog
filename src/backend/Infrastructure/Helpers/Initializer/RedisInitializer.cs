using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.DependencyInjection.Extensions;

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
        var operationBudgets = new RedisOperationBudgetCatalog();
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);
        services.TryAddSingleton<IRuntimeKeyScope, DefaultRuntimeKeyScope>();

        // Startup remains available for the hosted connector to perform delayed retries.
        redisOptions.AbortOnConnectFail = false;

        // Redis failover and transient network faults may require several reconnect attempts.
        redisOptions.ConnectRetry = 5;

        // Keepalive prevents idle NAT mappings from silently dropping the connection.
        redisOptions.KeepAlive = 15;

        // StackExchange.Redis still needs a transport ceiling, but operation-class
        // deadlines are the semantic authority and always end no later than this cap.
        redisOptions.ConnectTimeout = operationBudgets.TransportConnectTimeoutMilliseconds;
        redisOptions.AsyncTimeout = operationBudgets.TransportTimeoutMilliseconds;
        redisOptions.SyncTimeout = operationBudgets.TransportTimeoutMilliseconds;

        services.AddSingleton(operationBudgets);
        services.AddSingleton<RedisConnectionMultiplexerHolder>();
        services.AddSingleton<IRedisConnectionProvider>(static sp =>
            sp.GetRequiredService<RedisConnectionMultiplexerHolder>());
        services.AddSingleton<IRedisOperationExecutor, RedisOperationExecutor>();
        services.AddSingleton<IRedisConnectionMultiplexerFactory, StackExchangeRedisConnectionMultiplexerFactory>();
        services.AddHostedService(sp => new RedisMultiplexerHostedService(
            redisOptions,
            sp.GetRequiredService<RedisConnectionMultiplexerHolder>(),
            sp.GetRequiredService<IRedisConnectionMultiplexerFactory>(),
            sp.GetRequiredService<ILogger<RedisMultiplexerHostedService>>()));
        services.AddHostedService<ArticleHotRegistryRetirementHostedService>();

        var instanceName = configuration.GetSection("RedisOptions:InstanceName").Value ?? "FsusBlog_";
        services.AddSingleton(new SharedRedisDistributedCacheOptions(instanceName));
        services.AddSingleton<Microsoft.Extensions.Caching.Distributed.IDistributedCache, SharedRedisDistributedCache>();
    }
}

internal sealed class ArticleHotRegistryRetirementHostedService(
    IRedisOperationExecutor redisOperations,
    IRuntimeKeyScope keyScope,
    ILogger<ArticleHotRegistryRetirementHostedService> logger) : BackgroundService
{
    private static readonly TimeSpan s_retryDelay = TimeSpan.FromMilliseconds(250);
    private static readonly CachePolicyId[] s_retiredRegistryPolicies =
    [
        CachePolicyId.ArticleHot,
        CachePolicyId.TopArticles,
        CachePolicyId.ArticleHotFrame,
        CachePolicyId.TopArticlesFrame
    ];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        RedisKey[] keys = s_retiredRegistryPolicies
            .Select(policyId => (RedisKey)keyScope.PrefixKey(UnifiedCache.BuildRegistryKey(policyId)))
            .ToArray();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _ = await redisOperations.ExecuteAsync(
                        RedisOperationPort.UnifiedCacheMaintenance,
                        (multiplexer, _) => multiplexer.GetDatabase().KeyDeleteAsync(keys),
                        stoppingToken)
                    .ConfigureAwait(false);
                return;
            }
            catch (RedisOperationUnavailableException exception)
                when (exception.Port.OperationClass == RedisOperationClass.BackgroundMaintenance)
            {
                logger.LogWarning(
                    exception,
                    "Deferred retired article registry cleanup because Redis is unavailable; retrying");
                await Task.Delay(s_retryDelay, stoppingToken).ConfigureAwait(false);
            }
        }
    }
}

internal interface IRedisConnectionMultiplexerFactory
{
    Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options);
}

internal sealed class StackExchangeRedisConnectionMultiplexerFactory : IRedisConnectionMultiplexerFactory
{
    public async Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
    {
        ConnectionMultiplexer connection = await ConnectionMultiplexer.ConnectAsync(options).ConfigureAwait(false);
        // This factory owns a newly-created connection; never re-register on a shared holder.
        connection.RegisterProfiler(static () => CacheCoordinationObservation.Current?.RedisProfile!);
        return connection;
    }
}

internal sealed class RedisConnectionMultiplexerHolder : IRedisConnectionProvider, IDisposable
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

    public void Dispose()
        => Interlocked.Exchange(ref _multiplexer, null)?.Dispose();
}

internal sealed partial class RedisMultiplexerHostedService(
    ConfigurationOptions options,
    RedisConnectionMultiplexerHolder holder,
    IRedisConnectionMultiplexerFactory factory,
    ILogger<RedisMultiplexerHostedService> logger) : IHostedService
{
    private readonly object _startGate = new();
    private Task? _startTask;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        lock (_startGate)
        {
            _startTask ??= StartCoreAsync(cancellationToken);
            return Task.CompletedTask;
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

            if (!ReferenceEquals(multiplexer, holder.Current))
            {
                throw new InvalidOperationException("redis_multiplexer_identity_mismatch");
            }

            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception ex)
        {
            LogRedisConnectFailed(logger, ex);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
        => Task.CompletedTask;

    [LoggerMessage(EventId = 3101, Level = LogLevel.Critical, Message = "Redis multiplexer startup connection failed")]
    private static partial void LogRedisConnectFailed(ILogger logger, Exception exception);
}

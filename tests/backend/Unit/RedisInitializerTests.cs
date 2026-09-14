using System.Net;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisInitializerTests
{
    [Fact]
    public async Task ArticleHotRegistryRetirement_DeletesEveryRetiredRegistrySetInOneCommand()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        IDatabase database = Substitute.For<IDatabase>();
        var deleted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        database.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()).Returns(_ =>
        {
            deleted.TrySetResult();
            return 4L;
        });
        var service = new ArticleHotRegistryRetirementHostedService(
            RedisOperationExecutor.ForTestConnection(connection),
            new DefaultRuntimeKeyScope(),
            NullLogger<ArticleHotRegistryRetirementHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);

        await deleted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        await database.Received(1).KeyDeleteAsync(
            Arg.Is<RedisKey[]>(keys => keys.Select(static key => key.ToString()).SequenceEqual(new[]
            {
                "cache:registry:3",
                "cache:registry:7",
                "cache:registry:30",
                "cache:registry:31"
            })),
            CommandFlags.None);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ArticleHotRegistryRetirement_RetriesAfterRedisRecovery()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        IDatabase database = Substitute.For<IDatabase>();
        var deleted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        database.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()).Returns(_ =>
        {
            deleted.TrySetResult();
            return 4L;
        });
        var operations = new FailOnceRedisOperationExecutor(connection);
        var service = new ArticleHotRegistryRetirementHostedService(
            operations,
            new DefaultRuntimeKeyScope(),
            NullLogger<ArticleHotRegistryRetirementHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);
        await deleted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(2, operations.AttemptCount);
        await database.Received(1).KeyDeleteAsync(Arg.Any<RedisKey[]>(), CommandFlags.None);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public void RedisInitializer_RegistersHostedAsyncConnectionLifecycle()
    {
        ServiceCollection services = CreateRedisServices();

        ServiceDescriptor factoryDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IRedisConnectionMultiplexerFactory));
        ServiceDescriptor holderDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(RedisConnectionMultiplexerHolder));
        ServiceDescriptor providerDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IRedisConnectionProvider));
        ServiceDescriptor executorDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IRedisOperationExecutor));
        ServiceDescriptor distributedCacheDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IDistributedCache));

        Assert.Equal(ServiceLifetime.Singleton, factoryDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, holderDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, providerDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, executorDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, distributedCacheDescriptor.Lifetime);
        Assert.DoesNotContain(
            services,
            static descriptor => descriptor.ServiceType == typeof(IConnectionMultiplexer));
        Assert.Contains(
            services,
            static descriptor => descriptor.ServiceType == typeof(IHostedService)
                && descriptor.ImplementationFactory is not null);
    }

    [Fact]
    public async Task ServiceProviderLifecycle_SharesOneMultiplexerAcrossCacheHealthAndConsumers()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        IDatabase database = Substitute.For<IDatabase>();
        multiplexer.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        database.PingAsync(Arg.Any<CommandFlags>()).Returns(Task.FromResult(TimeSpan.FromMilliseconds(1)));
        var factory = new RetryingCountingRedisFactory(multiplexer);

        ServiceCollection services = CreateRedisServices();
        services.RemoveAll<IRedisConnectionMultiplexerFactory>();
        services.AddSingleton<IRedisConnectionMultiplexerFactory>(factory);
        services.AddMemoryCache();
        services.AddSingleton<ICachePolicyRegistry, CachePolicyRegistry>();
        services.AddSingleton<IRuntimeKeyScope, DefaultRuntimeKeyScope>();
        services.AddSingleton<PolicyShardedCacheL1Store>();
        services.AddSingleton<ICacheKeyResolver, CacheKeyResolver>();
        services.AddSingleton<CacheSingleFlightCoordinator>();
        services.AddSingleton<ICacheTelemetry, CacheTelemetry>();
        services.AddSingleton<UnifiedCache>();
        services.AddSingleton<IHostedService, DirectRedisHostedConsumer>();

        ServiceProvider provider = services.BuildServiceProvider();
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-redis-lifecycle-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "wwwroot"));
        try
        {
            Assert.Equal(0, factory.CreateCount);

            IHostedService[] hostedServices = provider.GetServices<IHostedService>().ToArray();
            RedisMultiplexerHostedService hosted = hostedServices
                .OfType<RedisMultiplexerHostedService>()
                .Single();
            DirectRedisHostedConsumer consumer = hostedServices
                .OfType<DirectRedisHostedConsumer>()
                .Single();

            Assert.Equal(0, factory.CreateCount);

            await Task.WhenAll(
                hosted.StartAsync(CancellationToken.None),
                hosted.StartAsync(CancellationToken.None));

            Assert.Equal(1, factory.CreateCount);
            Assert.Equal(2, factory.ConnectionAttemptCount);
            Assert.Equal(1, factory.InitialFailureCount);
            Assert.NotNull(factory.Options);
            Assert.False(factory.Options!.AbortOnConnectFail);
            Assert.Equal(5, factory.Options.ConnectRetry);
            RedisOperationBudgetCatalog operationBudgets = provider.GetRequiredService<RedisOperationBudgetCatalog>();
            Assert.Equal(operationBudgets.TransportConnectTimeoutMilliseconds, factory.Options.ConnectTimeout);
            Assert.Equal(operationBudgets.TransportTimeoutMilliseconds, factory.Options.AsyncTimeout);
            Assert.Equal(operationBudgets.TransportTimeoutMilliseconds, factory.Options.SyncTimeout);

            var distributedCache = Assert.IsType<SharedRedisDistributedCache>(
                provider.GetRequiredService<IDistributedCache>());
            UnifiedCache unifiedCache = provider.GetRequiredService<UnifiedCache>();

            FieldInfo operationsField = typeof(UnifiedCache).GetField(
                "_redisOperations",
                BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("UnifiedCache Redis operation executor field was not found.");

            Assert.Same(multiplexer, provider.GetRequiredService<RedisConnectionMultiplexerHolder>().Current);
            Assert.DoesNotContain(
                typeof(IConnectionMultiplexer),
                Assert.Single(typeof(SharedRedisDistributedCache).GetConstructors()).GetParameters()
                    .Select(static parameter => parameter.ParameterType));
            Assert.Same(provider.GetRequiredService<IRedisOperationExecutor>(), operationsField.GetValue(unifiedCache));
            Assert.Same(multiplexer, consumer.Connection);

            int failedEvents = 0;
            int restoredEvents = 0;
            multiplexer.ConnectionFailed += (_, _) => failedEvents++;
            multiplexer.ConnectionRestored += (_, _) => restoredEvents++;
            var redisFailure = new RedisConnectionException(
                ConnectionFailureType.UnableToConnect,
                "simulated transient failure");
            var eventArgs = new ConnectionFailedEventArgs(
                multiplexer,
                new DnsEndPoint("localhost", 6379),
                ConnectionType.Interactive,
                ConnectionFailureType.UnableToConnect,
                redisFailure,
                "unit-test");
            multiplexer.ConnectionFailed += Raise.Event<EventHandler<ConnectionFailedEventArgs>>(multiplexer, eventArgs);
            multiplexer.ConnectionRestored += Raise.Event<EventHandler<ConnectionFailedEventArgs>>(multiplexer, eventArgs);

            Assert.Equal(1, failedEvents);
            Assert.Equal(1, restoredEvents);
            Assert.Equal(1, factory.CreateCount);
            Assert.Same(multiplexer, provider.GetRequiredService<RedisConnectionMultiplexerHolder>().Current);

            IConfiguration configuration = CreateRedisConfiguration();
            var environment = new TestWebHostEnvironment(tempRoot);
            IConfigurationHealthSnapshot configurationSnapshot = Substitute.For<IConfigurationHealthSnapshot>();
            configurationSnapshot.Current.Returns(new ProductionConfigurationHealthCheck("ok", []));
            var probe = new ProductionReadinessProbe(
                configuration,
                environment,
                provider,
                configurationSnapshot,
                NullLogger<ProductionReadinessProbe>.Instance);

            ProductionHealthReport report = await probe.CheckAsync(CancellationToken.None);

            var redisHealth = Assert.IsType<ProductionDependencyHealthCheck>(report.Checks["redis"]);
            Assert.Equal("ok", redisHealth.Status);
            await database.Received(1).PingAsync(CommandFlags.DemandMaster);

            await hosted.StopAsync(CancellationToken.None);
            multiplexer.DidNotReceive().Dispose();

            provider.Dispose();
            multiplexer.Received(1).Dispose();
            provider.Dispose();
            multiplexer.Received(1).Dispose();
        }
        finally
        {
            provider.Dispose();
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task RedisMultiplexerHostedService_StartAsyncDoesNotBlockHostAndReadinessPreservesConnectionException()
    {
        var expected = new RedisConnectionException(
            ConnectionFailureType.UnableToConnect,
            "unit redis failed");
        var holder = new RedisConnectionMultiplexerHolder();
        var service = new RedisMultiplexerHostedService(
            ConfigurationOptions.Parse("localhost:6379"),
            holder,
            new FailingRedisFactory(expected),
            NullLogger<RedisMultiplexerHostedService>.Instance);

        await service.StartAsync(CancellationToken.None);
        RedisConnectionException published = await Assert.ThrowsAsync<RedisConnectionException>(
            () => holder.WaitAsync());

        Assert.Same(expected, published);
        await service.StartAsync(CancellationToken.None);
    }

    [Fact]
    public async Task RedisMultiplexerHostedService_StartAsyncYieldsWhileConnectIsSlow()
    {
        var factory = new HangingRedisFactory();
        ServiceCollection serviceCollection = CreateRedisServices();
        serviceCollection.RemoveAll<IRedisConnectionMultiplexerFactory>();
        serviceCollection.AddSingleton<IRedisConnectionMultiplexerFactory>(factory);
        ServiceProvider services = serviceCollection.BuildServiceProvider();
        RedisMultiplexerHostedService service = services
            .GetServices<IHostedService>()
            .OfType<RedisMultiplexerHostedService>()
            .Single();
        RedisConnectionMultiplexerHolder holder = services.GetRequiredService<RedisConnectionMultiplexerHolder>();

        Task startTask = service.StartAsync(CancellationToken.None);
        await factory.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.True(startTask.IsCompletedSuccessfully);
        Assert.False(holder.WaitAsync().IsCompleted);

        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        factory.Release(multiplexer);
        await holder.WaitAsync().WaitAsync(TimeSpan.FromSeconds(1));

        Assert.Same(multiplexer, holder.Current);
        services.Dispose();
        multiplexer.Received(1).Dispose();
    }

    [Fact]
    public void LegacyMultiplexerIsNotRegisteredForRequestTimeResolution()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        var factory = new RetryingCountingRedisFactory(multiplexer);
        ServiceCollection services = CreateRedisServices();
        services.RemoveAll<IRedisConnectionMultiplexerFactory>();
        services.AddSingleton<IRedisConnectionMultiplexerFactory>(factory);
        using ServiceProvider provider = services.BuildServiceProvider();

        Assert.Null(provider.GetService<IConnectionMultiplexer>());
        Assert.Equal(0, factory.CreateCount);
    }

    [Fact]
    public void ClassifiedExecutorResolutionBeforeHostedStartupDoesNotResolveOrBlockOnMultiplexer()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        var factory = new RetryingCountingRedisFactory(multiplexer);
        ServiceCollection services = CreateRedisServices();
        services.RemoveAll<IRedisConnectionMultiplexerFactory>();
        services.AddSingleton<IRedisConnectionMultiplexerFactory>(factory);
        using ServiceProvider provider = services.BuildServiceProvider();

        IRedisOperationExecutor executor = provider.GetRequiredService<IRedisOperationExecutor>();

        Assert.IsType<RedisOperationExecutor>(executor);
        Assert.Equal(0, factory.CreateCount);
    }

    [Fact]
    public async Task RedisMultiplexerHostedService_CancellationAfterCreationDefersDisposeUntilProviderShutdown()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        using var cancellation = new CancellationTokenSource();
        var factory = new CancelAfterCreationRedisFactory(multiplexer, cancellation);
        ServiceCollection serviceCollection = CreateRedisServices();
        serviceCollection.RemoveAll<IRedisConnectionMultiplexerFactory>();
        serviceCollection.AddSingleton<IRedisConnectionMultiplexerFactory>(factory);
        ServiceProvider services = serviceCollection.BuildServiceProvider();
        RedisMultiplexerHostedService service = services
            .GetServices<IHostedService>()
            .OfType<RedisMultiplexerHostedService>()
            .Single();
        RedisConnectionMultiplexerHolder holder = services.GetRequiredService<RedisConnectionMultiplexerHolder>();

        await service.StartAsync(cancellation.Token);
        Assert.Same(multiplexer, await holder.WaitAsync());

        multiplexer.DidNotReceive().Dispose();
        Assert.Same(multiplexer, holder.Current);
        services.Dispose();
        multiplexer.Received(1).Dispose();
    }

    [Fact]
    public async Task SharedRedisDistributedCache_SetAsyncPreservesPrefixPayloadAndExpirationProtocol()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        IDatabase database = Substitute.For<IDatabase>();
        multiplexer.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        database
            .HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<HashEntry[]>(), Arg.Any<CommandFlags>())
            .Returns(Task.CompletedTask);
        var cache = new SharedRedisDistributedCache(
            multiplexer,
            new SharedRedisDistributedCacheOptions("FsusBlog_Tests_"));
        byte[] payload = [1, 2, 3, 4];
        var options = new DistributedCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10),
            SlidingExpiration = TimeSpan.FromMinutes(2)
        };

        await cache.SetAsync("identity", payload, options, CancellationToken.None);

        await database.Received(1).HashSetAsync(
            Arg.Is<RedisKey>(static key => key.ToString() == "FsusBlog_Tests_identity"),
            Arg.Is<HashEntry[]>(entries => HasExpectedDistributedCacheFields(entries, payload)),
            CommandFlags.None);
        AssertExpirationCall(database, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(2));
        Assert.Same(multiplexer, cache.Connection);
        Assert.IsAssignableFrom<IBufferDistributedCache>(cache);
        Assert.False(typeof(IDisposable).IsAssignableFrom(cache.GetType()));
    }

    [Fact]
    public async Task SharedRedisDistributedCache_GetAsyncRefreshesSlidingTtlOnTheSharedConnection()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        IDatabase database = Substitute.For<IDatabase>();
        multiplexer.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        byte[] payload = [9, 8, 7];
        RedisValue[] storedValues =
        [
            DateTimeOffset.UtcNow.AddMinutes(10).Ticks,
            TimeSpan.FromMinutes(2).Ticks,
            payload
        ];
        database
            .HashGetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(storedValues));
        var cache = new SharedRedisDistributedCache(
            multiplexer,
            new SharedRedisDistributedCacheOptions("FsusBlog_Tests_"));

        byte[]? actual = await cache.GetAsync("identity", CancellationToken.None);

        Assert.Equal(payload, actual);
        await database.Received(1).HashGetAsync(
            Arg.Is<RedisKey>(static key => key.ToString() == "FsusBlog_Tests_identity"),
            Arg.Is<RedisValue[]>(static fields => HasExpectedMetadataFields(fields)),
            CommandFlags.None);
        AssertExpirationCall(database, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(2));
        multiplexer.DidNotReceive().Dispose();
    }

    [Fact]
    public void SharedRedisDistributedCache_SynchronousRequestApisFailImmediatelyWithoutRedisWait()
    {
        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        var cache = new SharedRedisDistributedCache(
            multiplexer,
            new SharedRedisDistributedCacheOptions("FsusBlog_Tests_"));
        var options = new DistributedCacheEntryOptions();

        Assert.Equal("redis_sync_operation_forbidden", Assert.Throws<NotSupportedException>(() => cache.Get("key")).Message);
        Assert.Equal("redis_sync_operation_forbidden", Assert.Throws<NotSupportedException>(() => cache.Set("key", [1], options)).Message);
        Assert.Equal("redis_sync_operation_forbidden", Assert.Throws<NotSupportedException>(() => cache.Refresh("key")).Message);
        Assert.Equal("redis_sync_operation_forbidden", Assert.Throws<NotSupportedException>(() => cache.Remove("key")).Message);
        multiplexer.DidNotReceiveWithAnyArgs().GetDatabase(default, default);
    }

    [Fact]
    public void ProductionSource_CreatesTheMultiplexerOnlyThroughTheAsyncFactory()
    {
        string backendRoot = BackendTestPaths.FromRoot("src", "backend");
        string[] creationSites = Directory
            .EnumerateFiles(backendRoot, "*.cs", SearchOption.AllDirectories)
            .SelectMany(static path => File.ReadLines(path).Select(line => (path, line)))
            .Where(static entry => entry.line.Contains("ConnectionMultiplexer.Connect", StringComparison.Ordinal))
            .Select(static entry => $"{Path.GetRelativePath(BackendTestPaths.RepositoryRoot, entry.path)}:{entry.line.Trim()}")
            .ToArray();

        string creationSite = Assert.Single(creationSites);
        Assert.Contains("RedisInitializer.cs", creationSite, StringComparison.Ordinal);
        Assert.Contains("ConnectionMultiplexer.ConnectAsync(options)", creationSite, StringComparison.Ordinal);
        Assert.DoesNotContain("ConnectionMultiplexer.Connect(options)", creationSite, StringComparison.Ordinal);
    }

    private static bool HasExpectedDistributedCacheFields(HashEntry[] entries, byte[] payload)
    {
        if (entries.Length != 3)
        {
            return false;
        }

        Dictionary<string, RedisValue> values = entries.ToDictionary(
            static entry => entry.Name.ToString(),
            static entry => entry.Value,
            StringComparer.Ordinal);
        return (long)values["absexp"] > DateTimeOffset.UtcNow.Ticks
            && (long)values["sldexp"] == TimeSpan.FromMinutes(2).Ticks
            && ((byte[]?)values["data"])!.SequenceEqual(payload);
    }

    private static bool HasExpectedMetadataFields(RedisValue[] fields)
        => fields.Length == 3
            && fields[0] == "absexp"
            && fields[1] == "sldexp"
            && fields[2] == "data";

    private static void AssertExpirationCall(IDatabase database, TimeSpan minimum, TimeSpan maximum)
    {
        var call = Assert.Single(
            database.ReceivedCalls(),
            static candidate => candidate.GetMethodInfo().Name == nameof(IDatabase.KeyExpireAsync));
        object?[] arguments = call.GetArguments();
        Assert.Equal("FsusBlog_Tests_identity", Assert.IsType<RedisKey>(arguments[0]).ToString());
        TimeSpan ttl = Assert.IsType<TimeSpan>(arguments[1]);
        Assert.InRange(ttl, minimum, maximum);
    }

    private static ServiceCollection CreateRedisServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddRedis(CreateRedisConfiguration());
        return services;
    }

    private static IConfiguration CreateRedisConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Redis"] = "localhost:6379,connectTimeout=50",
                ["RedisOptions:InstanceName"] = "FsusBlog_Tests_"
            })
            .Build();

    private sealed class DirectRedisHostedConsumer(RedisConnectionMultiplexerHolder holder) : IHostedService
    {
        public IConnectionMultiplexer Connection => holder.Current;

        public Task StartAsync(CancellationToken cancellationToken)
            => Task.CompletedTask;

        public Task StopAsync(CancellationToken cancellationToken)
            => Task.CompletedTask;
    }

    private sealed class FailingRedisFactory(Exception exception) : IRedisConnectionMultiplexerFactory
    {
        public Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
            => Task.FromException<IConnectionMultiplexer>(exception);
    }

    private sealed class CancelAfterCreationRedisFactory(
        IConnectionMultiplexer connection,
        CancellationTokenSource cancellation) : IRedisConnectionMultiplexerFactory
    {
        public Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
        {
            cancellation.Cancel();
            return Task.FromResult(connection);
        }
    }

    private sealed class HangingRedisFactory : IRedisConnectionMultiplexerFactory
    {
        private readonly TaskCompletionSource<IConnectionMultiplexer> _release =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Started
        {
            get;
        } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
        {
            Started.TrySetResult();
            return _release.Task;
        }

        public void Release(IConnectionMultiplexer multiplexer)
            => _release.SetResult(multiplexer);
    }

    private sealed class RetryingCountingRedisFactory(IConnectionMultiplexer connection) : IRedisConnectionMultiplexerFactory
    {
        public int CreateCount
        {
            get; private set;
        }
        public int ConnectionAttemptCount
        {
            get; private set;
        }
        public int InitialFailureCount
        {
            get; private set;
        }
        public ConfigurationOptions? Options
        {
            get; private set;
        }

        public Task<IConnectionMultiplexer> CreateAsync(ConfigurationOptions options)
        {
            CreateCount++;
            Options = options;

            // Model one failed endpoint attempt followed by the configured internal retry.
            ConnectionAttemptCount++;
            InitialFailureCount++;
            if (options.ConnectRetry < 1 || options.AbortOnConnectFail)
            {
                return Task.FromException<IConnectionMultiplexer>(new RedisConnectionException(
                    ConnectionFailureType.UnableToConnect,
                    "retry policy disabled"));
            }

            ConnectionAttemptCount++;
            return Task.FromResult(connection);
        }
    }

    private sealed class FailOnceRedisOperationExecutor(IConnectionMultiplexer connection) : IRedisOperationExecutor
    {
        private readonly RedisOperationBudgetCatalog _catalog = new();
        private int _attemptCount;

        public int AttemptCount => Volatile.Read(ref _attemptCount);

        public async Task<T> ExecuteAsync<T>(
            RedisOperationPort port,
            Func<IConnectionMultiplexer, CancellationToken, Task<T>> command,
            CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _attemptCount) == 1)
            {
                RedisOperationPortDefinition definition = _catalog.Get(port);
                throw new RedisOperationUnavailableException(
                    definition,
                    _catalog.Get(definition.OperationClass),
                    RedisOperationFailureKind.ConnectionUnavailable);
            }

            return await command(connection, cancellationToken);
        }

        public async Task ExecuteAsync(
            RedisOperationPort port,
            Func<IConnectionMultiplexer, CancellationToken, Task> command,
            CancellationToken cancellationToken)
            => await ExecuteAsync(
                port,
                async (multiplexer, token) =>
                {
                    await command(multiplexer, token);
                    return true;
                },
                cancellationToken);
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public string EnvironmentName { get; set; } = Environments.Development;
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

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
    public void RedisInitializer_RegistersHostedAsyncConnectionLifecycle()
    {
        ServiceCollection services = CreateRedisServices();

        ServiceDescriptor factoryDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IRedisConnectionMultiplexerFactory));
        ServiceDescriptor holderDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(RedisConnectionMultiplexerHolder));
        ServiceDescriptor multiplexerDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IConnectionMultiplexer));
        ServiceDescriptor distributedCacheDescriptor = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IDistributedCache));

        Assert.Equal(ServiceLifetime.Singleton, factoryDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, holderDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, multiplexerDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, distributedCacheDescriptor.Lifetime);
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
        services.AddSingleton<UnifiedCache>();
        services.AddSingleton<IUnifiedCache>(sp => sp.GetRequiredService<UnifiedCache>());
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

            Assert.Equal(1, factory.CreateCount);

            await Task.WhenAll(
                hosted.StartAsync(CancellationToken.None),
                hosted.StartAsync(CancellationToken.None));

            Assert.Equal(1, factory.CreateCount);
            Assert.Equal(2, factory.ConnectionAttemptCount);
            Assert.Equal(1, factory.InitialFailureCount);
            Assert.NotNull(factory.Options);
            Assert.False(factory.Options!.AbortOnConnectFail);
            Assert.Equal(5, factory.Options.ConnectRetry);

            IConnectionMultiplexer registered = provider.GetRequiredService<IConnectionMultiplexer>();
            var distributedCache = Assert.IsType<SharedRedisDistributedCache>(
                provider.GetRequiredService<IDistributedCache>());
            UnifiedCache unifiedCache = provider.GetRequiredService<UnifiedCache>();

            FieldInfo redisField = typeof(UnifiedCache).GetField(
                "_redis",
                BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("UnifiedCache Redis identity field was not found.");

            Assert.Same(multiplexer, registered);
            Assert.Same(multiplexer, distributedCache.Connection);
            Assert.Same(multiplexer, redisField.GetValue(unifiedCache));
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
            Assert.Same(multiplexer, provider.GetRequiredService<IConnectionMultiplexer>());

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
    public async Task RedisMultiplexerHostedService_StartAsyncPreservesRedisConnectionException()
    {
        var expected = new RedisConnectionException(
            ConnectionFailureType.UnableToConnect,
            "unit redis failed");
        var holder = new RedisConnectionMultiplexerHolder();
        using ServiceProvider services = new ServiceCollection().BuildServiceProvider();
        var service = new RedisMultiplexerHostedService(
            ConfigurationOptions.Parse("localhost:6379"),
            holder,
            new FailingRedisFactory(expected),
            services,
            NullLogger<RedisMultiplexerHostedService>.Instance);

        RedisConnectionException actual = await Assert.ThrowsAsync<RedisConnectionException>(
            () => service.StartAsync(CancellationToken.None));
        RedisConnectionException published = await Assert.ThrowsAsync<RedisConnectionException>(
            () => holder.WaitAsync());

        Assert.Same(expected, actual);
        Assert.Same(expected, published);
        await Assert.ThrowsAsync<RedisConnectionException>(
            () => service.StartAsync(CancellationToken.None));
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

        Assert.False(startTask.IsCompleted);
        Assert.False(holder.WaitAsync().IsCompleted);

        IConnectionMultiplexer multiplexer = Substitute.For<IConnectionMultiplexer>();
        factory.Release(multiplexer);
        await startTask.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.Same(multiplexer, holder.Current);
        services.Dispose();
        multiplexer.Received(1).Dispose();
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

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => service.StartAsync(cancellation.Token));

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

    private sealed class DirectRedisHostedConsumer(IConnectionMultiplexer connection) : IHostedService
    {
        public IConnectionMultiplexer Connection { get; } = connection;

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

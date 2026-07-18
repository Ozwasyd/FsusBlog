using FsusBlog.Server.Infrastructure.Helpers.Initializer;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisInitializerTests
{
    [Fact]
    public async Task RedisInitializer_RegistersHostedAsyncConnectionLifecycle()
    {
        var services = new ServiceCollection();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Redis"] = "localhost:6379,connectTimeout=50",
                ["RedisOptions:InstanceName"] = "FsusBlog_Tests_"
            })
            .Build();
        services.AddLogging();

        services.AddRedis(configuration);

        ServiceDescriptor connectorDescriptor = Assert.Single(
            services, static descriptor => descriptor.ServiceType == typeof(IRedisConnectionMultiplexerConnector));
        ServiceDescriptor holderDescriptor = Assert.Single(
            services, static descriptor => descriptor.ServiceType == typeof(RedisConnectionMultiplexerHolder));
        ServiceDescriptor multiplexerDescriptor = Assert.Single(
            services, static descriptor => descriptor.ServiceType == typeof(IConnectionMultiplexer));
        Assert.Equal(ServiceLifetime.Singleton, connectorDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, holderDescriptor.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, multiplexerDescriptor.Lifetime);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationFactory is not null);

        var holder = new RedisConnectionMultiplexerHolder();
        var connector = new HangingRedisConnector();
        var hostedService = new RedisMultiplexerHostedService(
            ConfigurationOptions.Parse("localhost:6379"),
            holder,
            connector,
            NullLogger<RedisMultiplexerHostedService>.Instance);

        Task startTask = hostedService.StartAsync(CancellationToken.None);
        await connector.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.False(holder.WaitAsync().IsCompleted);

        var multiplexer = Substitute.For<IConnectionMultiplexer>();
        connector.Release(multiplexer);
        await startTask.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Same(multiplexer, await holder.WaitAsync());
    }

    [Fact]
    public async Task RedisMultiplexerHostedService_StartAsyncPreservesRedisConnectionException()
    {
        var expected = new RedisConnectionException(ConnectionFailureType.UnableToConnect, "unit redis failed");
        var service = new RedisMultiplexerHostedService(
            ConfigurationOptions.Parse("localhost:6379"),
            new RedisConnectionMultiplexerHolder(),
            new FailingRedisConnector(expected),
            NullLogger<RedisMultiplexerHostedService>.Instance);

        RedisConnectionException actual = await Assert.ThrowsAsync<RedisConnectionException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Same(expected, actual);
    }

    [Fact]
    public async Task RedisMultiplexerHostedService_StartAsyncYieldsWhileConnectIsSlow()
    {
        var connector = new HangingRedisConnector();
        var holder = new RedisConnectionMultiplexerHolder();
        var service = new RedisMultiplexerHostedService(
            ConfigurationOptions.Parse("localhost:6379"),
            holder,
            connector,
            NullLogger<RedisMultiplexerHostedService>.Instance);

        Task startTask = service.StartAsync(CancellationToken.None);
        await connector.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.False(startTask.IsCompleted);

        var multiplexer = Substitute.For<IConnectionMultiplexer>();
        connector.Release(multiplexer);
        await startTask.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.Same(multiplexer, holder.Current);
    }

    private sealed class FailingRedisConnector(Exception exception) : IRedisConnectionMultiplexerConnector
    {
        public Task<IConnectionMultiplexer> ConnectAsync(ConfigurationOptions options)
            => Task.FromException<IConnectionMultiplexer>(exception);
    }

    private sealed class HangingRedisConnector : IRedisConnectionMultiplexerConnector
    {
        private readonly TaskCompletionSource<IConnectionMultiplexer> _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IConnectionMultiplexer> ConnectAsync(ConfigurationOptions options)
        {
            Started.TrySetResult();
            return _release.Task;
        }

        public void Release(IConnectionMultiplexer multiplexer)
            => _release.SetResult(multiplexer);
    }
}

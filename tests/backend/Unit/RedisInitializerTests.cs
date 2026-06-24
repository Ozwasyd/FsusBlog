using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisInitializerTests
{
    [Fact]
    public void RedisInitializer_ConnectsFromHostedServiceWithoutSyncOverAsync()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/Initializer/RedisInitializer.cs");

        Assert.DoesNotContain("Lazy<Task<IConnectionMultiplexer>>", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".GetAwaiter().GetResult()", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".Wait()", source, StringComparison.Ordinal);
        Assert.Contains("IHostedService", source, StringComparison.Ordinal);
        Assert.Contains("await connector.ConnectAsync", source, StringComparison.Ordinal);
        Assert.Contains("services.AddSingleton<IConnectionMultiplexer>", source, StringComparison.Ordinal);
        Assert.Contains("ConnectionMultiplexerFactory = () => multiplexerHolder.WaitAsync()", source, StringComparison.Ordinal);
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
        Task<int> unrelatedWork = Task.Run(static () => Environment.CurrentManagedThreadId);

        Assert.Same(unrelatedWork, await Task.WhenAny(unrelatedWork, Task.Delay(TimeSpan.FromMilliseconds(250))));
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

using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisOperationExecutorTests
{
    [Fact]
    public async Task IdempotentPortRetriesTransientFailureWithinClassBudget()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        int result = await executor.ExecuteAsync(
            RedisOperationPort.UnifiedCacheRead,
            (_, _) => ++attempts == 1
                ? Task.FromException<int>(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline"))
                : Task.FromResult(42),
            CancellationToken.None);

        Assert.Equal(42, result);
        Assert.Equal(2, attempts);
    }

    [Theory]
    [InlineData("READONLY replica is read-only")]
    [InlineData("MOVED 1 127.0.0.1:6380")]
    public async Task IdempotentPortRetriesRedisTopologyTransition(string message)
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        int result = await executor.ExecuteAsync(
            RedisOperationPort.UnifiedCacheRead,
            (_, _) => ++attempts == 1
                ? Task.FromException<int>(new RedisServerException(message))
                : Task.FromResult(9),
            CancellationToken.None);

        Assert.Equal(9, result);
        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task AtomicPortNeverRetriesAnUncertainFailure()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.PerceptionChallenge,
                (_, _) =>
                {
                    attempts++;
                    return Task.FromException<int>(
                        new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline"));
                },
                CancellationToken.None));

        Assert.Equal(1, attempts);
        Assert.Equal(RedisOperationClass.SecurityAtomic, failure.Port.OperationClass);
        Assert.Equal("fail-closed", failure.Budget.FailAction);
    }

    [Fact]
    public async Task CommandDeadlineEndsOptionalProjectionWithoutWaitingForUnderlyingCommand()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        var never = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.ArticleServiceOptionalProjection,
                (_, _) => never.Task,
                CancellationToken.None));

        Assert.Equal(RedisOperationFailureKind.CommandTimeout, failure.FailureKind);
        Assert.Equal("use-local-or-base-value", failure.Budget.FailAction);
    }

    [Theory]
    [InlineData(5, true)]
    [InlineData(50, true)]
    [InlineData(500, false)]
    [InlineData(15000, false)]
    public async Task FaultDelayMatrixHonorsOptionalProjectionDeadline(int delayMilliseconds, bool succeeds)
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);

        Task<int> ExecuteAsync() => executor.ExecuteAsync(
            RedisOperationPort.ArticleServiceOptionalProjection,
            async (_, token) =>
            {
                await Task.Delay(delayMilliseconds, token);
                return delayMilliseconds;
            },
            CancellationToken.None);

        if (succeeds)
        {
            Assert.Equal(delayMilliseconds, await ExecuteAsync());
        }
        else
        {
            RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(ExecuteAsync);
            Assert.Equal(RedisOperationFailureKind.CommandTimeout, failure.FailureKind);
        }
    }

    [Fact]
    public async Task CallerCancellationIsPreservedInsteadOfBeingReclassified()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.UnifiedCacheRead,
                (_, _) => Task.FromResult(1),
                cancellation.Token));
    }

    [Fact]
    public async Task SecurityCircuitDoesNotSuppressOptionalProjectionClass()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        for (int i = 0; i < 3; i++)
        {
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
                executor.ExecuteAsync(
                    RedisOperationPort.PerceptionChallenge,
                    (_, _) => Task.FromException<int>(
                        new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline")),
                    CancellationToken.None));
        }

        int result = await executor.ExecuteAsync(
            RedisOperationPort.ArticleServiceOptionalProjection,
            (_, _) => Task.FromResult(7),
            CancellationToken.None);

        Assert.Equal(7, result);
        RedisOperationUnavailableException circuitFailure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.PerceptionChallenge,
                (_, _) => Task.FromResult(8),
                CancellationToken.None));
        Assert.Equal(RedisOperationFailureKind.CircuitOpen, circuitFailure.FailureKind);
    }

    [Fact]
    public async Task ThousandConcurrentContentMissesAreBoundedByRedisCircuitAndDatabaseGate()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var catalog = new RedisOperationBudgetCatalog();
        var executor = new RedisOperationExecutor(
            new FixedConnectionProvider(connection),
            catalog,
            TimeProvider.System);
        var databaseGate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(4, TimeSpan.FromSeconds(1)),
            NullLogger<DbConcurrencyGate>.Instance);
        int redisCommands = 0;
        int activeDatabaseCalls = 0;
        int maxActiveDatabaseCalls = 0;
        int databaseFallbacks = 0;
        int databaseRejections = 0;

        Task<int> ExecuteRequestAsync()
            => ExecuteRequestCoreAsync();

        async Task<int> ExecuteRequestCoreAsync()
        {
            try
            {
                return await executor.ExecuteAsync<int>(
                    RedisOperationPort.UnifiedCacheRead,
                    async (_, token) =>
                    {
                        Interlocked.Increment(ref redisCommands);
                        await Task.Delay(20, token);
                        throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "fault-injected disconnect");
                    },
                    CancellationToken.None);
            }
            catch (RedisOperationUnavailableException failure)
                when (failure.Port.OperationClass == RedisOperationClass.ContentCacheRead)
            {
                return await databaseGate.ExecuteClassifiedAsync(
                    DbWorkloadClass.PublicShortRead,
                    "fault-injected-content-cache-miss",
                    async token =>
                    {
                        int active = Interlocked.Increment(ref activeDatabaseCalls);
                        UpdateMaximum(ref maxActiveDatabaseCalls, active);
                        try
                        {
                            await Task.Delay(10, token);
                            Interlocked.Increment(ref databaseFallbacks);
                            return 1;
                        }
                        finally
                        {
                            Interlocked.Decrement(ref activeDatabaseCalls);
                        }
                    },
                    _ =>
                    {
                        Interlocked.Increment(ref databaseRejections);
                        return Task.FromResult(0);
                    },
                    CancellationToken.None);
            }
        }

        int[] results = await Task.WhenAll(Enumerable.Range(0, 1000).Select(_ => ExecuteRequestAsync()));

        RedisOperationBudget budget = catalog.Get(RedisOperationClass.ContentCacheRead);
        int maximumCommandsBeforeCircuit = checked(
            (budget.MaxConcurrency + budget.CircuitFailureThreshold - 1) * (budget.RetryCount + 1));
        Assert.InRange(redisCommands, 1, maximumCommandsBeforeCircuit);
        Assert.InRange(maxActiveDatabaseCalls, 1, 4);
        Assert.Equal(databaseFallbacks, results.Sum());
        Assert.True(databaseRejections > 0);
        DbWorkloadGateSnapshot snapshot = databaseGate.GetDiagnostics().Workloads["public-short-read"];
        Assert.True(snapshot.P99ExecutionMs > 0);
        Assert.True(snapshot.QueueRejected > 0);
    }

    [Fact]
    public async Task MetricsExposeTimingFailureCircuitFallbackAndClassTags()
    {
        var measurements = new ConcurrentBag<(string Name, Dictionary<string, object?> Tags)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == "FsusBlog.Server.RedisOperations")
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.SetMeasurementEventCallback<double>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.SetMeasurementEventCallback<int>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.Start();

        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        Assert.Equal(
            1,
            await executor.ExecuteAsync(
                RedisOperationPort.UnifiedCacheRead,
                (_, _) => Task.FromResult(1),
                CancellationToken.None));

        var never = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.ArticleServiceOptionalProjection,
                (_, _) => never.Task,
                CancellationToken.None));

        using var cancellation = new CancellationTokenSource();
        Task<int> cancelled = executor.ExecuteAsync(
            RedisOperationPort.SharedDistributedCacheRead,
            async (_, token) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return 0;
            },
            cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);

        string[] requiredInstruments =
        [
            "fsus.redis.command.count",
            "fsus.redis.queue_time",
            "fsus.redis.server_time",
            "fsus.redis.end_to_end_time",
            "fsus.redis.timeout.count",
            "fsus.redis.cancel.count",
            "fsus.redis.circuit.state",
            "fsus.redis.fallback.count"
        ];
        Assert.All(requiredInstruments, name => Assert.Contains(measurements, item => item.Name == name));
        Assert.All(measurements, item =>
        {
            Assert.True(item.Tags.ContainsKey("fsus.redis.port"));
            Assert.True(item.Tags.ContainsKey("fsus.redis.class"));
            Assert.True(item.Tags.ContainsKey("fsus.redis.fail_action"));
        });
        Assert.Contains(
            measurements,
            item => item.Tags.GetValueOrDefault("fsus.redis.class") as string == "content-cache-read");
        Assert.Contains(
            measurements,
            item => item.Tags.GetValueOrDefault("fsus.redis.class") as string == "optional-projection");
    }

    private static RedisOperationExecutor CreateExecutor(IConnectionMultiplexer connection)
        => new(
            new FixedConnectionProvider(connection),
            new RedisOperationBudgetCatalog(),
            TimeProvider.System);

    private static void UpdateMaximum(ref int target, int candidate)
    {
        int current = Volatile.Read(ref target);
        while (candidate > current)
        {
            int observed = Interlocked.CompareExchange(ref target, candidate, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    private sealed class FixedConnectionProvider(IConnectionMultiplexer connection) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromResult(connection);
    }
}

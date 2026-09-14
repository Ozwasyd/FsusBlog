using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class CacheLeaseDurableReplayIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task PubSubLoss_DurableReplayDoesNotDuplicateCacheLeaseRebuild()
    {
        string connectionString = await CreateDatabaseAsync();
        string prefix = $"test:cache-lease-replay:{Guid.CreateVersion7():N}:";
        string channel = $"invalidation-{Guid.CreateVersion7():N}";
        RedisChannel physicalChannel = RedisChannel.Literal($"{prefix}{channel}");
        await using ConnectionMultiplexer sourceRedis = await redis.ConnectAsync();
        await using ConnectionMultiplexer targetRedis = await redis.ConnectAsync();

        var policies = new CachePolicyRegistry();
        var sourceScope = new TestRuntimeScope(prefix);
        var targetScope = new TestRuntimeScope(prefix);
        using var sourceMemory = new MemoryCache(new MemoryCacheOptions());
        using var targetMemory = new MemoryCache(new MemoryCacheOptions());
        using var sourceSingleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, sourceScope, NullLogger<CacheKeyResolver>.Instance));
        using var targetSingleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, targetScope, NullLogger<CacheKeyResolver>.Instance));
        using var sourceCache = new UnifiedCache(sourceRedis, policies, sourceScope, NullLogger<UnifiedCache>.Instance);
        using var targetCache = new UnifiedCache(targetRedis, policies, targetScope, NullLogger<UnifiedCache>.Instance);
        var sourceCoordinator = new CacheMissCoordinator(sourceSingleFlight, sourceCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var targetCoordinator = new CacheMissCoordinator(targetSingleFlight, targetCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var ownerStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var targetApplyStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowOwnerPublish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int sourceBuilds = 0;
        int targetBuilds = 0;
        string identity = "durable-replay";

        await using NpgsqlDataSource sourceDataSource = NpgsqlDataSource.Create(connectionString);
        var targetApplier = new CacheLeaseReplayApplier(
            targetCoordinator,
            targetCache,
            targetApplyStarted,
            () => Interlocked.Increment(ref targetBuilds));

        using ServiceProvider sourceServices = CreateLedgerServices(connectionString);
        using ServiceProvider targetServices = CreateLedgerServices(connectionString);
        using DistributedInvalidationBus source = CreateBus(
            "node-a",
            ["node-a", "node-b"],
            channel,
            prefix,
            sourceRedis,
            sourceServices,
            new NoopApplier());
        using DistributedInvalidationBus target = CreateBus(
            "node-b",
            ["node-a", "node-b"],
            channel,
            prefix,
            targetRedis,
            targetServices,
            targetApplier);

        await source.StartAsync(CancellationToken.None);
        await target.StartAsync(CancellationToken.None);
        await Task.Delay(TimeSpan.FromMilliseconds(150));
        await targetRedis.GetSubscriber().UnsubscribeAsync(physicalChannel);

        Task<string?> owner = sourceCoordinator.CoordinateAsync(
            CachePolicyId.SystemPage,
            identity,
            async token =>
            {
                string? value = await sourceCache.GetStringAsync(CachePolicyId.SystemPage, identity, token);
                return new CacheReadResult<string>(value is not null, value);
            },
            async token =>
            {
                Interlocked.Increment(ref sourceBuilds);
                await using NpgsqlCommand command = sourceDataSource.CreateCommand("SELECT 'built'::text");
                string value = (string)(await command.ExecuteScalarAsync(token) ?? throw new InvalidOperationException("cache lease replay source query returned null"));
                ownerStarted.TrySetResult();
                await allowOwnerPublish.Task.WaitAsync(token);
                await sourceCache.SetStringAsync(CachePolicyId.SystemPage, identity, value, cancellationToken: token);
                return value;
            },
            "cache-lease-durable-replay",
            strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(10)));

        await ownerStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        DistributedInvalidationPublishResult publication = await source.PublishAsync(CreateRequest());
        Assert.Equal(DistributedInvalidationPublishStatus.Degraded, publication.Status);
        await targetApplyStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        allowOwnerPublish.TrySetResult();

        Assert.Equal("built", await owner.WaitAsync(TimeSpan.FromSeconds(10)));
        await EventuallyAsync(() => targetApplier.Applied == 1);
        await EventuallyAsync(async () =>
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
            return db.Queryable<DistributedInvalidationConvergenceObligationEntity>().Single().State == "complete";
        });

        Assert.Equal(1, sourceBuilds);
        Assert.Equal(0, targetBuilds);
        Assert.Equal("built", await targetCache.GetStringAsync(CachePolicyId.SystemPage, identity));
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal("applied", verify.Queryable<DistributedInvalidationInboxEntity>().Single().ApplyState);

        await target.StopAsync(CancellationToken.None);
        await source.StopAsync(CancellationToken.None);
    }

    private async Task<string> CreateDatabaseAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(DistributedInvalidationConvergenceObligationEntity),
            typeof(DistributedInvalidationInboxEntity),
            typeof(DistributedInvalidationTopologyRetirementEntity),
            typeof(DistributedInvalidationReconcileCoverageEntity));
        return connection;
    }

    private static ServiceProvider CreateLedgerServices(string connection)
        => new ServiceCollection()
            .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connection))
            .AddSingleton(TimeProvider.System)
            .AddSingleton<DistributedInvalidationConvergenceRuntimeState>()
            .AddScoped<IDistributedInvalidationDeliveryLedger, DistributedInvalidationConvergenceObligationStore>()
            .BuildServiceProvider();

    private static DistributedInvalidationBus CreateBus(
        string nodeId,
        IReadOnlyList<string> nodeIds,
        string channel,
        string prefix,
        IConnectionMultiplexer redis,
        ServiceProvider services,
        IDistributedInvalidationLocalApplier applier)
    {
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = nodeId,
            Channel = channel,
            Topology = DistributedInvalidationTopologyManifest.Create(channel, nodeIds),
            ApplyRetryCount = 2,
            ApplyRetryDelay = TimeSpan.FromMilliseconds(10),
            RecoveryReplayInterval = TimeSpan.FromMilliseconds(100),
            DedupeCapacity = 128
        };
        var scope = new TestRuntimeScope(prefix);
        return new DistributedInvalidationBus(
            new RedisDistributedInvalidationTransport(
                RedisOperationExecutor.ForTestConnection(redis),
                scope,
                options,
                TimeProvider.System),
            applier,
            new DistributedInvalidationEventFactory(options, scope, TimeProvider.System),
            options,
            new DistributedInvalidationRuntimeState(TimeProvider.System),
            new CacheInvalidationRuntimeState(),
            NullLogger<DistributedInvalidationBus>.Instance,
            services.GetRequiredService<IServiceScopeFactory>());
    }

    private static DistributedInvalidationRequest CreateRequest()
        => new(
            DistributedInvalidationEventKinds.ArticleMutation,
            ["article"],
            ["article:42"],
            ["public-aot"]);

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate())
        {
            await Task.Delay(25, timeout.Token);
        }
    }

    private static async Task EventuallyAsync(Func<Task<bool>> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await predicate())
        {
            await Task.Delay(25, timeout.Token);
        }
    }

    private sealed class TestRuntimeScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;

        public string PrefixKey(string key)
            => string.Concat(prefix, key);
    }

    private sealed class NoopApplier : IDistributedInvalidationLocalApplier
    {
        public Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
            => Task.FromResult<DistributedInvalidationLocalApplyResult?>(null);
    }

    private sealed class CacheLeaseReplayApplier(
        ICacheMissCoordinator coordinator,
        UnifiedCache cache,
        TaskCompletionSource applyStarted,
        Action recordBuild) : IDistributedInvalidationLocalApplier
    {
        public int Applied
        {
            get;
            private set;
        }

        public async Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
            DistributedInvalidationEvent invalidation,
            CancellationToken cancellationToken = default)
        {
            applyStarted.TrySetResult();
            string? value = await coordinator.CoordinateAsync(
                CachePolicyId.SystemPage,
                "durable-replay",
                async token =>
                {
                    string? cached = await cache.GetStringAsync(CachePolicyId.SystemPage, "durable-replay", token);
                    return new CacheReadResult<string>(cached is not null, cached);
                },
                token =>
                {
                    recordBuild();
                    return Task.FromResult<string?>("target-must-not-rebuild");
                },
                "cache-lease-durable-replay",
                cancellationToken,
                new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(10)));
            if (value != "built")
            {
                throw new InvalidOperationException($"durable replay observed unexpected cache value '{value ?? "null"}'");
            }

            Applied++;
            return new DistributedInvalidationLocalApplyResult(
                true,
                true,
                true,
                true,
                DistributedInvalidationRebuildObligationStatus.Durable,
                DistributedInvalidationLocalApplyStatus.Applied,
                "cache-lease-replay-proof",
                1,
                1);
        }
    }
}

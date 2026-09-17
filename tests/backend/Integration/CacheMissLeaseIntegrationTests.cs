using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CacheMissLeaseIntegrationTests(PublicHotDeliveryRedisFixture redis, PostgresSchemaMigrationFixture postgres, Xunit.Abstractions.ITestOutputHelper output) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    public async Task SeparateProcesses_ColdKey_ExecuteOneDatabaseCommand(int concurrency)
    {
        string database = await postgres.CreateDatabaseAsync();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"eight-cache-process-{Guid.NewGuid():N}:";
        await using var first = new CacheCoordinationProcessProbe.Child(connection.Configuration, postgres.BuildDatabaseConnectionString(database), prefix, "normal", concurrency / 2);
        await using var second = new CacheCoordinationProcessProbe.Child(connection.Configuration, postgres.BuildDatabaseConnectionString(database), prefix, "normal", concurrency / 2);
        await Task.WhenAll(first.ReadyAsync(), second.ReadyAsync());
        output.WriteLine(first.Identity);
        output.WriteLine(second.Identity);
        await Task.WhenAll(first.GoAsync(), second.GoAsync());
        using var a = await first.ReadAsync("complete");
        using var b = await second.ReadAsync("complete");
        output.WriteLine(a.RootElement.GetRawText());
        output.WriteLine(b.RootElement.GetRawText());
        Assert.Equal(1, a.RootElement.GetProperty("dbCommands").GetInt32() + b.RootElement.GetProperty("dbCommands").GetInt32());
        Assert.Equal(concurrency, a.RootElement.GetProperty("successes").GetInt32() + b.RootElement.GetProperty("successes").GetInt32());
        Assert.Equal(0, a.RootElement.GetProperty("activeEntries").GetInt32());
        Assert.Equal(0, b.RootElement.GetProperty("activeEntries").GetInt32());
        await Task.WhenAll(first.FinishAsync(), second.FinishAsync());
    }

    [Fact]
    public async Task OwnerProcessCrash_LeaseExpiresAndSuccessorPublishes()
    {
        string database = await postgres.CreateDatabaseAsync();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"eight-cache-crash-{Guid.NewGuid():N}:";
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using var cache = new UnifiedCache(connection, new CachePolicyRegistry(), new TestKeyScope(prefix), NullLogger<UnifiedCache>.Instance);
        string lease = cache.BuildKey(CachePolicyId.SystemPage, "__lease__:value");
        string value = cache.BuildKey(CachePolicyId.SystemPage, "value");
        IDatabase db = connection.GetDatabase();
        await using var owner = new CacheCoordinationProcessProbe.Child(connection.Configuration, postgres.BuildDatabaseConnectionString(database), prefix, "crash", 1);
        await owner.ReadyAsync();
        output.WriteLine(owner.Identity);
        await owner.GoAsync();
        using var owned = await owner.ReadAsync("owned");
        output.WriteLine(owned.RootElement.GetRawText());
        Assert.Equal(1, owned.RootElement.GetProperty("dbCommands").GetInt32());
        string[] commands = owned.RootElement.GetProperty("redisCommands").EnumerateArray().Select(item => item.GetString()!).ToArray();
        Assert.Equal(2, commands.Count(command => command == "GET"));
        Assert.Equal(1, commands.Count(command => command == "SET"));
        Assert.True(await db.KeyExistsAsync(lease));
        await owner.KillOwnerAsync();
        Assert.False(await db.KeyExistsAsync(value));
        var deadline = Stopwatch.StartNew();
        while (await db.KeyExistsAsync(lease) && deadline.Elapsed < TimeSpan.FromSeconds(8))
        {
            await Task.Delay(50);
        }
        Assert.False(await db.KeyExistsAsync(lease));
        await using var successor = new CacheCoordinationProcessProbe.Child(connection.Configuration, postgres.BuildDatabaseConnectionString(database), prefix, "normal", 1);
        await successor.ReadyAsync();
        output.WriteLine($"ownerExited=true leaseExpired=true expiryObservationMs={deadline.Elapsed.TotalMilliseconds:F0}");
        output.WriteLine(successor.Identity);
        await successor.GoAsync();
        using var completed = await successor.ReadAsync("complete");
        output.WriteLine(completed.RootElement.GetRawText());
        Assert.Equal(1, completed.RootElement.GetProperty("dbCommands").GetInt32());
        await successor.FinishAsync();
        Assert.Equal("built", await cache.GetStringAsync(CachePolicyId.SystemPage, "value"));
        Assert.False(await db.KeyExistsAsync(lease));
    }

    [Theory]
    [InlineData("loser")]
    [InlineData("write-failure")]
    public async Task CoordinationFailure_CapturesRedisAndPostgresCommands(string scenario)
    {
        string database = await postgres.CreateDatabaseAsync();
        using var commandCapture = new PostgresCommandCapture();
        using ILoggerFactory logFactory = LoggerFactory.Create(builder => builder.SetMinimumLevel(LogLevel.Information).AddProvider(commandCapture));
        var dataSourceBuilder = new NpgsqlDataSourceBuilder(postgres.BuildDatabaseConnectionString(database));
        dataSourceBuilder.UseLoggerFactory(logFactory);
        await using NpgsqlDataSource dataSource = dataSourceBuilder.Build();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-failure-capture-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        const CachePolicyId Policy = CachePolicyId.TaxonomyExactMetadataFrame;
        string leaseKey = cache.BuildKey(Policy, "__lease__:value");
        string valueKey = cache.BuildKey(Policy, "value");
        string registryKey = scope.PrefixKey(UnifiedCache.BuildRegistryKeyForTests(Policy));
        IDatabase db = connection.GetDatabase();
        if (scenario == "loser")
        {
            await db.StringSetAsync(leaseKey, "other-owner", TimeSpan.FromSeconds(30));
        }
        else
        {
            await db.StringSetAsync(registryKey, "wrong-type");
        }
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        try
        {
            CacheCoordinationException failure = await Assert.ThrowsAsync<CacheCoordinationException>(() => coordinator.CoordinateAsync<string>(Policy, "value",
                async token =>
                {
                    string? value = await cache.GetStringAsync(Policy, "value", token);
                    return new CacheReadResult<string>(value is not null, value);
                },
                async token =>
                {
                    await using NpgsqlCommand query = dataSource.CreateCommand("SELECT 'built'::text");
                    Assert.Equal("built", await query.ExecuteScalarAsync(token));
                    await cache.SetStringAsync(Policy, "value", "built", cancellationToken: token);
                    return "built";
                }, "failure-capture",
                strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(20), TimeSpan.FromSeconds(10))));
            string[] commands = profile.FinishProfiling().Select(command => command.Command).ToArray();
            Assert.Equal(1, commands.Count(command => command == "SET"));
            Assert.DoesNotContain("SADD", commands);
            if (scenario == "loser")
            {
                Assert.Equal("refill-timeout", failure.Reason);
                Assert.Empty(commandCapture.Completed);
                Assert.Equal(3, commands.Count(command => command == "GET"));
                Assert.DoesNotContain(commands, command => command is "EVAL" or "EVALSHA");
                Assert.Equal("other-owner", (string?)await db.StringGetAsync(leaseKey));
            }
            else
            {
                Assert.Equal("publication-registry-invalid", failure.Reason);
                Assert.Equal("SELECT 'built'::text", Assert.Single(commandCapture.Completed));
                Assert.Equal(2, commands.Count(command => command == "GET"));
                Assert.Equal(2, commands.Count(command => command is "EVAL" or "EVALSHA"));
                Assert.False(await db.KeyExistsAsync(leaseKey));
            }
            Assert.False(await db.KeyExistsAsync(valueKey));
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
        finally
        {
            await db.KeyDeleteAsync([leaseKey, valueKey, registryKey]);
        }
    }

    [Fact]
    public async Task FactoryProfiler_EmitsCoordinationMeasurementsWithoutIdentities()
    {
        await using ConnectionMultiplexer fixtureConnection = await redis.ConnectAsync();
        using IConnectionMultiplexer connection = await new StackExchangeRedisConnectionMultiplexerFactory().CreateAsync(ConfigurationOptions.Parse(fixtureConnection.Configuration));
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-metrics-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        using Activity activity = new Activity("cache-coordination-test").Start();
        var samples = new ConcurrentDictionary<string, double>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, owner) =>
        {
            if (instrument.Name.StartsWith("fsus.cache.coordination.", StringComparison.Ordinal))
            {
                owner.EnableMeasurementEvents(instrument);
            }
        };
        void Record(Instrument instrument, double measurement, ReadOnlySpan<KeyValuePair<string, object?>> tags)
        {
            if (Activity.Current?.TraceId != activity.TraceId)
            {
                return;
            }
            foreach (KeyValuePair<string, object?> tag in tags)
            {
                Assert.Contains(tag.Key, new[] { "fsus.cache.policy", "fsus.cache.release.outcome" });
            }
            samples[instrument.Name] = measurement;
        }
        listener.SetMeasurementEventCallback<long>((instrument, value, tags, _) => Record(instrument, value, tags));
        listener.SetMeasurementEventCallback<double>((instrument, value, tags, _) => Record(instrument, value, tags));
        listener.Start();
        try
        {
            await coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, "private-identity",
                async token =>
                {
                    string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, "private-identity", token);
                    return new CacheReadResult<string>(value is not null, value);
                },
                async token =>
                {
                    await cache.SetStringAsync(CachePolicyId.SystemPage, "private-identity", "private-payload", cancellationToken: token);
                    return "private-payload";
                }, "private-operation");
            Assert.Equal(6, samples.Count);
            Assert.Equal(5, samples["fsus.cache.coordination.redis_commands"]);
            Assert.Equal(1, samples["fsus.cache.coordination.rebuild_count"]);
            Assert.Equal(1, samples["fsus.cache.coordination.release"]);
            Assert.Equal(0, samples["fsus.cache.coordination.active_entries"]);
            Assert.True(samples["fsus.cache.coordination.local_wait"] >= 0);
            Assert.True(samples["fsus.cache.coordination.lease_wait"] >= 0);
        }
        finally
        {
            await cache.RemoveAsync(CachePolicyId.SystemPage, "private-identity");
        }
    }

    [Fact]
    public async Task InvalidRegistry_RejectsPublicationWithoutValueAndReleasesLease()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-write-failure-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        const CachePolicyId Policy = CachePolicyId.TaxonomyExactMetadataFrame;
        string registryKey = scope.PrefixKey(UnifiedCache.BuildRegistryKeyForTests(Policy));
        string valueKey = cache.BuildKey(Policy, "value");
        string leaseKey = cache.BuildKey(Policy, "__lease__:value");
        IDatabase db = connection.GetDatabase();
        await db.StringSetAsync(registryKey, "invalid-registry-type");
        try
        {
            CacheCoordinationException failure = await Assert.ThrowsAsync<CacheCoordinationException>(() => coordinator.CoordinateAsync<string>(Policy, "value",
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await cache.SetStringAsync(Policy, "value", "uncommitted", cancellationToken: token);
                    return "uncommitted";
                }, "invalid-registry"));
            Assert.Equal("publication-registry-invalid", failure.Reason);
            Assert.False(await db.KeyExistsAsync(valueKey));
            Assert.False(await db.KeyExistsAsync(leaseKey));
            Assert.False((await cache.TryGetRawAsync(Policy, "value")).Hit);
            Assert.Equal("invalid-registry-type", (string?)await db.StringGetAsync(registryKey));
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
        finally
        {
            await db.KeyDeleteAsync([registryKey, valueKey, leaseKey]);
        }
    }

    [Fact]
    public async Task SuccessfulRenewal_PublishesAfterInitialLeaseTtlAndReleasesAuthority()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-renew-success-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string valueKey = cache.BuildKey(CachePolicyId.SystemPage, "value");
        string leaseKey = cache.BuildKey(CachePolicyId.SystemPage, "__lease__:value");
        IDatabase db = connection.GetDatabase();
        try
        {
            string? result = await coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, "value",
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(1500), token);
                    Assert.True(await db.KeyExistsAsync(leaseKey));
                    await cache.SetStringAsync(CachePolicyId.SystemPage, "value", "renewed", cancellationToken: token);
                    return "renewed";
                }, "renewed-publication",
                strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(1), TimeSpan.Zero, TimeSpan.FromSeconds(5)));
            Assert.Equal("renewed", result);
            Assert.Equal("renewed", (string?)await db.StringGetAsync(valueKey));
            Assert.False(await db.KeyExistsAsync(leaseKey));
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
        finally
        {
            await db.KeyDeleteAsync([valueKey, leaseKey]);
        }
    }

    [Fact]
    public async Task ColdLeader_ProfilesTwoReadsOneAcquireAndAtomicPublishRelease()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-profile-{Guid.NewGuid():N}";
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        try
        {
            string? result = await coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                async token =>
                {
                    string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, identity, token);
                    return new CacheReadResult<string>(value is not null, value);
                },
                async token =>
                {
                    await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "built", cancellationToken: token);
                    return "built";
                }, "profile");
            Assert.Equal("built", result);
            string[] commands = profile.FinishProfiling().Select(command => command.Command).ToArray();
            Assert.Equal(2, commands.Count(command => command == "GET"));
            Assert.Equal(1, commands.Count(command => command == "SET"));
            Assert.Equal(2, commands.Count(command => command is "EVAL" or "EVALSHA"));
            Assert.DoesNotContain("SADD", commands);
            Assert.False(await connection.GetDatabase().KeyExistsAsync(cache.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}")));
        }
        finally
        {
            await cache.RemoveAsync(CachePolicyId.SystemPage, identity);
        }
    }

    [Fact]
    public async Task ArticleHotFrame_ColdLeaderPublishesAtomicallyWithoutRegistryAndL1HitUsesNoRedis()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-hot-frame-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = "v1:frame:article-hot:aeds-v2:ranking-v1:count:10";
        Assert.Equal(1, await cache.IncrementAsync(
            CachePolicyId.AdminStats,
            IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
        var activeProfile = new ProfilingSession();
        connection.RegisterProfiler(() => activeProfile);
        OwnedAedsFrameReadLease? response = null;
        try
        {
            response = await coordinator.CoordinateAsync<OwnedAedsFrameReadLease>(
                CachePolicyId.ArticleHotFrame,
                identity,
                async token =>
                {
                    OwnedFrameCacheReadResult read = await cache.TryGetOwnedFrameAsync(
                        CachePolicyId.ArticleHotFrame,
                        identity,
                        AedsFrameType.ArticleHot,
                        token);
                    return new CacheReadResult<OwnedAedsFrameReadLease>(read.Hit, read.Lease);
                },
                async token =>
                {
                    OwnedAedsFrame frame = AedsOwnedFrameBuilder.BuildOwned(
                        AedsFrameType.ArticleHot,
                        writer => PodBinaryCodec.WritePopularArticles([], writer));
                    OwnedAedsFrameReadLease lease = frame.AcquireReadLease();
                    Assert.True(await cache.TrySetOwnedFrameAsync(
                        CachePolicyId.ArticleHotFrame,
                        identity,
                        frame,
                        new OwnedFramePublicationGuard(
                            CachePolicyId.AdminStats,
                            IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                            1),
                        cancellationToken: token));
                    return lease;
                },
                "article-hot-frame");

            Assert.NotNull(response);
            string[] coldCommands = activeProfile.FinishProfiling().Select(command => command.Command).ToArray();
            Assert.Equal(2, coldCommands.Count(command => command == "GET"));
            Assert.Equal(1, coldCommands.Count(command => command == "SET"));
            Assert.Equal(2, coldCommands.Count(command => command is "EVAL" or "EVALSHA"));
            Assert.DoesNotContain("SADD", coldCommands);
            Assert.False(await connection.GetDatabase().KeyExistsAsync(scope.PrefixKey(UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.ArticleHotFrame))));

            activeProfile = new ProfilingSession();
            OwnedFrameCacheReadResult l1 = await cache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleHotFrame,
                identity,
                AedsFrameType.ArticleHot);
            Assert.True(l1.Hit);
            l1.Lease!.Dispose();
            Assert.Empty(activeProfile.FinishProfiling());
        }
        finally
        {
            response?.Dispose();
            await cache.RemoveAsync(CachePolicyId.ArticleHotFrame, identity);
            await cache.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    [Fact]
    public async Task ArticleHotFrame_GenerationDriftIsRejectedAtPublicationLinearizationPoint()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-hot-frame-drift-{Guid.NewGuid():N}:");
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        const string Identity = "v1:frame:article-hot:aeds-v2:ranking-v1:count:10";

        Assert.Equal(1, await cache.IncrementAsync(
            CachePolicyId.AdminStats,
            IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
        try
        {
            bool? published = await coordinator.CoordinateAsync<bool>(
                CachePolicyId.ArticleHotFrame,
                Identity,
                _ => Task.FromResult(new CacheReadResult<bool>(false, default)),
                async token =>
                {
                    Assert.Equal(2, await cache.IncrementAsync(
                        CachePolicyId.AdminStats,
                        IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                        cancellationToken: token));
                    OwnedAedsFrame frame = AedsOwnedFrameBuilder.BuildOwned(
                        AedsFrameType.ArticleHot,
                        writer => PodBinaryCodec.WritePopularArticles([], writer));
                    return await cache.TrySetOwnedFrameAsync(
                        CachePolicyId.ArticleHotFrame,
                        Identity,
                        frame,
                        new OwnedFramePublicationGuard(
                            CachePolicyId.AdminStats,
                            IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                            1),
                        cancellationToken: token);
                },
                "article-hot-frame-generation-drift");

            Assert.False(published);
            Assert.False(await connection.GetDatabase().KeyExistsAsync(cache.BuildKey(CachePolicyId.ArticleHotFrame, Identity)));
            OwnedFrameCacheReadResult local = await cache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleHotFrame,
                Identity,
                AedsFrameType.ArticleHot);
            Assert.False(local.Hit);
        }
        finally
        {
            await cache.RemoveAsync(CachePolicyId.ArticleHotFrame, Identity);
            await cache.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    [Fact]
    public async Task ArticleHotFrame_TwoNodesSameGenerationExecuteOneWholeBuild()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var firstMemory = new MemoryCache(new MemoryCacheOptions());
        using var secondMemory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope($"eight-cache-hot-frame-two-node-{Guid.NewGuid():N}:");
        using var firstCache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var secondCache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var firstSingleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        using var secondSingleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var firstCoordinator = new CacheMissCoordinator(firstSingleFlight, firstCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var secondCoordinator = new CacheMissCoordinator(secondSingleFlight, secondCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        const string Identity = "v7:frame:article-hot:aeds-v2:ranking-v1:count:50";
        int wholeBuilds = 0;

        async Task<OwnedAedsFrameReadLease?> ExecuteAsync(UnifiedCache cache, CacheMissCoordinator coordinator)
            => await coordinator.CoordinateAsync<OwnedAedsFrameReadLease>(
                CachePolicyId.ArticleHotFrame,
                Identity,
                async token =>
                {
                    OwnedFrameCacheReadResult read = await cache.TryGetOwnedFrameAsync(
                        CachePolicyId.ArticleHotFrame,
                        Identity,
                        AedsFrameType.ArticleHot,
                        token);
                    return new CacheReadResult<OwnedAedsFrameReadLease>(read.Hit, read.Lease);
                },
                async token =>
                {
                    Interlocked.Increment(ref wholeBuilds);
                    await Task.Delay(100, token);
                    OwnedAedsFrame frame = AedsOwnedFrameBuilder.BuildOwned(
                        AedsFrameType.ArticleHot,
                        writer => PodBinaryCodec.WritePopularArticles([], writer));
                    OwnedAedsFrameReadLease lease = frame.AcquireReadLease();
                    await cache.SetOwnedFrameAsync(CachePolicyId.ArticleHotFrame, Identity, frame, cancellationToken: token);
                    return lease;
                },
                "article-hot-frame-two-node");

        Task<OwnedAedsFrameReadLease?> first = ExecuteAsync(firstCache, firstCoordinator);
        Task<OwnedAedsFrameReadLease?> second = ExecuteAsync(secondCache, secondCoordinator);
        OwnedAedsFrameReadLease?[] results = await Task.WhenAll(first, second);
        try
        {
            Assert.Equal(1, Volatile.Read(ref wholeBuilds));
            Assert.All(results, Assert.NotNull);
        }
        finally
        {
            foreach (OwnedAedsFrameReadLease? result in results)
            {
                result?.Dispose();
            }
            await firstCache.RemoveAsync(CachePolicyId.ArticleHotFrame, Identity);
        }
    }

    [Theory]
    [InlineData("string")]
    [InlineData("negative")]
    [InlineData("owned")]
    public async Task ReplacedOwner_CannotPublishValueOrDeleteReplacementLease(string kind)
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using var cache = new UnifiedCache(connection, new CachePolicyRegistry(), new DefaultRuntimeKeyScope(), NullLogger<UnifiedCache>.Instance);
        var resolver = new CacheKeyResolver(new CachePolicyRegistry(), new DefaultRuntimeKeyScope(), NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(resolver);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-fence-{Guid.NewGuid():N}";
        CachePolicyId policy = kind == "owned" ? CachePolicyId.ArticleHotFrame : CachePolicyId.SystemPage;
        string leaseKey = cache.BuildKey(policy, $"__lease__:{identity}");
        string valueKey = cache.BuildKey(policy, identity);
        IDatabase db = connection.GetDatabase();
        try
        {
            CacheCoordinationException failure = await Assert.ThrowsAsync<CacheCoordinationException>(() => coordinator.CoordinateAsync<string>(
                policy, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async _ =>
                {
                    Assert.True(await db.StringSetAsync(leaseKey, "replacement-owner", TimeSpan.FromSeconds(30)));
                    if (kind == "negative")
                    {
                        await cache.SetNegativeAsync(CachePolicyId.SystemPage, identity, CancellationToken.None);
                    }
                    else if (kind == "owned")
                    {
                        using var writer = new AedsFrameBufferWriter(128);
                        writer.Write(new byte[8]);
                        writer.Seal(AedsFrameType.ArticleHot);
                        await cache.SetOwnedFrameAsync(policy, identity, writer.DetachOwnedFrame(), cancellationToken: CancellationToken.None);
                    }
                    else
                    {
                        await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "obsolete", cancellationToken: CancellationToken.None);
                    }
                    return "obsolete";
                }, "replaced-owner"));
            Assert.Equal("publication-lease-lost", failure.Reason);
            Assert.False(await db.KeyExistsAsync(valueKey));
            Assert.False((await cache.TryGetRawAsync(policy, identity)).Hit);
            Assert.Equal(0, cache.GetOwnedFrameResidencySnapshot().EntryCount);
            Assert.Equal("replacement-owner", (string?)await db.StringGetAsync(leaseKey));
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
        finally
        {
            await db.KeyDeleteAsync([leaseKey, valueKey]);
        }
    }

    [Theory]
    [InlineData(100, false)]
    [InlineData(1000, false)]
    [InlineData(100, true)]
    [InlineData(1000, true)]
    public async Task Coordinators_ColdKey_ExecuteOnePostgresCommandAndReleaseLease(int concurrency, bool twoNodes)
    {
        string database = await postgres.CreateDatabaseAsync();
        using var commandCapture = new PostgresCommandCapture();
        using ILoggerFactory logFactory = LoggerFactory.Create(builder => builder.SetMinimumLevel(LogLevel.Information).AddProvider(commandCapture));
        var dataSourceBuilder = new NpgsqlDataSourceBuilder(postgres.BuildDatabaseConnectionString(database));
        dataSourceBuilder.UseLoggerFactory(logFactory);
        await using NpgsqlDataSource dataSource = dataSourceBuilder.Build();
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memoryA = new MemoryCache(new MemoryCacheOptions());
        using var memoryB = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cacheA = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var cacheB = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        var resolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleA = new CacheSingleFlightCoordinator(resolver);
        using var singleB = new CacheSingleFlightCoordinator(resolver);
        var coordinatorA = new CacheMissCoordinator(singleA, cacheA, policies, NullLogger<CacheMissCoordinator>.Instance);
        var coordinatorB = new CacheMissCoordinator(singleB, cacheB, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-concurrency-{Guid.NewGuid():N}";
        string leaseKey = cacheA.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}");
        string valueKey = cacheA.BuildKey(CachePolicyId.SystemPage, identity);
        var builderStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseBuilder = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int builds = 0;
        try
        {
            Task<string?>[] requests = Enumerable.Range(0, concurrency).Select(index =>
            {
                UnifiedCache cache = !twoNodes || index % 2 == 0 ? cacheA : cacheB;
                CacheMissCoordinator coordinator = !twoNodes || index % 2 == 0 ? coordinatorA : coordinatorB;
                return coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                    async token =>
                    {
                        string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, identity, token);
                        return new CacheReadResult<string>(value is not null, value);
                    },
                    async token =>
                    {
                        Interlocked.Increment(ref builds);
                        builderStarted.TrySetResult();
                        await releaseBuilder.Task.WaitAsync(token);
                        await using NpgsqlCommand query = dataSource.CreateCommand("SELECT 'built'::text");
                        Assert.Equal("built", await query.ExecuteScalarAsync(token));
                        await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "built", cancellationToken: token);
                        return "built";
                    }, "two-coordinators",
                    strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10)));
            }).ToArray();
            await builderStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
            releaseBuilder.SetResult();
            string?[] values = await Task.WhenAll(requests).WaitAsync(TimeSpan.FromSeconds(20));
            Assert.All(values, value => Assert.Equal("built", value));
            Assert.Equal(1, builds);
            Assert.Equal("SELECT 'built'::text", Assert.Single(commandCapture.Completed));
            Assert.False(await connection.GetDatabase().KeyExistsAsync(leaseKey));
            Assert.Equal(0, singleA.ActiveEntryCount);
            Assert.Equal(0, singleB.ActiveEntryCount);
        }
        finally
        {
            releaseBuilder.TrySetResult();
            await connection.GetDatabase().KeyDeleteAsync([leaseKey, valueKey]);
        }
    }

    [Fact]
    public async Task RenewalLosesAuthority_IgnoringCancellationCannotInstallL1OrL2()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-renew-loss-{Guid.NewGuid():N}";
        string leaseKey = cache.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}");
        IDatabase db = connection.GetDatabase();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await db.StringSetAsync(leaseKey, "new-owner", TimeSpan.FromSeconds(30));
                    var lost = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    using CancellationTokenRegistration registration = token.Register(() => lost.TrySetResult());
                    await lost.Task.WaitAsync(TimeSpan.FromSeconds(3));
                    await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "obsolete", cancellationToken: CancellationToken.None);
                    return "obsolete";
                }, "renew-loss",
                strategy: new CacheRebuildStrategy(TimeSpan.FromMilliseconds(500), TimeSpan.Zero, TimeSpan.FromSeconds(5))));
            Assert.False(await db.KeyExistsAsync(cache.BuildKey(CachePolicyId.SystemPage, identity)));
            Assert.False((await cache.TryGetRawAsync(CachePolicyId.SystemPage, identity)).Hit);
            Assert.Equal("new-owner", (string?)await db.StringGetAsync(leaseKey));
        }
        finally
        {
            await db.KeyDeleteAsync(leaseKey);
            await cache.RemoveAsync(CachePolicyId.SystemPage, identity);
        }
    }

    [Fact]
    public async Task FencedPublication_PreservesTtlAndRegistryMembership()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-registry-{Guid.NewGuid():N}";
        const CachePolicyId Policy = CachePolicyId.TaxonomyExactMetadataFrame;
        string valueKey = cache.BuildKey(Policy, identity);
        string registryKey = UnifiedCache.BuildRegistryKeyForTests(Policy);
        IDatabase db = connection.GetDatabase();
        try
        {
            await coordinator.CoordinateAsync<string>(Policy, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await cache.SetStringAsync(Policy, identity, "built", TimeSpan.FromSeconds(30), token);
                    return "built";
                }, "registry");
            Assert.Equal("built", (string?)await db.StringGetAsync(valueKey));
            Assert.True(await db.SetContainsAsync(registryKey, valueKey));
            TimeSpan? ttl = await db.KeyTimeToLiveAsync(valueKey);
            Assert.NotNull(ttl);
            Assert.InRange(ttl.Value.TotalSeconds, 20, 33);
            Assert.Null(await db.KeyTimeToLiveAsync(registryKey));
        }
        finally
        {
            await cache.RemoveAsync(Policy, identity);
        }
        Assert.False(await db.SetContainsAsync(registryKey, valueKey));
    }

    [Fact]
    public async Task NestedPublication_ChecksParentLeaseAndRejectsDifferentStore()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using var otherMemory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var other = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        string identity = $"eight-cache-nested-{Guid.NewGuid():N}";
        string leaseKey = cache.BuildKey(CachePolicyId.SystemPage, identity);
        string childKey = cache.BuildKey(CachePolicyId.SystemPage, $"{identity}-child");
        IDatabase db = connection.GetDatabase();
        await db.StringSetAsync(leaseKey, "replaced", TimeSpan.FromSeconds(30));
        await db.StringSetAsync(childKey, "child", TimeSpan.FromSeconds(30));
        try
        {
            using var parent = new CacheRebuildLeaseScope(cache, CachePolicyId.SystemPage, identity, "old", CancellationToken.None);
            using (var child = new CacheRebuildLeaseScope(cache, CachePolicyId.SystemPage, $"{identity}-child", "child", CancellationToken.None))
            {
                CacheCoordinationException lost = await Assert.ThrowsAsync<CacheCoordinationException>(() => cache.SetStringAsync(CachePolicyId.SystemPage, $"{identity}-value", "obsolete"));
                Assert.Equal("publication-lease-lost", lost.Reason);
            }
            Assert.Same(parent, CacheRebuildLeaseScope.Current);
            CacheCoordinationException mismatch = await Assert.ThrowsAsync<CacheCoordinationException>(() => other.SetStringAsync(CachePolicyId.SystemPage, $"{identity}-value", "obsolete"));
            Assert.Equal("publication-store-mismatch", mismatch.Reason);
            Assert.False((await cache.TryGetRawAsync(CachePolicyId.SystemPage, $"{identity}-value")).Hit);
            Assert.False((await other.TryGetRawAsync(CachePolicyId.SystemPage, $"{identity}-value")).Hit);
        }
        finally
        {
            await db.KeyDeleteAsync([leaseKey, childKey]);
        }
    }
    private sealed class TestKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class PostgresCommandCapture : ILoggerProvider, ILogger
    {
        internal ConcurrentQueue<string> Completed { get; } = new();
        public ILogger CreateLogger(string categoryName) => this;
        public bool IsEnabled(LogLevel logLevel) => true;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public void Dispose()
        {
        }

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Name == "CommandExecutionCompleted" && state is IEnumerable<KeyValuePair<string, object?>> fields)
            {
                Completed.Enqueue(fields.Single(field => field.Key == "CommandText").Value?.ToString() ?? string.Empty);
            }
        }
    }
}

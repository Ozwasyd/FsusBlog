using System.Diagnostics;

using BenchmarkDotNet.Attributes;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

[Config(typeof(CacheL1TelemetryPercentileConfig))]
[MemoryDiagnoser]
public class UnifiedCacheL1TelemetryIncrementHotPathBenchmarks
{
    private const int Identity = 42;
    private readonly CachePolicyRegistry _policies = new();
    private readonly DefaultRuntimeKeyScope _scope = new();
    private readonly MemoryCache _disabledMemory = new(new MemoryCacheOptions());
    private readonly MemoryCache _sampledMemory = new(new MemoryCacheOptions());
    private UnifiedCache _telemetryDisabled = null!;
    private UnifiedCache _sampledTelemetry = null!;

    [GlobalSetup]
    public void Setup()
    {
        IDatabase database = Substitute.For<IDatabase>();
        database.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);

        _telemetryDisabled = CreateCache(redis, _disabledMemory, DisabledCacheTelemetry.Instance);
        _sampledTelemetry = CreateCache(redis, _sampledMemory, new CacheTelemetry());
        Seed(_telemetryDisabled);
        Seed(_sampledTelemetry);
    }

    [Benchmark(Baseline = true)]
    public Task<CacheReadResult<int>> TelemetryOff_TypedL1Hit()
        => _telemetryDisabled.TryGetAsync(
            CachePolicyId.ArticleDetail,
            Identity,
            static bytes => (true, bytes.Length));

    [Benchmark]
    public Task<CacheReadResult<int>> SampledTelemetry_TypedL1Hit()
        => _sampledTelemetry.TryGetAsync(
            CachePolicyId.ArticleDetail,
            Identity,
            static bytes => (true, bytes.Length));

    [Benchmark]
    public Task<CacheReadResult<byte[]>> TelemetryOff_RawL1Hit()
        => _telemetryDisabled.TryGetRawAsync(CachePolicyId.ArticleHot, Identity);

    [Benchmark]
    public Task<CacheReadResult<byte[]>> SampledTelemetry_RawL1Hit()
        => _sampledTelemetry.TryGetRawAsync(CachePolicyId.ArticleHot, Identity);

    [Benchmark]
    public Task<CacheReadResult<ReadOnlyMemory<byte>>> TelemetryOff_ReadonlyL1Hit()
        => _telemetryDisabled.TryGetRawReadonlyAsync(CachePolicyId.SystemSeo, Identity);

    [Benchmark]
    public Task<CacheReadResult<ReadOnlyMemory<byte>>> SampledTelemetry_ReadonlyL1Hit()
        => _sampledTelemetry.TryGetRawReadonlyAsync(CachePolicyId.SystemSeo, Identity);

    [Benchmark]
    public async Task<int> TelemetryOff_OwnedL1Hit()
    {
        OwnedFrameCacheReadResult read = await _telemetryDisabled.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleDetailFrame,
            Identity,
            AedsFrameType.ArticleDetail);
        using OwnedAedsFrameReadLease lease = read.Lease!;
        return lease.Length;
    }

    [Benchmark]
    public async Task<int> SampledTelemetry_OwnedL1Hit()
    {
        OwnedFrameCacheReadResult read = await _sampledTelemetry.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleDetailFrame,
            Identity,
            AedsFrameType.ArticleDetail);
        using OwnedAedsFrameReadLease lease = read.Lease!;
        return lease.Length;
    }

    [GlobalCleanup]
    public void Cleanup()
    {
        _telemetryDisabled.Dispose();
        _sampledTelemetry.Dispose();
        _disabledMemory.Dispose();
        _sampledMemory.Dispose();
    }

    private UnifiedCache CreateCache(
        IConnectionMultiplexer redis,
        IMemoryCache memory,
        ICacheTelemetry telemetry)
    {
        var keyResolver = new CacheKeyResolver(
            _policies,
            _scope,
            NullLogger<CacheKeyResolver>.Instance);
        return new UnifiedCache(
            memory,
            new PolicyShardedCacheL1Store(_policies),
            redis,
            _policies,
            _scope,
            keyResolver,
            new CacheSingleFlightCoordinator(keyResolver),
            telemetry,
            NullLogger<UnifiedCache>.Instance);
    }

    private static void Seed(UnifiedCache cache)
    {
        cache.SetRawAsync(CachePolicyId.ArticleDetail, Identity, [1, 2, 3, 4]).GetAwaiter().GetResult();
        cache.SetRawAsync(CachePolicyId.ArticleHot, Identity, [5, 6, 7, 8]).GetAwaiter().GetResult();
        cache.SetRawAsync(CachePolicyId.SystemSeo, Identity, [9, 10, 11, 12]).GetAwaiter().GetResult();
        using var writer = new AedsFrameBufferWriter(256);
        writer.Write([13, 14, 15, 16]);
        writer.Seal(AedsFrameType.ArticleDetail);
        cache.SetOwnedFrameAsync(
                CachePolicyId.ArticleDetailFrame,
                Identity,
                writer.DetachOwnedFrame())
            .GetAwaiter()
            .GetResult();
    }

    private sealed class DisabledCacheTelemetry : ICacheTelemetry
    {
        public static DisabledCacheTelemetry Instance { get; } = new();

        public void RecordOperation(string operation, string policy, string layer, string outcome, TimeSpan elapsed)
        {
        }

        public CacheL1HitObservation BeginL1Hit(CachePolicyId policyId, CacheL1Operation operation) => default;

        public void RecordL1Hit(
            CachePolicyId policyId,
            CacheL1Operation operation,
            bool negative,
            CacheL1HitObservation observation)
        {
        }
    }
}

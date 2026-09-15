using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Tests.Unit;

public sealed class RuntimeCacheL1BoundaryEvidenceTests
{
    [Fact]
    public async Task UnifiedCacheHotHitRecordsAnUnsampledZeroAllocationSynchronousBoundary()
    {
        var database = Substitute.For<IDatabase>();
        database.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        using UnifiedCache cache = CreateCache(database);
        await cache.SetRawAsync(CachePolicyId.SystemPage, "runtime-cache-boundary", [1]);
        database.ClearReceivedCalls();
        for (int warmup = 0; warmup < 64; warmup++)
        {
            CacheReadResult<int> warmed = await cache.TryGetAsync(
                CachePolicyId.SystemPage,
                "runtime-cache-boundary",
                static bytes => bytes.Length == 1 && bytes.Span[0] == 1 ? (true, 1) : (false, 0));
            Assert.True(warmed.Hit);
        }

        RuntimeCacheL1BoundaryEvidence evidence = default;
        for (int attempt = 0; attempt < 64; attempt++)
        {
            string requestId = $"runtime-cache-l1-hot-{attempt}";
            using RuntimeCacheEvidenceObservation request = RuntimeCacheEvidenceObservation.Begin(
                requestId,
                "GET",
                "/_fsus/testing/runtime-cache/scenarios/telemetry/probe/hit");
            CacheReadResult<int> read = await cache.TryGetAsync(
                CachePolicyId.SystemPage,
                "runtime-cache-boundary",
                static bytes => bytes.Length == 1 && bytes.Span[0] == 1 ? (true, 1) : (false, 0));
            Assert.True(read.Hit);
            Assert.True(RuntimeCacheL1BoundaryEvidenceStore.TryTake(
                requestId,
                out IReadOnlyList<RuntimeCacheL1BoundaryEvidence> stored));
            evidence = Assert.Single(stored);
            if (!evidence.Sampled)
            {
                break;
            }
        }

        Assert.False(evidence.Sampled);
        Assert.Equal("hit", evidence.Outcome);
        Assert.Equal(evidence.StartedThreadId, evidence.CompletedThreadId);
        Assert.Equal(0, evidence.AllocatedBytes);
        await database.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public void UnsampledBoundaryMeasuresTheExactSynchronousThreadWithoutAllocating()
    {
        Measure("warmup-runtime-cache-l1-boundary");

        RuntimeCacheL1BoundaryEvidence evidence = Measure("measured-runtime-cache-l1-boundary");

        Assert.False(evidence.Sampled);
        Assert.Equal("hit", evidence.Outcome);
        Assert.Equal(evidence.StartedThreadId, evidence.CompletedThreadId);
        Assert.Equal(0, evidence.AllocatedBytes);
        Assert.Equal(CachePolicyId.SystemPage, evidence.PolicyId);
        Assert.Equal(CacheL1Operation.Typed, evidence.Operation);
    }

    private static RuntimeCacheL1BoundaryEvidence Measure(string requestId)
    {
        using RuntimeCacheEvidenceObservation request = RuntimeCacheEvidenceObservation.Begin(
            requestId,
            "GET",
            "/_fsus/testing/runtime-cache/scenarios/telemetry/probe");
        RuntimeCacheL1BoundaryEvidenceScope scope = RuntimeCacheL1BoundaryEvidenceScope.Begin(
            CachePolicyId.SystemPage,
            CacheL1Operation.Typed);
        RuntimeCacheL1BoundaryEvidence completed = scope.Complete(sampled: false, "hit");
        Assert.True(RuntimeCacheL1BoundaryEvidenceStore.TryTake(requestId, out IReadOnlyList<RuntimeCacheL1BoundaryEvidence> stored));
        return Assert.Single(stored);
    }

    private static UnifiedCache CreateCache(IDatabase database)
    {
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        return new UnifiedCache(
            redis,
            new CachePolicyRegistry(),
            new DefaultRuntimeKeyScope(),
            NullLogger<UnifiedCache>.Instance);
    }
}

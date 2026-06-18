using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests for AdaptivePowGovernor — pure concurrency/difficulty logic.
/// Uses a minimal null-cache stub so no Redis/Memory dependency is needed.
/// </summary>
public sealed class AdaptivePowGovernorTests
{
    // ─── CurrentGlobalDifficulty thresholds ───────────────────────────────

    [Fact]
    public void CurrentGlobalDifficulty_ReturnBaseDifficultyWhenIdle()
    {
        var governor = CreateGovernor();

        // No requests recorded → RPS = 0 → BASE_DIFFICULTY = 16 bits
        Assert.Equal(16, governor.CurrentGlobalDifficulty);
    }

    [Fact]
    public void CurrentGlobalDifficulty_ReturnsElevatedAtLowLoad()
    {
        var governor = CreateGovernor();

        RecordRequests(governor, 101);

        // RPS > 100 → ELEVATED_DIFFICULTY = 20 bits
        Assert.Equal(20, governor.CurrentGlobalDifficulty);
    }

    [Fact]
    public void CurrentGlobalDifficulty_ReturnsHighLoadAtMediumLoad()
    {
        var governor = CreateGovernor();

        RecordRequests(governor, 301);

        // RPS > 300 → HIGH_LOAD_DIFFICULTY = 24 bits
        Assert.Equal(24, governor.CurrentGlobalDifficulty);
    }

    [Fact]
    public void CurrentGlobalDifficulty_ReturnsWarModeAtHighLoad()
    {
        var governor = CreateGovernor();

        RecordRequests(governor, 1001);

        // RPS > 1000 → WAR_MODE_DIFFICULTY = 28 bits
        Assert.Equal(28, governor.CurrentGlobalDifficulty);
    }

    // ─── RecordInboundRequest ─────────────────────────────────────────────

    [Fact]
    public void RecordInboundRequest_IncreasesEffectiveDifficulty()
    {
        var governor = CreateGovernor();

        int before = governor.CurrentGlobalDifficulty;
        RecordRequests(governor, 1001);
        int after = governor.CurrentGlobalDifficulty;

        Assert.True(after > before);
    }

    // ─── GetDifficultyForIpAsync ──────────────────────────────────────────

    [Fact]
    public async Task GetDifficultyForIpAsync_ReturnsGlobalDifficultyForUnknownIp()
    {
        var governor = CreateGovernor();
        int global = governor.CurrentGlobalDifficulty;

        int result = await governor.GetDifficultyForIpAsync("1.2.3.4");

        Assert.Equal(global, result);
    }

    [Fact]
    public async Task GetDifficultyForIpAsync_AddsPenaltyForHighRiskIp()
    {
        // Risk score 20 → two 4-bit penalty steps
        var governor = CreateGovernor(riskScoreForAnyIp: 20);
        int global = governor.CurrentGlobalDifficulty;

        int result = await governor.GetDifficultyForIpAsync("1.2.3.4");

        Assert.Equal(Math.Min(global + 8, 28), result);
    }

    [Fact]
    public async Task GetDifficultyForIpAsync_CapsAtWarMode()
    {
        // Even a huge risk score must not exceed WAR_MODE = 28 bits
        var governor = CreateGovernor(riskScoreForAnyIp: 9999);

        int result = await governor.GetDifficultyForIpAsync("1.2.3.4");

        Assert.Equal(28, result);
    }

    [Fact]
    public async Task GetDifficultyForIpAsync_CacheHitAvoidsCacheQuery()
    {
        // Call the same IP twice – second call should use L1 cache (no extra cache queries)
        var stub = new StubUnifiedCache(riskScore: 10);
        var governor = new AdaptivePowGovernor(stub);

        await governor.GetDifficultyForIpAsync("10.0.0.1");
        int callsAfterFirst = stub.GetStringCallCount;
        await governor.GetDifficultyForIpAsync("10.0.0.1");

        // Second call should be served from L1 (the internal 10-second TTL cache),
        // so no additional remote calls are expected.
        Assert.Equal(callsAfterFirst, stub.GetStringCallCount);
    }

    // ─── Tick ─────────────────────────────────────────────────────────────

    [Fact]
    public void Tick_DoesNotThrow()
    {
        var governor = CreateGovernor();
        var ex = Record.Exception(() => governor.Tick());
        Assert.Null(ex);
    }

    [Fact]
    public void Tick_CarriesLoadForwardWithEwmaAfterWindowReset()
    {
        var governor = CreateGovernor();
        RecordRequests(governor, 1001);
        typeof(AdaptivePowGovernor)
            .GetField("_lastTick", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .SetValue(governor, Environment.TickCount64 - 1000);

        governor.Tick();

        Assert.Equal(28, governor.CurrentGlobalDifficulty);
    }

    [Fact]
    public void StableIpHashForTests_IsDeterministicAcrossCalls()
    {
        uint first = AdaptivePowGovernor.StableIpHashForTests("203.0.113.10");
        uint second = AdaptivePowGovernor.StableIpHashForTests("203.0.113.10");

        Assert.Equal(first, second);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    private static AdaptivePowGovernor CreateGovernor(int riskScoreForAnyIp = 0)
        => new AdaptivePowGovernor(new StubUnifiedCache(riskScoreForAnyIp));

    private static void RecordRequests(AdaptivePowGovernor governor, int count)
    {
        for (int i = 0; i < count; i++)
        {
            governor.RecordInboundRequest();
        }
    }

    // ─── Stub IUnifiedCache ──────────────────────────────────────────────

    private sealed class StubUnifiedCache(int riskScore = 0) : IUnifiedCache
    {
        private int _getStringCallCount;
        public int GetStringCallCount => _getStringCallCount;

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _getStringCallCount);
            string? value = riskScore > 0 ? riskScore.ToString() : null;
            return Task.FromResult(value);
        }

        // ── Not exercised by AdaptivePowGovernor ──────────────────────────
        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<T>));
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<byte[]>));
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<ReadOnlyMemory<byte>>));
        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => Task.FromResult(0L);
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<T>));
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult<IAsyncDisposable>(NullDisposable.Instance);
        public string BuildKey(CachePolicyId policyId, string identity, string? version = null) => $"{policyId}:{identity}";

        private sealed class NullDisposable : IAsyncDisposable
        {
            public static readonly NullDisposable Instance = new();
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}

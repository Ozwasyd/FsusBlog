using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamPreflightGrantServiceTests
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly DateTimeOffset s_now = new(2026, 7, 19, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ExchangeTarget_IsDeterministicAndCanResumeOnlyWhileGrantExists()
    {
        var cache = new MemoryGrantCache();
        var service = new NotificationStreamPreflightGrantService(cache, cache, cache, new FixedTimeProvider(s_now));
        SecurityChallengeProofClaims proof = CreateProof();
        NotificationStreamPreflightGrantBinding binding = CreateBinding();

        NotificationStreamPreflightGrantExchange first = service.CreateExchangeTarget("fcp_proof-token", proof);
        NotificationStreamPreflightGrantExchange second = service.CreateExchangeTarget("fcp_proof-token", proof);
        await cache.SetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            first.CacheIdentity,
            first.Payload,
            first.Ttl);

        string? resumed = await service.TryResumeExchangeAsync("fcp_proof-token", binding, CancellationToken.None);
        NotificationStreamPreflightGrantConsumeResult consumed = await service.ConsumeAsync(
            first.Token,
            binding,
            CancellationToken.None);
        string? afterConsume = await service.TryResumeExchangeAsync("fcp_proof-token", binding, CancellationToken.None);

        Assert.Equal(first.Token, second.Token);
        Assert.Equal(first.CacheIdentity, second.CacheIdentity);
        Assert.Equal(first.Payload, second.Payload);
        Assert.Equal(first.Token, resumed);
        Assert.True(consumed.Accepted);
        Assert.Null(afterConsume);
    }

    [Fact]
    public async Task TryResumeExchangeAsync_BindingMismatchDoesNotExposePreparedGrant()
    {
        var cache = new MemoryGrantCache();
        var service = new NotificationStreamPreflightGrantService(cache, cache, cache, new FixedTimeProvider(s_now));
        NotificationStreamPreflightGrantExchange target = service.CreateExchangeTarget("fcp_proof-token", CreateProof());
        await cache.SetRawAsync(CachePolicyId.SecurityChallengeProof, target.CacheIdentity, target.Payload, target.Ttl);

        string? resumed = await service.TryResumeExchangeAsync(
            "fcp_proof-token",
            CreateBinding() with
            {
                RouteKey = "notification:other"
            },
            CancellationToken.None);

        Assert.Null(resumed);
    }

    private static SecurityChallengeProofClaims CreateProof()
        => new(
            "challenge-final",
            "sha256PowV1",
            "notification.subscribe",
            "notification:subscribe",
            HashA,
            HashB,
            HashC,
            s_now.AddMinutes(-1),
            s_now.AddMinutes(5),
            "proof-nonce",
            "risk-v2");

    private static NotificationStreamPreflightGrantBinding CreateBinding()
        => new("notification.subscribe", "notification:subscribe", HashA, HashB, HashC, "risk-v2");

    private sealed class MemoryGrantCache : ICacheRawWriter, ICacheRawReader, ICacheOneTimeStore
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _values[Key(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task SetNegativeAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.TryGetValue(Key(policyId, identity), out byte[]? value)
                ? new CacheReadResult<byte[]>(true, value)
                : new CacheReadResult<byte[]>(false, null));
        }

        public async Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            CacheReadResult<byte[]> read = await TryGetRawAsync(policyId, identity, cancellationToken);
            return read.Hit && read.Value is not null
                ? new CacheReadResult<ReadOnlyMemory<byte>>(true, read.Value)
                : new CacheReadResult<ReadOnlyMemory<byte>>(false, default);
        }

        public Task<bool> ConsumeOnceAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.Remove(Key(policyId, identity)));
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string key = Key(policyId, identity);
            if (!_values.Remove(key, out byte[]? payload))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, value) = decoder(payload);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, value)
                : new CacheReadResult<T>(false, default));
        }

        private static string Key(CachePolicyId policyId, string identity) => $"{policyId}:{identity}";
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}

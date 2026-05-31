using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisPowServiceTests
{
    [Fact]
    public async Task VerifyAsync_ConsumesValidProofOnce()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        var challenge = await service.GenerateChallengeAsync("127.0.0.1");
        string browserFingerprint = "unit-browser";
        string nonce = SolveNonce(challenge.Salt, browserFingerprint, challenge.Difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = challenge.Salt,
            PowNonce = nonce,
            Difficulty = challenge.Difficulty,
            PowTimestamp = challenge.Timestamp,
            PowSignature = challenge.Signature,
            BrowserFp = browserFingerprint
        };

        Assert.True(await service.VerifyAsync(request, "127.0.0.1"));
        Assert.False(await service.VerifyAsync(request, "127.0.0.1"));
    }

    [Fact]
    public async Task VerifyAsync_RejectsOverlongProofFieldsWithoutThrowing()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        var request = new VirtualPowRequest
        {
            PowSalt = new string('s', 129),
            PowNonce = "1",
            Difficulty = 4,
            PowTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            PowSignature = Convert.ToBase64String(new byte[32]),
            BrowserFp = "unit-browser"
        };

        bool result = await service.VerifyAsync(request, "127.0.0.1");

        Assert.False(result);
    }

    private static RedisPowService CreateService(OneShotCache cache)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = "unit-test-secret-key-with-enough-entropy"
            })
            .Build();
        var governor = new AdaptivePowGovernor(cache);
        return new RedisPowService(configuration, NullLogger<RedisPowService>.Instance, governor, cache);
    }

    private static string SolveNonce(string salt, string browserFingerprint, int difficulty)
    {
        for (long nonce = 0; nonce < 1_000_000; nonce++)
        {
            string candidate = nonce.ToString();
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{salt}:{candidate}:{browserFingerprint}"));
            if (HasLeadingDifficulty(hash, difficulty))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("Unable to solve unit PoW nonce.");
    }

    private static bool HasLeadingDifficulty(ReadOnlySpan<byte> hash, int difficulty)
    {
        int fullBytes = difficulty / 2;
        for (int i = 0; i < fullBytes; i++)
        {
            if (hash[i] != 0)
            {
                return false;
            }
        }

        return difficulty % 2 == 0 || (hash[fullBytes] & 0xF0) == 0;
    }

    private sealed class OneShotCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, string> _leases = new(StringComparer.Ordinal);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(_leases.TryAdd($"{policyId}:{identity}", value));

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<byte[]>));

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(NullAsyncDisposable.Instance);

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";

        private sealed class NullAsyncDisposable : IAsyncDisposable
        {
            public static readonly NullAsyncDisposable Instance = new();

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}

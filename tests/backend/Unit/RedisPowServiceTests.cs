using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisPowServiceTests
{
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task GenerateChallengeAsync_UsesUrlSafeSignatureEncoding()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);

        PowChallenge challenge = await service.GenerateChallengeAsync("127.0.0.1");

        Assert.DoesNotContain("+", challenge.Signature, StringComparison.Ordinal);
        Assert.DoesNotContain("/", challenge.Signature, StringComparison.Ordinal);
        Assert.DoesNotContain("=", challenge.Signature, StringComparison.Ordinal);
        Assert.Equal(32, WebEncoders.Base64UrlDecode(challenge.Signature).Length);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_AcceptsChallengeSignatureAfterUrlQueryRoundTrip()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        PowChallenge challenge = await service.GenerateChallengeAsync("127.0.0.1");
        string transmittedSignature = Uri.UnescapeDataString(Uri.EscapeDataString(challenge.Signature));
        string browserFingerprint = "unit-browser";
        string nonce = SolveNonce(challenge.Salt, browserFingerprint, challenge.Difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = challenge.Salt,
            PowNonce = nonce,
            Difficulty = challenge.Difficulty,
            PowTimestamp = challenge.Timestamp,
            PowSignature = transmittedSignature,
            BrowserFp = browserFingerprint
        };

        Assert.True(await service.VerifyAsync(request, "127.0.0.1"));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsStandardBase64SignatureCompatibilityFormat()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        PowChallenge challenge = await service.GenerateChallengeAsync("127.0.0.1");
        string standardBase64Signature = Convert.ToBase64String(WebEncoders.Base64UrlDecode(challenge.Signature));
        string browserFingerprint = "unit-browser";
        string nonce = SolveNonce(challenge.Salt, browserFingerprint, challenge.Difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = challenge.Salt,
            PowNonce = nonce,
            Difficulty = challenge.Difficulty,
            PowTimestamp = challenge.Timestamp,
            PowSignature = standardBase64Signature,
            BrowserFp = browserFingerprint
        };

        Assert.False(await service.VerifyAsync(request, "127.0.0.1"));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsOverlongProofFieldsWithoutThrowing()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        var request = new VirtualPowRequest
        {
            PowSalt = new string('s', 129),
            PowNonce = "1",
            Difficulty = 16,
            PowTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            PowSignature = Convert.ToBase64String(new byte[32]),
            BrowserFp = "unit-browser"
        };

        bool result = await service.VerifyAsync(request, "127.0.0.1");

        Assert.False(result);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsMalformedSignatureWithoutThrowing()
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        var request = new VirtualPowRequest
        {
            PowSalt = "salt",
            PowNonce = "1",
            Difficulty = 16,
            PowTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            PowSignature = "not-base64",
            BrowserFp = "unit-browser"
        };

        bool result = await service.VerifyAsync(request, "127.0.0.1");

        Assert.False(result);
    }

    [Theory]
    [InlineData(long.MinValue)]
    [InlineData(long.MaxValue)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsExtremeTimestampsWithoutThrowing(long timestamp)
    {
        var cache = new OneShotCache();
        var service = CreateService(cache);
        var request = new VirtualPowRequest
        {
            PowSalt = "salt",
            PowNonce = "1",
            Difficulty = 16,
            PowTimestamp = timestamp,
            PowSignature = Convert.ToBase64String(new byte[32]),
            BrowserFp = "unit-browser"
        };

        bool result = await service.VerifyAsync(request, "127.0.0.1");

        Assert.False(result);
    }

    [Theory]
    [InlineData(long.MinValue)]
    [InlineData(long.MaxValue)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ResolveReplayTtl_HandlesExtremeTimestampsWithoutThrowing(long timestamp)
    {
        MethodInfo method = typeof(RedisPowService).GetMethod("ResolveReplayTtl", BindingFlags.NonPublic | BindingFlags.Static)!;

        var ttl = (TimeSpan)method.Invoke(null, [timestamp])!;

        Assert.True(ttl >= TimeSpan.FromSeconds(1));
        Assert.True(ttl <= TimeSpan.FromMinutes(5));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void CheckWorkloadWithSpan_RejectsDifficultyBeyondSha256BitRange()
    {
        var request = new VirtualPowRequest
        {
            PowSalt = "salt",
            PowNonce = "nonce",
            Difficulty = 257,
            PowTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            PowSignature = Convert.ToBase64String(new byte[32]),
            BrowserFp = "unit-browser"
        };
        MethodInfo method = typeof(RedisPowService).GetMethod("CheckWorkloadWithSpan", BindingFlags.NonPublic | BindingFlags.Static)!;

        bool result = (bool)method.Invoke(null, [request])!;

        Assert.False(result);
    }

    [Theory]
    [InlineData(8)]
    [InlineData(9)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void CheckWorkloadWithSpan_AcceptsByteAndBitAlignedDifficulties(int difficulty)
    {
        string browserFingerprint = "unit-browser";
        string salt = "bit-level-salt";
        string nonce = SolveNonce(salt, browserFingerprint, difficulty);
        var request = new VirtualPowRequest
        {
            PowSalt = salt,
            PowNonce = nonce,
            Difficulty = difficulty,
            PowTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            PowSignature = Convert.ToBase64String(new byte[32]),
            BrowserFp = browserFingerprint
        };
        MethodInfo method = typeof(RedisPowService).GetMethod("CheckWorkloadWithSpan", BindingFlags.NonPublic | BindingFlags.Static)!;

        bool result = (bool)method.Invoke(null, [request])!;

        Assert.True(result);
    }

    [Theory]
    [InlineData(31)]
    [InlineData(32)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    public void Constructor_RequiresSigningKeyOfAtLeast32Characters(int length)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:Pow:SigningKey"] = new string('k', length)
            })
            .Build();
        var cache = new OneShotCache();
        var governor = new AdaptivePowGovernor(cache);

        if (length < 32)
        {
            Assert.Throws<InvalidOperationException>(() =>
                new RedisPowService(configuration, NullLogger<RedisPowService>.Instance, governor, cache));
        }
        else
        {
            _ = new RedisPowService(configuration, NullLogger<RedisPowService>.Instance, governor, cache);
        }
    }

    [Theory]
    [InlineData(-302)]
    [InlineData(-298)]
    [InlineData(298)]
    [InlineData(302)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    public void ResolveReplayTtl_OnlyAcceptsTimestampsWithinPlusMinus300Seconds(long offsetSeconds)
    {
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + offsetSeconds;
        MethodInfo method = typeof(RedisPowService).GetMethod("ResolveReplayTtl", BindingFlags.NonPublic | BindingFlags.Static)!;

        var ttl = (TimeSpan)method.Invoke(null, [timestamp])!;

        if (Math.Abs(offsetSeconds) <= 298)
        {
            Assert.Equal(TimeSpan.FromMinutes(5), ttl);
        }
        else
        {
            Assert.Equal(TimeSpan.FromSeconds(1), ttl);
        }
    }

    [Theory]
    [InlineData("  padded-context  ", "padded-context")]
    [InlineData("   ", "")]
    [InlineData(null, "")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void NormalizeBindingContext_TrimsWhitespaceAndTreatsMissingAsEmpty(string? input, string expected)
    {
        MethodInfo method = typeof(RedisPowService).GetMethod("NormalizeBindingContext", BindingFlags.NonPublic | BindingFlags.Static)!;

        var result = (string)method.Invoke(null, [input])!;

        Assert.Equal(expected, result);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void HashForLog_TreatsNullAsEmptyInput()
    {
        MethodInfo method = typeof(RedisPowService).GetMethod("HashForLog", BindingFlags.NonPublic | BindingFlags.Static)!;

        var nullHash = (string)method.Invoke(null, [null])!;
        var emptyHash = (string)method.Invoke(null, [string.Empty])!;

        Assert.Equal(emptyHash, nullHash);
        Assert.Equal(16, nullHash.Length);
    }

    private static RedisPowService CreateService(OneShotCache cache)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:Pow:SigningKey"] = "unit-test-pow-signing-key-with-enough-entropy"
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
        int fullBytes = difficulty / 8;
        for (int i = 0; i < fullBytes; i++)
        {
            if (hash[i] != 0)
            {
                return false;
            }
        }

        int remainingBits = difficulty % 8;
        return remainingBits == 0 || (hash[fullBytes] >> (8 - remainingBits)) == 0;
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

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<ReadOnlyMemory<byte>>));

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

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
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

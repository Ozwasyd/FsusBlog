using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Subscriptions;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SiteSubscriptionProofServiceTests
{
    private static readonly DateTimeOffset BaselineNow = new(2026, 6, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void RuntimeServices_RegisterSiteSubscriptionProofService()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISiteSubscriptionProofService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(SiteSubscriptionProofService), descriptor.ImplementationType);
    }

    [Fact]
    public void CachePolicyRegistry_DefinesConsumeOnceSubscriptionProofPolicy()
    {
        var registry = new CachePolicyRegistry();

        Assert.True(registry.TryGet(CachePolicyId.SiteSubscriptionUnsubscribeProof, out CachePolicy policy));
        Assert.Equal(CachePolicyId.SiteSubscriptionUnsubscribeProof, policy.Id);
        Assert.Equal(TimeSpan.Zero, policy.L1Ttl);
        Assert.Equal(TimeSpan.FromMinutes(15), policy.L2Ttl);
        Assert.True(policy.SecurityCritical);
        Assert.False(policy.RegisterKeysForPrefixInvalidation);
    }

    [Fact]
    public async Task IssueUnsubscribeProofAsync_StoresBoundClaimsWithoutRawEmailOrToken()
    {
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = CreateService(cache, clock);

        SiteSubscriptionUnsubscribeProofIssueResult result = await service.IssueUnsubscribeProofAsync(
            new SiteSubscriptionUnsubscribeProofIssueRequest(
                " Reader@Example.COM ",
                "EMAIL",
                TimeSpan.FromMinutes(15)),
            CancellationToken.None);

        Assert.StartsWith("fsu_unsub_", result.ProofToken, StringComparison.Ordinal);
        Assert.Equal(CachePolicyId.SiteSubscriptionUnsubscribeProof, cache.LastSetPolicyId);
        Assert.Equal(TimeSpan.FromMinutes(15), cache.LastSetTtl);
        Assert.Equal(ExpectedEmailHash("reader@example.com"), result.Claims.EmailHash);
        Assert.Equal("email", result.Claims.Channel);
        Assert.Equal(BaselineNow, result.Claims.IssuedAt);
        Assert.Equal(BaselineNow.AddMinutes(15), result.Claims.ExpiresAt);
        Assert.False(string.IsNullOrWhiteSpace(result.Claims.Nonce));
        Assert.DoesNotContain("Reader@Example.COM", cache.LastStoredJson, StringComparison.Ordinal);
        Assert.DoesNotContain("reader@example.com", cache.LastStoredJson, StringComparison.Ordinal);
        Assert.DoesNotContain(result.ProofToken, cache.LastStoredJson, StringComparison.Ordinal);
        Assert.DoesNotContain("Reader", cache.LastSetIdentity, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("example.com", cache.LastSetIdentity, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void HashEmail_UsesSubscriptionPepperHmac()
    {
        IConfiguration first = CreateConfiguration("subscription-email-hash-pepper-one-with-enough-entropy");
        IConfiguration second = CreateConfiguration("subscription-email-hash-pepper-two-with-enough-entropy");

        string firstHash = SiteSubscriptionIdentity.HashEmail(" Reader@Example.COM ", first);
        string repeatHash = SiteSubscriptionIdentity.HashEmail("reader@example.com", first);
        string secondHash = SiteSubscriptionIdentity.HashEmail("reader@example.com", second);
        string bareSha = ExpectedBareShaEmailHash("reader@example.com");

        Assert.Equal(repeatHash, firstHash);
        Assert.NotEqual(firstHash, secondHash);
        Assert.NotEqual(bareSha, firstHash);
        Assert.Equal(ExpectedHmacEmailHash("reader@example.com", "subscription-email-hash-pepper-one-with-enough-entropy"), firstHash);
    }

    [Fact]
    public async Task ConsumeUnsubscribeProofAsync_AcceptsMatchingProofAndRejectsReplay()
    {
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = CreateService(cache, clock);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await service.IssueUnsubscribeProofAsync(
            CreateIssueRequest(),
            CancellationToken.None);

        SiteSubscriptionUnsubscribeProofConsumeResult accepted = await service.ConsumeUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);
        SiteSubscriptionUnsubscribeProofConsumeResult replay = await service.ConsumeUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);

        Assert.True(accepted.Accepted);
        Assert.Equal("ok", accepted.Reason);
        Assert.Equal(ExpectedEmailHash("reader@example.com"), accepted.Claims?.EmailHash);
        Assert.False(replay.Accepted);
        Assert.Equal("proof_replayed_or_missing", replay.Reason);
    }

    [Fact]
    public async Task ValidateUnsubscribeProofAsync_DoesNotConsumeUntilCommit()
    {
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = CreateService(cache, clock);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await service.IssueUnsubscribeProofAsync(
            CreateIssueRequest(),
            CancellationToken.None);

        SiteSubscriptionUnsubscribeProofConsumeResult first = await service.ValidateUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);
        SiteSubscriptionUnsubscribeProofConsumeResult second = await service.ValidateUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);
        SiteSubscriptionUnsubscribeProofConsumeResult committed = await service.CommitUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);
        SiteSubscriptionUnsubscribeProofConsumeResult replay = await service.ValidateUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);

        Assert.True(first.Accepted);
        Assert.True(second.Accepted);
        Assert.True(committed.Accepted);
        Assert.False(replay.Accepted);
        Assert.Equal("proof_replayed_or_missing", replay.Reason);
    }

    [Theory]
    [InlineData("email", "email_hash_mismatch")]
    [InlineData("channel", "channel_mismatch")]
    public async Task ConsumeUnsubscribeProofAsync_RejectsBindingMismatch(string field, string expectedReason)
    {
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = CreateService(cache, clock);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await service.IssueUnsubscribeProofAsync(
            CreateIssueRequest(),
            CancellationToken.None);

        SiteSubscriptionUnsubscribeProofConsumeRequest request = field switch
        {
            "email" => CreateConsumeRequest(issued.ProofToken) with { Email = "other@example.com" },
            "channel" => CreateConsumeRequest(issued.ProofToken) with { Channel = "rss" },
            _ => CreateConsumeRequest(issued.ProofToken)
        };
        SiteSubscriptionUnsubscribeProofConsumeResult result = await service.ConsumeUnsubscribeProofAsync(
            request,
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal(expectedReason, result.Reason);
    }

    [Fact]
    public async Task ConsumeUnsubscribeProofAsync_RejectsExpiredProofWithoutConsuming()
    {
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = CreateService(cache, clock);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await service.IssueUnsubscribeProofAsync(
            CreateIssueRequest(),
            CancellationToken.None);
        clock.UtcNow = BaselineNow.AddMinutes(16);

        SiteSubscriptionUnsubscribeProofConsumeResult result = await service.ConsumeUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal("proof_expired", result.Reason);
        SiteSubscriptionUnsubscribeProofConsumeResult replay = await service.ConsumeUnsubscribeProofAsync(
            CreateConsumeRequest(issued.ProofToken),
            CancellationToken.None);
        Assert.Equal("proof_expired", replay.Reason);
    }

    private static SiteSubscriptionUnsubscribeProofIssueRequest CreateIssueRequest()
        => new("reader@example.com", "email", TimeSpan.FromMinutes(15));

    private static SiteSubscriptionUnsubscribeProofConsumeRequest CreateConsumeRequest(string proofToken)
        => new(proofToken, "reader@example.com", "email");

    private static SiteSubscriptionProofService CreateService(MemoryProofCache cache, MutableTimeProvider clock)
        => new(cache, clock, CreateConfiguration("unit-test-subscription-email-hash-pepper-with-enough-entropy"));

    private static IConfiguration CreateConfiguration(string pepper)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Subscription:EmailHashPepper"] = pepper
            })
            .Build();

    private static string ExpectedEmailHash(string normalizedEmail)
        => ExpectedHmacEmailHash(normalizedEmail, "unit-test-subscription-email-hash-pepper-with-enough-entropy");

    private static string ExpectedBareShaEmailHash(string normalizedEmail)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalizedEmail)));

    private static string ExpectedHmacEmailHash(string normalizedEmail, string pepper)
        => Convert.ToHexStringLower(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(pepper),
            Encoding.UTF8.GetBytes(normalizedEmail)));

    private sealed class MemoryProofCache : IUnifiedCache
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public CachePolicyId LastSetPolicyId
        {
            get; private set;
        }
        public TimeSpan? LastSetTtl
        {
            get; private set;
        }
        public string LastSetIdentity { get; private set; } = string.Empty;
        public string LastStoredJson { get; private set; } = string.Empty;

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            LastSetPolicyId = policyId;
            LastSetTtl = l2TtlOverride;
            LastSetIdentity = identity;
            LastStoredJson = Encoding.UTF8.GetString(value);
            _values[BuildKey(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            string key = BuildKey(policyId, identity);
            if (!_values.Remove(key, out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            string key = BuildKey(policyId, identity);
            if (!_values.TryGetValue(key, out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}

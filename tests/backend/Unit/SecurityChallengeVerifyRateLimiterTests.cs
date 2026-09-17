using System.Net;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeVerifyRateLimiterTests
{
    private static readonly DateTimeOffset s_baselineNow = new(2026, 6, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task TryAcquireAsync_UsesSharedUnifiedCacheWindowCounterWithoutRawIdentity()
    {
        Type limiterType = typeof(SecurityChallengeProofService).Assembly.GetType(
            "FsusBlog.Server.Services.Security.SecurityChallengeVerifyRateLimiter")
            ?? throw new Xunit.Sdk.XunitException("SecurityChallengeVerifyRateLimiter type must exist.");
        MethodInfo method = limiterType.GetMethod(
            "TryAcquireAsync",
            [typeof(HttpContext), typeof(string), typeof(string), typeof(CancellationToken)])
            ?? throw new Xunit.Sdk.XunitException("TryAcquireAsync signature must match the endpoint contract.");
        var cache = new WindowCounterCache();
        var clock = new MutableTimeProvider(s_baselineNow);
        object firstInstance = Activator.CreateInstance(limiterType, cache, new RiskControlContextFactory(), clock)
            ?? throw new Xunit.Sdk.XunitException("Unable to construct first limiter instance.");
        object secondInstance = Activator.CreateInstance(limiterType, cache, new RiskControlContextFactory(), clock)
            ?? throw new Xunit.Sdk.XunitException("Unable to construct second limiter instance.");
        const string ChallengeId = "challenge-raw-secret-569";
        const string Action = "auth.login";

        Assert.True(await InvokeAsync(method, firstInstance, CreateContext(), ChallengeId, Action));
        Assert.True(await InvokeAsync(method, firstInstance, CreateContext(), ChallengeId, Action));
        Assert.True(await InvokeAsync(method, secondInstance, CreateContext(), ChallengeId, Action));
        Assert.False(await InvokeAsync(method, secondInstance, CreateContext(), ChallengeId, Action));

        Assert.Equal(4, cache.Calls.Count);
        Assert.All(cache.Calls, call =>
        {
            Assert.Equal("SecurityChallengeVerifyRateLimit", call.PolicyId.ToString());
            Assert.Equal(TimeSpan.FromMinutes(2), call.Expiry);
            Assert.StartsWith("verify:", call.Identity, StringComparison.Ordinal);
            Assert.DoesNotContain("198.51.100.17", call.Identity, StringComparison.Ordinal);
            Assert.DoesNotContain("device-raw-secret-569", call.Identity, StringComparison.Ordinal);
            Assert.DoesNotContain(ChallengeId, call.Identity, StringComparison.Ordinal);
        });
        Assert.Single(cache.Identities);
    }

    [Fact]
    public async Task TryAcquireAsync_TimeBoundaryDoesNotResetCounterIdentity()
    {
        Type limiterType = typeof(SecurityChallengeProofService).Assembly.GetType(
            "FsusBlog.Server.Services.Security.SecurityChallengeVerifyRateLimiter")
            ?? throw new Xunit.Sdk.XunitException("SecurityChallengeVerifyRateLimiter type must exist.");
        MethodInfo method = limiterType.GetMethod(
            "TryAcquireAsync",
            [typeof(HttpContext), typeof(string), typeof(string), typeof(CancellationToken)])
            ?? throw new Xunit.Sdk.XunitException("TryAcquireAsync signature must match the endpoint contract.");
        var cache = new WindowCounterCache();
        var clock = new MutableTimeProvider(s_baselineNow);
        object limiter = Activator.CreateInstance(limiterType, cache, new RiskControlContextFactory(), clock)
            ?? throw new Xunit.Sdk.XunitException("Unable to construct limiter instance.");

        Assert.True(await InvokeAsync(method, limiter, CreateContext(), "challenge-1", "public.read"));
        Assert.True(await InvokeAsync(method, limiter, CreateContext(), "challenge-1", "public.read"));
        Assert.True(await InvokeAsync(method, limiter, CreateContext(), "challenge-1", "public.read"));
        Assert.False(await InvokeAsync(method, limiter, CreateContext(), "challenge-1", "public.read"));
        clock.UtcNow = s_baselineNow.AddMinutes(1);

        Assert.False(await InvokeAsync(method, limiter, CreateContext(), "challenge-1", "public.read"));
        Assert.Single(cache.Identities);
    }

    [Fact]
    public void SecurityChallengeVerifyRateLimiter_DoesNotKeepLocalGrowingCollections()
    {
        Type limiterType = typeof(SecurityChallengeProofService).Assembly.GetType(
            "FsusBlog.Server.Services.Security.SecurityChallengeVerifyRateLimiter")
            ?? throw new Xunit.Sdk.XunitException("SecurityChallengeVerifyRateLimiter type must exist.");

        FieldInfo[] fields = limiterType.GetFields(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);

        Assert.DoesNotContain(fields, static field =>
            field.FieldType.Name.Contains("ConcurrentDictionary", StringComparison.Ordinal)
            || typeof(System.Collections.IDictionary).IsAssignableFrom(field.FieldType));
    }

    private static async Task<bool> InvokeAsync(
        MethodInfo method,
        object limiter,
        HttpContext context,
        string challengeId,
        string action)
    {
        var task = Assert.IsAssignableFrom<Task<bool>>(method.Invoke(
            limiter,
            [context, challengeId, action, CancellationToken.None]));
        return await task;
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-raw-secret-569";
        return context;
    }

    private sealed class WindowCounterCache : IUnifiedCache
    {
        private readonly Dictionary<string, long> _counts = new(StringComparer.Ordinal);

        public List<IncrementCall> Calls { get; } = [];

        public IReadOnlyCollection<string> Identities => _counts.Keys;

        public Task<long> IncrementWithExpiryAsync(
            CachePolicyId policyId,
            string identity,
            TimeSpan expiry,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            Calls.Add(new IncrementCall(policyId, identity, value, expiry));
            _counts.TryGetValue(identity, out long current);
            current += value;
            _counts[identity] = current;
            return Task.FromResult(current);
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed record IncrementCall(CachePolicyId PolicyId, string Identity, long Value, TimeSpan Expiry);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}

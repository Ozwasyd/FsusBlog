using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBackfillLeaseTests
{
    [Theory]
    [InlineData("single", PublicAotBackfillLeaseMode.Local)]
    [InlineData("static-role", PublicAotBackfillLeaseMode.Redis)]
    [InlineData("adaptive", PublicAotBackfillLeaseMode.Redis)]
    [InlineData("unknown-multi-mode", PublicAotBackfillLeaseMode.Redis)]
    public void RuntimeMode_DefaultsNonSingleModesToRedis(
        string runtimeMode,
        PublicAotBackfillLeaseMode expected)
    {
        Assert.Equal(expected, PublicAotBackfillLeaseOptions.ForRuntimeMode(runtimeMode).Mode);
    }

    [Fact]
    public async Task DualNodeRace_OnlyOneNodeAcquiresRouteAssetLease()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T00:00:00Z"));
        var cache = new LeaseCache(clock);
        PublicAotBackfillLease nodeA = CreateRedisLease(cache);
        PublicAotBackfillLease nodeB = CreateRedisLease(cache);
        PublicAotBackfillRequest request = Request();

        await using IPublicAotBackfillLeaseHandle? holderA = await nodeA.TryAcquireAsync(request);
        await using IPublicAotBackfillLeaseHandle? holderB = await nodeB.TryAcquireAsync(request);

        Assert.NotNull(holderA);
        Assert.Null(holderB);
        Assert.Equal(1, cache.AcquireSuccessCount);
        Assert.Contains("article%3A42", PublicAotBackfillLease.BuildIdentity(request), StringComparison.Ordinal);
        Assert.Contains("frontend-v7", PublicAotBackfillLease.BuildIdentity(request), StringComparison.Ordinal);
        Assert.EndsWith(":pw-7", PublicAotBackfillLease.BuildIdentity(request), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExpiredHolder_CanBeTakenOver_AndStaleReleaseCannotDeleteNewOwner()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T00:00:00Z"));
        var cache = new LeaseCache(clock);
        PublicAotBackfillLease firstNode = CreateRedisLease(cache);
        PublicAotBackfillLease secondNode = CreateRedisLease(cache);
        PublicAotBackfillLease thirdNode = CreateRedisLease(cache);
        PublicAotBackfillRequest request = Request();

        IPublicAotBackfillLeaseHandle first = Assert.IsAssignableFrom<IPublicAotBackfillLeaseHandle>(
            await firstNode.TryAcquireAsync(request));
        Assert.True(await first.RenewAsync());
        clock.Advance(TimeSpan.FromSeconds(31));
        IPublicAotBackfillLeaseHandle second = Assert.IsAssignableFrom<IPublicAotBackfillLeaseHandle>(
            await secondNode.TryAcquireAsync(request));

        await first.DisposeAsync();
        Assert.Null(await thirdNode.TryAcquireAsync(request));

        await second.DisposeAsync();
        await using IPublicAotBackfillLeaseHandle? third = await thirdNode.TryAcquireAsync(request);
        Assert.NotNull(third);
    }

    [Fact]
    public async Task SingleMode_UsesLocalLeaseWithoutCacheRoundTrip()
    {
        var cache = new LeaseCache(TimeProvider.System);
        var lease = new PublicAotBackfillLease(
            cache,
            new PublicAotBackfillLeaseOptions(
                PublicAotBackfillLeaseMode.Local,
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(10)),
            NullLogger<PublicAotBackfillLease>.Instance);

        await using IPublicAotBackfillLeaseHandle? handle = await lease.TryAcquireAsync(Request());

        Assert.NotNull(handle);
        Assert.True(await handle.RenewAsync());
        Assert.Equal(0, cache.AcquireAttemptCount);
    }

    private static PublicAotBackfillLease CreateRedisLease(LeaseCache cache)
        => new(
            cache,
            new PublicAotBackfillLeaseOptions(
                PublicAotBackfillLeaseMode.Redis,
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(10)),
            NullLogger<PublicAotBackfillLease>.Instance);

    private static PublicAotBackfillRequest Request()
        => new(PublicPageKind.ArticleDetail, "article:42", "/article/42", string.Empty, "cache:article:42")
        {
            FrontendAssetVersion = "frontend-v7",
            TestSessionId = "pw-7",
            ScheduledInvalidationVersion = 12
        };

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan delta) => utcNow = utcNow.Add(delta);
    }

    private sealed class LeaseCache(TimeProvider clock) : ICacheLeaseStore
    {
        private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private int _acquireAttempts;
        private int _acquireSuccesses;

        public int AcquireAttemptCount => Volatile.Read(ref _acquireAttempts);
        public int AcquireSuccessCount => Volatile.Read(ref _acquireSuccesses);

        public Task<bool> TryAcquireLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _acquireAttempts);
            lock (_entries)
            {
                RemoveExpired(identity);
                if (!_entries.TryAdd(identity, new Entry(value, clock.GetUtcNow().Add(ttl))))
                {
                    return Task.FromResult(false);
                }
                Interlocked.Increment(ref _acquireSuccesses);
                return Task.FromResult(true);
            }
        }

        public Task<bool> TryRenewLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
        {
            lock (_entries)
            {
                RemoveExpired(identity);
                if (!_entries.TryGetValue(identity, out Entry? current)
                    || !string.Equals(current.Value, expectedValue, StringComparison.Ordinal))
                {
                    return Task.FromResult(false);
                }
                _entries[identity] = new Entry(expectedValue, clock.GetUtcNow().Add(ttl));
                return Task.FromResult(true);
            }
        }

        public Task<bool> TryReleaseLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            CancellationToken cancellationToken = default)
        {
            lock (_entries)
            {
                RemoveExpired(identity);
                bool removed = _entries.TryGetValue(identity, out Entry? current)
                    && string.Equals(current.Value, expectedValue, StringComparison.Ordinal)
                    && _entries.TryRemove(identity, out _);
                return Task.FromResult(removed);
            }
        }

        private void RemoveExpired(string identity)
        {
            if (_entries.TryGetValue(identity, out Entry? entry) && entry.ExpiresAtUtc <= clock.GetUtcNow())
            {
                _entries.TryRemove(identity, out _);
            }
        }

        private sealed record Entry(string Value, DateTimeOffset ExpiresAtUtc);
    }
}

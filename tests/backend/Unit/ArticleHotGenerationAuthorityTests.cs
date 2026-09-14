using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleHotGenerationAuthorityTests
{
    [Fact]
    public async Task SharedAuthority_PublishesStrictlyMonotonicVersions_AndObserveConvergesBothNodes()
    {
        var counters = new InMemoryCounterStore();
        var scopes = Substitute.For<IServiceScopeFactory>();
        var first = new HotStatsInvalidationCoalescer(
            scopes,
            NullLogger<HotStatsInvalidationCoalescer>.Instance,
            counters,
            sharedReader: null);
        var second = new HotStatsInvalidationCoalescer(
            scopes,
            NullLogger<HotStatsInvalidationCoalescer>.Instance,
            counters,
            sharedReader: null);

        long[] published =
        [
            await first.PublishNextHotArticlesVersionAsync("first"),
            await second.PublishNextHotArticlesVersionAsync("second"),
            await first.PublishNextHotArticlesVersionAsync("third"),
            await second.PublishNextHotArticlesVersionAsync("fourth")
        ];

        Assert.Equal([1L, 2L, 3L, 4L], published);
        Assert.Equal(
            4,
            counters.Read(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));

        first.ObserveHotArticlesVersion(published[^1]);
        second.ObserveHotArticlesVersion(published[^1]);

        Assert.Equal(4, first.CurrentHotArticlesVersion);
        Assert.Equal(4, second.CurrentHotArticlesVersion);
        Assert.Equal(
            first.BuildVersionedHotArticlesIdentity("home"),
            second.BuildVersionedHotArticlesIdentity("home"));
    }

    [Fact]
    public void Observe_IgnoresOlderAndDuplicateVersions_AndRejectsNegativeVersions()
    {
        var provider = new HotStatsInvalidationCoalescer(
            Substitute.For<IServiceScopeFactory>(),
            NullLogger<HotStatsInvalidationCoalescer>.Instance);

        provider.ObserveHotArticlesVersion(12);
        provider.ObserveHotArticlesVersion(7);
        provider.ObserveHotArticlesVersion(12);

        Assert.Equal(12, provider.CurrentHotArticlesVersion);
        Assert.Equal("v12:hot", provider.BuildVersionedHotArticlesIdentity("hot"));
        Assert.Throws<ArgumentOutOfRangeException>(() => provider.ObserveHotArticlesVersion(-1));
        Assert.Equal(12, provider.CurrentHotArticlesVersion);
    }

    [Theory]
    [InlineData("public-hot-read:v0", 0L)]
    [InlineData("public-hot-read:v42", 42L)]
    [InlineData("public-hot-read:v9223372036854775807", long.MaxValue)]
    public void Resolver_AcceptsOnlyCanonicalNonNegativePublicHotReadVersions(string target, long expected)
    {
        Assert.True(DistributedInvalidationTargetResolver.TryParsePublicHotReadVersion(target, out long parsed));
        Assert.Equal(expected, parsed);

        DistributedInvalidationTargetPlan plan = DistributedInvalidationTargetResolver.Resolve(VersionEvent(target));

        Assert.True(plan.IsExact, plan.FullReconcileReason);
        Assert.Contains(target, plan.HotReadFragments);
    }

    [Theory]
    [InlineData("public-hot-read:v-1")]
    [InlineData("public-hot-read:v+1")]
    [InlineData("public-hot-read:v")]
    [InlineData("public-hot-read:v01garbage")]
    [InlineData("public-hot-read:v9223372036854775808")]
    [InlineData("public-hot-read:V1")]
    [InlineData("garbage")]
    public void Resolver_RejectsNegativeMalformedAndOverflowPublicHotReadVersions(string target)
    {
        Assert.False(DistributedInvalidationTargetResolver.TryParsePublicHotReadVersion(target, out _));

        DistributedInvalidationTargetPlan plan = DistributedInvalidationTargetResolver.Resolve(VersionEvent(target));

        Assert.False(plan.IsExact);
        Assert.Equal($"artifact-target:{target}", plan.FullReconcileReason);
    }

    [Fact]
    public async Task LocalApplier_AdvancesProviderWithoutRegressingOnOlderOrDuplicateEvents()
    {
        var provider = new RecordingHotArticlesVersionProvider();
        var localCache = Substitute.For<ICacheLocalInvalidator>();
        localCache
            .InvalidateLocal(Arg.Any<IReadOnlyList<CacheKeyIdentity>>())
            .Returns(new CacheL1InvalidationReceipt([]));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object>()).Returns(Substitute.For<IDatabase>());
        var environment = Substitute.For<IWebHostEnvironment>();
        environment.ContentRootPath.Returns(Path.GetTempPath());
        environment.WebRootPath.Returns(Path.GetTempPath());
        var publicAot = new PublicAotFileShellCache(
            environment,
            RedisOperationExecutor.ForTestConnection(redis),
            NullLogger<PublicAotFileShellCache>.Instance,
            configuration: new ConfigurationBuilder().Build(),
            publicArtifactStorage: Substitute.For<IPublicArtifactStorage>());
        var delivery = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
            delivery,
            delivery);
        var applier = new DistributedInvalidationLocalApplier(
            localCache,
            publicAot,
            new PublicAotInvalidationTracker(new InMemoryPublicAotInvalidationGenerationAuthority()),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            new PublicHotReadStore(),
            queue,
            Substitute.For<IAotSeoConfigSnapshot>(),
            new CacheInvalidationRuntimeState(),
            NullLogger<DistributedInvalidationLocalApplier>.Instance,
            hotArticlesVersionProvider: provider);

        DistributedInvalidationLocalApplyResult? advanced = await applier.ApplyAsync(VersionEvent("public-hot-read:v9", "event-9"));
        DistributedInvalidationLocalApplyResult? older = await applier.ApplyAsync(VersionEvent("public-hot-read:v4", "event-4"));
        DistributedInvalidationLocalApplyResult? duplicate = await applier.ApplyAsync(VersionEvent("public-hot-read:v9", "event-9-repeat"));

        Assert.NotNull(advanced);
        Assert.NotNull(older);
        Assert.NotNull(duplicate);
        Assert.All(new[] { advanced, older, duplicate }, static result => Assert.True(result.IsApplied));
        Assert.Equal(9, provider.CurrentHotArticlesVersion);
        Assert.Equal([9L, 4L, 9L], provider.ObservedVersions);
    }

    private static DistributedInvalidationEvent VersionEvent(string target, string? eventId = null)
        => DistributedInvalidationEvent.Create(
            eventId ?? $"event-{target}",
            DistributedInvalidationEventKinds.PublicHotReadVersionPublished,
            "node-a",
            "test",
            ["hot-articles"],
            ["article:hot"],
            [target],
            $"trace-{eventId ?? target}",
            TimeProvider.System);

    private sealed class InMemoryCounterStore : ICacheCounterStore
    {
        private readonly object _gate = new();
        private readonly Dictionary<(CachePolicyId PolicyId, string Identity), long> _values = [];

        public Task<long> IncrementAsync(
            CachePolicyId policyId,
            string identity,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_gate)
            {
                var key = (policyId, identity);
                _values.TryGetValue(key, out long current);
                long next = checked(current + value);
                _values[key] = next;
                return Task.FromResult(next);
            }
        }

        public long Read(CachePolicyId policyId, string identity)
        {
            lock (_gate)
            {
                return _values.TryGetValue((policyId, identity), out long value) ? value : 0;
            }
        }
    }

    private sealed class RecordingHotArticlesVersionProvider : IHotArticlesCacheVersionProvider
    {
        private readonly List<long> _observedVersions = [];

        public long CurrentHotArticlesVersion
        {
            get;
            private set;
        }

        public IReadOnlyList<long> ObservedVersions => _observedVersions;

        public string BuildVersionedHotArticlesIdentity(string identity)
            => $"v{CurrentHotArticlesVersion}:{identity}";

        public void ObserveHotArticlesVersion(long version)
        {
            _observedVersions.Add(version);
            CurrentHotArticlesVersion = Math.Max(CurrentHotArticlesVersion, version);
        }
    }
}

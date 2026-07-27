using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Security;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CacheInvalidationDispatcherTests
{
    [Fact]
    public async Task DistributedDeliveredResult_IsDurablyConsumedBeforeMutationReturns()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        var obligations = Substitute.For<IDistributedInvalidationObligationStore>();
        DistributedInvalidationPublishResult result = PublishResult(DistributedInvalidationPublishStatus.Published, DistributedInvalidationTransportStatus.Delivered);
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>()).Returns(result);
        obligations.UpsertAsync(result, Arg.Any<CancellationToken>()).Returns(new DistributedInvalidationConvergenceObligation("o", "event", "article_mutation", "node", "scope", "mutation", "topology", result.Status, DistributedInvalidationTransportStatus.Delivered, DateTimeOffset.UtcNow, DistributedInvalidationConvergenceState.Complete, 1, null));
        var sut = new CacheInvalidationDispatcher(cache, cache, Substitute.For<IHttpCacheInvalidator>(), distributedInvalidationPublisher: publisher, distributedInvalidationObligations: obligations);

        await sut.InvalidateArticleMutationAsync(42);

        await obligations.Received(1).UpsertAsync(result, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DistributedPendingResult_AndStoreFailureCannotBeReportedAsFullSuccess()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        var obligations = Substitute.For<IDistributedInvalidationObligationStore>();
        DistributedInvalidationPublishResult result = PublishResult(DistributedInvalidationPublishStatus.Degraded, DistributedInvalidationTransportStatus.UnderDelivered);
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>()).Returns(result);
        obligations.UpsertAsync(result, Arg.Any<CancellationToken>()).Returns<Task<DistributedInvalidationConvergenceObligation>>(_ => throw new InvalidOperationException("store-failed"));
        var sut = new CacheInvalidationDispatcher(cache, cache, Substitute.For<IHttpCacheInvalidator>(), distributedInvalidationPublisher: publisher, distributedInvalidationObligations: obligations);

        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.InvalidateArticleMutationAsync(42));
    }

    [Fact]
    public async Task LocalOnlyResult_CreatesNoRemoteObligation()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        var obligations = Substitute.For<IDistributedInvalidationObligationStore>();
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>()).Returns(new DistributedInvalidationPublishResult(DistributedInvalidationPublishStatus.LocalOnly, null, null));
        var sut = new CacheInvalidationDispatcher(cache, cache, Substitute.For<IHttpCacheInvalidator>(), distributedInvalidationPublisher: publisher, distributedInvalidationObligations: obligations);

        await sut.InvalidateArticleMutationAsync(42);

        await obligations.DidNotReceiveWithAnyArgs().UpsertAsync(default!, default);
    }

    private static DistributedInvalidationPublishResult PublishResult(DistributedInvalidationPublishStatus status, DistributedInvalidationTransportStatus transportStatus)
    {
        DistributedInvalidationEvent @event = DistributedInvalidationEvent.Create("event", DistributedInvalidationEventKinds.ArticleMutation, "node", "scope", ["article"], ["article:42"], ["public-aot"], "trace", TimeProvider.System);
        var receipt = new DistributedInvalidationTransportPublishResult("channel", transportStatus == DistributedInvalidationTransportStatus.Delivered ? 2 : 1, 2, true, DateTimeOffset.UtcNow, transportStatus, "topology", transportStatus == DistributedInvalidationTransportStatus.Delivered ? null : "under-delivered");
        return new(status, @event.EventId, status == DistributedInvalidationPublishStatus.Published ? null : "under-delivered", @event, receipt);
    }
    [Fact]
    public async Task InvalidateArticleMutationAsync_ClearsDistributionAndListVersionCaches()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator);

        await sut.InvalidateArticleMutationAsync(42);

        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.ArticleDetail, "42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v2:42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v3:42")
            && HasKey(keys, CachePolicyId.ArticleDetailFrame, "core:v3:42")), Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.ArticleListVersion, "main", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.ArticleSearchVersion, "main", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveAsync(CachePolicyId.ArticleRss, "main", Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(
            CachePolicyId.AdminStats,
            AdminStatsFrameVersioning.CounterIdentity,
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:v0:main")), Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.CategoryFrame, "all")
            || HasKey(keys, CachePolicyId.TagFrame, "all")), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(Arg.Is<CacheTag[]>(tags =>
            !tags.Contains(CacheTag.Category)
            && !tags.Contains(CacheTag.Tag)
            && tags.Contains(CacheTag.ArticleList)
            && tags.Contains(CacheTag.HotArticles)
            && tags.Contains(CacheTag.Stats)));
    }

    [Fact]
    public async Task InvalidateStatsAsync_RemovesJsonAndCoreStatsCache()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator);

        await sut.InvalidateStatsAsync();

        await cache.Received(1).IncrementAsync(
            CachePolicyId.AdminStats,
            AdminStatsFrameVersioning.CounterIdentity,
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:v0:main")), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
    }

    [Fact]
    public async Task InvalidateHotArticlesAsync_PublishesVersionWithoutPrefixDelete()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var versionPublisher = Substitute.For<IHotArticlesCacheVersionPublisher>();
        versionPublisher.PublishNextHotArticlesVersion("direct-invalidation").Returns(8L);
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator, hotArticlesVersionPublisher: versionPublisher);

        await sut.InvalidateHotArticlesAsync();

        versionPublisher.Received(1).PublishNextHotArticlesVersion("direct-invalidation");
        await cache.DidNotReceive().RemoveByPrefixAsync(CachePolicyId.ArticleHot, Arg.Any<string>(), Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixAsync(CachePolicyId.ArticleHotFrame, Arg.Any<string>(), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.HotArticles);
    }

    [Fact]
    public async Task InvalidateSeoAndComplianceAsync_InvalidatesAotSeoSnapshot()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var snapshot = Substitute.For<IAotSeoConfigSnapshot>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator, aotSeoConfigSnapshot: snapshot);

        await sut.InvalidateSeoAsync();
        await sut.InvalidateComplianceAsync();

        snapshot.Received(2).Invalidate();
    }

    [Fact]
    public async Task InvalidateCommentMutationAsync_WithoutScope_BumpsCommentCursorVersionsAndStats()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator);

        await sut.InvalidateCommentMutationAsync();

        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "global", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.UserCommentCursorVersion, "global", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixManyAsync(Arg.Any<IReadOnlyList<CachePrefixIdentity>>(), Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:v0:main")), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
    }

    [Fact]
    public async Task InvalidateCommentMutationAsync_WithScope_BumpsOnlyAffectedArticleRootAndUser()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator);

        await sut.InvalidateCommentMutationAsync(new CommentCacheInvalidationScope(
            ArticleId: 42,
            RootId: 99,
            AccountId: 7,
            PublicArticleChanged: true,
            UserCommentsChanged: true));

        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42:root:99", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.UserCommentCursorVersion, "account:7", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixManyAsync(Arg.Any<IReadOnlyList<CachePrefixIdentity>>(), Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            HasKey(keys, CachePolicyId.AdminStats, "main")
            && HasKey(keys, CachePolicyId.AdminStats, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:main")
            && HasKey(keys, CachePolicyId.AdminStatsFrame, "core:v0:main")), Arg.Any<CancellationToken>());
        await httpCacheInvalidator.Received(1).InvalidateAsync(CacheTag.Stats);
        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
    }

    [Fact]
    public async Task InvalidateCommentPolicyAsync_RecordsBoundaryWithoutGlobalCommentOutputTag()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(CachePolicyId.AnonymousCommentPolicyVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(12L);
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var runtimeState = new CacheInvalidationRuntimeState();
        var localInvalidator = Substitute.For<IAnonymousCommentPolicyInvalidationSink>();
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator, runtimeState, commentPolicyInvalidationSink: localInvalidator);

        await sut.InvalidateCommentPolicyAsync();

        await httpCacheInvalidator.DidNotReceive().InvalidateAsync(CacheTag.Comment);
        localInvalidator.Received(1).InvalidateLocalSnapshot();
        await cache.Received(1).IncrementAsync(CachePolicyId.AnonymousCommentPolicyVersion, "main", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceiveWithAnyArgs().RemoveAsync(default, (string)null!, default);
        await cache.DidNotReceiveWithAnyArgs().RemoveManyAsync(default!, default);
        Assert.Equal("comment_policy", runtimeState.Snapshot().LastKind);
        Assert.Equal("anonymous-comment-policy:v12", runtimeState.Snapshot().LastDetail);
    }

    [Fact]
    public async Task RuntimeState_RecordAsync_AggregatesCountsAcrossInstances()
    {
        var counters = CreateSharedCounterStore(out ICacheStringReader reader);
        var first = new CacheInvalidationRuntimeState(counters, reader);
        var second = new CacheInvalidationRuntimeState(counters, reader);

        await first.RecordAsync("article", "first-node");
        await second.RecordAsync("article", "second-node");

        CacheInvalidationRuntimeSnapshot snapshot = await first.SnapshotAsync();

        Assert.Equal(2, snapshot.ArticleMutationCount);
        await counters.Received().IncrementAsync(CachePolicyId.AdminStats, "cache-invalidation:article", 1, Arg.Any<CancellationToken>());
    }

    private static bool HasKey(IReadOnlyList<CacheKeyIdentity> keys, CachePolicyId policyId, string identity)
        => keys.Any(key => key.PolicyId == policyId && key.Identity == identity);

    private static bool HasPrefix(IReadOnlyList<CachePrefixIdentity> prefixes, CachePolicyId policyId, string identityPrefix)
        => prefixes.Any(prefix => prefix.PolicyId == policyId && prefix.IdentityPrefix == identityPrefix);

    private static ICacheCounterStore CreateSharedCounterStore(out ICacheStringReader reader)
    {
        var values = new ConcurrentDictionary<string, long>(StringComparer.Ordinal);
        var counters = Substitute.For<ICacheCounterStore>();
        counters.IncrementAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string identity = call.ArgAt<string>(1);
                long value = call.ArgAt<long>(2);
                return values.AddOrUpdate(identity, value, (_, current) => current + value);
            });
        reader = Substitute.For<ICacheStringReader>();
        reader.GetStringAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                string identity = call.ArgAt<string>(1);
                return values.TryGetValue(identity, out long value)
                    ? value.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : null;
            });
        return counters;
    }
}

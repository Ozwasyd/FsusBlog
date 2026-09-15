using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CacheInvalidationDispatcherTests
{
    [Theory]
    [InlineData("article", DistributedInvalidationEventKinds.ArticleMutation)]
    [InlineData("taxonomy", DistributedInvalidationEventKinds.TaxonomyMutation)]
    [InlineData("system-page", DistributedInvalidationEventKinds.SystemPageMutation)]
    [InlineData("seo", DistributedInvalidationEventKinds.SeoMutation)]
    [InlineData("compliance", DistributedInvalidationEventKinds.ComplianceMutation)]
    public async Task SitemapMutationPublishFailure_RejectsSourceArtifactWithAuditableEventIdentity(
        string mutation,
        string expectedEventKind)
    {
        var cacheStore = Substitute.For<IUnifiedCache>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        DistributedInvalidationRequest? observed = null;
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns<Task<DistributedInvalidationPublishResult>>(call =>
            {
                observed = call.Arg<DistributedInvalidationRequest>();
                throw new InvalidOperationException("publish-failed");
            });
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var tracker = new PublicAotInvalidationTracker(authority);
        var sitemap = new SitemapArtifactCache(tracker);
        int builds = 0;
        _ = await sitemap.GetOrBuildAsync(
            _ => Task.FromResult(BuildSitemap(++builds)),
            CancellationToken.None);
        var sut = new CacheInvalidationDispatcher(
            cacheStore,
            cacheStore,
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: publisher,
            publicAotInvalidationTracker: tracker);

        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => mutation switch
        {
            "article" => sut.InvalidateArticleMutationAsync(42),
            "taxonomy" => sut.InvalidateCategoryTagAsync(),
            "system-page" => sut.InvalidateSystemPageAsync("about"),
            "seo" => sut.InvalidateSeoAsync(),
            "compliance" => sut.InvalidateComplianceAsync(),
            _ => throw new ArgumentOutOfRangeException(nameof(mutation), mutation, null)
        });
        SitemapArtifactSet rebuilt = await sitemap.GetOrBuildAsync(
            _ => Task.FromResult(BuildSitemap(++builds)),
            CancellationToken.None);

        Assert.Equal("publish-failed", failure.Message);
        Assert.NotNull(observed);
        Assert.Equal(expectedEventKind, observed.Kind);
        Assert.Equal(authority.Current.LastMutationId, observed.EventId);
        Assert.StartsWith($"{mutation}:", observed.EventId, StringComparison.Ordinal);
        Assert.Equal(1, rebuilt.Generation);
        Assert.Equal(1, authority.Current.AllGeneration);
        Assert.Equal(2, builds);
        Assert.Equal("root-2", rebuilt.RootDocument);
        if (mutation is "article" or "taxonomy" or "system-page")
        {
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
                authority.Current.KeyGenerations.Keys);
            Assert.DoesNotContain(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                authority.Current.KeyGenerations.Keys);
        }
        else
        {
            Assert.Contains(
                PublicAotInvalidationGenerationStateCodec.AllCoordinate,
                authority.Current.KeyGenerations.Keys);
            Assert.DoesNotContain(
                PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
                authority.Current.KeyGenerations.Keys);
        }
    }

    private static SitemapArtifactBuildResult BuildSitemap(int version)
        => new(new SitemapArtifactSet($"root-{version}", []), AllocationBytes: 1);

    [Fact]
    public async Task ArticleViewProjection_PublishesOneCanonicalVersionedBatch()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationPublishResult(DistributedInvalidationPublishStatus.LocalOnly, null, null));
        var sut = new CacheInvalidationDispatcher(
            cache,
            cache,
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: publisher);

        await sut.PublishArticleViewProjectionsAsync(new Dictionary<int, int>
        {
            [42] = 120,
            [7] = 19
        });

        await publisher.Received(1).PublishAsync(
            Arg.Is<DistributedInvalidationRequest>(request =>
                request.Kind == DistributedInvalidationEventKinds.ArticleViewProjection
                && request.CacheTags.Count == 0
                && request.RouteKeys.Count == 0
                && request.ArtifactKeys.SequenceEqual(new[]
                {
                    DistributedInvalidationTargetResolver.FormatArticleViewProjectionTarget(7, 19, 19),
                    DistributedInvalidationTargetResolver.FormatArticleViewProjectionTarget(42, 120, 120)
                })),
            Arg.Any<CancellationToken>());
    }

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
        await cache.Received(1).RemoveByPrefixAsync(
            CachePolicyId.RelatedReading,
            "article:42:",
            Arg.Any<CancellationToken>());
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
    public async Task InvalidateArticleBodyRepairAsync_InvalidatesOnlyArticleDerivedResidency()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var httpCacheInvalidator = Substitute.For<IHttpCacheInvalidator>();
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        DistributedInvalidationRequest? observed = null;
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                observed = call.Arg<DistributedInvalidationRequest>();
                return new DistributedInvalidationPublishResult(DistributedInvalidationPublishStatus.LocalOnly, null, null);
            });
        var sut = new CacheInvalidationDispatcher(
            cache,
            cache,
            httpCacheInvalidator,
            distributedInvalidationPublisher: publisher);

        await sut.InvalidateArticleBodyRepairAsync(42, "article-repair:test", CancellationToken.None);

        await cache.Received(1).RemoveManyAsync(Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
            keys.Count == 4
            && HasKey(keys, CachePolicyId.ArticleDetail, "42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v2:42")
            && HasKey(keys, CachePolicyId.ArticleDetail, "core:v3:42")
            && HasKey(keys, CachePolicyId.ArticleDetailFrame, "core:v3:42")), Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(
            CachePolicyId.RelatedReading,
            "article:42:",
            Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(
            CachePolicyId.ArticleSearchVersion,
            "main",
            1,
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().IncrementAsync(
            CachePolicyId.ArticleListVersion,
            Arg.Any<string>(),
            Arg.Any<long>(),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().IncrementAsync(
            CachePolicyId.AdminStats,
            Arg.Any<string>(),
            Arg.Any<long>(),
            Arg.Any<CancellationToken>());
        await httpCacheInvalidator.DidNotReceiveWithAnyArgs().InvalidateAsync(default!);
        await publisher.Received(1).PublishAsync(
            Arg.Is<DistributedInvalidationRequest>(request =>
                request.Kind == DistributedInvalidationEventKinds.ArticleMutation
                && request.CacheTags.SequenceEqual(new[] { "article" })
                && request.RouteKeys.SequenceEqual(new[] { "article:42" })
                && request.ArtifactKeys.SequenceEqual(new[] { "article-detail:42", "public-aot", "public-hot-read" })
                && request.EventId == "article-repair:test"),
            Arg.Any<CancellationToken>());
        Assert.NotNull(observed);
        DistributedInvalidationTargetPlan plan = DistributedInvalidationTargetResolver.Resolve(
            DistributedInvalidationEvent.Create(
                observed.EventId!,
                observed.Kind,
                "node-a",
                "test",
                observed.CacheTags,
                observed.RouteKeys,
                observed.ArtifactKeys,
                "trace-body-repair",
                TimeProvider.System));
        Assert.True(plan.IsExact);
        Assert.Contains("article:42", plan.HotReadFragments);
        Assert.Contains("html:article:42", plan.HotReadFragments);
        Assert.DoesNotContain("list:hot", plan.HotReadFragments);
        Assert.DoesNotContain("list:featured", plan.HotReadFragments);
        Assert.DoesNotContain("list:home", plan.HotReadFragments);
    }

    [Fact]
    public async Task InvalidateCategoryTagAsync_RemovesAllRelatedReadingFrames()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var sut = new CacheInvalidationDispatcher(cache, cache, Substitute.For<IHttpCacheInvalidator>());

        await sut.InvalidateCategoryTagAsync();

        await cache.Received(1).IncrementAsync(
            CachePolicyId.ArticleListVersion,
            "main",
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveByPrefixAsync(
            CachePolicyId.RelatedReading,
            "article:",
            Arg.Any<CancellationToken>());
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
        versionPublisher.PublishNextHotArticlesVersionAsync("direct-invalidation", Arg.Any<CancellationToken>()).Returns(8L);
        var sut = new CacheInvalidationDispatcher(cache, cache, httpCacheInvalidator, hotArticlesVersionPublisher: versionPublisher);

        await sut.InvalidateHotArticlesAsync();

        await versionPublisher.Received(1).PublishNextHotArticlesVersionAsync("direct-invalidation", Arg.Any<CancellationToken>());
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

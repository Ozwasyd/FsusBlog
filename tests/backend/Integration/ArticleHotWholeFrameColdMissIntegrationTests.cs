using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

/// <summary>
/// #1845 acceptance: this deliberately exercises the production endpoint, production article
/// projection, a real PostgreSQL database, and a real Redis owned-frame store.  The older unit
/// tests cover the same coordination shape with in-memory substitutes, but cannot prove that a
/// real cold frame has only one metadata query and one atomic publication.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleHotWholeFrameColdMissIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Theory]
    [InlineData(false, 1)]
    [InlineData(false, 3)]
    [InlineData(false, 10)]
    [InlineData(false, 50)]
    [InlineData(true, 1)]
    [InlineData(true, 3)]
    [InlineData(true, 10)]
    [InlineData(true, 50)]
    public async Task WholeFrameColdMiss_TwoRealNodes_CoalescesOnePostgresProjectionAndOneAtomicPublication(
        bool featured,
        int count)
    {
        string connectionString = await CreateFixtureAsync();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"issue-1845-whole-frame-{Guid.CreateVersion7():N}:";
        var scope = new TestKeyScope(prefix);
        var policies = new CachePolicyRegistry();
        using var firstCache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var secondCache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var firstFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        using var secondFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var firstCoordinator = new CacheMissCoordinator(firstFlight, firstCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var secondCoordinator = new CacheMissCoordinator(secondFlight, secondCache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var version = new FixedHotVersion(1);
        Assert.Equal(1, await firstCache.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));

        ArticleEndpointService first = CreateEndpoint(
            new ArticleCoreService(CreateProductionReader(firstDb, firstCoordinator, scope, connection)),
            firstCache,
            firstCoordinator,
            version);
        ArticleEndpointService second = CreateEndpoint(
            new ArticleCoreService(CreateProductionReader(secondDb, secondCoordinator, scope, connection)),
            secondCache,
            secondCoordinator,
            version);
        int firstCommands = 0;
        int secondCommands = 0;
        firstDb.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref firstCommands);
        secondDb.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref secondCommands);
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);

        try
        {
            if (featured)
            {
                ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>[] responses = await Task.WhenAll(
                    Enumerable.Range(0, 48).Select(index => (index & 1) == 0
                        ? first.GetFeaturedArticlesAsync(count)
                        : second.GetFeaturedArticlesAsync(count)));
                try
                {
                    Assert.All(responses, static response => Assert.True(response.HasCachedFrame));
                    byte[] firstFrame = responses[0].CachedFrame!.Memory.ToArray();
                    AssertFeaturedFrame(firstFrame, Math.Min(count, 20));
                    await AssertL2ParityAsync(secondCache, CachePolicyId.TopArticlesFrame, ArticleHotFrameIdentity.BuildFeatured(1, count), AedsFrameType.ArticleFeatured, firstFrame);
                }
                finally
                {
                    foreach (ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>> response in responses)
                    {
                        response.CachedFrame?.Dispose();
                    }
                }
            }
            else
            {
                ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>[] responses = await Task.WhenAll(
                    Enumerable.Range(0, 48).Select(index => (index & 1) == 0
                        ? first.GetHotArticlesAsync(count)
                        : second.GetHotArticlesAsync(count)));
                try
                {
                    Assert.All(responses, static response => Assert.True(response.HasCachedFrame));
                    byte[] firstFrame = responses[0].CachedFrame!.Memory.ToArray();
                    AssertHotFrame(firstFrame, count);
                    await AssertL2ParityAsync(secondCache, CachePolicyId.ArticleHotFrame, ArticleHotFrameIdentity.BuildHot(1, count), AedsFrameType.ArticleHot, firstFrame);
                }
                finally
                {
                    foreach (ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> response in responses)
                    {
                        response.CachedFrame?.Dispose();
                    }
                }
            }

            Assert.Equal(1, Volatile.Read(ref firstCommands) + Volatile.Read(ref secondCommands));
            string[] commands = profile.FinishProfiling().Select(static command => command.Command).ToArray();
            // A second lease contender can perform its own lease SET after the owner has released;
            // it must not produce another frame.  The frame itself is proven singular by one DB
            // projection, byte parity, and the dedicated single-owner command test.
            Assert.InRange(commands.Count(static command => command == "SET"), 1, 2);
            Assert.DoesNotContain("SADD", commands);
            Assert.Contains(commands, static command => command is "EVAL" or "EVALSHA");
            Assert.Equal(0, firstCache.GetOwnedFrameResidencySnapshot().EntryCount + secondCache.GetOwnedFrameResidencySnapshot().EntryCount - 2);
        }
        finally
        {
            firstDb.Aop.OnLogExecuting = null;
            secondDb.Aop.OnLogExecuting = null;
            await firstCache.RemoveAsync(featured ? CachePolicyId.TopArticlesFrame : CachePolicyId.ArticleHotFrame,
                featured ? ArticleHotFrameIdentity.BuildFeatured(1, count) : ArticleHotFrameIdentity.BuildHot(1, count));
            await firstCache.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    [Fact]
    public async Task WholeFrameGenerationDrift_BetweenProjectionAndPublication_NeverPublishesOldIdentity()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"issue-1845-generation-drift-{Guid.CreateVersion7():N}:";
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope(prefix);
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var flight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(flight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var version = new MutableHotVersion(1);
        Assert.Equal(1, await cache.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
        var core = Substitute.For<IArticleCoreService>();
        int calls = 0;
        core.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref calls) == 1)
                {
                    version.Set(2);
                    Assert.Equal(2, await cache.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
                }

                return Result<IReadOnlyList<PopularArticleCoreModel>>.Success(CreatePopular(10));
            });
        ArticleEndpointService endpoint = CreateEndpoint(core, cache, coordinator, version);

        try
        {
            ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> response = await endpoint.GetHotArticlesAsync(10);
            try
            {
                Assert.True(response.HasCachedFrame);
                Assert.Equal(2, Volatile.Read(ref calls));
            }
            finally
            {
                response.CachedFrame?.Dispose();
            }

            Assert.False((await cache.TryGetOwnedFrameAsync(CachePolicyId.ArticleHotFrame, ArticleHotFrameIdentity.BuildHot(1, 10), AedsFrameType.ArticleHot)).Hit);
            OwnedFrameCacheReadResult current = await cache.TryGetOwnedFrameAsync(CachePolicyId.ArticleHotFrame, ArticleHotFrameIdentity.BuildHot(2, 10), AedsFrameType.ArticleHot);
            try
            {
                Assert.True(current.Hit);
                Assert.NotNull(current.Lease);
                AssertHotFrame(current.Lease.Memory.ToArray(), 10);
            }
            finally
            {
                current.Lease?.Dispose();
            }
        }
        finally
        {
            await cache.RemoveAsync(CachePolicyId.ArticleHotFrame, ArticleHotFrameIdentity.BuildHot(1, 10));
            await cache.RemoveAsync(CachePolicyId.ArticleHotFrame, ArticleHotFrameIdentity.BuildHot(2, 10));
            await cache.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    [Fact]
    public async Task WholeFrameAbandonedOwnerLease_ExpiresBeforeSuccessorBuildsTheRealColdFrame()
    {
        string connectionString = await CreateFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"issue-1845-abandoned-owner-{Guid.CreateVersion7():N}:";
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope(prefix);
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var flight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(flight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        var version = new FixedHotVersion(1);
        string identity = ArticleHotFrameIdentity.BuildHot(1, 3);
        Assert.Equal(1, await cache.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
        Assert.True(await cache.TryAcquireLeaseAsync(CachePolicyId.ArticleHotFrame, identity, "owner-that-stopped-before-publish", TimeSpan.FromMilliseconds(125)));
        await Task.Delay(TimeSpan.FromMilliseconds(175));
        ArticleEndpointService successor = CreateEndpoint(
            new ArticleCoreService(CreateProductionReader(db, coordinator, scope, connection)),
            cache,
            coordinator,
            version);
        int commands = 0;
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref commands);

        try
        {
            ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> response = await successor.GetHotArticlesAsync(3);
            try
            {
                Assert.True(response.HasCachedFrame);
                AssertHotFrame(response.CachedFrame!.Memory.ToArray(), 3);
            }
            finally
            {
                response.CachedFrame?.Dispose();
            }

            Assert.Equal(1, Volatile.Read(ref commands));
            Assert.False(await connection.GetDatabase().KeyExistsAsync(cache.BuildKey(CachePolicyId.ArticleHotFrame, $"__lease__:{identity}")));
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
            await cache.RemoveAsync(CachePolicyId.ArticleHotFrame, identity);
            await cache.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    [Theory]
    [InlineData(PublicationFailure.BeforeScript)]
    [InlineData(PublicationFailure.GuardRejected)]
    [InlineData(PublicationFailure.AfterScriptResponseLost)]
    public async Task WholeFramePublicationFailure_LeavesOnlyAnAtomicTerminalState(PublicationFailure failure)
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        string prefix = $"issue-1845-publication-{failure}-{Guid.CreateVersion7():N}:";
        var policies = new CachePolicyRegistry();
        var scope = new TestKeyScope(prefix);
        var executor = new PublicationFaultExecutor(connection, failure);
        using var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance, executor);
        using var authority = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var flight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(flight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = ArticleHotFrameIdentity.BuildHot(1, 3);
        string valueKey = cache.BuildKey(CachePolicyId.ArticleHotFrame, identity);
        string registryKey = scope.PrefixKey(UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.ArticleHotFrame));
        Assert.Equal(1, await authority.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));

        try
        {
            OwnedAedsFrame frame = AedsOwnedFrameBuilder.BuildOwned(AedsFrameType.ArticleHot, writer => PodBinaryCodec.WritePopularArticles(CreatePopular(3), writer));
            if (failure == PublicationFailure.GuardRejected)
            {
                Assert.Equal(2, await authority.IncrementAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity));
                bool? published = await PublishThroughOwnerLeaseAsync(cache, coordinator, identity, frame);
                Assert.False(published);
                Assert.False(await connection.GetDatabase().KeyExistsAsync(valueKey));
            }
            else
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => PublishThroughOwnerLeaseAsync(cache, coordinator, identity, frame));
                Assert.Equal(failure == PublicationFailure.AfterScriptResponseLost, await connection.GetDatabase().KeyExistsAsync(valueKey));
            }

            Assert.False(await connection.GetDatabase().KeyExistsAsync(registryKey));
            OwnedFrameCacheReadResult l1 = await cache.TryGetOwnedFrameAsync(CachePolicyId.ArticleHotFrame, identity, AedsFrameType.ArticleHot);
            try
            {
                Assert.Equal(failure == PublicationFailure.AfterScriptResponseLost, l1.Hit);
                if (l1.Lease is not null)
                {
                    AssertHotFrame(l1.Lease.Memory.ToArray(), 3);
                }
            }
            finally
            {
                l1.Lease?.Dispose();
            }
        }
        finally
        {
            await connection.GetDatabase().KeyDeleteAsync([valueKey, registryKey]);
            await authority.RemoveAsync(CachePolicyId.AdminStats, IHotArticlesCacheVersionProvider.AuthorityCounterIdentity);
        }
    }

    private static Task<bool> PublishThroughOwnerLeaseAsync(
        UnifiedCache cache,
        ICacheMissCoordinator coordinator,
        string identity,
        OwnedAedsFrame frame)
        => coordinator.CoordinateAsync<bool>(
            CachePolicyId.ArticleHotFrame,
            identity,
            _ => Task.FromResult(new CacheReadResult<bool>(false, default)),
            token => cache.TrySetOwnedFrameAsync(
                CachePolicyId.ArticleHotFrame,
                identity,
                frame,
                new OwnedFramePublicationGuard(
                    CachePolicyId.AdminStats,
                    IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                    1),
                cancellationToken: token),
            "issue-1845-script-fault");

    private async Task<string> CreateFixtureAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO category(id, name, description) VALUES (1, 'hot-category', NULL);
            INSERT INTO article_revision(
                id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                tag_ids, content_block_id, markdown_content, diff_summary,
                created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
            SELECT value, value, 1, 'article ' || value::text, 'summary', '/cover-' || value::text || '.webp', 1,
                '', value, '# body', '', 1, NULL, NULL, '2026-07-20T00:00:00Z'
            FROM generate_series(1, 50) AS value;
            INSERT INTO article_rights_snapshot(
                id, article_id, article_revision_id, revision_no, article_rights_policy_id,
                enabled, license_type, copy_policy, max_excerpt_chars, allow_code_copy,
                show_public_badge, proof_binding_enabled, policy_hash, content_canonical_hash, created_at)
            VALUES (
                1, 1, 1, 1, 1,
                true, 'all-rights-reserved', 'append-attribution', 300, true,
                true, true, 'policy-hash', 'content-hash', '2026-07-20T00:00:00Z');
            INSERT INTO article_publication(
                id, article_id, publication_no, article_revision_id, revision_no,
                rights_snapshot_id, responsibility_snapshot_id, transition_kind, published_at, created_at)
            SELECT value, value, 1, value, 1, 1, NULL, 'publish',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'
            FROM generate_series(1, 50) AS value;
            INSERT INTO article(
                id, title, summary, coverimageurl, categoryid, views, createtime,
                metadata_updated_at, status, scheduled_publish_at, published_at,
                last_published_at, public_updated_at, current_revision_id,
                current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
            SELECT value, 'article ' || value::text, 'summary', NULL, 1, 1000 - value,
                '2026-07-20T00:00:00Z'::timestamptz - (value * interval '1 second'),
                '2026-07-20T00:00:00Z', 2, NULL, '2026-07-20T00:00:00Z',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', value, value,
                NULL, NULL, NULL, false
            FROM generate_series(1, 50) AS value;
            """);
        return connectionString;
    }

    private static ArticleEndpointService CreateEndpoint(
        IArticleCoreService core,
        UnifiedCache cache,
        ICacheMissCoordinator coordinator,
        IHotArticlesCacheVersionProvider version)
        => new(
            core,
            Substitute.For<IArticleMutationCommandService>(),
            cache,
            cache,
            coordinator,
            Substitute.For<IArticleDetailAedsArtifactStore>(),
            Substitute.For<IPublicArticleProjectionStore>(),
            Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            version,
            new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System));

    private static ArticleService CreateProductionReader(
        SqlSugarClient db,
        ICacheMissCoordinator missCoordinator,
        IRuntimeKeyScope scope,
        IConnectionMultiplexer redis)
        => new(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: missCoordinator,
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope,
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: Substitute.For<IArticlePublicationValidator>(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _articleListCursorCodec: new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System));

    private static IReadOnlyList<PopularArticleCoreModel> CreatePopular(int count)
        => Enumerable.Range(1, count)
            .Select(id => new PopularArticleCoreModel(PodProjector.ProjectPopularArticle(id, $"article {id}", 1000 - id), id, $"article {id}", 1000 - id))
            .ToArray();

    private static async Task AssertL2ParityAsync(
        UnifiedCache cache,
        CachePolicyId policy,
        string identity,
        AedsFrameType type,
        byte[] expected)
    {
        OwnedFrameCacheReadResult l2 = await cache.TryGetOwnedFrameAsync(policy, identity, type);
        try
        {
            Assert.True(l2.Hit);
            Assert.NotNull(l2.Lease);
            Assert.Equal(expected, l2.Lease.Memory.ToArray());
        }
        finally
        {
            l2.Lease?.Dispose();
        }
    }

    private static void AssertHotFrame(byte[] frame, int expectedCount)
    {
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ArticleHot, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodePopularArticles(decoded.Value.Payload, out IReadOnlyList<PopularArticleCoreModel> articles));
        Assert.Equal(expectedCount, articles.Count);
        Assert.Equal(Enumerable.Range(1, expectedCount), articles.Select(static article => article.Id));
    }

    private static void AssertFeaturedFrame(byte[] frame, int expectedCount)
    {
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ArticleFeatured, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeFeaturedArticles(decoded.Value.Payload, out IReadOnlyList<FeaturedArticleSummaryDto> articles));
        Assert.Equal(expectedCount, articles.Count);
        Assert.Equal(Enumerable.Range(1, expectedCount), articles.Select(static article => article.Id));
    }

    private sealed class TestKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;

        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class FixedHotVersion(long version) : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => version;

        public string BuildVersionedHotArticlesIdentity(string identity) => identity;
    }

    private sealed class MutableHotVersion(long initial) : IHotArticlesCacheVersionProvider
    {
        private long _version = initial;

        public long CurrentHotArticlesVersion => Volatile.Read(ref _version);

        public string BuildVersionedHotArticlesIdentity(string identity) => identity;

        public void Set(long version) => Volatile.Write(ref _version, version);
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);
    }

    public enum PublicationFailure : byte
    {
        BeforeScript = 0,
        GuardRejected = 1,
        AfterScriptResponseLost = 2
    }

    private sealed class PublicationFaultExecutor(IConnectionMultiplexer connection, PublicationFailure failure) : IRedisOperationExecutor
    {
        private int _leaseOperations;

        public async Task<T> ExecuteAsync<T>(
            RedisOperationPort port,
            Func<IConnectionMultiplexer, CancellationToken, Task<T>> command,
            CancellationToken cancellationToken)
        {
            if (port != RedisOperationPort.UnifiedCacheLease || failure == PublicationFailure.GuardRejected)
            {
                return await command(connection, cancellationToken);
            }

            // The first lease-port call acquires the distributed owner lease.  The next one is
            // the whole-frame publication script; release follows it and must remain available.
            if (Interlocked.Increment(ref _leaseOperations) != 2)
            {
                return await command(connection, cancellationToken);
            }

            if (failure == PublicationFailure.BeforeScript)
            {
                throw new InvalidOperationException("injected-before-article-hot-publication-script");
            }

            _ = await command(connection, cancellationToken);
            throw new InvalidOperationException("injected-after-article-hot-publication-script-response");
        }

        public async Task ExecuteAsync(
            RedisOperationPort port,
            Func<IConnectionMultiplexer, CancellationToken, Task> command,
            CancellationToken cancellationToken)
        {
            if (port != RedisOperationPort.UnifiedCacheLease || failure == PublicationFailure.GuardRejected)
            {
                await command(connection, cancellationToken);
                return;
            }

            if (Interlocked.Increment(ref _leaseOperations) != 2)
            {
                await command(connection, cancellationToken);
                return;
            }

            if (failure == PublicationFailure.BeforeScript)
            {
                throw new InvalidOperationException("injected-before-article-hot-publication-script");
            }

            await command(connection, cancellationToken);
            throw new InvalidOperationException("injected-after-article-hot-publication-script-response");
        }
    }
}

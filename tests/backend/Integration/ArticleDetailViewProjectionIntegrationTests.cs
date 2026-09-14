using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Net;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleDetailViewProjectionIntegrationTests(
    PublicHotDeliveryRedisFixture redis,
    PostgresSchemaMigrationFixture postgres) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task L1L2AndDbMiss_RealRedisCaptureContainsNoPerRequestViewOverlay()
    {
        string prefix = $"test:article-detail-view:{Guid.CreateVersion7():N}:";
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        var scope = new PrefixRuntimeKeyScope(prefix);
        var writerCache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            NullLogger<UnifiedCache>.Instance);
        var readerCache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            NullLogger<UnifiedCache>.Instance);
        ArticleDetailReadModel cached = CreateDetail(42, views: 100);
        await writerCache.SetRawAsync(
            CachePolicyId.ArticleDetail,
            42,
            ServerCacheBinaryCodec.EncodeArticleDetail(cached));
        _ = DrainCommands(profile);

        (ArticleService l1Service, IAdo l1Ado) = CreateService(connection, writerCache, scope);
        ArticleDetailReadModel? l1 = await l1Service.GetByIdAsync(42);
        string[] l1Commands = DrainCommands(profile);

        Assert.Equal(100, l1!.Views);
        Assert.Empty(l1Commands);
        Assert.Empty(l1Ado.ReceivedCalls());

        (ArticleService l2Service, IAdo l2Ado) = CreateService(connection, readerCache, scope);
        ArticleDetailReadModel? l2 = await l2Service.GetByIdAsync(42);
        string[] l2Commands = DrainCommands(profile);

        Assert.Equal(100, l2!.Views);
        Assert.Equal(1, l2Commands.Count(static command => command == "GET"));
        Assert.DoesNotContain(l2Commands, static command => command == "ZSCORE");
        Assert.Empty(l2Ado.ReceivedCalls());

        ArticleDetailReadModel? missing = await l2Service.GetByIdAsync(999);
        string[] missCommands = DrainCommands(profile);

        Assert.Null(missing);
        Assert.Equal(1, missCommands.Count(static command => command == "GET"));
        Assert.DoesNotContain(missCommands, static command => command == "ZSCORE");
        await l2Ado.Received(1).GetDataReaderAsync(
            Arg.Is<string>(sql => sql.Contains("FROM article a", StringComparison.Ordinal)),
            Arg.Any<List<SugarParameter>>());
        await redis.DeleteNamespaceAsync(prefix);
    }

    [Fact]
    public async Task IncompleteCurrentCachePayload_MissesAndRebuildsWithoutImplicitBodyQuery()
    {
        string prefix = $"test:article-detail-empty-hit:{Guid.CreateVersion7():N}:";
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        var scope = new PrefixRuntimeKeyScope(prefix);
        var cache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            NullLogger<UnifiedCache>.Instance);
        byte[] incompletePayload = ServerCacheBinaryCodec.EncodeArticleDetail(CreateDetail(42, views: 100));
        int contentBlockOffset = incompletePayload.AsSpan().LastIndexOf(BitConverter.GetBytes(701L));
        Assert.True(contentBlockOffset > 0);
        Array.Clear(incompletePayload, contentBlockOffset, sizeof(long));
        await cache.SetRawAsync(
            CachePolicyId.ArticleDetail,
            42,
            incompletePayload);
        _ = DrainCommands(profile);
        (ArticleService service, IAdo ado) = CreateService(connection, cache, scope);

        ArticleDetailReadModel? detail = await service.GetByIdAsync(42);

        Assert.Null(detail);
        string[] rebuildCommands = DrainCommands(profile);
        Assert.Contains("UNLINK", rebuildCommands);
        Assert.Contains("SETEX", rebuildCommands);
        await ado.Received(1).GetDataReaderAsync(
            Arg.Is<string>(sql => sql.Contains("FROM article a", StringComparison.Ordinal)),
            Arg.Any<List<SugarParameter>>());
        await redis.DeleteNamespaceAsync(prefix);
    }

    [Fact]
    public async Task PublishedRevisionContentBlock_IsTheCompletePublicDetailProjectionSource()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag));
        const string Markdown = "# canonical publication block";
        long blockId = await db.Insertable(new ArticleRevisionContentBlock
        {
            ContentHash = new string('a', 64),
            MarkdownContent = Markdown,
            ByteLength = System.Text.Encoding.UTF8.GetByteCount(Markdown)
        }).ExecuteReturnBigIdentityAsync();
        int articleId = await db.Insertable(new Article
        {
            Title = "legacy metadata",
            CategoryId = 1,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow,
            PublicUpdatedAt = DateTime.UtcNow,
            Views = 17
        }).ExecuteReturnIdentityAsync();
        long revisionId = await db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "published title",
            Summary = "published summary",
            CategoryId = 1,
            ContentBlockId = blockId,
            MarkdownContent = string.Empty,
            TagIds = string.Empty
        }).ExecuteReturnBigIdentityAsync();
        long publicationId = await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "published"
        }).ExecuteReturnBigIdentityAsync();
        await db.Updateable<Article>()
            .SetColumns(article => new Article
            {
                CurrentRevisionId = revisionId,
                CurrentPublicationId = publicationId
            })
            .Where(article => article.Id == articleId)
            .ExecuteCommandAsync();

        string prefix = $"test:article-detail-content-block:{Guid.CreateVersion7():N}:";
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var scope = new PrefixRuntimeKeyScope(prefix);
        var cache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            NullLogger<UnifiedCache>.Instance);
        ArticleService service = CreateService(connection, cache, scope, db);

        ArticleDetailReadModel? projected = await service.GetByIdAsync(articleId);
        ArticleDetailReadModel? cached = await service.GetByIdAsync(articleId);

        Assert.NotNull(projected);
        Assert.Equal(Markdown, projected.Content);
        Assert.Equal(Markdown, cached!.Content);
        await redis.DeleteNamespaceAsync(prefix);
    }

    [Fact]
    public async Task MissingPublishedContentBlock_DoesNotFallBackToLegacyInlineOrCacheIncompleteProjection()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag));
        int articleId = await db.Insertable(new Article
        {
            Title = "metadata",
            CategoryId = 1,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow,
            PublicUpdatedAt = DateTime.UtcNow,
            Views = 3
        }).ExecuteReturnIdentityAsync();
        long revisionId = await db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "missing block",
            Summary = string.Empty,
            CategoryId = 1,
            ContentBlockId = 987_654_321,
            MarkdownContent = "legacy inline must never be served",
            TagIds = string.Empty
        }).ExecuteReturnBigIdentityAsync();
        long publicationId = await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "published"
        }).ExecuteReturnBigIdentityAsync();
        await db.Updateable<Article>()
            .SetColumns(article => new Article
            {
                CurrentRevisionId = revisionId,
                CurrentPublicationId = publicationId
            })
            .Where(article => article.Id == articleId)
            .ExecuteCommandAsync();

        string prefix = $"test:article-detail-missing-block:{Guid.CreateVersion7():N}:";
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        var scope = new PrefixRuntimeKeyScope(prefix);
        var cache = new UnifiedCache(connection, new CachePolicyRegistry(), scope, NullLogger<UnifiedCache>.Instance);
        ArticleService service = CreateService(connection, cache, scope, db);

        ArticleDetailReadModel? projected = await service.GetByIdAsync(articleId);
        (bool hit, _) = await cache.TryGetAsync(
            CachePolicyId.ArticleDetail,
            articleId,
            ServerCacheBinaryCodec.DecodeArticleDetail);

        Assert.Null(projected);
        Assert.False(hit);
        await redis.DeleteNamespaceAsync(prefix);
    }

    [Fact]
    public async Task LatentDisconnectedAndRecoveredRedis_L1DetailNeverWaitsForRedis()
    {
        string prefix = $"test:article-detail-view-disconnected:{Guid.CreateVersion7():N}:";
        ConnectionMultiplexer connection = await redis.ConnectAsync();
        var scope = new PrefixRuntimeKeyScope(prefix);
        var cache = new UnifiedCache(
            connection,
            new CachePolicyRegistry(),
            scope,
            NullLogger<UnifiedCache>.Instance);
        await cache.SetRawAsync(
            CachePolicyId.ArticleDetail,
            42,
            ServerCacheBinaryCodec.EncodeArticleDetail(CreateDetail(42, views: 100)));
        var projection = new ArticleDetailViewProjection();
        projection.ApplyAuthoritative(42, views: 125, version: 125);
        (ArticleService service, IAdo ado) = CreateService(connection, cache, scope, projection);

        EndPoint endpoint = Assert.Single(connection.GetEndPoints());
        await connection.GetServer(endpoint).ExecuteAsync("CLIENT", "PAUSE", "500", "ALL");
        long pausedStarted = Stopwatch.GetTimestamp();
        ArticleDetailReadModel? duringPause = await service.GetByIdAsync(42);
        TimeSpan pausedElapsed = Stopwatch.GetElapsedTime(pausedStarted);
        Assert.Equal(125, duringPause!.Views);
        Assert.True(pausedElapsed < TimeSpan.FromMilliseconds(100), $"L1 detail waited {pausedElapsed.TotalMilliseconds:F2} ms during a 500 ms Redis pause");

        await Task.Delay(TimeSpan.FromMilliseconds(550));
        _ = await connection.GetDatabase().PingAsync();
        ArticleDetailReadModel? recovered = await service.GetByIdAsync(42);
        Assert.Equal(125, recovered!.Views);

        await connection.DisposeAsync();
        long started = Stopwatch.GetTimestamp();
        ArticleDetailReadModel? detail = await service.GetByIdAsync(42);
        TimeSpan elapsed = Stopwatch.GetElapsedTime(started);

        Assert.Equal(125, detail!.Views);
        Assert.True(elapsed < TimeSpan.FromMilliseconds(100), $"L1 detail waited {elapsed.TotalMilliseconds:F2} ms");
        Assert.Empty(ado.ReceivedCalls());
    }

    private static (ArticleService Service, IAdo Ado) CreateService(
        IConnectionMultiplexer redis,
        UnifiedCache cache,
        IRuntimeKeyScope scope,
        IArticleDetailViewProjection? projection = null)
    {
        var ado = Substitute.For<IAdo>();
        DbDataReader reader = new DataTable().CreateDataReader();
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<List<SugarParameter>>()).Returns(reader);
        var db = Substitute.For<ISqlSugarClient>();
        db.Ado.Returns(ado);
        var service = new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: cache,
            _cacheWriter: cache,
            _stringReader: cache,
            _stringWriter: cache,
            _cacheMissCoordinator: new DirectCacheMissCoordinator(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope,
            _httpContextAccessor: new HttpContextAccessor(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _articleDetailViewProjection: projection);
        return (service, ado);
    }

    private static ArticleService CreateService(
        IConnectionMultiplexer redis,
        UnifiedCache cache,
        IRuntimeKeyScope scope,
        ISqlSugarClient db)
        => new(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: cache,
            _cacheWriter: cache,
            _stringReader: cache,
            _stringWriter: cache,
            _cacheMissCoordinator: new DirectCacheMissCoordinator(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: scope,
            _httpContextAccessor: new HttpContextAccessor(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());

    private static string[] DrainCommands(ProfilingSession profile)
        => profile.FinishProfiling().Select(static command => command.Command).ToArray();

    private static ArticleDetailReadModel CreateDetail(int id, int views)
        => new()
        {
            Id = id,
            Title = "Article",
            Content = "Content",
            Summary = "Summary",
            Views = views,
            WordCount = 7,
            EstimatedReadingMinutes = 1,
            CreateTime = DateTime.UtcNow,
            CategoryId = 1,
            CategoryName = "Category",
            Tags = [],
            Status = ArticleStatus.Published,
            CurrentRevisionId = 801,
            RevisionNo = 7,
            CurrentPublicationId = 1201,
            PublicationNo = 4,
            ContentBlockId = 701,
            PublishedAt = DateTime.UtcNow
        };

    private sealed class DirectCacheMissCoordinator : ICacheMissCoordinator
    {
        public async Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
        {
            _ = policyId;
            _ = identity;
            _ = operation;
            _ = strategy;
            CacheReadResult<T> hit = await tryReadAsync(cancellationToken).ConfigureAwait(false);
            return hit.Hit ? hit.Value : await rebuildAsync(cancellationToken).ConfigureAwait(false);
        }

        public Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            int identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
            => CoordinateAsync(
                policyId,
                identity.ToString(System.Globalization.CultureInfo.InvariantCulture),
                tryReadAsync,
                rebuildAsync,
                operation,
                cancellationToken,
                strategy);
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;

        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}

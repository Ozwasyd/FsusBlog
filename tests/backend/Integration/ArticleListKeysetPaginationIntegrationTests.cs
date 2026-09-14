using System.Collections.Concurrent;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
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
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleListKeysetPaginationIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PublicContentPaginationFixture_SeedsTenThousandTwentyRealKeysetRows()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord));
        string ownerPrefix = $"fxpc:pagination:{Guid.NewGuid():N}";
        DateTime baseTimeUtc = new(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc);

        int inserted = await PublicContentFixtureSeeder.InsertDeepPaginationRowsAsync(
            db,
            ownerPrefix,
            categoryId: 1,
            tagId: 7,
            contentBlockId: 1,
            createdByAdminPrincipalId: 1,
            rightsSnapshotId: 1,
            baseTimeUtc,
            CancellationToken.None);

        Assert.Equal(PublicContentFixtureSeeder.PaginationArticleCount, inserted);
        List<PaginationFixtureBoundaryRow> boundaries = await db.Ado.SqlQueryAsync<PaginationFixtureBoundaryRow>(
            """
            WITH visible AS (
                SELECT
                    article.id AS "ArticleId",
                    article.createtime AS "CreateTimeUtc",
                    row_number() OVER (ORDER BY article.createtime DESC, article.id DESC) AS "Ordinal"
                FROM article
                JOIN article_publication publication ON publication.id = article.current_publication_id
                JOIN article_revision revision ON revision.id = publication.article_revision_id
                WHERE article.isdeleted = false
                  AND article.status = 2
                  AND left(article.title, length(@OwnerPrefix)) = @OwnerPrefix
            )
            SELECT "ArticleId", "CreateTimeUtc", "Ordinal"
            FROM visible
            WHERE "Ordinal" IN (90, 990, 9990)
            ORDER BY "Ordinal";
            """,
            new SugarParameter("@OwnerPrefix", ownerPrefix));
        Assert.Equal([90, 990, 9990], boundaries.Select(static row => row.Ordinal));

        var codec = new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System);
        PublicContentPaginationProjection projection = PublicContentFixtureSeeder.BuildPaginationProjection(
            generation: 73,
            articleCount: inserted,
            ownedArticleCount: inserted,
            boundaries.Select((row, index) => new PublicContentPaginationBoundaryRow(
                LogicalPage: new[] { 10, 100, 1000 }[index],
                row.ArticleId,
                row.CreateTimeUtc.Kind == DateTimeKind.Unspecified
                    ? DateTime.SpecifyKind(row.CreateTimeUtc, DateTimeKind.Utc)
                    : row.CreateTimeUtc.ToUniversalTime(),
                SortValue: 0,
                PrecedingItemCount: checked((int)row.Ordinal))).ToArray(),
            codec);
        Assert.All(projection.Cursors, page => Assert.True(codec.TryDecode(
            page.Cursor,
            categoryId: null,
            tagId: null,
            normalizedKeyword: string.Empty,
            pageSize: 10,
            queryVersion: 73,
            sort: ArticleListSortMode.Latest,
            out _)));
    }

    [Fact]
    public async Task HotAndFeaturedSeedProjection_UsesOneBatchAndDropsInvisibleOrMissingIds()
    {
        string connectionString = await CreateProductionFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article_revision SET cover_image_url = '/visible.webp' WHERE id = 1;
            UPDATE article SET isdeleted = true WHERE id = 2;
            UPDATE article SET status = 1 WHERE id = 3;
            UPDATE article SET scheduled_publish_at = '2099-01-01T00:00:00Z' WHERE id = 4;
            """);
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        IDatabase redisDatabase = Substitute.For<IDatabase>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(redisDatabase);
        redisDatabase.SortedSetRangeByRankAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<long>(),
                Arg.Any<long>(),
                Order.Descending,
                Arg.Any<CommandFlags>())
            .Returns(new RedisValue[] { 1, 2, 3, 4, 999_999 });
        var strings = new InMemoryStringCache();
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var missCoordinator = new CacheMissCoordinator(singleFlight, new InMemoryLeaseStore(), policies, NullLogger<CacheMissCoordinator>.Instance);
        ArticleService gateway = CreateProductionReader(db, strings, missCoordinator, scope, redis: redis);
        int commands = 0;
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref commands);

        IReadOnlyList<PopularArticleCoreModel> hot = await ((IArticleCoreGateway)gateway).GetHotArticlesAsync(new ArticleCountQuery(5));

        Assert.Equal([1], hot.Select(static item => item.Id).ToArray());
        Assert.Equal(1, Volatile.Read(ref commands));
        Volatile.Write(ref commands, 0);

        IReadOnlyList<FeaturedArticleCoreModel> featured = await ((IArticleCoreGateway)gateway).GetFeaturedArticlesAsync(new ArticleCountQuery(5));

        Assert.Equal([1], featured.Select(static item => item.Id).ToArray());
        Assert.Equal(0, Volatile.Read(ref commands));

        db.Aop.OnLogExecuting = null;
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article SET views = 100 WHERE id = 1;
            UPDATE article SET views = 90 WHERE id = 5;
            UPDATE article_revision SET cover_image_url = '/second.webp' WHERE id = 5;
            """);
        redisDatabase.SortedSetRangeByRankAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<long>(),
                Arg.Any<long>(),
                Order.Descending,
                Arg.Any<CommandFlags>())
            .Returns(Array.Empty<RedisValue>());
        strings = new InMemoryStringCache();
        gateway = CreateProductionReader(db, strings, missCoordinator, scope, redis: redis);
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref commands);
        Volatile.Write(ref commands, 0);

        hot = await ((IArticleCoreGateway)gateway).GetHotArticlesAsync(new ArticleCountQuery(2));

        Assert.Equal([1, 5], hot.Select(static item => item.Id).ToArray());
        Assert.Equal(1, Volatile.Read(ref commands));
        Volatile.Write(ref commands, 0);

        featured = await ((IArticleCoreGateway)gateway).GetFeaturedArticlesAsync(new ArticleCountQuery(2));

        Assert.Equal([1, 5], featured.Select(static item => item.Id).ToArray());
        Assert.Equal(0, Volatile.Read(ref commands));
    }

    [Fact]
    public async Task PublicHotAndAotPreloads_EmitFirstPageCursorConsumedByDynamicSecondPage()
    {
        string connectionString = await CreateProductionFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var strings = new InMemoryStringCache();
        var policies = new CachePolicyRegistry();
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var keyResolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(keyResolver);
        var missCoordinator = new CacheMissCoordinator(
            singleFlight,
            new InMemoryLeaseStore(),
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        var cursorCodec = new ArticleListCursorCodec(
            new EphemeralDataProtectionProvider(),
            TimeProvider.System);
        ArticleService gateway = CreateProductionReader(db, strings, missCoordinator, scope, cursorCodec);
        var core = new ArticleCoreService(gateway);
        var options = new PublicHotReadOptions
        {
            PreloadSizes = [10],
            HotSizes = [1],
            FeaturedSizes = [3],
            MaxPreloadSize = 10,
            MaxArticleFrames = 1,
            EnablePrecompressedBinaryVariants = false
        };
        var encoder = new AedsEncoder();
        var projector = new PublicHotArtifactProjector(
            db,
            encoder,
            new ImmediateDbConcurrencyGate(),
            Options.Create(options),
            new ArticleBodyRepairQueue(),
            cursorCodec,
            TimeProvider.System,
            NullLogger<PublicHotArtifactProjector>.Instance,
            cacheStringReader: strings);

        PublicHotReadSnapshot hotSnapshot = await projector.BuildInitialSnapshotAsync(CancellationToken.None);
        Assert.All(hotSnapshot.ListArtifacts, static pair => Assert.Equal((ushort)1, pair.Key.Page));
        var hotStore = new PublicHotReadStore(options: Options.Create(options));
        hotStore.Publish(hotSnapshot);
        var hotContext = new DefaultHttpContext();
        hotContext.Request.Method = HttpMethods.Get;
        hotContext.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        hotContext.Request.Headers.Accept = "application/octet-stream";
        hotContext.Response.Body = new MemoryStream();
        bool hotFellThrough = false;

        await PublicHotReadFastPath.TryServeAsync(
            hotContext,
            _ =>
            {
                hotFellThrough = true;
                return Task.CompletedTask;
            },
            hotStore,
            options,
            new PublicHotReadCounters());

        Assert.False(hotFellThrough);
        Assert.Equal(StatusCodes.Status200OK, hotContext.Response.StatusCode);
        var decodedHotFrame = encoder.TryDecode(((MemoryStream)hotContext.Response.Body).ToArray());
        Assert.True(decodedHotFrame.IsSuccess, decodedHotFrame.Error.Message);
        Assert.Equal(AedsFrameType.ArticleList, decodedHotFrame.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeArticlePage(decodedHotFrame.Value.Payload, out CorePageResult<ArticleListCoreModel> hotPage));
        Assert.True(hotPage.HasMore);
        Assert.False(string.IsNullOrWhiteSpace(hotPage.NextCursor));

        IAotSeoConfigSnapshot seo = Substitute.For<IAotSeoConfigSnapshot>();
        seo.GetAsync(Arg.Any<CancellationToken>())
            .Returns(new PublicAotSeoSnapshot("Fsus", "Blog", "https://example.test"));
        IArticleCoreService aotCore = Substitute.For<IArticleCoreService>();
        aotCore.GetPageListAsync(Arg.Any<ArticlePageQuery>(), Arg.Any<CancellationToken>())
            .Returns(call => core.GetPageListAsync(
                call.Arg<ArticlePageQuery>(),
                call.Arg<CancellationToken>()));
        aotCore.GetFeaturedArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success([]));
        aotCore.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlyList<PopularArticleCoreModel>>.Success([]));
        var aotProvider = new PublicAotHomeBootstrapProvider(aotCore, seo);
        var aotMatch = new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);
        var aotResult = await aotProvider.BuildSnapshotAsync(aotMatch);
        Assert.True(aotResult.IsSuccess, aotResult.Error.Message);
        PublicHomePageSnapshot aotPage = Assert.IsType<PublicHomePageSnapshot>(aotResult.Value);
        Assert.True(aotPage.HasMore);
        Assert.False(string.IsNullOrWhiteSpace(aotPage.NextCursor));

        IOwnedFrameCache ownedFrames = Substitute.For<IOwnedFrameCache>();
        ownedFrames.TryGetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<AedsFrameType>(),
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        ownedFrames.SetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<OwnedAedsFrame>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                call.Arg<OwnedAedsFrame>().Retire();
                return Task.CompletedTask;
            });
        var endpoint = new ArticleEndpointService(
            core,
            Substitute.For<IArticleMutationCommandService>(),
            strings,
            ownedFrames,
            missCoordinator,
            Substitute.For<IArticleDetailAedsArtifactStore>(),
            Substitute.For<IPublicArticleProjectionStore>(),
            Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            Substitute.For<IHotArticlesCacheVersionProvider>(),
            cursorCodec);

        int[][] secondPageIds = new int[2][];
        string[] preloadCursors = [hotPage.NextCursor!, aotPage.NextCursor!];
        for (int index = 0; index < preloadCursors.Length; index++)
        {
            ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> response = await endpoint.GetPageListAsync(
                page: 2,
                size: 10,
                categoryId: null,
                tagId: null,
                isDeleted: false,
                canReadDeleted: false,
                status: null,
                canReadPrivate: false,
                cursor: preloadCursors[index]);
            try
            {
                Assert.True(response.Result.IsSuccess, response.Result.Error.Message);
                secondPageIds[index] = response.Result.Value.Items.Select(static item => item.Id).ToArray();
            }
            finally
            {
                response.CachedFrame?.Dispose();
            }
        }

        Assert.Equal(10, secondPageIds[0].Length);
        Assert.Equal(secondPageIds[0], secondPageIds[1]);
        Assert.Empty(hotPage.Items.Select(static item => item.Id).Intersect(secondPageIds[0]));
    }

    [Fact]
    public async Task ProductionReader_CountHitAndMissCommandBudgetIsConstantThroughLogicalPage1000()
    {
        string connectionString = await CreateProductionFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var commands = new ConcurrentQueue<string>();
        db.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);

        var strings = new InMemoryStringCache();
        var policies = new CachePolicyRegistry();
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var keyResolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(keyResolver);
        var missCoordinator = new CacheMissCoordinator(
            singleFlight,
            new InMemoryLeaseStore(),
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        IArticleCoreGateway gateway = CreateProductionReader(db, strings, missCoordinator, scope);

        foreach (int logicalPage in new[] { 1, 10, 100, 1000 })
        {
            ArticleListCursorPosition? cursor = logicalPage == 1
                ? null
                : await ReadBoundaryAsync(connectionString, (logicalPage - 1) * 10 - 1);
            var query = new ArticlePageQuery(
                logicalPage,
                10,
                CategoryId: null,
                TagId: null,
                IsDeleted: false,
                ListCacheVersion: 1_000 + logicalPage,
                UseSourceCache: false,
                Cursor: cursor);
            commands.Clear();

            var coldPage = await gateway.GetPageListAsync(query);

            string[] coldCommands = commands.ToArray();
            Assert.Equal(2, coldCommands.Length);
            Assert.DoesNotContain(coldCommands, static sql => sql.Contains("OFFSET", StringComparison.OrdinalIgnoreCase));
            Assert.All(coldPage.Items, static item => Assert.Equal("cursor-tag", Assert.Single(item.Tags).Name));
            Assert.True(
                coldPage.Items.Count == 10,
                $"logical page {logicalPage} returned {coldPage.Items.Count} items at {cursor}; commands: {string.Join(" | ", coldCommands)}");

            commands.Clear();
            var hotPage = await gateway.GetPageListAsync(query);

            string[] hotCommands = commands.ToArray();
            Assert.Single(hotCommands);
            Assert.DoesNotContain(hotCommands, static sql => sql.Contains("OFFSET", StringComparison.OrdinalIgnoreCase));
            Assert.Equal(coldPage.Items.Select(static item => item.Id), hotPage.Items.Select(static item => item.Id));
        }
    }

    [Fact]
    public async Task ProductionReader_PublicQueryCannotEnterPageBasedSourceCache()
    {
        string connectionString = await CreateProductionFixtureAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var strings = new InMemoryStringCache();
        var policies = new CachePolicyRegistry();
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var keyResolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(keyResolver);
        var missCoordinator = new CacheMissCoordinator(
            singleFlight,
            new InMemoryLeaseStore(),
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        IArticleCoreGateway gateway = CreateProductionReader(db, strings, missCoordinator, scope);

        CorePageResult<ArticleListCoreModel> page = await gateway.GetPageListAsync(
            new ArticlePageQuery(1, 10, null, null, false, UseSourceCache: true));

        Assert.Equal(10, page.Items.Count);
        Assert.True(page.HasMore);
        Assert.False(string.IsNullOrWhiteSpace(page.NextCursor));
    }

    [Fact]
    public async Task ProductionReader_OneHundredConcurrentColdCountsUseOneRebuild()
    {
        string connectionString = await CreateProductionFixtureAsync();
        var commands = new ConcurrentQueue<string>();

        var strings = new InMemoryStringCache();
        var policies = new CachePolicyRegistry();
        var scope = Substitute.For<IRuntimeKeyScope>();
        scope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var keyResolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(keyResolver);
        var missCoordinator = new CacheMissCoordinator(
            singleFlight,
            new InMemoryLeaseStore(),
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        SqlSugarClient[] clients = Enumerable.Range(0, 100)
            .Select(_ => PostgresSqlSugarTestClient.Create(connectionString))
            .ToArray();
        try
        {
            foreach (SqlSugarClient client in clients)
            {
                client.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            }

            Task<CorePageResult<ArticleListCoreModel>>[] requests = clients
                .Select(client => ((IArticleCoreGateway)CreateProductionReader(client, strings, missCoordinator, scope)).GetPageListAsync(new ArticlePageQuery(
                    Page: 1,
                    Size: 10,
                    CategoryId: null,
                    TagId: null,
                    IsDeleted: false,
                    ListCacheVersion: 91,
                    UseSourceCache: false)))
                .ToArray();
            CorePageResult<ArticleListCoreModel>[] pages = await Task.WhenAll(requests);

            Assert.All(pages, static page => Assert.Equal(10, page.Items.Count));
            Assert.Single(commands, static sql => sql.Contains("SELECT COUNT(1) AS \"__TotalCount\"", StringComparison.Ordinal));
            Assert.Equal(101, commands.Count);
        }
        finally
        {
            foreach (SqlSugarClient client in clients)
            {
                client.Dispose();
            }
        }
    }

    [Fact]
    public async Task ProductionEndpoint_RejectsVersionDriftThenRestartsWithoutDuplicatesAcrossConcurrentMutations()
    {
        const long InitialVersion = 401;
        const long MutatedVersion = 402;
        string connectionString = await CreateProductionFixtureAsync();
        await ExecuteProductionMutationAsync(
            connectionString,
            """
            INSERT INTO article_revision(
                id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                tag_ids, content_block_id, markdown_content, diff_summary,
                created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
            VALUES (
                20002, 20002, 1, 'article pending publication', 'summary', NULL, 1,
                '7', 20002, '# body', '', 1, NULL, NULL, '2026-07-20T00:00:00Z');
            INSERT INTO article(
                id, title, summary, coverimageurl, categoryid, views, createtime,
                metadata_updated_at, status, scheduled_publish_at, published_at,
                last_published_at, public_updated_at, current_revision_id,
                current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
            VALUES (
                20002, 'article pending publication', 'summary', NULL, 1, 0,
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 1, NULL, NULL,
                NULL, '2026-07-20T00:00:00Z', 20002, NULL, NULL, NULL, NULL, false);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var strings = new InMemoryStringCache();
        await strings.SetStringAsync(CachePolicyId.ArticleListVersion, "main", InitialVersion.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        var keyResolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(keyResolver);
        var missCoordinator = new CacheMissCoordinator(
            singleFlight,
            new InMemoryLeaseStore(),
            policies,
            NullLogger<CacheMissCoordinator>.Instance);
        var cursorCodec = new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System);
        ArticleService reader = CreateProductionReader(db, strings, missCoordinator, scope, cursorCodec);
        var core = new ArticleCoreService(reader);
        ArticleEndpointService endpoint = CreateEndpoint(core, strings, missCoordinator, cursorCodec);

        CorePageResult<ArticleListCoreModel> first = await ReadEndpointPageAsync(
            endpoint,
            page: 1,
            size: 100,
            keyword: "article",
            cursor: null);
        Assert.True(first.HasMore);
        Assert.False(string.IsNullOrWhiteSpace(first.NextCursor));
        int alreadySeenId = first.Items[0].Id;

        await Task.WhenAll(
            ExecuteProductionMutationAsync(
                connectionString,
                """
                INSERT INTO article_revision(
                    id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                    tag_ids, content_block_id, markdown_content, diff_summary,
                    created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
                VALUES (
                    20001, 20001, 1, 'article concurrently inserted', 'summary', NULL, 1,
                    '7', 20001, '# body', '', 1, NULL, NULL, '2026-07-21T00:00:00Z');
                INSERT INTO article_publication(
                    id, article_id, publication_no, article_revision_id, revision_no,
                    rights_snapshot_id, responsibility_snapshot_id, transition_kind, published_at, created_at)
                VALUES (
                    20001, 20001, 1, 20001, 1,
                    1, NULL, 'publish', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z');
                INSERT INTO article(
                    id, title, summary, coverimageurl, categoryid, views, createtime,
                    metadata_updated_at, status, scheduled_publish_at, published_at,
                    last_published_at, public_updated_at, current_revision_id,
                    current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
                VALUES (
                    20001, 'article concurrently inserted', 'summary', NULL, 1, 0,
                    '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z', 2, NULL, '2026-07-21T00:00:00Z',
                    '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z', 20001, 20001,
                    NULL, NULL, NULL, false);
                """),
            ExecuteProductionMutationAsync(
                connectionString,
                "UPDATE article SET isdeleted = true, deleted_at = NOW() WHERE id = @article_id;",
                new NpgsqlParameter("article_id", alreadySeenId)),
            ExecuteProductionMutationAsync(
                connectionString,
                """
                INSERT INTO article_publication(
                    id, article_id, publication_no, article_revision_id, revision_no,
                    rights_snapshot_id, responsibility_snapshot_id, transition_kind, published_at, created_at)
                VALUES (
                    20002, 20002, 1, 20002, 1,
                    1, NULL, 'publish', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
                UPDATE article
                SET status = 2,
                    published_at = '2026-07-20T00:00:00Z',
                    last_published_at = '2026-07-20T00:00:00Z',
                    current_publication_id = 20002
                WHERE id = 20002;
                """));
        await strings.SetStringAsync(CachePolicyId.ArticleListVersion, "main", MutatedVersion.ToString(System.Globalization.CultureInfo.InvariantCulture));

        int commands = 0;
        db.Aop.OnLogExecuting = (_, _) => Interlocked.Increment(ref commands);
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> stale = await endpoint.GetPageListAsync(
            page: 2,
            size: 100,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            keyword: "article",
            cursor: first.NextCursor);
        stale.CachedFrame?.Dispose();
        Assert.False(stale.Result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, stale.Result.Error.Code);
        Assert.Equal(0, Volatile.Read(ref commands));

        db.Aop.OnLogExecuting = null;
        IReadOnlyList<int> expected = await ReadCurrentProductionArticleIdsAsync(connectionString, "article");
        var seen = new List<int>(expected.Count);
        int page = 1;
        string? cursor = null;
        bool hasMore;
        do
        {
            CorePageResult<ArticleListCoreModel> current = await ReadEndpointPageAsync(
                endpoint,
                page,
                size: 100,
                keyword: "article",
                cursor);
            seen.AddRange(current.Items.Select(static item => item.Id));
            hasMore = current.HasMore;
            cursor = current.NextCursor;
            page++;
        }
        while (hasMore);

        Assert.Equal(expected, seen);
        Assert.Equal(seen.Count, seen.Distinct().Count());
    }

    [Fact]
    public async Task CompositeCursor_ExplainUsesOrderedIndexWithoutSortOrOffset()
    {
        string connectionString = await CreateFixtureAsync();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (NpgsqlCommand disableSeqScan = connection.CreateCommand())
        {
            disableSeqScan.CommandText = "SET enable_seqscan = off;";
            await disableSeqScan.ExecuteNonQueryAsync();
        }

        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, createtime
            FROM public_article_keyset_fixture
            WHERE category_id = 1
              AND (createtime < @cursor_time OR (createtime = @cursor_time AND id < @cursor_id))
            ORDER BY createtime DESC, id DESC
            LIMIT 5;
            """;
        command.Parameters.AddWithValue("cursor_time", new DateTime(2026, 7, 20, 0, 0, 0, DateTimeKind.Utc));
        command.Parameters.AddWithValue("cursor_id", int.MaxValue);
        string plan = (string)(await command.ExecuteScalarAsync())!;

        Assert.True(
            plan.Contains("Index Scan", StringComparison.Ordinal)
            || plan.Contains("Index Only Scan", StringComparison.Ordinal),
            plan);
        Assert.DoesNotContain("\"Node Type\": \"Sort\"", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("OFFSET", plan, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Shared Hit Blocks", plan, StringComparison.Ordinal);
    }

    private static ArticleEndpointService CreateEndpoint(
        IArticleCoreService core,
        ICacheStringReader strings,
        ICacheMissCoordinator missCoordinator,
        IArticleListCursorCodec cursorCodec)
    {
        IOwnedFrameCache ownedFrames = Substitute.For<IOwnedFrameCache>();
        ownedFrames.TryGetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<AedsFrameType>(),
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        ownedFrames.SetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<OwnedAedsFrame>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                call.Arg<OwnedAedsFrame>().Retire();
                return Task.CompletedTask;
            });
        return new ArticleEndpointService(
            core,
            Substitute.For<IArticleMutationCommandService>(),
            strings,
            ownedFrames,
            missCoordinator,
            Substitute.For<IArticleDetailAedsArtifactStore>(),
            Substitute.For<IPublicArticleProjectionStore>(),
            Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            Substitute.For<IHotArticlesCacheVersionProvider>(),
            cursorCodec);
    }

    private static async Task<CorePageResult<ArticleListCoreModel>> ReadEndpointPageAsync(
        ArticleEndpointService endpoint,
        int page,
        int size,
        string keyword,
        string? cursor)
    {
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> payload = await endpoint.GetPageListAsync(
            page,
            size,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            keyword: keyword,
            sort: null,
            cursor: cursor);
        try
        {
            Assert.True(payload.Result.IsSuccess, payload.Result.Error.Message);
            return payload.Result.Value;
        }
        finally
        {
            payload.CachedFrame?.Dispose();
        }
    }

    private static async Task ExecuteProductionMutationAsync(
        string connectionString,
        string sql,
        params NpgsqlParameter[] parameters)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.Parameters.AddRange(parameters);
        await command.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    private static async Task<IReadOnlyList<int>> ReadCurrentProductionArticleIdsAsync(
        string connectionString,
        string keyword)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT a.id
            FROM article a
            JOIN article_publication publication ON publication.id = a.current_publication_id
            JOIN article_revision revision ON revision.id = publication.article_revision_id
            WHERE a.isdeleted = false
              AND a.status = 2
              AND a.current_publication_id IS NOT NULL
              AND (a.published_at IS NULL OR a.published_at <= NOW())
              AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= NOW())
              AND (revision.title LIKE @keyword OR revision.summary LIKE @keyword)
            ORDER BY a.createtime DESC, a.id DESC;
            """;
        command.Parameters.AddWithValue("keyword", $"%{keyword}%");
        var ids = new List<int>();
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            ids.Add(reader.GetInt32(0));
        }

        return ids;
    }

    private async Task<string> CreateFixtureAsync()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE public_article_keyset_fixture (
                id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                createtime timestamptz NOT NULL,
                category_id integer NOT NULL,
                tag_ids integer[] NOT NULL,
                title text NOT NULL,
                is_published boolean NOT NULL DEFAULT true,
                is_deleted boolean NOT NULL DEFAULT false
            );
            CREATE INDEX idx_public_article_keyset_fixture
                ON public_article_keyset_fixture(category_id, createtime DESC, id DESC);
            INSERT INTO public_article_keyset_fixture(createtime, category_id, tag_ids, title)
            SELECT
                '2026-07-20T00:00:00Z'::timestamptz - (((value - 1) / 3) * interval '1 minute'),
                CASE WHEN value % 4 = 0 THEN 2 ELSE 1 END,
                CASE WHEN value % 5 = 0 THEN ARRAY[8] ELSE ARRAY[7] END,
                CASE WHEN value % 6 = 0 THEN 'other' ELSE 'needle article ' || value::text END
            FROM generate_series(1, 80) AS value;
            INSERT INTO public_article_keyset_fixture(createtime, category_id, tag_ids, title, is_published)
            VALUES ('2026-07-21T00:00:00Z', 1, ARRAY[7], 'needle pending publication', false);
            ANALYZE public_article_keyset_fixture;
            """);
        return connectionString;
    }

    private async Task<string> CreateProductionFixtureAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleTag),
            typeof(ArticleBody),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(CategoryPublicArticleCount),
            typeof(TagPublicArticleCount));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO category(id, name, description) VALUES (1, 'cursor-category', NULL);
            INSERT INTO tag(id, name, description) VALUES (7, 'cursor-tag', NULL);

            INSERT INTO article_revision(
                id, article_id, revision_no, title, summary, cover_image_url, categoryid,
                tag_ids, content_block_id, markdown_content, diff_summary,
                created_by_admin_principal_id, rollback_source_revision_id, rollback_reason, created_at)
            SELECT value, value, 1, 'article ' || value::text, 'summary', NULL, 1,
                '7', value, '# body', '', 1, NULL, NULL, '2026-07-20T00:00:00Z'
            FROM generate_series(1, 10020) AS value;

            INSERT INTO article_publication(
                id, article_id, publication_no, article_revision_id, revision_no,
                rights_snapshot_id, responsibility_snapshot_id, transition_kind, published_at, created_at)
            SELECT value, value, 1, value, 1, 1, NULL, 'publish',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'
            FROM generate_series(1, 10020) AS value;

            INSERT INTO article(
                id, title, summary, coverimageurl, categoryid, views, createtime,
                metadata_updated_at, status, scheduled_publish_at, published_at,
                last_published_at, public_updated_at, current_revision_id,
                current_publication_id, pending_publication_at, archived_at, deleted_at, isdeleted)
            SELECT value, 'article ' || value::text, 'summary', NULL, 1, 0,
                '2026-07-20T00:00:00Z'::timestamptz - (((value - 1) / 3) * interval '1 second'),
                '2026-07-20T00:00:00Z', 2, NULL, '2026-07-20T00:00:00Z',
                '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', value, value,
                NULL, NULL, NULL, false
            FROM generate_series(1, 10020) AS value;

            INSERT INTO article_body(article_id, markdown_content, updated_at)
            VALUES (10020, '# body', '2026-07-20T00:00:00Z');

            INSERT INTO article_rights_snapshot(
                id, article_id, article_revision_id, revision_no, article_rights_policy_id,
                enabled, license_type, copy_policy, max_excerpt_chars, allow_code_copy,
                show_public_badge, proof_binding_enabled, policy_hash, content_canonical_hash, created_at)
            VALUES (
                1, 10020, 10020, 1, 1,
                true, 'all-rights-reserved', 'append-attribution', 300, true,
                true, true, 'policy-hash', 'content-hash', '2026-07-20T00:00:00Z');

            INSERT INTO category_public_article_count(category_id, article_count, updated_at_utc)
            VALUES (1, 10020, '2026-07-20T00:00:00Z');
            INSERT INTO tag_public_article_count(tag_id, article_count, updated_at_utc)
            VALUES (7, 10020, '2026-07-20T00:00:00Z');
            ANALYZE article;
            """);
        return connectionString;
    }

    private static async Task<ArticleListCursorPosition> ReadBoundaryAsync(string connectionString, int zeroBasedOrderedIndex)
    {
        int group = zeroBasedOrderedIndex / 3;
        int groupOffset = zeroBasedOrderedIndex % 3;
        int articleId = checked(group * 3 + (3 - groupOffset));
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT createtime, id
            FROM article
            WHERE id = @article_id
              AND isdeleted = false
              AND status = 2
              AND current_publication_id IS NOT NULL;
            """;
        command.Parameters.AddWithValue("article_id", articleId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        DateTime createTime = reader.GetDateTime(0);
        return new ArticleListCursorPosition(
            createTime.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(createTime, DateTimeKind.Utc) : createTime.ToUniversalTime(),
            reader.GetInt32(1));
    }

    private static ArticleService CreateProductionReader(
        SqlSugarClient db,
        InMemoryStringCache strings,
        ICacheMissCoordinator missCoordinator,
        IRuntimeKeyScope scope,
        IArticleListCursorCodec? cursorCodec = null,
        IConnectionMultiplexer? redis = null)
    {
        if (redis is null)
        {
            redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        }
        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: strings,
            _stringWriter: strings,
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
            _articleListCursorCodec: cursorCodec
                ?? new ArticleListCursorCodec(new EphemeralDataProtectionProvider(), TimeProvider.System));
    }

    private sealed class PaginationFixtureBoundaryRow
    {
        public int ArticleId
        {
            get; init;
        }
        public DateTime CreateTimeUtc
        {
            get; init;
        }
        public long Ordinal
        {
            get; init;
        }
    }

    private static async Task<IReadOnlyList<int>> ReadAllMatchingIdsAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT id
            FROM public_article_keyset_fixture
            WHERE category_id = 1
              AND 7 = ANY(tag_ids)
              AND title LIKE '%needle%'
              AND is_published = true
              AND is_deleted = false
            ORDER BY createtime DESC, id DESC;
            """;
        var ids = new List<int>();
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            ids.Add(reader.GetInt32(0));
        }
        return ids;
    }

    private static async Task<Page> ReadPageAsync(string connectionString, Position? cursor, int limit)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, createtime
            FROM public_article_keyset_fixture
            WHERE category_id = 1
              AND 7 = ANY(tag_ids)
              AND title LIKE '%needle%'
              AND is_published = true
              AND is_deleted = false
              AND (@cursor_time IS NULL OR createtime < @cursor_time OR (createtime = @cursor_time AND id < @cursor_id))
            ORDER BY createtime DESC, id DESC
            LIMIT @limit;
            """;
        command.Parameters.AddWithValue(
            "cursor_time",
            NpgsqlTypes.NpgsqlDbType.TimestampTz,
            cursor.HasValue ? cursor.Value.CreateTimeUtc : DBNull.Value);
        command.Parameters.AddWithValue("cursor_id", cursor?.Id ?? int.MaxValue);
        command.Parameters.AddWithValue("limit", limit + 1);
        var rows = new List<Position>(limit + 1);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            rows.Add(new Position(reader.GetDateTime(1).ToUniversalTime(), reader.GetInt32(0)));
        }

        bool hasMore = rows.Count > limit;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }
        return new Page(rows.Select(static row => row.Id).ToArray(), rows.Count == 0 ? null : rows[^1], hasMore);
    }

    private readonly record struct Position(DateTime CreateTimeUtc, int Id);
    private sealed record Page(IReadOnlyList<int> Ids, Position? Cursor, bool HasMore);

    private sealed class InMemoryStringCache : ICacheStringReader, ICacheStringWriter
    {
        private readonly ConcurrentDictionary<(CachePolicyId Policy, string Identity), string> _values = new();

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.GetValueOrDefault((policyId, identity)));
        }

        public Task SetStringAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _values[(policyId, identity)] = value;
            return Task.CompletedTask;
        }
    }

    private sealed class InMemoryLeaseStore : ICacheLeaseStore
    {
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> TryRenewLeaseAsync(CachePolicyId policyId, string identity, string expectedValue, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> TryReleaseLeaseAsync(CachePolicyId policyId, string identity, string expectedValue, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
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
}

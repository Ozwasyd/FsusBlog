using System.Collections.Concurrent;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class RelatedReadingProjectionIntegrationTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task RealRedis_ColdL1L2AndNegativePathsPreserveExactFrameBytes()
    {
        string prefix = $"test:related-reading:{Guid.CreateVersion7():N}:";
        try
        {
            using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
            InitRelatedReadingTables(db);
            DateTime publishedAt = DateTime.UtcNow.AddHours(-2);
            int categoryId = db.Insertable(new Category { Name = $"related-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int tagId = db.Insertable(new Tag { Name = $"related-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int sourceId = InsertArticle(db, categoryId, "Source PostgreSQL cache", publishedAt);
            int candidateId = InsertArticle(db, categoryId, "Candidate PostgreSQL cache", publishedAt.AddMinutes(-10));
            db.Insertable(new[]
            {
                new ArticleTag { ArticleId = sourceId, TagId = tagId },
                new ArticleTag { ArticleId = candidateId, TagId = tagId }
            }).ExecuteCommand();

            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var profile = new ProfilingSession();
            connection.RegisterProfiler(() => profile);
            var commands = new ConcurrentQueue<string>();
            db.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            var encoder = new AedsEncoder();

            using RelatedReadingRuntime coldRuntime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                db,
                encoder,
                seedVersion: true);
            _ = DrainCommands(profile);
            commands.Clear();

            byte[] coldBytes;
            using (OwnedAedsFrameReadLease? cold = await coldRuntime.Service.BuildFrameAsync(sourceId))
            {
                Assert.NotNull(cold);
                coldBytes = cold.Memory.ToArray();
            }

            string projectionSql = Assert.Single(commands);
            AssertProjectionFrame(encoder, coldBytes, candidateId);
            _ = DrainCommands(profile);
            commands.Clear();

            using (OwnedAedsFrameReadLease? l1 = await coldRuntime.Service.BuildFrameAsync(sourceId))
            {
                Assert.NotNull(l1);
                Assert.Equal(coldBytes, l1.Memory.ToArray());
            }

            Assert.Empty(commands);
            Assert.Empty(DrainCommands(profile));

            using RelatedReadingRuntime l2Runtime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                db,
                encoder,
                seedVersion: false);
            commands.Clear();
            _ = DrainCommands(profile);
            using (OwnedAedsFrameReadLease? l2 = await l2Runtime.Service.BuildFrameAsync(sourceId))
            {
                Assert.NotNull(l2);
                Assert.Equal(coldBytes, l2.Memory.ToArray());
            }

            Assert.Empty(commands);
            Assert.Equal(2, DrainCommands(profile).Count(static command => command == "GET"));

            commands.Clear();
            using OwnedAedsFrameReadLease? missingCold = await coldRuntime.Service.BuildFrameAsync(int.MaxValue);
            Assert.Null(missingCold);
            Assert.Single(commands);
            _ = DrainCommands(profile);
            commands.Clear();

            using OwnedAedsFrameReadLease? missingL1 = await coldRuntime.Service.BuildFrameAsync(int.MaxValue);
            Assert.Null(missingL1);
            Assert.Empty(commands);
            Assert.Empty(DrainCommands(profile));

            string negativeIdentity = RelatedReadingService.BuildCacheIdentity(int.MaxValue, 73);
            var registry = new CachePolicyRegistry();
            Assert.True(registry.TryGet(CachePolicyId.RelatedReading, out CachePolicy relatedPolicy));
            string negativeRedisKey = string.Concat(prefix, relatedPolicy.BuildKey(negativeIdentity));
            Assert.True(await connection.GetDatabase().KeyExistsAsync(negativeRedisKey));
            RedisValue negativeValue = await connection.GetDatabase().StringGetAsync(negativeRedisKey);
            Assert.False(negativeValue.IsNull);
            Assert.Empty((byte[])negativeValue!);
            _ = DrainCommands(profile);

            using RelatedReadingRuntime negativeL2Runtime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                db,
                encoder,
                seedVersion: false);
            commands.Clear();
            _ = DrainCommands(profile);
            using OwnedAedsFrameReadLease? missingL2 = await negativeL2Runtime.Service.BuildFrameAsync(int.MaxValue);
            Assert.Null(missingL2);
            Assert.Empty(commands);
            Assert.Equal(2, DrainCommands(profile).Count(static command => command == "GET"));

            db.Ado.ExecuteCommand(
                "UPDATE article_revision SET title = 'Candidate after mutation' WHERE article_id = @ArticleId",
                new[] { new SugarParameter("@ArticleId", candidateId) });
            var httpCache = Substitute.For<IHttpCacheInvalidator>();
            var invalidation = new CacheInvalidationDispatcher(coldRuntime.Cache, coldRuntime.Cache, httpCache);
            await invalidation.InvalidateArticleMutationAsync(
                candidateId,
                $"related-reading-article-{Guid.CreateVersion7():N}",
                CancellationToken.None);
            _ = DrainCommands(profile);
            commands.Clear();
            using (OwnedAedsFrameReadLease? drifted = await coldRuntime.Service.BuildFrameAsync(sourceId))
            {
                Assert.NotNull(drifted);
                Assert.False(coldBytes.AsSpan().SequenceEqual(drifted.Memory.Span));
                var decoded = encoder.TryDecode(drifted.Memory);
                Assert.True(decoded.IsSuccess, decoded.Error.Message);
                Assert.True(PodBinaryCodec.TryDecodeRelatedReading(decoded.Value.Payload, out RelatedReadingResponse response));
                Assert.Contains(response.Related, static item => item.Title == "Candidate after mutation");
            }

            Assert.Single(commands);
            string driftedIdentity = RelatedReadingService.BuildCacheIdentity(sourceId, 74);
            string driftedRedisKey = string.Concat(prefix, relatedPolicy.BuildKey(driftedIdentity));
            Assert.True(await connection.GetDatabase().KeyExistsAsync(driftedRedisKey));
            await httpCache.Received(1).InvalidateAsync(Arg.Is<CacheTag[]>(tags => tags.Contains(CacheTag.ArticleList)));

            await invalidation.InvalidateCategoryTagAsync(
                $"related-reading-taxonomy-{Guid.CreateVersion7():N}",
                CancellationToken.None);
            Assert.Equal(
                "75",
                await coldRuntime.Cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main"));
            Assert.False(await connection.GetDatabase().KeyExistsAsync(driftedRedisKey));

            Assert.Single(projectionSql.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            using var plan = db.Ado.GetDataTable(
                $"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {projectionSql}",
                new[]
                {
                    new SugarParameter("@ArticleId", sourceId),
                    new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                    new SugarParameter("@Now", DateTime.UtcNow),
                    new SugarParameter("@CandidateWindow", 120)
                });
            Assert.NotEmpty(plan.Rows.Cast<System.Data.DataRow>());
            Assert.Contains("Plan", Convert.ToString(plan.Rows[0][0], System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RealPostgres_ColdProjectionCoversZeroOneAndOneHundredTwentyCandidatesWithDeterministicVisibility()
    {
        string prefix = $"test:related-reading-cardinality:{Guid.CreateVersion7():N}:";
        try
        {
            using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
            InitRelatedReadingTables(db);
            DateTime now = DateTime.UtcNow;
            int zeroCategory = db.Insertable(new Category { Name = $"zero-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int oneCategory = db.Insertable(new Category { Name = $"one-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int manyCategory = db.Insertable(new Category { Name = $"many-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int zeroSource = InsertArticle(db, zeroCategory, "Zero source", now.AddHours(-4));
            int oneSource = InsertArticle(db, oneCategory, "One source", now.AddHours(-3));
            int oneCandidate = InsertArticle(db, oneCategory, "One candidate", now.AddHours(-3).AddMinutes(-1));
            int manySource = InsertArticle(db, manyCategory, "PostgreSQL cache source", now.AddMinutes(-10));
            DateTime tiedPublishedAt = now.AddMinutes(-20);
            int[] visibleCandidates = Enumerable.Range(0, 120)
                .Select(index => InsertArticle(db, manyCategory, $"PostgreSQL cache candidate {index:D3}", tiedPublishedAt))
                .ToArray();
            int draftId = InsertArticle(db, manyCategory, "Hidden draft", now.AddMinutes(-5), ArticleStatus.Draft);
            int archivedId = InsertArticle(db, manyCategory, "Hidden archived", now.AddMinutes(-4), ArticleStatus.Archived);
            int deletedId = InsertArticle(db, manyCategory, "Hidden deleted", now.AddMinutes(-3), isDeleted: true);
            int scheduledId = InsertArticle(
                db,
                manyCategory,
                "Hidden scheduled",
                now.AddMinutes(-2),
                scheduledPublishAt: now.AddHours(1));
            int missingPublicationId = db.Insertable(new Article
            {
                Title = "Hidden without publication authority",
                Summary = "must not become public",
                CategoryId = manyCategory,
                CreateTime = now.AddMinutes(-1),
                PublishedAt = now.AddMinutes(-1),
                Status = ArticleStatus.Published,
                IsDeleted = false,
                CurrentPublicationId = null
            }).ExecuteReturnIdentity();
            int sharedTagId = db.Insertable(new Tag { Name = $"shared-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int sharedSourceCategory = db.Insertable(new Category { Name = $"shared-source-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int sharedCandidateCategory = db.Insertable(new Category { Name = $"shared-candidate-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int sharedSource = InsertArticle(db, sharedSourceCategory, "Published shared-tag source", now.AddHours(-6));
            int sharedCandidate = InsertArticle(db, sharedCandidateCategory, "Published shared-tag candidate", now.AddHours(-7));
            SetPublishedRevisionTags(db, sharedSource, sharedTagId);
            SetPublishedRevisionTags(db, sharedCandidate, sharedTagId);
            db.Ado.ExecuteCommand(
                "UPDATE article SET title = 'mutable draft title', categoryid = @MutableCategory WHERE id = @ArticleId",
                new[]
                {
                    new SugarParameter("@MutableCategory", zeroCategory),
                    new SugarParameter("@ArticleId", sharedCandidate)
                });
            int tieCategory = db.Insertable(new Category { Name = $"tie-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            DateTime tieTime = now.AddHours(-8);
            int tiePrevious = InsertArticle(db, tieCategory, "Tie previous", tieTime);
            int tieSource = InsertArticle(db, tieCategory, "Tie source", tieTime);
            int tieNext = InsertArticle(db, tieCategory, "Tie next", tieTime);

            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var commands = new ConcurrentQueue<string>();
            db.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            var encoder = new AedsEncoder();
            using RelatedReadingRuntime runtime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                db,
                encoder,
                seedVersion: true);

            var cases = new[]
            {
                (ArticleId: zeroSource, ExpectedCount: 0),
                (ArticleId: oneSource, ExpectedCount: 1),
                (ArticleId: manySource, ExpectedCount: 6),
                (ArticleId: sharedSource, ExpectedCount: 1),
                (ArticleId: tieSource, ExpectedCount: 2)
            };
            var decodedResponses = new Dictionary<int, FsusBlog.Shared.Contracts.Outputs.RelatedReadingResponse>();
            foreach ((int articleId, int expectedCount) in cases)
            {
                commands.Clear();
                using OwnedAedsFrameReadLease? lease = await runtime.Service.BuildFrameAsync(articleId);
                Assert.NotNull(lease);
                Assert.Single(commands);
                var decoded = encoder.TryDecode(lease.Memory);
                Assert.True(decoded.IsSuccess, decoded.Error.Message);
                Assert.True(PodBinaryCodec.TryDecodeRelatedReading(decoded.Value.Payload, out var response));
                Assert.Equal(expectedCount, response.Related.Count);
                decodedResponses[articleId] = response;
            }

            Assert.Equal(oneCandidate, Assert.Single(decodedResponses[oneSource].Related).Id);
            RelatedReadingItem shared = Assert.Single(decodedResponses[sharedSource].Related);
            Assert.Equal(sharedCandidate, shared.Id);
            Assert.Equal("Published shared-tag candidate", shared.Title);
            Assert.Contains("共同标签", shared.Reason, StringComparison.Ordinal);
            Assert.Equal(tiePrevious, decodedResponses[tieSource].Previous?.Id);
            Assert.Equal(tieNext, decodedResponses[tieSource].Next?.Id);
            int[] expectedTieBreak = visibleCandidates.OrderByDescending(static id => id).Take(6).ToArray();
            Assert.Equal(expectedTieBreak, decodedResponses[manySource].Related.Select(static item => item.Id).ToArray());
            Assert.Equal(expectedTieBreak[0], decodedResponses[manySource].Previous?.Id);
            Assert.Null(decodedResponses[manySource].Next);
            int[] hidden = [draftId, archivedId, deletedId, scheduledId, missingPublicationId];
            Assert.DoesNotContain(
                decodedResponses[manySource].Related.Select(static item => item.Id),
                hidden.Contains);
            Assert.DoesNotContain(decodedResponses[manySource].Previous?.Id ?? 0, hidden);
            Assert.DoesNotContain(decodedResponses[manySource].Next?.Id ?? 0, hidden);
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    [Fact]
    public async Task RealPostgres_OneHundredSameKeyCallsBuildOnceAndDifferentKeysProgressConcurrently()
    {
        string prefix = $"test:related-reading-singleflight:{Guid.CreateVersion7():N}:";
        try
        {
            using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
            InitRelatedReadingTables(db);
            DateTime publishedAt = DateTime.UtcNow.AddHours(-3);
            int categoryId = db.Insertable(new Category { Name = $"singleflight-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int sourceId = InsertArticle(db, categoryId, "Singleflight source", publishedAt);
            _ = InsertArticle(db, categoryId, "Singleflight candidate", publishedAt.AddMinutes(-1));

            await using ConnectionMultiplexer connection = await redis.ConnectAsync();
            var commands = new ConcurrentQueue<string>();
            db.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            using RelatedReadingRuntime runtime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                db,
                new AedsEncoder(),
                seedVersion: true);
            commands.Clear();

            Task<OwnedAedsFrameReadLease?>[] sameKeyTasks = Enumerable.Range(0, 100)
                .Select(_ => runtime.Service.BuildFrameAsync(sourceId))
                .ToArray();
            OwnedAedsFrameReadLease?[] sameKeyLeases = await Task.WhenAll(sameKeyTasks);
            try
            {
                Assert.All(sameKeyLeases, Assert.NotNull);
                Assert.Single(commands);
            }
            finally
            {
                foreach (OwnedAedsFrameReadLease? lease in sameKeyLeases)
                {
                    lease?.Dispose();
                }
            }

            int firstCategory = db.Insertable(new Category { Name = $"parallel-a-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int secondCategory = db.Insertable(new Category { Name = $"parallel-b-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
            int firstArticle = InsertArticle(db, firstCategory, "Parallel source A", publishedAt.AddMinutes(-20));
            int secondArticle = InsertArticle(db, secondCategory, "Parallel source B", publishedAt.AddMinutes(-30));
            string connectionString = db.CurrentConnectionConfig.ConnectionString;
            using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
            using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
            firstDb.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            secondDb.Aop.OnLogExecuting = (sql, _) => commands.Enqueue(sql);
            using RelatedReadingRuntime firstRuntime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                firstDb,
                new AedsEncoder(),
                seedVersion: false);
            using RelatedReadingRuntime secondRuntime = await RelatedReadingRuntime.CreateAsync(
                connection,
                prefix,
                secondDb,
                new AedsEncoder(),
                seedVersion: false);
            commands.Clear();

            Task<OwnedAedsFrameReadLease?> firstTask = firstRuntime.Service.BuildFrameAsync(firstArticle);
            Task<OwnedAedsFrameReadLease?> secondTask = secondRuntime.Service.BuildFrameAsync(secondArticle);
            OwnedAedsFrameReadLease?[] differentKeyLeases = await Task.WhenAll(firstTask, secondTask);
            try
            {
                Assert.All(differentKeyLeases, Assert.NotNull);
                Assert.Equal(2, commands.Count);
            }
            finally
            {
                foreach (OwnedAedsFrameReadLease? lease in differentKeyLeases)
                {
                    lease?.Dispose();
                }
            }
        }
        finally
        {
            await redis.DeleteNamespaceAsync(prefix);
        }
    }

    private static void AssertProjectionFrame(AedsEncoder encoder, byte[] frame, int expectedCandidateId)
    {
        var decoded = encoder.TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ArticleRelatedReading, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeRelatedReading(decoded.Value.Payload, out var response));
        Assert.Contains(response.Related, item => item.Id == expectedCandidateId);
    }

    private static string[] DrainCommands(ProfilingSession profile)
        => profile.FinishProfiling().Select(static command => command.Command).ToArray();

    private static void InitRelatedReadingTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleTag),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord));

    private static void SetPublishedRevisionTags(SqlSugarClient db, int articleId, params int[] tagIds)
        => db.Ado.ExecuteCommand(
            "UPDATE article_revision SET tag_ids = @TagIds WHERE article_id = @ArticleId",
            new[]
            {
                new SugarParameter("@TagIds", string.Join(',', tagIds)),
                new SugarParameter("@ArticleId", articleId)
            });

    private static int InsertArticle(
        SqlSugarClient db,
        int categoryId,
        string title,
        DateTime publishedAt,
        ArticleStatus status = ArticleStatus.Published,
        bool isDeleted = false,
        DateTime? scheduledPublishAt = null)
    {
        int articleId = db.Insertable(new Article
        {
            Title = title,
            Summary = "PostgreSQL cache projection",
            CategoryId = categoryId,
            Views = 1,
            CreateTime = publishedAt,
            PublishedAt = publishedAt,
            ScheduledPublishAt = scheduledPublishAt,
            Status = status,
            IsDeleted = isDeleted
        }).ExecuteReturnIdentity();
        long revisionId = db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = title,
            Summary = "PostgreSQL cache projection",
            CategoryId = categoryId,
            TagIds = string.Empty,
            ContentBlockId = 0,
            CreatedByAdminPrincipalId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "publish",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        db.Ado.ExecuteCommand(
            "UPDATE article SET current_revision_id = @RevisionId, current_publication_id = @PublicationId WHERE id = @ArticleId",
            new[]
            {
                new SugarParameter("@RevisionId", revisionId),
                new SugarParameter("@PublicationId", publicationId),
                new SugarParameter("@ArticleId", articleId)
            });
        return articleId;
    }

    private sealed class RelatedReadingRuntime : IDisposable
    {
        private readonly CacheSingleFlightCoordinator _singleFlight;

        private RelatedReadingRuntime(
            UnifiedCache cache,
            CacheSingleFlightCoordinator singleFlight,
            RelatedReadingService service)
        {
            Cache = cache;
            _singleFlight = singleFlight;
            Service = service;
        }

        public UnifiedCache Cache
        {
            get;
        }

        public RelatedReadingService Service
        {
            get;
        }

        public static async Task<RelatedReadingRuntime> CreateAsync(
            IConnectionMultiplexer connection,
            string prefix,
            ISqlSugarClient db,
            AedsEncoder encoder,
            bool seedVersion)
        {
            var policies = new CachePolicyRegistry();
            var scope = new PrefixRuntimeKeyScope(prefix);
            var cache = new UnifiedCache(connection, policies, scope, NullLogger<UnifiedCache>.Instance);
            if (seedVersion)
            {
                await cache.SetStringAsync(CachePolicyId.ArticleListVersion, "main", "73");
            }

            var resolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
            var singleFlight = new CacheSingleFlightCoordinator(resolver);
            var coordinator = new CacheMissCoordinator(
                singleFlight,
                cache,
                policies,
                NullLogger<CacheMissCoordinator>.Instance);
            var service = new RelatedReadingService(db, cache, coordinator, cache, cache, encoder);
            return new RelatedReadingRuntime(cache, singleFlight, service);
        }

        public void Dispose()
        {
            Cache.Dispose();
            _singleFlight.Dispose();
        }
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string ScopeToken => prefix;

        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}

using FsusBlog.Core.Algorithms;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleMutationVersionedOutboxIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ExpandMigration_BackfillsLegacyCoordinatesOnPostgresAndIsIdempotent()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE article_mutation_outbox (
                id bigint PRIMARY KEY,
                aggregate_id integer NOT NULL,
                article_revision_id bigint NULL,
                revision_no integer NULL,
                responsibility_snapshot_id bigint NULL,
                article_publication_id bigint NULL
            );
            CREATE TABLE article_publication (
                id bigint PRIMARY KEY,
                rights_snapshot_id bigint NOT NULL,
                responsibility_snapshot_id bigint NULL
            );
            CREATE TABLE article_responsibility_snapshot (
                id bigint PRIMARY KEY,
                responsibility_version integer NOT NULL
            );
            INSERT INTO article_publication(id, rights_snapshot_id, responsibility_snapshot_id)
            VALUES (401, 201, 301);
            INSERT INTO article_responsibility_snapshot(id, responsibility_version)
            VALUES (301, 7);
            INSERT INTO article_mutation_outbox(
                id, aggregate_id, article_revision_id, revision_no,
                responsibility_snapshot_id, article_publication_id)
            VALUES (1, 1215, 101, 1, NULL, 401);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        ISchemaMigrationDescriptor migration = ArticleMutationOutboxVersionMigrationDefinitions.BuildMigration();

        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }

        Assert.Equal(1, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT schema_version FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(201, await fixture.QueryScalarAsync<long>(
            connectionString,
            "SELECT rights_snapshot_id FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(301, await fixture.QueryScalarAsync<long>(
            connectionString,
            "SELECT responsibility_snapshot_id FROM article_mutation_outbox WHERE id = 1;"));
        Assert.Equal(7, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT responsibility_version FROM article_mutation_outbox WHERE id = 1;"));
        Assert.True(await fixture.IndexExistsAsync(
            connectionString,
            "idx_article_mutation_outbox_version_coordinate"));
    }

    [Fact]
    public async Task ContinuousUpdates_OutOfOrderReplayUsesPersistedPostgresCoordinates()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE article (
                id integer PRIMARY KEY,
                current_revision_id bigint NULL,
                current_publication_id bigint NULL
            );
            CREATE TABLE article_revision (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                revision_no integer NOT NULL
            );
            CREATE TABLE article_rights_snapshot (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                article_revision_id bigint NOT NULL
            );
            CREATE TABLE article_responsibility_snapshot (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                article_revision_id bigint NOT NULL,
                responsibility_version integer NOT NULL
            );
            CREATE TABLE article_publication (
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                publication_no integer NOT NULL,
                article_revision_id bigint NOT NULL,
                revision_no integer NOT NULL,
                rights_snapshot_id bigint NOT NULL,
                responsibility_snapshot_id bigint NULL
            );

            INSERT INTO article_revision(id, article_id, revision_no)
            VALUES (101, 1215, 1), (102, 1215, 2);
            INSERT INTO article_rights_snapshot(id, article_id, article_revision_id)
            VALUES (201, 1215, 101), (202, 1215, 102);
            INSERT INTO article_responsibility_snapshot(
                id, article_id, article_revision_id, responsibility_version)
            VALUES (301, 1215, 101, 1), (302, 1215, 102, 2);
            INSERT INTO article_publication(
                id, article_id, publication_no, article_revision_id, revision_no,
                rights_snapshot_id, responsibility_snapshot_id)
            VALUES
                (401, 1215, 1, 101, 1, 201, 301),
                (402, 1215, 2, 102, 2, 202, 302);
            INSERT INTO article(id, current_revision_id, current_publication_id)
            VALUES (1215, 102, 402);
            """);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);

        ArticleMutationVersionDisposition oldDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            Envelope(101, 1, 201, 301, 1, 401, 1),
            CancellationToken.None);
        ArticleMutationVersionDisposition currentDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            Envelope(102, 2, 202, 302, 2, 402, 2),
            CancellationToken.None);

        Assert.Equal(ArticleMutationVersionDispositionKind.Skip, oldDisposition.Kind);
        Assert.Equal("superseded-by-release:402", oldDisposition.Reason);
        Assert.Equal(ArticleMutationVersionDispositionKind.Process, currentDisposition.Kind);
        Assert.Null(currentDisposition.Reason);
    }

    [Fact]
    public async Task CoordinatorBarrier_NewReleaseCommittedInsideSearchSkipsRemainingConsumers()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticlePublicationRecord),
            typeof(Category));

        var revisionOne = new ArticleRevision
        {
            ArticleId = 1215,
            RevisionNo = 1,
            Title = "v1",
            Summary = "v1",
            MarkdownContent = "v1"
        };
        revisionOne.Id = await db.Insertable(revisionOne).ExecuteReturnBigIdentityAsync();
        var revisionTwo = new ArticleRevision
        {
            ArticleId = 1215,
            RevisionNo = 2,
            Title = "v2",
            Summary = "v2",
            MarkdownContent = "v2"
        };
        revisionTwo.Id = await db.Insertable(revisionTwo).ExecuteReturnBigIdentityAsync();
        var releaseOne = new ArticlePublicationRecord
        {
            ArticleId = 1215,
            PublicationNo = 1,
            ArticleRevisionId = revisionOne.Id,
            RevisionNo = 1,
            PublishedAt = DateTime.UtcNow.AddMinutes(-2)
        };
        releaseOne.Id = await db.Insertable(releaseOne).ExecuteReturnBigIdentityAsync();
        var releaseTwo = new ArticlePublicationRecord
        {
            ArticleId = 1215,
            PublicationNo = 2,
            ArticleRevisionId = revisionTwo.Id,
            RevisionNo = 2,
            PublishedAt = DateTime.UtcNow.AddMinutes(-1)
        };
        releaseTwo.Id = await db.Insertable(releaseTwo).ExecuteReturnBigIdentityAsync();
        await db.Insertable(new Article
        {
            Id = 1215,
            Title = "current",
            Content = "current",
            Status = ArticleStatus.Published,
            CurrentRevisionId = revisionOne.Id,
            CurrentPublicationId = releaseOne.Id,
            PublishedAt = releaseOne.PublishedAt,
            CreateTime = DateTime.UtcNow.AddDays(-1)
        }).ExecuteCommandAsync();
        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET id = 1215, current_revision_id = @RevisionId, current_publication_id = @PublicationId;",
            new SugarParameter("@RevisionId", revisionOne.Id),
            new SugarParameter("@PublicationId", releaseOne.Id));
        await db.Insertable(new ArticleBody
        {
            ArticleId = 1215,
            MarkdownContent = "v1",
            UpdatedAt = DateTime.UtcNow.AddMinutes(-2)
        }).ExecuteCommandAsync();

        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var hotQueue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }),
            new InMemoryPublicHotArtifactDeliveryStateStore());
        var projections = new ArticleMutationProjectionInvalidator(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<ITaxonomyCountProjectionService>(),
            Substitute.For<IArticleDetailAedsArtifactProjector>(),
            Substitute.For<IPublicArtifactRevocationCoordinator>(),
            hotQueue,
            NullLogger<ArticleMutationProjectionInvalidator>.Instance);
        string searchRoot = Path.Combine(Path.GetTempPath(), $"fsus-search-race-{Guid.NewGuid():N}");
        Directory.CreateDirectory(searchRoot);
        var searchServices = new ServiceCollection();
        searchServices.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
        await using ServiceProvider searchProvider = searchServices.BuildServiceProvider();
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.WebRootPath.Returns(searchRoot);
        environment.ContentRootPath.Returns(searchRoot);
        var realSearch = new SearchIndexService(
            searchProvider.GetRequiredService<IServiceScopeFactory>(),
            environment,
            new ConfigurationBuilder().Build(),
            Substitute.For<INotificationStreamPublisher>(),
            Substitute.For<ICacheCounterStore>(),
            new ArticleBodyRepairQueue(),
            NullLogger<SearchIndexService>.Instance);
        ISearchIndexService search = Substitute.For<ISearchIndexService>();
        search.AddOrUpdateVersionedIndexAsync(
                Arg.Any<Article>(),
                Arg.Any<ArticleMutationVersionReference>(),
                Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                ArticleMutationVersionReference coordinate = call.ArgAt<ArticleMutationVersionReference>(1);
                Assert.Equal(releaseOne.Id, coordinate.ReleaseId);
                await db.Ado.ExecuteCommandAsync(
                    "UPDATE article SET current_revision_id = @RevisionId, current_publication_id = @PublicationId WHERE id = 1215;",
                    new SugarParameter("@RevisionId", revisionTwo.Id),
                    new SugarParameter("@PublicationId", releaseTwo.Id));
                ArticleMutationSupersededException superseded = await Assert.ThrowsAsync<ArticleMutationSupersededException>(
                    () => realSearch.AddOrUpdateVersionedIndexAsync(
                        call.ArgAt<Article>(0),
                        coordinate,
                        call.ArgAt<CancellationToken>(2)));
                Assert.Equal($"superseded-by-release:{releaseTwo.Id}", superseded.Reason);
                throw superseded;
            });
        IMessageRealtimePublisher publisher = Substitute.For<IMessageRealtimePublisher>();
        var coordinator = new ArticleMutationSideEffectCoordinator(
            db,
            Substitute.For<IArticlePublicMutationFence>(),
            projections,
            new ArticleMutationDelivery(search, publisher, Substitute.For<IIntegrityProofScheduler>()),
            new ArticleAssetCleanupPolicy(new ArticleAssetCleanupQueue()),
            NullLogger<ArticleMutationSideEffectCoordinator>.Instance);
        var alreadyCompleted = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.PublicAotInvalidation,
            ArticleMutationReplayEdges.HttpCacheInvalidation,
            ArticleMutationReplayEdges.PublicArtifactRevocation
        };

        ArticleMutationReplayResult result = await coordinator.ReplayOutboxAsync(
            1215,
            ArticleMutationEventTypes.Updated,
            "barrier-v1",
            new ArticleMutationVersionReference(revisionOne.Id, 1, releaseOne.Id, 1),
            alreadyCompleted,
            CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.DoesNotContain(ArticleMutationReplayEdges.SearchProjection, result.CompletedEdges);
        Assert.Contains(ArticleMutationReplayEdges.SearchProjection, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.TaxonomyProjection, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.ArticleDetailAeds, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.PublicHotRead, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.Notification, result.SkippedEdges);
        Assert.All(result.SkippedEdges, edge =>
            Assert.Equal($"superseded-by-release:{releaseTwo.Id}", result.SkippedEdgeReasons[edge]));
        Assert.False(hotQueue.Reader.TryRead(out _));
        Assert.Empty(Directory.EnumerateFiles(searchRoot, "*", SearchOption.AllDirectories));
        await publisher.DidNotReceiveWithAnyArgs().PushArticleChangedAsync(default, default);

        var hotProjector = new PublicHotArtifactProjector(
            db,
            Substitute.For<IAedsEncoder>(),
            new DbConcurrencyGate(
                new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Database:PublicArticleProjection:MaxPoolSize"] = "2"
                }).Build(),
                NullLogger<DbConcurrencyGate>.Instance),
            Options.Create(new PublicHotReadOptions()),
            new ArticleBodyRepairQueue(),
            Substitute.For<IArticleListCursorCodec>(),
            TimeProvider.System,
            NullLogger<PublicHotArtifactProjector>.Instance);
        PublicHotReadSnapshot currentSnapshot = PublicHotReadSnapshot.Empty;
        PublicHotReadSnapshot staleResult = await hotProjector.RebuildAfterArticleMutationAsync(
            currentSnapshot,
            1215,
            releaseOne.Id,
            CancellationToken.None);
        Assert.Same(currentSnapshot, staleResult);
    }

    [Fact]
    public async Task Dispatcher_SkipsOlderE1BeforeLegacyCurrentE2AndRestartDoesNotDuplicate()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleTag),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ArticleRightsSnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationOutboxEdge));

        var revisions = new[]
        {
            new ArticleRevision { ArticleId = 1215, RevisionNo = 1, Title = "v1", MarkdownContent = "v1" },
            new ArticleRevision { ArticleId = 1215, RevisionNo = 2, Title = "v2", MarkdownContent = "v2" }
        };
        foreach (ArticleRevision revision in revisions)
        {
            revision.Id = await db.Insertable(revision).ExecuteReturnBigIdentityAsync();
        }
        var rights = new[]
        {
            new ArticleRightsSnapshot { ArticleId = 1215, ArticleRevisionId = revisions[0].Id, RevisionNo = 1 },
            new ArticleRightsSnapshot { ArticleId = 1215, ArticleRevisionId = revisions[1].Id, RevisionNo = 2 }
        };
        foreach (ArticleRightsSnapshot snapshot in rights)
        {
            snapshot.Id = await db.Insertable(snapshot).ExecuteReturnBigIdentityAsync();
        }
        var releases = new[]
        {
            new ArticlePublicationRecord { ArticleId = 1215, PublicationNo = 1, ArticleRevisionId = revisions[0].Id, RevisionNo = 1, RightsSnapshotId = rights[0].Id, TransitionKind = "updated" },
            new ArticlePublicationRecord { ArticleId = 1215, PublicationNo = 2, ArticleRevisionId = revisions[1].Id, RevisionNo = 2, RightsSnapshotId = rights[1].Id, TransitionKind = "updated" }
        };
        foreach (ArticlePublicationRecord release in releases)
        {
            release.Id = await db.Insertable(release).ExecuteReturnBigIdentityAsync();
        }
        await db.Insertable(new Article
        {
            Id = 1215,
            Title = "v2",
            Content = "v2",
            Status = ArticleStatus.Published,
            CurrentRevisionId = revisions[1].Id,
            CurrentPublicationId = releases[1].Id
        }).ExecuteCommandAsync();
        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET id = 1215, current_revision_id = @RevisionId, current_publication_id = @PublicationId;",
            new SugarParameter("@RevisionId", revisions[1].Id),
            new SugarParameter("@PublicationId", releases[1].Id));

        DateTime due = DateTime.UtcNow.AddMinutes(-1);
        ArticleMutationOutboxEvent eventOne = ArticleMutationOutboxProducer.Create(
            1215,
            ArticleMutationEventTypes.Updated,
            new ArticleVersionCoordinates(revisions[0].Id, 1, rights[0].Id, null, releases[0].Id, 1),
            null,
            null,
            due);
        var eventTwo = new ArticleMutationOutboxEvent
        {
            EventId = "legacy-current-e2",
            AggregateId = 1215,
            SchemaVersion = 1,
            ArticleRevisionId = revisions[1].Id,
            RevisionNo = 2,
            RightsSnapshotId = rights[1].Id,
            ArticlePublicationId = releases[1].Id,
            PublicationNo = 2,
            EventType = ArticleMutationEventTypes.Updated,
            PayloadJson = $$"""
                {
                  "articleId": 1215,
                  "eventType": "updated",
                  "articleRevisionId": {{revisions[1].Id}},
                  "revisionNo": 2,
                  "articlePublicationId": {{releases[1].Id}},
                  "publicationNo": 2,
                  "rightsSnapshotId": {{rights[1].Id}}
                }
                """,
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = due.AddSeconds(1),
            CreatedAt = due.AddSeconds(1)
        };
        eventOne.Id = await db.Insertable(eventOne).ExecuteReturnBigIdentityAsync();
        eventTwo.Id = await db.Insertable(eventTwo).ExecuteReturnBigIdentityAsync();
        ArticleMutationOutboxEnvelope eventOneEnvelope = ArticleMutationOutboxEnvelopeCodec.Read(eventOne);
        long? currentReleaseId = await db.Queryable<Article>()
            .ClearFilter()
            .Where(article => article.Id == 1215)
            .Select(article => article.CurrentPublicationId)
            .FirstAsync();
        Assert.Equal(releases[0].Id, eventOneEnvelope.Version.ReleaseId);
        Assert.Equal(releases[1].Id, currentReleaseId);
        ArticleMutationVersionDisposition eventOneDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            eventOneEnvelope,
            CancellationToken.None);
        ArticleMutationVersionDisposition eventTwoDisposition = await ArticleMutationOutboxVersionGuard.EvaluateAsync(
            db,
            ArticleMutationOutboxEnvelopeCodec.Read(eventTwo),
            CancellationToken.None);
        Assert.Equal(ArticleMutationVersionDispositionKind.Skip, eventOneDisposition.Kind);
        Assert.Equal($"superseded-by-release:{releases[1].Id}", eventOneDisposition.Reason);
        Assert.Equal(ArticleMutationVersionDispositionKind.Process, eventTwoDisposition.Kind);

        IReadOnlySet<string> coordinatorEdges = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.SearchProjection,
            ArticleMutationReplayEdges.ArticleDetailAeds,
            ArticleMutationReplayEdges.TaxonomyProjection,
            ArticleMutationReplayEdges.PublicArtifactRevocation,
            ArticleMutationReplayEdges.PublicHotRead
        };
        var coordinator = Substitute.For<IArticleMutationSideEffectCoordinator>();
        coordinator.ReplayOutboxAsync(
                Arg.Any<int>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<ArticleMutationVersionReference>(),
                Arg.Any<IReadOnlySet<string>>(),
                Arg.Any<CancellationToken>())
            .Returns(ArticleMutationReplayResult.Success(coordinatorEdges));
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] = connectionString,
                ["Database:PublicArticleProjection:MaxPoolSize"] = "2"
            }).Build();
        ICacheInvalidationDispatcher cacheInvalidation = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAotInvalidation = Substitute.For<IPublicAotInvalidationService>();
        ServiceProvider BuildProvider()
        {
            var services = new ServiceCollection();
            services.AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString));
            services.AddScoped<IDbConcurrencyGate>(_ => new DbConcurrencyGate(configuration, NullLogger<DbConcurrencyGate>.Instance));
            services.AddScoped(_ => cacheInvalidation);
            services.AddScoped(_ => publicAotInvalidation);
            services.AddScoped(_ => coordinator);
            return services.BuildServiceProvider();
        }
        ArticleMutationOutboxDispatcher CreateDispatcher(ServiceProvider provider) => new(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<ArticleMutationOutboxDispatcher>.Instance,
            TimeProvider.System,
            Substitute.For<IBackgroundWorkerLease>(),
            Substitute.For<IActiveReleaseTransactionalCommitGuard>());

        await using (ServiceProvider provider = BuildProvider())
        {
            int processed = await CreateDispatcher(provider).ProcessPendingAsync(CancellationToken.None);
            List<ArticleMutationOutboxEvent> observed = await db.Queryable<ArticleMutationOutboxEvent>()
                .OrderBy(item => item.Id, OrderByType.Asc)
                .ToListAsync();
            Assert.True(
                processed == 2,
                string.Join(
                    "; ",
                    observed.Select(item => $"{item.EventId}:{item.Status}:{item.RetryCount}:{item.LastError}")));
        }
        await coordinator.Received(1).ReplayOutboxAsync(
            1215,
            ArticleMutationEventTypes.Updated,
            eventTwo.EventId,
            Arg.Any<ArticleMutationVersionReference>(),
            Arg.Any<IReadOnlySet<string>>(),
            Arg.Any<CancellationToken>());
        await coordinator.DidNotReceive().ReplayOutboxAsync(
            1215,
            ArticleMutationEventTypes.Updated,
            eventOne.EventId,
            Arg.Any<ArticleMutationVersionReference>(),
            Arg.Any<IReadOnlySet<string>>(),
            Arg.Any<CancellationToken>());
        await cacheInvalidation.Received(1).InvalidateArticleMutationAsync(
            1215,
            eventTwo.EventId,
            Arg.Any<CancellationToken>());
        await publicAotInvalidation.Received(1).InvalidateArticleMutationAsync(
            1215,
            Arg.Any<IEnumerable<int>>(),
            Arg.Any<IEnumerable<int>>(),
            eventTwo.EventId,
            Arg.Any<CancellationToken>());
        List<ArticleMutationOutboxEdge> oldEdges = await db.Queryable<ArticleMutationOutboxEdge>()
            .Where(edge => edge.OutboxEventId == eventOne.Id)
            .ToListAsync();
        Assert.NotEmpty(oldEdges);
        Assert.All(oldEdges, edge =>
        {
            Assert.Equal(ArticleMutationOutboxEdgeStatus.Skipped, edge.Status);
            Assert.Equal($"superseded-by-release:{releases[1].Id}", edge.LastError);
        });

        await using (ServiceProvider restartedProvider = BuildProvider())
        {
            Assert.Equal(0, await CreateDispatcher(restartedProvider).ProcessPendingAsync(CancellationToken.None));
        }
        await coordinator.Received(1).ReplayOutboxAsync(
            1215,
            ArticleMutationEventTypes.Updated,
            eventTwo.EventId,
            Arg.Any<ArticleMutationVersionReference>(),
            Arg.Any<IReadOnlySet<string>>(),
            Arg.Any<CancellationToken>());
        await cacheInvalidation.Received(1).InvalidateArticleMutationAsync(
            1215,
            eventTwo.EventId,
            Arg.Any<CancellationToken>());
        await publicAotInvalidation.Received(1).InvalidateArticleMutationAsync(
            1215,
            Arg.Any<IEnumerable<int>>(),
            Arg.Any<IEnumerable<int>>(),
            eventTwo.EventId,
            Arg.Any<CancellationToken>());
    }

    private static ArticleMutationOutboxEnvelope Envelope(
        long revisionId,
        int revisionNo,
        long rightsSnapshotId,
        long responsibilitySnapshotId,
        int responsibilityVersion,
        long releaseId,
        int releaseNo)
        => new(
            ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            $"event-{releaseId}",
            1215,
            ArticleMutationEventTypes.Updated,
            new ArticleMutationVersionReference(
                revisionId,
                revisionNo,
                releaseId,
                releaseNo,
                responsibilitySnapshotId,
                rightsSnapshotId,
                responsibilityVersion),
            new ArticleMutationScopeChange(null, null),
            new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc));
}

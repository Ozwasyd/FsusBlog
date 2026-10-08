using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

using Comment = FsusBlog.Server.Entities.Comment;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleDestructiveMutationBehaviorTests(
    PostgresSchemaMigrationFixture fixture,
    ArticleDestructiveMutationDatabaseFixture classDatabase)
    : IClassFixture<ArticleDestructiveMutationDatabaseFixture>, IAsyncLifetime
{
    [Fact]
    public async Task DeleteAndRestore_EnforceStateMachineAndRestoreToDraft()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        SeedTaxonomy(db);
        int articleId = SeedArticle(db, isDeleted: false, status: ArticleStatus.Published);
        ArticleService service = CreateService(db);

        Assert.False(await service.RestoreAsync(articleId));
        Assert.True(await service.DeleteAsync(articleId));
        Assert.False(await service.DeleteAsync(articleId));

        Article deleted = LoadArticle(db, articleId);
        Assert.True(deleted.IsDeleted);
        Assert.Equal(ArticleStatus.Deleted, deleted.Status);
        Assert.NotNull(deleted.DeletedAt);

        Assert.True(await service.RestoreAsync(articleId));
        Assert.False(await service.RestoreAsync(articleId));

        // Restore uses a raw optimistic-concurrency UPDATE. Read through a fresh
        // SqlSugar context so the assertion observes the committed row rather
        // than the entity instance cached by the earlier deleted-state read.
        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Article restored = LoadArticle(assertDb, articleId);
        Assert.False(restored.IsDeleted);
        // Restore republishes through the publication transition writer and
        // returns the article to a public published coordinate set.
        Assert.Equal(ArticleStatus.Published, restored.Status);
        Assert.Null(restored.DeletedAt);
        Assert.NotNull(restored.PublishedAt);
    }

    [Fact]
    public async Task DeleteAsync_AdvancesOnlySitemapCoordinateAndKeepsTargetedAotEdge()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        SeedTaxonomy(db);
        int articleId = SeedArticle(db, isDeleted: false, status: ArticleStatus.Published);
        var authority = new InMemoryPublicAotInvalidationGenerationAuthority();
        var tracker = new PublicAotInvalidationTracker(authority);
        var publisher = Substitute.For<IDistributedInvalidationPublisher>();
        DistributedInvalidationRequest? observed = null;
        bool identityBoundAtPublish = false;
        publisher.PublishAsync(Arg.Any<DistributedInvalidationRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                observed = call.Arg<DistributedInvalidationRequest>();
                identityBoundAtPublish = string.Equals(
                    authority.Current.LastMutationId,
                    observed.EventId,
                    StringComparison.Ordinal);
                return new DistributedInvalidationPublishResult(
                    DistributedInvalidationPublishStatus.LocalOnly,
                    observed.EventId,
                    null);
            });
        var cache = Substitute.For<IUnifiedCache>();
        var dispatcher = new CacheInvalidationDispatcher(
            cache,
            cache,
            Substitute.For<IHttpCacheInvalidator>(),
            distributedInvalidationPublisher: publisher,
            publicAotInvalidationTracker: tracker);
        var publicAot = Substitute.For<IPublicAotInvalidationService>();
        ArticleService service = CreateService(
            db,
            publicAotInvalidation: publicAot,
            cacheInvalidation: dispatcher);

        Assert.True(await service.DeleteAsync(articleId));

        Assert.True(LoadArticle(db, articleId).IsDeleted);
        Assert.Equal(1, tracker.GetSitemapGeneration());
        Assert.DoesNotContain(
            PublicAotInvalidationGenerationStateCodec.AllCoordinate,
            authority.Current.KeyGenerations.Keys);
        Assert.Contains(
            PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
            authority.Current.KeyGenerations.Keys);
        Assert.True(identityBoundAtPublish);
        Assert.Equal(DistributedInvalidationEventKinds.ArticleMutation, observed?.Kind);
        NSubstitute.Core.ICall targetedAot = Assert.Single(
            publicAot.ReceivedCalls(),
            call => string.Equals(
                call.GetMethodInfo().Name,
                nameof(IPublicAotInvalidationService.InvalidateArticleMutationAsync),
                StringComparison.Ordinal));
        Assert.Equal(articleId, targetedAot.GetArguments()[0]);
        await publicAot.DidNotReceive().InvalidateAllAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task DeleteAsync_StaleRowVersionFailsWithoutChangingArticleState()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        SeedTaxonomy(setupDb);
        int articleId = SeedArticle(setupDb, isDeleted: false, status: ArticleStatus.Published);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction concurrentUpdate = await holder.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand(
            "UPDATE article SET views = views + 1 WHERE id = @ArticleId;",
            holder,
            concurrentUpdate))
        {
            command.Parameters.AddWithValue("@ArticleId", articleId);
            Assert.Equal(1, await command.ExecuteNonQueryAsync());
        }

        await RealConcurrencyHarness.RunInterleavedAsync(
            () => service.DeleteAsync(articleId),
            async deleteTask =>
            {
                await Task.Delay(TimeSpan.FromMilliseconds(250));
                Assert.False(deleteTask.IsCompleted);
                await concurrentUpdate.CommitAsync();

                bool deleted = await deleteTask.WaitAsync(TimeSpan.FromSeconds(10));
                Article article = LoadArticle(setupDb, articleId);
                Assert.False(deleted);
                Assert.False(article.IsDeleted);
                Assert.Equal(ArticleStatus.Published, article.Status);
                Assert.Equal(1, article.Views);
            },
            async () => await concurrentUpdate.DisposeAsync());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-delete-async-establishes-fence-before-delete-and-fails-closed-when-fence-is-unavailable")]
    public async Task DeleteAsync_EstablishesFenceBeforeDeleteAndFailsClosedWhenFenceIsUnavailable()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        SeedTaxonomy(setupDb);
        int articleId = SeedArticle(setupDb, isDeleted: false, status: ArticleStatus.Published);
        var mutationFence = Substitute.For<IArticlePublicMutationFence>();
        mutationFence
            .BeginPublicMutationFenceAsync(articleId, Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Article beforeCommit = LoadArticle(setupDb, articleId);
                Assert.False(beforeCommit.IsDeleted);
                Assert.Equal(ArticleStatus.Published, beforeCommit.Status);
                return Task.FromException(new InvalidOperationException("revocation unavailable"));
            });
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb, mutationFence);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.DeleteAsync(articleId));

        Assert.Equal("revocation unavailable", error.Message);
        Article afterFailure = LoadArticle(setupDb, articleId);
        Assert.False(afterFailure.IsDeleted);
        Assert.Equal(ArticleStatus.Published, afterFailure.Status);
        Assert.Empty(setupDb.Queryable<ArticleMutationOutboxEvent>().ToList());
        await mutationFence.DidNotReceive()
            .RecoverAbortedPublicMutationFenceAsync(
                articleId,
                Arg.Any<string>(),
                Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task DeleteAsync_ConcurrentWritersAllowExactlyOneStateTransition()
    {
        string connectionString = classDatabase.ConnectionString;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            SeedTaxonomy(setupDb);
            SeedArticle(setupDb, isDeleted: false, status: ArticleStatus.Published, id: 42);
        }
        using var barrier = new Barrier(2);

        bool[] results = await RealConcurrencyHarness.RunAsync(
            () => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateService(db).DeleteAsync(42);
            }),
            () => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateService(db).DeleteAsync(42);
            })).WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Article article = LoadArticle(assertDb, 42);
        Assert.Equal(1, results.Count(static result => result));
        Assert.Equal(1, results.Count(static result => !result));
        Assert.True(article.IsDeleted);
        Assert.Equal(ArticleStatus.Deleted, article.Status);
        Assert.Equal(1, assertDb.Queryable<ArticleMutationOutboxEvent>().Count());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-permanent-delete-and-clear-trash-never-remove-active-articles")]
    public async Task PermanentDeleteAndClearTrash_NeverRemoveActiveArticles()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        SeedTaxonomy(db);
        int activeId = SeedArticle(db, isDeleted: false, status: ArticleStatus.Draft, id: 41);
        int permanentId = SeedArticle(db, isDeleted: true, status: ArticleStatus.Deleted, id: 42);
        int clearTrashId = SeedArticle(db, isDeleted: true, status: ArticleStatus.Deleted, id: 43);
        ArticleService service = CreateService(db);

        Assert.False(await service.PermanentlyDeleteArticleAsync(activeId));
        Assert.True(await service.PermanentlyDeleteArticleAsync(permanentId));
        int cleared = await service.ClearTrashAsync();

        Assert.Equal(1, cleared);
        Assert.NotNull(db.Queryable<Article>().ClearFilter().InSingle(activeId));
        Assert.Null(db.Queryable<Article>().ClearFilter().InSingle(permanentId));
        Assert.Null(db.Queryable<Article>().ClearFilter().InSingle(clearTrashId));
        Assert.Equal(0, db.Queryable<ArticleBody>()
            .Where(body => body.ArticleId == permanentId || body.ArticleId == clearTrashId)
            .Count());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task PermanentlyDeleteArticleAsync_ConcurrentWritersAllowExactlyOneRemoval()
    {
        string connectionString = classDatabase.ConnectionString;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            SeedTaxonomy(setupDb);
            SeedArticle(setupDb, isDeleted: true, status: ArticleStatus.Deleted, id: 42);
        }
        using var barrier = new Barrier(2);

        bool[] results = await RealConcurrencyHarness.RunAsync(
            () => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateService(db).PermanentlyDeleteArticleAsync(42);
            }),
            () => StartBarrierTaskAsync(barrier, async () =>
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                return await CreateService(db).PermanentlyDeleteArticleAsync(42);
            })).WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Single(results, static result => result);
        Assert.Single(results, static result => !result);
        Assert.Null(assertDb.Queryable<Article>().ClearFilter().InSingle(42));
        Assert.Null(assertDb.Queryable<ArticleBody>().InSingle(42));
        ArticleMutationOutboxEvent outbox = Assert.Single(assertDb.Queryable<ArticleMutationOutboxEvent>().ToList());
        Assert.Equal("permanently-deleted", outbox.EventType);
        Assert.Equal(42, outbox.AggregateId);
    }

    private static Article LoadArticle(SqlSugarClient db, int articleId)
        => db.Queryable<Article>().ClearFilter().InSingle(articleId)
            ?? throw new InvalidOperationException($"Article {articleId} was not found.");

    public async Task InitializeAsync()
        => _ = await classDatabase.ResetAsync(fixture);

    public Task DisposeAsync() => Task.CompletedTask;

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(AdminPrincipal),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag),
            typeof(Comment),
            typeof(ArticleDraft),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand),
            typeof(ArticleViewSeed),
            typeof(ContentAsset),
            typeof(ArticlePublicTaxonomyProjection));
        foreach (var step in ArticleCanvasLinkMigrationDefinitions.BuildMigration().Steps)
        {
            step.ExecuteAsync(db, CancellationToken.None).GetAwaiter().GetResult();
        }
        // Deletion kernel targets additional projection tables that are not always
        // modelled as SqlSugar entities; keep empty shells so DELETE stays valid.
        db.Ado.ExecuteCommand(
            """
            CREATE TABLE IF NOT EXISTS asset_library_article_ref (
                article_id integer NOT NULL,
                asset_url text NOT NULL,
                PRIMARY KEY (article_id, asset_url)
            );
            CREATE TABLE IF NOT EXISTS public_article_projection (
                article_id integer PRIMARY KEY
            );
            """);
    }

    private static void SeedTaxonomy(SqlSugarClient db)
    {
        db.Insertable(new Category { Id = 1, Name = "Category 1" }).ExecuteCommand();
        db.Insertable(new Tag { Id = 1, Name = "Tag 1" }).ExecuteCommand();
    }

    private static int SeedArticle(
        SqlSugarClient db,
        bool isDeleted,
        ArticleStatus status,
        int? id = null)
    {
        var article = new Article
        {
            Id = id ?? 0,
            Title = $"Article {id?.ToString() ?? "generated"}",
            Summary = "summary",
            CategoryId = 1,
            Status = status,
            IsDeleted = isDeleted,
            DeletedAt = isDeleted ? DateTime.UtcNow : null,
            CreateTime = DateTime.UtcNow.AddMinutes(-2),
            PublishedAt = status == ArticleStatus.Published ? DateTime.UtcNow.AddMinutes(-1) : null
        };
        int articleId;
        if (id.HasValue)
        {
            db.Ado.ExecuteCommand(
                """
                INSERT INTO article
                    (id, title, summary, categoryid, views, createtime, metadata_updated_at, status, published_at, deleted_at, isdeleted)
                VALUES
                (@Id, @Title, @Summary, @CategoryId, 0, @CreateTime, @CreateTime, @Status, CAST(@PublishedAt AS timestamp), CAST(@DeletedAt AS timestamp), @IsDeleted);
                """,
                new SugarParameter("@Id", id.Value),
                new SugarParameter("@Title", article.Title),
                new SugarParameter("@Summary", article.Summary),
                new SugarParameter("@CategoryId", article.CategoryId),
                new SugarParameter("@CreateTime", article.CreateTime),
                new SugarParameter("@Status", (int)article.Status),
                new SugarParameter("@PublishedAt", (object?)article.PublishedAt ?? DBNull.Value),
                new SugarParameter("@DeletedAt", (object?)article.DeletedAt ?? DBNull.Value),
                new SugarParameter("@IsDeleted", article.IsDeleted));
            articleId = id.Value;
        }
        else
        {
            articleId = db.Insertable(article).ExecuteReturnIdentity();
        }

        db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = "# body",
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommand();
        db.Insertable(new ArticleTag { ArticleId = articleId, TagId = 1 }).ExecuteCommand();
        SeedCurrentVersionCoordinates(db, articleId, article.Title, article.Summary, article.CategoryId, article.PublishedAt ?? article.CreateTime);
        return articleId;
    }

    private static void SeedCurrentVersionCoordinates(
        SqlSugarClient db,
        int articleId,
        string title,
        string? summary,
        int categoryId,
        DateTime publishedAt)
    {
        long revisionId = db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = title,
            Summary = summary,
            CategoryId = categoryId,
            TagIds = "1",
            MarkdownContent = "# body",
            DiffSummary = "seed",
            CreatedByAdminPrincipalId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long rightsSnapshotId = db.Insertable(new ArticleRightsSnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            ArticleRightsPolicyId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = rightsSnapshotId,
            TransitionKind = "seed",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        db.Ado.ExecuteCommand(
            """
            UPDATE article
            SET current_revision_id = @RevisionId,
                current_publication_id = @PublicationId
            WHERE id = @ArticleId;
            """,
            new SugarParameter("@RevisionId", revisionId),
            new SugarParameter("@PublicationId", publicationId),
            new SugarParameter("@ArticleId", articleId));
    }

    private static ArticleService CreateService(
        SqlSugarClient db,
        IArticlePublicMutationFence? mutationFence = null,
        IPublicAotInvalidationService? publicAotInvalidation = null,
        ICacheInvalidationDispatcher? cacheInvalidation = null)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var runtimeKeyScope = Substitute.For<IRuntimeKeyScope>();
        runtimeKeyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: runtimeKeyScope,
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: publicAotInvalidation ?? Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: cacheInvalidation ?? Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: mutationFence ?? Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());
    }

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(20)),
                    "Timed out waiting for concurrent article mutation writers.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}

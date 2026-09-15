using System.Collections.Concurrent;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging;
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
public sealed class ArticleBodyRepairIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task DetailAedsProjector_UsesCanonicalArticleBodyWithoutSchedulingLegacyRepair()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        int articleId = await InsertPublishedArticleAsync(
            db,
            markdown: string.Empty,
            currentPublicationMatchesRevision: true);
        Article article = await db.Queryable<Article>().InSingleAsync(articleId);
        long revisionId = article.CurrentRevisionId!.Value;
        await db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = "# canonical body",
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();
        await db.Insertable(new ArticleRightsSnapshot
        {
            Id = 1,
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            ArticleRightsPolicyId = 1,
            PolicyHash = "policy-hash",
            ContentCanonicalHash = "content-hash"
        }).ExecuteCommandAsync();
        var store = Substitute.For<IArticleDetailAedsArtifactStore>();
        var projection = Substitute.For<IPublicArticleProjectionStore>();
        projection.VerifyShadowParityAsync(
                articleId,
                Arg.Any<ReadOnlyMemory<byte>>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        var repairQueue = new ArticleBodyRepairQueue();
        var projector = new ArticleDetailAedsArtifactProjector(
            db,
            store,
            projection,
            new ImmediateDbConcurrencyGate(),
            repairQueue,
            TimeProvider.System,
            NullLogger<ArticleDetailAedsArtifactProjector>.Instance);

        await projector.GenerateAndStoreAsync(articleId, CancellationToken.None);

        Assert.Equal(0, repairQueue.PendingCount);
        await projection.Received(1).UpsertAsync(
            Arg.Is<PublicArticleProjectionWrite>(write => write.ArticleId == articleId && !write.Frame.IsEmpty),
            Arg.Any<CancellationToken>());
        await store.Received(1).WriteAsync(
            articleId,
            Arg.Is<ReadOnlyMemory<byte>>(frame => !frame.IsEmpty),
            Arg.Any<CancellationToken>());
        await projection.DidNotReceiveWithAnyArgs().MarkUnavailableAsync(default, default!, default);
    }

    [Fact]
    public async Task Worker_QueuedPublishedCurrentRevisionWithoutBody_PersistsRevisionMarkdownOnce()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ConcurrentQueue<string> sqlLog = CaptureSql(db);
        const string Markdown = "# repaired body";
        var queue = new ArticleBodyRepairQueue();
        var workerLog = new CollectingLogger<ArticleBodyRepairWorker>();
        (ArticleBodyRepairService service, ICacheInvalidationDispatcher cache, IPublicAotInvalidationService publicAot, ISearchIndexService search, PublicHotArtifactUpdateQueue publicHot) = CreateService(db);
        var rebuildReached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        search.AddOrUpdateIndexAsync(Arg.Any<Article>()).Returns(_ =>
        {
            rebuildReached.TrySetResult();
            return Task.CompletedTask;
        });
        await using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(service)
            .BuildServiceProvider();
        using var worker = new ArticleBodyRepairWorker(
            queue,
            provider.GetRequiredService<IServiceScopeFactory>(),
            workerLog);

        int articleId = await InsertPublishedArticleAsync(
            db,
            Markdown,
            currentPublicationMatchesRevision: true);
        Assert.True(queue.TrySchedule(articleId, "article-detail-db"));

        await worker.StartAsync(CancellationToken.None);
        try
        {
            await rebuildReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitForQueueCompletionAsync(queue);
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }

        ArticleBody? body = await db.Queryable<ArticleBody>()
            .Where(item => item.ArticleId == articleId)
            .SingleAsync();
        Assert.NotNull(body);
        Assert.Equal(Markdown, body.MarkdownContent);
        Assert.Equal(0, queue.PendingCount);
        Assert.True(publicHot.Reader.TryPeek(out PublicHotArtifactUpdate hotUpdate));
        Assert.Equal(articleId, hotUpdate.ArticleId);
        Assert.Equal("article-body-repaired", hotUpdate.Reason);
        AssertRepairDidNotQueryMissingPublicationTable(sqlLog, workerLog.Entries);
        await cache.Received(1).InvalidateArticleBodyRepairAsync(
            articleId,
            Arg.Is<string>(value => value.StartsWith("article-repair:", StringComparison.Ordinal)),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default);
        await publicAot.Received(1).InvalidateRouteAsync(
            PublicPageId.ArticleDetail,
            $"article:{articleId}",
            Arg.Any<CancellationToken>());
        await publicAot.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default, default, default);
        await search.Received(1).AddOrUpdateIndexAsync(Arg.Is<Article>(article => article.Id == articleId));
    }

    [Fact]
    public async Task RepairAsync_PublicationRevisionMismatch_LeavesBodyUnresolvedWithoutSideEffects()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ConcurrentQueue<string> sqlLog = CaptureSql(db);
        var repairLog = new CollectingLogger<ArticleBodyRepairService>();
        (ArticleBodyRepairService service, ICacheInvalidationDispatcher cache, IPublicAotInvalidationService publicAot, ISearchIndexService search, PublicHotArtifactUpdateQueue publicHot) = CreateService(db, repairLog);

        int articleId = await InsertPublishedArticleAsync(
            db,
            "forged body",
            currentPublicationMatchesRevision: false);

        await service.RepairAsync(new ArticleBodyRepairRequest(articleId, "article-detail-db"), CancellationToken.None);

        Assert.Equal(0, await db.Queryable<ArticleBody>()
            .Where(item => item.ArticleId == articleId)
            .CountAsync());
        Assert.False(publicHot.Reader.TryPeek(out _));
        AssertRepairDidNotQueryMissingPublicationTable(sqlLog, repairLog.Entries);
        await cache.DidNotReceiveWithAnyArgs().InvalidateArticleBodyRepairAsync(default, default!, default);
        await publicAot.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default, default, default);
        await search.DidNotReceiveWithAnyArgs().AddOrUpdateIndexAsync(default!);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord),
            typeof(ArticleBody),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(Category),
            typeof(Tag));
        await AssertAuthoritativePublicationSchemaAsync(db);
        return db;
    }

    private static async Task WaitForQueueCompletionAsync(ArticleBodyRepairQueue queue)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (queue.PendingCount > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(25), timeout.Token);
        }
    }

    private static async Task<int> InsertPublishedArticleAsync(
        SqlSugarClient db,
        string markdown,
        bool currentPublicationMatchesRevision)
    {
        var article = new Article
        {
            Title = "published",
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow
        };
        int articleId = await db.Insertable(article).ExecuteReturnIdentityAsync();
        article.Id = articleId;

        var currentRevision = new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = "current",
            MarkdownContent = markdown
        };
        currentRevision.Id = await db.Insertable(currentRevision).ExecuteReturnBigIdentityAsync();

        var publicationRevision = new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 2,
            Title = "publication",
            MarkdownContent = "publication markdown"
        };
        publicationRevision.Id = await db.Insertable(publicationRevision).ExecuteReturnBigIdentityAsync();
        if (currentPublicationMatchesRevision)
        {
            publicationRevision = currentRevision;
        }

        var publication = new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = publicationRevision.Id,
            RevisionNo = publicationRevision.RevisionNo,
            RightsSnapshotId = 1,
            TransitionKind = "published"
        };
        publication.Id = await db.Insertable(publication).ExecuteReturnBigIdentityAsync();

        article.CurrentRevisionId = currentRevision.Id;
        article.CurrentPublicationId = publication.Id;
        await db.Updateable(article).ExecuteCommandAsync();
        return articleId;
    }

    private static async Task AssertAuthoritativePublicationSchemaAsync(SqlSugarClient db)
    {
        Assert.Equal(
            1,
            await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'article_publication'"));
        Assert.Equal(
            0,
            await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'article_publication_record'"));
        PostgresException missingTable = await Assert.ThrowsAsync<PostgresException>(
            () => db.Ado.GetIntAsync("SELECT COUNT(*) FROM article_publication_record"));
        Assert.Equal("42P01", missingTable.SqlState);
        Assert.Contains("article_publication_record", missingTable.MessageText, StringComparison.Ordinal);
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM article_publication"));
    }

    private static ConcurrentQueue<string> CaptureSql(SqlSugarClient db)
    {
        var statements = new ConcurrentQueue<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Enqueue(sql);
        return statements;
    }

    private static void AssertRepairDidNotQueryMissingPublicationTable(
        ConcurrentQueue<string> sqlLog,
        IReadOnlyList<string> logEntries)
    {
        string[] statements = [.. sqlLog];
        Assert.Contains(
            statements,
            sql => sql.Contains("article_publication", StringComparison.OrdinalIgnoreCase)
                && sql.Contains("JOIN", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            statements,
            sql => sql.Contains("article_publication_record", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            logEntries,
            entry => entry.Contains("42P01", StringComparison.Ordinal)
                || entry.Contains("article_publication_record", StringComparison.Ordinal)
                || entry.Contains("article_body_repair_failed", StringComparison.Ordinal));
    }

    private static (ArticleBodyRepairService Service, ICacheInvalidationDispatcher Cache, IPublicAotInvalidationService PublicAot, ISearchIndexService Search, PublicHotArtifactUpdateQueue PublicHot) CreateService(
        SqlSugarClient db,
        ILogger<ArticleBodyRepairService>? logger = null)
    {
        ICacheInvalidationDispatcher cache = Substitute.For<ICacheInvalidationDispatcher>();
        cache.InvalidateArticleMutationAsync(Arg.Any<int?>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();
        publicAot.InvalidateArticleMutationAsync(
                Arg.Any<int?>(),
                Arg.Any<IEnumerable<int>?>(),
                Arg.Any<IEnumerable<int>?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        ISearchIndexService search = Substitute.For<ISearchIndexService>();
        search.AddOrUpdateIndexAsync(Arg.Any<Article>()).Returns(Task.CompletedTask);

        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        IArticleDetailAedsArtifactProjector details = Substitute.For<IArticleDetailAedsArtifactProjector>();
        details.GenerateAndStoreAsync(Arg.Any<int>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        IPublicArtifactRevocationCoordinator revocations = Substitute.For<IPublicArtifactRevocationCoordinator>();
        revocations.RevokeArticleAsync(Arg.Any<int>(), Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        var publicHot = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }),
            new InMemoryPublicHotArtifactDeliveryStateStore());
        var projections = new ArticleMutationProjectionInvalidator(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<ITaxonomyCountProjectionService>(),
            details,
            revocations,
            publicHot,
            NullLogger<ArticleMutationProjectionInvalidator>.Instance);

        return (
            new ArticleBodyRepairService(
                db,
                cache,
                publicAot,
                projections,
                search,
                logger ?? NullLogger<ArticleBodyRepairService>.Instance),
            cache,
            publicAot,
            search,
            publicHot);
    }

    private sealed class CollectingLogger<T> : ILogger<T>
    {
        private readonly List<string> _entries = [];

        internal IReadOnlyList<string> Entries
        {
            get
            {
                lock (_entries)
                {
                    return [.. _entries];
                }
            }
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            string entry = formatter(state, exception);
            if (exception is not null)
            {
                entry = $"{entry} | {exception}";
            }

            lock (_entries)
            {
                _entries.Add(entry);
            }
        }
    }
}

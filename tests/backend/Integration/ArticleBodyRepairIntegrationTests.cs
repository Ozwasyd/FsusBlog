using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

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
    public async Task Worker_QueuedPublishedCurrentRevisionWithoutBody_PersistsRevisionMarkdownOnce()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        const string Markdown = "# repaired body";
        var queue = new ArticleBodyRepairQueue();
        (ArticleBodyRepairService service, ICacheInvalidationDispatcher cache, IPublicAotInvalidationService publicAot, ISearchIndexService search) = CreateService(db);
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
            NullLogger<ArticleBodyRepairWorker>.Instance);

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
        await cache.Received(1).InvalidateArticleMutationAsync(
            articleId,
            Arg.Is<string>(value => value.StartsWith("article-repair:", StringComparison.Ordinal)),
            Arg.Any<CancellationToken>());
        await publicAot.Received(1).InvalidateArticleMutationAsync(
            articleId,
            null,
            null,
            Arg.Is<string>(value => value.StartsWith("article-repair:", StringComparison.Ordinal)),
            Arg.Any<CancellationToken>());
        await search.Received(1).AddOrUpdateIndexAsync(Arg.Is<Article>(article => article.Id == articleId));
    }

    [Fact]
    public async Task RepairAsync_PublicationRevisionMismatch_LeavesBodyUnresolvedWithoutSideEffects()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (ArticleBodyRepairService service, ICacheInvalidationDispatcher cache, IPublicAotInvalidationService publicAot, ISearchIndexService search) = CreateService(db);

        int articleId = await InsertPublishedArticleAsync(
            db,
            "forged body",
            currentPublicationMatchesRevision: false);

        await service.RepairAsync(new ArticleBodyRepairRequest(articleId, "article-detail-db"), CancellationToken.None);

        Assert.Null(await db.Queryable<ArticleBody>()
            .Where(item => item.ArticleId == articleId)
            .SingleAsync());
        await cache.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default);
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
            typeof(ArticleBody));
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

    private static (ArticleBodyRepairService Service, ICacheInvalidationDispatcher Cache, IPublicAotInvalidationService PublicAot, ISearchIndexService Search) CreateService(SqlSugarClient db)
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
        var projections = new ArticleMutationProjectionInvalidator(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<ITaxonomyCountProjectionService>(),
            details,
            revocations,
            new PublicHotArtifactUpdateQueue(
                Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }),
                new InMemoryPublicHotArtifactDeliveryStateStore()),
            NullLogger<ArticleMutationProjectionInvalidator>.Instance);

        return (
            new ArticleBodyRepairService(
                db,
                cache,
                publicAot,
                projections,
                search,
                NullLogger<ArticleBodyRepairService>.Instance),
            cache,
            publicAot,
            search);
    }
}

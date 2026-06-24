using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class ArticleRevisionConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly MethodInfo SaveRevisionMethod = typeof(ArticleService)
        .GetMethod("SaveArticleRevisionAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("SaveArticleRevisionAsync should exist.");

    [Fact]
    public async Task SaveArticleRevisionAsync_ConcurrentWritersProduceOnlyOneNextRevisionNumber()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedRevisionAsync(setupDb, articleId, revisionNo: 1);

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService firstService = CreateService(firstDb);
        ArticleService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => SaveRevisionInTransactionAsync(firstDb, firstService, articleId, "first concurrent update")),
                StartBarrierTaskAsync(barrier, () => SaveRevisionInTransactionAsync(secondDb, secondService, articleId, "second concurrent update")))
            .WaitAsync(TimeSpan.FromSeconds(30));

        List<int> revisionNumbers = await setupDb.Queryable<ArticleRevision>()
            .Where(revision => revision.ArticleId == articleId)
            .OrderBy(revision => revision.RevisionNo)
            .Select(revision => revision.RevisionNo)
            .ToListAsync();

        Assert.Equal([1, 2, 3], revisionNumbers);
        Assert.Equal(1, revisionNumbers.Count(static revisionNo => revisionNo == 2));
    }

    [Fact]
    public async Task SaveArticleRevisionAsync_DeletedArticleDoesNotAllocateRevisionNumber()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int articleId = await SeedArticleAsync(db, isDeleted: true);
        ArticleService service = CreateService(db);

        await SaveRevisionInTransactionAsync(db, service, articleId, "deleted article update");

        int revisionCount = await db.Queryable<ArticleRevision>()
            .CountAsync(revision => revision.ArticleId == articleId);
        Assert.Equal(0, revisionCount);
    }

    private static async Task SaveRevisionInTransactionAsync(
        SqlSugarClient db,
        ArticleService service,
        int articleId,
        string diffSummary)
    {
        var result = await db.Ado.UseTranAsync(async () =>
        {
            await InvokeSaveRevisionAsync(service, articleId, diffSummary);
            return true;
        });

        Assert.True(result.IsSuccess, result.ErrorMessage);
    }

    private static async Task InvokeSaveRevisionAsync(ArticleService service, int articleId, string diffSummary)
    {
        var task = (Task?)SaveRevisionMethod.Invoke(
            service,
            [
                articleId,
                "Title",
                "# body",
                "summary",
                null,
                1,
                Array.Empty<int>(),
                diffSummary
            ]);

        Assert.NotNull(task);
        await task;
    }

    private static Task StartBarrierTaskAsync(Barrier barrier, Func<Task> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent revision writers.");
                await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static async Task<int> SeedArticleAsync(SqlSugarClient db, bool isDeleted = false)
        => await db.Insertable(new Article
        {
            Title = "Title",
            Summary = "summary",
            CategoryId = 1,
            Status = isDeleted ? ArticleStatus.Deleted : ArticleStatus.Published,
            IsDeleted = isDeleted,
            DeletedAt = isDeleted ? DateTime.UtcNow : null,
            CreateTime = DateTime.UtcNow,
            PublishedAt = isDeleted ? null : DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();

    private static async Task SeedRevisionAsync(SqlSugarClient db, int articleId, int revisionNo)
        => await db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = revisionNo,
            Title = "Original",
            Summary = "summary",
            CategoryId = 1,
            TagIds = string.Empty,
            MarkdownContent = "# original",
            DiffSummary = "seed",
            CreatedByAdminPrincipalId = 1,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRevision));

    private static ArticleService CreateService(SqlSugarClient db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cache: Substitute.For<IUnifiedCache>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>());
    }
}

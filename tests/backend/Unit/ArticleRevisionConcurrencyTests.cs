using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleRevisionConcurrencyTests(
    PostgresSchemaMigrationFixture fixture,
    ArticleRevisionConcurrencyDatabaseFixture classDatabase)
    : IClassFixture<ArticleRevisionConcurrencyDatabaseFixture>, IAsyncLifetime
{
    private static readonly MethodInfo SaveRevisionMethod = typeof(ArticleService)
        .GetMethod("SaveArticleRevisionAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("SaveArticleRevisionAsync should exist.");

    [Fact]
    public async Task SaveArticleRevisionAsync_ConcurrentWritersProduceOnlyOneNextRevisionNumber()
    {
        string connectionString = classDatabase.ConnectionString;
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
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        int articleId = await SeedArticleAsync(db, isDeleted: true);
        ArticleService service = CreateService(db);

        await SaveRevisionInTransactionAsync(db, service, articleId, "deleted article update", expectSuccess: false);

        int revisionCount = await db.Queryable<ArticleRevision>()
            .CountAsync(revision => revision.ArticleId == articleId);
        Assert.Equal(0, revisionCount);
    }

    [Fact]
    public async Task UpdateAsync_ConcurrentRowVersionMismatchDoesNotRewriteArticleOrTags()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# original");
        await SeedTagsAsync(setupDb, articleId, [1, 2]);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        await using var holder = new Npgsql.NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using Npgsql.NpgsqlTransaction concurrentChange = await holder.BeginTransactionAsync();
        await using (var updateCommand = new Npgsql.NpgsqlCommand(
            "UPDATE article SET views = views + 1 WHERE id = @ArticleId;",
            holder,
            concurrentChange))
        {
            updateCommand.Parameters.AddWithValue("@ArticleId", articleId);
            Assert.Equal(1, await updateCommand.ExecuteNonQueryAsync());
        }

        Task<bool> updateTask = service.UpdateAsync(articleId, new UpdateArticleRequest
        {
            Title = "Concurrent overwrite",
            Summary = "changed",
            Content = "# changed",
            CategoryId = 2,
            TagIds = [3, 4],
            Status = ArticleStatus.Published
        });
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        Assert.False(updateTask.IsCompleted);

        await concurrentChange.CommitAsync();
        bool updated = await updateTask.WaitAsync(TimeSpan.FromSeconds(10));

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        List<int> tagIds = await setupDb.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .OrderBy(tag => tag.TagId)
            .Select(tag => tag.TagId)
            .ToListAsync();

        Assert.False(updated);
        Assert.Equal("Title", article.Title);
        Assert.Equal(1, article.CategoryId);
        Assert.Equal("# original", body.MarkdownContent);
        Assert.Equal([1, 2], tagIds);
    }

    [Fact]
    public async Task UpdateAsync_SuccessfulUpdateRewritesTagSetWithAtomicUpsert()
    {
        string connectionString = classDatabase.ConnectionString;
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(setupDb);
        await SeedTaxonomyAsync(setupDb);
        int articleId = await SeedArticleAsync(setupDb);
        await SeedBodyAsync(setupDb, articleId, "# original");
        await SeedTagsAsync(setupDb, articleId, [1, 2]);
        using SqlSugarClient serviceDb = PostgresSqlSugarTestClient.Create(connectionString);
        ArticleService service = CreateService(serviceDb);

        bool updated = await service.UpdateAsync(articleId, new UpdateArticleRequest
        {
            Title = "Updated",
            Summary = "changed",
            Content = "# changed",
            CategoryId = 2,
            TagIds = [2, 3, 3],
            Status = ArticleStatus.Published
        });

        Article article = await setupDb.Queryable<Article>().InSingleAsync(articleId);
        ArticleBody body = await setupDb.Queryable<ArticleBody>().InSingleAsync(articleId);
        List<int> tagIds = await setupDb.Queryable<ArticleTag>()
            .Where(tag => tag.ArticleId == articleId)
            .OrderBy(tag => tag.TagId)
            .Select(tag => tag.TagId)
            .ToListAsync();

        Assert.True(updated);
        Assert.Equal("Updated", article.Title);
        Assert.Equal(2, article.CategoryId);
        Assert.Equal("# changed", body.MarkdownContent);
        Assert.Equal([2, 3], tagIds);
    }

    private static async Task SaveRevisionInTransactionAsync(
        SqlSugarClient db,
        ArticleService service,
        int articleId,
        string diffSummary,
        bool expectSuccess = true)
    {
        var result = await db.Ado.UseTranAsync(async () =>
        {
            await InvokeSaveRevisionAsync(service, articleId, diffSummary);
            return true;
        });

        if (expectSuccess)
        {
            Assert.True(result.IsSuccess, result.ErrorMessage);
        }
        else
        {
            Assert.False(result.IsSuccess);
            Assert.Contains("Article revision was not created", result.ErrorMessage, StringComparison.Ordinal);
        }
    }

    public async Task InitializeAsync()
        => _ = await classDatabase.ResetAsync(fixture);

    public Task DisposeAsync() => Task.CompletedTask;

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

    private static async Task SeedTaxonomyAsync(SqlSugarClient db)
    {
        await db.Insertable(new[]
        {
            new Category { Id = 1, Name = "Category 1" },
            new Category { Id = 2, Name = "Category 2" }
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            new Tag { Id = 1, Name = "Tag 1" },
            new Tag { Id = 2, Name = "Tag 2" },
            new Tag { Id = 3, Name = "Tag 3" },
            new Tag { Id = 4, Name = "Tag 4" }
        }).ExecuteCommandAsync();
    }

    private static async Task SeedBodyAsync(SqlSugarClient db, int articleId, string content)
        => await db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = content,
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

    private static async Task SeedTagsAsync(SqlSugarClient db, int articleId, int[] tagIds)
        => await db.Insertable(tagIds.Select(tagId => new ArticleTag
        {
            ArticleId = articleId,
            TagId = tagId
        }).ToArray()).ExecuteCommandAsync();

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(Category),
            typeof(Tag),
            typeof(ArticleRevision),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleMutationOutboxEvent));

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
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>());
    }
}

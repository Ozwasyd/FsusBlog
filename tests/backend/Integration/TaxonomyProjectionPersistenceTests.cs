using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;
using Npgsql;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class TaxonomyProjectionPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ReconcileArticleAsync_PersistsCategoryTagCountsProjectionAndBumpsFrameVersion()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleTag),
            typeof(CategoryPublicArticleCount),
            typeof(TagPublicArticleCount),
            typeof(ArticlePublicTaxonomyProjection));

        int articleId = db.Insertable(new Article
        {
            Title = "taxonomy projection",
            Summary = "published",
            CategoryId = 7,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow.AddMinutes(-5),
            CreateTime = DateTime.UtcNow.AddMinutes(-10),
            IsDeleted = false
        }).ExecuteReturnIdentity();
        db.Insertable(new[]
        {
            new ArticleTag { ArticleId = articleId, TagId = 11 },
            new ArticleTag { ArticleId = articleId, TagId = 12 }
        }).ExecuteCommand();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>())
            .Returns("0");
        cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(1);
        IHttpCacheInvalidator invalidator = Substitute.For<IHttpCacheInvalidator>();
        var service = new TaxonomyCountProjectionService(db, cache, invalidator);

        await service.ReconcileArticleAsync(articleId);

        CategoryPublicArticleCount? category = await db.Queryable<CategoryPublicArticleCount>().InSingleAsync(7);
        List<TagPublicArticleCount> tags = await db.Queryable<TagPublicArticleCount>()
            .OrderBy(item => item.TagId)
            .ToListAsync();
        ArticlePublicTaxonomyProjection? projection =
            await db.Queryable<ArticlePublicTaxonomyProjection>().InSingleAsync(articleId);

        Assert.NotNull(category);
        Assert.Equal(1, category.ArticleCount);
        Assert.Equal([11, 12], tags.Select(static item => item.TagId));
        Assert.All(tags, static item => Assert.Equal(1, item.ArticleCount));
        Assert.NotNull(projection);
        Assert.Equal(7, projection.CategoryId);
        Assert.Equal("11,12", projection.TagIds);
        await cache.Received(1).IncrementAsync(
            CachePolicyId.TaxonomyFrameVersion,
            "main",
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).RemoveManyAsync(
            Arg.Is<IReadOnlyList<CacheKeyIdentity>>(keys =>
                HasKey(keys, CachePolicyId.CategoryFrame, "all")
                && HasKey(keys, CachePolicyId.TagFrame, "all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:0:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:0:all")
                && HasKey(keys, CachePolicyId.CategoryFrame, "v:1:all")
                && HasKey(keys, CachePolicyId.TagFrame, "v:1:all")),
            Arg.Any<CancellationToken>());
        await invalidator.Received(1).InvalidateAsync(
            Arg.Is<CacheTag[]>(values => values.Length == 2
                && values[0] == CacheTag.Category
                && values[1] == CacheTag.Tag));
    }

    [Fact]
    public async Task ReconcileArticleAsync_ConcurrentFirstProjectionAppliesCountsExactlyOnce()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setupDb,
            typeof(Article),
            typeof(ArticleTag),
            typeof(CategoryPublicArticleCount),
            typeof(TagPublicArticleCount),
            typeof(ArticlePublicTaxonomyProjection));

        int articleId = setupDb.Insertable(new Article
        {
            Title = "concurrent taxonomy projection",
            Summary = "published",
            CategoryId = 17,
            Status = ArticleStatus.Published,
            PublishedAt = DateTime.UtcNow.AddMinutes(-5),
            CreateTime = DateTime.UtcNow.AddMinutes(-10),
            IsDeleted = false
        }).ExecuteReturnIdentity();
        setupDb.Insertable(new[]
        {
            new ArticleTag { ArticleId = articleId, TagId = 21 },
            new ArticleTag { ArticleId = articleId, TagId = 22 }
        }).ExecuteCommand();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", Arg.Any<CancellationToken>())
            .Returns("0");
        cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, Arg.Any<CancellationToken>())
            .Returns(1);
        IHttpCacheInvalidator invalidator = Substitute.For<IHttpCacheInvalidator>();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        var firstService = new TaxonomyCountProjectionService(firstDb, cache, invalidator);
        var secondService = new TaxonomyCountProjectionService(secondDb, cache, invalidator);

        await using var lockConnection = new NpgsqlConnection(connectionString);
        await lockConnection.OpenAsync();
        await using NpgsqlTransaction lockTransaction = await lockConnection.BeginTransactionAsync();
        await using (var lockCommand = new NpgsqlCommand(
            "LOCK TABLE category_public_article_count IN ACCESS EXCLUSIVE MODE;",
            lockConnection,
            lockTransaction))
        {
            await lockCommand.ExecuteNonQueryAsync();
        }

        using var barrier = new Barrier(2);
        Task first = StartBarrierTaskAsync(barrier, () => firstService.ReconcileArticleAsync(articleId));
        Task second = StartBarrierTaskAsync(barrier, () => secondService.ReconcileArticleAsync(articleId));
        try
        {
            await WaitForProjectionLockWaitersAsync(connectionString, expectedCount: 2);
        }
        finally
        {
            await lockTransaction.CommitAsync();
        }

        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(30));

        CategoryPublicArticleCount? category = await setupDb.Queryable<CategoryPublicArticleCount>().InSingleAsync(17);
        List<TagPublicArticleCount> tags = await setupDb.Queryable<TagPublicArticleCount>()
            .OrderBy(item => item.TagId)
            .ToListAsync();
        List<ArticlePublicTaxonomyProjection> projections = await setupDb.Queryable<ArticlePublicTaxonomyProjection>()
            .Where(item => item.ArticleId == articleId)
            .ToListAsync();

        Assert.NotNull(category);
        Assert.Equal(1, category.ArticleCount);
        Assert.Equal([21, 22], tags.Select(static item => item.TagId));
        Assert.All(tags, static item => Assert.Equal(1, item.ArticleCount));
        Assert.Single(projections);
        Assert.Equal("21,22", projections[0].TagIds);
        await cache.Received(1).IncrementAsync(
            CachePolicyId.TaxonomyFrameVersion,
            "main",
            1,
            Arg.Any<CancellationToken>());
        await invalidator.Received(1).InvalidateAsync(
            Arg.Is<CacheTag[]>(values => values.Length == 2
                && values[0] == CacheTag.Category
                && values[1] == CacheTag.Tag));
    }

    private async Task WaitForProjectionLockWaitersAsync(string connectionString, int expectedCount)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            int waiting = await fixture.QueryScalarAsync<int>(
                connectionString,
                """
                SELECT COUNT(*)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock';
                """);
            if (waiting >= expectedCount)
            {
                return;
            }

            await Task.Delay(25);
        }

        throw new TimeoutException($"Expected {expectedCount} concurrent taxonomy projection lock waiters.");
    }

    private static Task StartBarrierTaskAsync(Barrier barrier, Func<Task> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent taxonomy projections.");
                await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static bool HasKey(
        IReadOnlyList<CacheKeyIdentity> keys,
        CachePolicyId policyId,
        string identity)
        => keys.Any(key => key.PolicyId == policyId
            && string.Equals(key.Identity, identity, StringComparison.Ordinal));
}

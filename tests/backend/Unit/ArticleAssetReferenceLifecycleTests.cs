using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleAssetUrlNormalizerTests
{
    [Theory]
    [InlineData("/uploads/illustration/Shared.PNG?width=800#hero", "/uploads/illustration/shared.png")]
    [InlineData("//uploads//illustration//shared.png", "/uploads/illustration/shared.png")]
    [InlineData("\\uploads\\illustration\\shared%2Epng", "/uploads/illustration/shared.png")]
    public void TryNormalize_CollapsesSupportedAliases(string rawUrl, string expected)
    {
        Assert.True(ArticleAssetUrlNormalizer.TryNormalize(rawUrl, out string normalized));
        Assert.Equal(expected, normalized);
    }

    [Theory]
    [InlineData("https://cdn.example/uploads/illustration/shared.png")]
    [InlineData("/uploads/illustration/../secret.png")]
    [InlineData("/uploads/avatar/shared.png")]
    public void TryNormalize_RejectsNonLocalOrEscapingPaths(string rawUrl)
        => Assert.False(ArticleAssetUrlNormalizer.TryNormalize(rawUrl, out _));
}

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleAssetReferenceLifecycleTests(PostgresSchemaMigrationFixture fixture)
{
    private const string SharedUrl = "/uploads/illustration/shared.png";

    [Fact]
    public async Task SharedArticleReference_QueuesOnlyAfterLastCurrentSourceIsRemoved()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(41, Image(SharedUrl), null));
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null));

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([41], [SharedUrl]));
        Assert.Empty(db.Queryable<ArticleAssetCleanupQueueItem>().ToList());

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [SharedUrl]));
        ArticleAssetCleanupQueueItem queued = Assert.Single(db.Queryable<ArticleAssetCleanupQueueItem>().ToList());
        Assert.Equal(SharedUrl, queued.NormalizedUrl);
        Assert.Equal(0, queued.AttemptCount);
    }

    [Fact]
    public async Task DraftReference_PreventsCurrentArticleRemovalFromQueueingAsset()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null));
        await InTransactionAsync(db, () => store.ReplaceDraftAsync(7, "article-42", 42, Image(SharedUrl), null));

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [SharedUrl]));

        ArticleAssetReference remaining = Assert.Single(db.Queryable<ArticleAssetReference>().ToList());
        Assert.Equal(ArticleAssetSourceKinds.Draft, remaining.SourceKind);
        Assert.Empty(db.Queryable<ArticleAssetCleanupQueueItem>().ToList());
    }

    [Fact]
    public async Task RollbackReference_PreservesHistoricalAssetAcrossCurrentVersionChanges()
    {
        const string ReplacementUrl = "/uploads/illustration/replacement.webp";
        using SqlSugarClient db = await CreateDatabaseAsync();
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null);
            await store.ReplaceRevisionAsync(1001, 42, Image(SharedUrl), null);
        });
        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Image(ReplacementUrl), null);
            await store.ReplaceRevisionAsync(1002, 42, Image(ReplacementUrl), null);
        });

        Assert.DoesNotContain(
            db.Queryable<ArticleAssetCleanupQueueItem>().ToList(),
            item => item.NormalizedUrl == SharedUrl);

        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null);
            await store.ReplaceRevisionAsync(1003, 42, Image(SharedUrl), null);
        });

        Assert.Equal(
            3,
            db.Queryable<ArticleAssetReference>()
                .Where(reference => reference.NormalizedUrl == SharedUrl)
                .Count());
        Assert.DoesNotContain(
            db.Queryable<ArticleAssetCleanupQueueItem>().ToList(),
            item => item.NormalizedUrl == SharedUrl);
    }

    [Fact]
    public async Task StartupRebuild_IndexesCurrentDraftAndRetainedRevisionSources()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        db.Insertable(new Article
        {
            Id = 42,
            Title = "asset rebuild",
            CoverImageUrl = SharedUrl,
            CategoryId = 1,
            Status = ArticleStatus.Draft,
            CreateTime = DateTime.UtcNow,
            IsDeleted = false
        }).ExecuteCommand();
        db.Insertable(new ArticleDraft
        {
            OwnerAdminPrincipalId = 7,
            DraftKey = "article-42",
            ArticleId = 42,
            MarkdownContent = Image(SharedUrl),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommand();
        db.Insertable(new ArticleRevision
        {
            ArticleId = 42,
            RevisionNo = 1,
            MarkdownContent = Image(SharedUrl),
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommand();
        IFileService files = Substitute.For<IFileService>();
        var cleanup = new ArticleAssetCleanupService(
            db,
            files,
            TimeProvider.System,
            NullLogger<ArticleAssetCleanupService>.Instance);

        Assert.Equal(3, await cleanup.RebuildReferenceLedgerAsync());
        Assert.Equal(
            [ArticleAssetSourceKinds.CurrentArticle, ArticleAssetSourceKinds.Draft, ArticleAssetSourceKinds.Revision],
            db.Queryable<ArticleAssetReference>()
                .Where(reference => reference.NormalizedUrl == SharedUrl)
                .ToList()
                .Select(static reference => reference.SourceKind)
                .Order(StringComparer.Ordinal)
                .ToArray());
    }

    [Fact]
    public async Task ConcurrentLastSourceRemoval_ProducesOneQueueItemAndOneIdempotentDelete()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            var store = new ArticleAssetReferenceStore(setupDb);
            await InTransactionAsync(setupDb, async () =>
            {
                await store.ReplaceCurrentArticleAsync(41, Image(SharedUrl), null);
                await store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null);
            });
        }

        using var barrier = new Barrier(2);
        await Task.WhenAll(
            StartBarrierTaskAsync(barrier, connectionString, 41),
            StartBarrierTaskAsync(barrier, connectionString, 42)).WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        _ = Assert.Single(assertDb.Queryable<ArticleAssetCleanupQueueItem>().ToList());
        assertDb.Ado.ExecuteCommand(
            "UPDATE article_asset_cleanup_queue SET not_before_utc = (now() AT TIME ZONE 'utc') - interval '1 minute';");
        IFileService files = Substitute.For<IFileService>();
        files.DeleteImageAsync(SharedUrl).Returns(true);
        var cleanup = new ArticleAssetCleanupService(
            assertDb,
            files,
            TimeProvider.System,
            NullLogger<ArticleAssetCleanupService>.Instance);

        Assert.Equal(1, await cleanup.ProcessDueAsync());
        Assert.Equal(0, await cleanup.ProcessDueAsync());
        await files.Received(1).DeleteImageAsync(SharedUrl);
        Assert.Empty(assertDb.Queryable<ArticleAssetCleanupQueueItem>().ToList());
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateTables(db);
        return db;
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleDraft),
            typeof(ArticleRevision),
            typeof(ArticleAssetReference),
            typeof(ArticleAssetCleanupQueueItem));

    private static async Task InTransactionAsync(SqlSugarClient db, Func<Task> action)
    {
        var transaction = await db.Ado.UseTranAsync(action);
        Assert.True(transaction.IsSuccess, transaction.ErrorMessage);
    }

    private static Task StartBarrierTaskAsync(Barrier barrier, string connectionString, int articleId)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(20)));
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var store = new ArticleAssetReferenceStore(db);
                await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([articleId], [SharedUrl]));
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static string Image(string url) => $"![asset]({url})";
}

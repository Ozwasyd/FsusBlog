using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleAssetReferenceLifecycleTests(PostgresSchemaMigrationFixture fixture)
{
    private const string SharedUrl = "/uploads/illustration/shared.png";

    [Fact]
    public void LedgerIdentity_IsAssetIdCompositeKey()
    {
        string[] keys = typeof(ContentAssetReference)
            .GetProperties()
            .Where(static property => property
                .GetCustomAttributes(typeof(SqlSugar.SugarColumn), inherit: false)
                .Cast<SqlSugar.SugarColumn>()
                .Any(static column => column.IsPrimaryKey))
            .Select(static property => property
                .GetCustomAttributes(typeof(SqlSugar.SugarColumn), inherit: false)
                .Cast<SqlSugar.SugarColumn>()
                .Single().ColumnName)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(["asset_id", "source_key", "source_kind"], keys);
        Assert.DoesNotContain(
            typeof(ContentAssetReference).GetProperties(),
            static property => property.Name.Contains("Url", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void DeletePort_AcceptsOnlyAssetId()
    {
        System.Reflection.MethodInfo method = Assert.Single(typeof(IAssetStore).GetMethods());
        Assert.Equal(nameof(IAssetStore.DeleteAsync), method.Name);
        Assert.Equal(typeof(AssetId), method.GetParameters()[0].ParameterType);
    }

    [Fact]
    public void PublicUrlExtraction_IsPresentationOnlyAndStable()
    {
        string[] urls = ArticleAssetReferenceStore.ExtractPublicAssetUrls(
            "![hero](/uploads/illustration/a.png) ![hero](/uploads/illustration/a.png)",
            "/uploads/illustration/b.webp");

        Assert.Equal(
            ["/uploads/illustration/a.png", "/uploads/illustration/b.webp"],
            urls);
    }

    [Fact]
    public void CleanupQueue_UsesAssetIdPrimaryKey()
    {
        Assert.NotNull(typeof(ContentAssetCleanupQueueItem).GetProperty(nameof(ContentAssetCleanupQueueItem.AssetId)));
        Assert.DoesNotContain(
            typeof(ContentAssetCleanupQueueItem).GetProperties(),
            static property => property.Name.Contains("Url", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Path", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task LastReferenceSchedulesPendingDeleteAndReAddCancelsQueue()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/shared.png");
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(41, Image(SharedUrl), null));
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null));

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([41], [assetId]));
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [assetId]));
        ContentAssetCleanupQueueItem queued = Assert.Single(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        Assert.Equal(assetId.Value, queued.AssetId);
        Assert.Equal(ContentAssetStates.PendingDelete, db.Queryable<ContentAsset>().InSingle(assetId.Value).State);

        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null));
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        Assert.Equal(ContentAssetStates.Active, db.Queryable<ContentAsset>().InSingle(assetId.Value).State);
    }

    [Fact]
    public async Task RetainedRevisionPreventsCurrentReferenceRemovalFromSchedulingDelete()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/shared.png");
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null);
            await store.ReplaceRevisionAsync(1001, 42, Image(SharedUrl), null);
        });

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [assetId]));

        ContentAssetReference remaining = Assert.Single(db.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(ContentAssetSourceKinds.Revision, remaining.SourceKind);
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
    }

    [Fact]
    public async Task TransactionRollbackLeavesReferenceReplacementAtomic()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId shared = SeedAsset(db, "illustration/shared.png");
        _ = SeedAsset(db, "illustration/replacement.png");
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null));

        var rollback = await db.Ado.UseTranAsync(async () =>
        {
            await store.ReplaceCurrentArticleAsync(
                42,
                Image("/uploads/illustration/replacement.png"),
                null);
            throw new InvalidOperationException("force rollback");
        });

        Assert.False(rollback.IsSuccess);
        ContentAssetReference reference = Assert.Single(db.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(shared.Value, reference.AssetId);
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
    }

    [Fact]
    public async Task ConcurrentLastSourceRemovalProducesOneQueueAndReferencedCleanupCannotDeleteFile()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        AssetId assetId;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            assetId = SeedAsset(setupDb, "illustration/shared.png");
            var store = new ArticleAssetReferenceStore(setupDb);
            await InTransactionAsync(setupDb, async () =>
            {
                await store.ReplaceCurrentArticleAsync(41, Image(SharedUrl), null);
                await store.ReplaceCurrentArticleAsync(42, Image(SharedUrl), null);
            });
        }

        using var barrier = new Barrier(2);
        await Task.WhenAll(
            StartBarrierTaskAsync(barrier, connectionString, 41, assetId),
            StartBarrierTaskAsync(barrier, connectionString, 42, assetId)).WaitAsync(TimeSpan.FromSeconds(20));

        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-content-asset-cleanup-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var paths = ReleaseStorageTestPaths.Create(root);
            string file = Path.Combine(paths.PublicAssetRoot, "illustration", "shared.png");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await File.WriteAllBytesAsync(file, [1, 2, 3]);
            using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
            _ = Assert.Single(assertDb.Queryable<ContentAssetCleanupQueueItem>().ToList());
            assertDb.Ado.ExecuteCommand(
                "UPDATE content_asset_cleanup_queue SET not_before_utc = (now() AT TIME ZONE 'utc') - interval '1 minute';");
            assertDb.Insertable(new ContentAssetReference
            {
                AssetId = assetId.Value,
                SourceKind = ContentAssetSourceKinds.Revision,
                SourceKey = "1001",
                ArticleId = 42,
                ReferenceCount = 1,
                UpdatedAtUtc = DateTime.UtcNow
            }).ExecuteCommand();
            var assetStore = new LocalContentAssetStore(
                assertDb,
                paths,
                NullLogger<LocalContentAssetStore>.Instance);
            var cleanup = new ArticleAssetCleanupService(
                assertDb,
                assetStore,
                TimeProvider.System,
                NullLogger<ArticleAssetCleanupService>.Instance);

            Assert.Equal(1, await cleanup.ProcessDueAsync());
            Assert.True(File.Exists(file));
            Assert.Empty(assertDb.Queryable<ContentAssetCleanupQueueItem>().ToList());
            Assert.NotNull(assertDb.Queryable<ContentAsset>().InSingle(assetId.Value));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LocalStorePathBoundaryRejectsRootTraversalAndAbsoluteCandidates()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-content-asset-root");
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, ".", out _));
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, "..", out _));
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, "../outside.png", out _));
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, "/tmp/outside.png", out _));
        Assert.True(LocalContentAssetStore.TryResolveStoragePath(root, "illustration/inside.png", out string path));
        Assert.Equal(
            Path.Combine(Path.GetFullPath(root), "illustration", "inside.png"),
            path);
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
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));

    private static AssetId SeedAsset(SqlSugarClient db, string storageKey)
    {
        AssetId assetId = AssetId.New();
        db.Insertable(new ContentAsset
        {
            AssetId = assetId.Value,
            StorageClass = "public",
            StorageKey = storageKey,
            MimeType = "image/png",
            Extension = ".png",
            SizeBytes = 3,
            Sha256 = new string('a', 64),
            WidthPixels = 1,
            HeightPixels = 1,
            State = ContentAssetStates.Active,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
        return assetId;
    }

    private static async Task InTransactionAsync(SqlSugarClient db, Func<Task> action)
    {
        var transaction = await db.Ado.UseTranAsync(action);
        Assert.True(transaction.IsSuccess, transaction.ErrorMessage);
    }

    private static Task StartBarrierTaskAsync(
        Barrier barrier,
        string connectionString,
        int articleId,
        AssetId assetId)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(20)));
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var store = new ArticleAssetReferenceStore(db);
                await InTransactionAsync(
                    db,
                    () => store.RemoveCurrentArticlesAndScheduleAsync([articleId], [assetId]));
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static string Image(string url) => $"![asset]({url})";
}

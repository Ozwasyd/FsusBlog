using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleAssetReferenceLifecycleTests(PostgresSchemaMigrationFixture fixture)
{
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
        string[] urls = ArticleAssetReferenceWriteBoundary.ExtractPublicAssetUrls(
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
    public void StoreWriteApi_DoesNotAcceptUrlPathOrMarkdown()
    {
        System.Reflection.MethodInfo[] methods = typeof(ArticleAssetReferenceStore)
            .GetMethods(System.Reflection.BindingFlags.Instance
                | System.Reflection.BindingFlags.Public
                | System.Reflection.BindingFlags.NonPublic)
            .Where(static method => method.DeclaringType == typeof(ArticleAssetReferenceStore)
                && (method.IsPublic || method.IsAssembly))
            .ToArray();

        Assert.NotEmpty(methods);
        Assert.DoesNotContain(
            methods.SelectMany(static method => method.GetParameters()),
            static parameter => parameter.Name?.Contains("url", StringComparison.OrdinalIgnoreCase) == true
                || parameter.Name?.Contains("path", StringComparison.OrdinalIgnoreCase) == true
                || parameter.Name?.Contains("markdown", StringComparison.OrdinalIgnoreCase) == true
                || parameter.ParameterType == typeof(AssetStorageKey));
        Assert.All(
            methods.Where(static method => method.Name.StartsWith("Replace", StringComparison.Ordinal)),
            static method => Assert.Contains(
                method.GetParameters(),
                parameter => parameter.ParameterType == typeof(IReadOnlyCollection<ArticleAssetReferenceWrite>)));
    }

    [Fact]
    public async Task Boundary_ResolvesPublicUrlsOnceAndAggregatesDuplicateReferences()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId first = SeedAsset(db, "illustration/a.png");
        AssetId second = SeedAsset(db, "illustration/b.png");

        ArticleAssetReferenceWrite[] writes = await new ArticleAssetReferenceWriteBoundary(db).ResolveAsync(
            "![zeta](/uploads/illustration/a.png) ![ignored](/uploads/illustration/a.png)",
            "/uploads/illustration/b.png");

        Assert.Equal(2, writes.Length);
        ArticleAssetReferenceWrite firstWrite = Assert.Single(writes, write => write.AssetId == first);
        Assert.Equal(2, firstWrite.ReferenceCount);
        Assert.Equal("zeta", firstWrite.AltText);
        ArticleAssetReferenceWrite secondWrite = Assert.Single(writes, write => write.AssetId == second);
        Assert.Equal(1, secondWrite.ReferenceCount);
        Assert.Null(secondWrite.AltText);
    }

    [Fact]
    public async Task SourceKinds_CreateUpdateAndDeleteUseOneLedger()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId first = SeedAsset(db, "illustration/a.png");
        AssetId second = SeedAsset(db, "illustration/b.png");
        var store = new ArticleAssetReferenceStore(db);

        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Writes(first, 2, " article "));
            await store.ReplaceDraftAsync(7, "draft-key", 42, Writes(first, 3, "draft"));
            await store.ReplaceRevisionAsync(1001, 42, Writes(second, 1, "revision"));
        });

        ContentAssetReference[] created = [.. db.Queryable<ContentAssetReference>().ToList()
            .OrderBy(static reference => reference.SourceKind, StringComparer.Ordinal)];
        Assert.Equal(3, created.Length);
        Assert.Equal(
            [ContentAssetSourceKinds.Article, ContentAssetSourceKinds.Draft, ContentAssetSourceKinds.Revision],
            created.Select(static reference => reference.SourceKind).ToArray());
        Assert.All(created, static reference => Assert.Equal(42, reference.ArticleId));
        Assert.Equal("7:draft-key", created.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Draft).SourceKey);
        Assert.Equal(2, created.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Article).ReferenceCount);
        Assert.Equal("article", created.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Article).AltText);

        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, [
                new(first, 1, "zeta"),
                new(first, 2, "alpha"),
                new(second, 1, null)]);
            await store.RemoveDraftAsync(7, "draft-key");
            await store.RemoveRevisionAsync(1001);
        });

        ContentAssetReference[] updated = db.Queryable<ContentAssetReference>().ToArray();
        Assert.Equal(2, updated.Length);
        ContentAssetReference merged = Assert.Single(updated, reference => reference.AssetId == first.Value);
        Assert.Equal(3, merged.ReferenceCount);
        Assert.Equal("alpha", merged.AltText);

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [first, second]));
        Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
    }

    [Fact]
    public async Task BatchReplace_HasConstantCommandCountAndStableOrderedAssetLock()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId[] assets = [.. Enumerable.Range(0, 10)
            .Select(index => SeedAsset(db, $"illustration/{index}.png"))];
        var store = new ArticleAssetReferenceStore(db);
        var statements = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Add(sql);

        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(41, Writes(assets[0])));
        int singleReferenceCommands = statements.Count;
        statements.Clear();
        await InTransactionAsync(
            db,
            () => store.ReplaceCurrentArticleAsync(
                42,
                [.. assets.Reverse().Select(static assetId => new ArticleAssetReferenceWrite(assetId, 1, null))]));

        Assert.Equal(singleReferenceCommands, statements.Count);
        string lockStatement = Assert.Single(
            statements,
            static sql => sql.Contains("pg_advisory_xact_lock", StringComparison.Ordinal)
                && sql.Contains("unnest", StringComparison.Ordinal));
        Assert.Contains("ORDER BY asset_id", lockStatement, StringComparison.Ordinal);
        Assert.DoesNotContain(statements, static sql => sql.Contains("article_asset_reference", StringComparison.Ordinal)
            || sql.Contains("asset_library_article_ref", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LastReferenceSchedulesPendingDeleteAndReAddCancelsQueue()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/shared.png");
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(41, Writes(assetId)));
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Writes(assetId)));

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([41], [assetId]));
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());

        await InTransactionAsync(db, () => store.RemoveCurrentArticlesAndScheduleAsync([42], [assetId]));
        ContentAssetCleanupQueueItem queued = Assert.Single(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        Assert.Equal(assetId.Value, queued.AssetId);
        Assert.Equal(ContentAssetStates.PendingDelete, db.Queryable<ContentAsset>().InSingle(assetId.Value).State);

        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Writes(assetId)));
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
            await store.ReplaceCurrentArticleAsync(42, Writes(assetId));
            await store.ReplaceRevisionAsync(1001, 42, Writes(assetId));
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
        await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(42, Writes(shared)));

        var rollback = await db.Ado.UseTranAsync(async () =>
        {
            await store.ReplaceCurrentArticleAsync(
                42,
                Writes(AssetId.FromGuid(db.Queryable<ContentAsset>()
                    .Where(asset => asset.StorageKey == "illustration/replacement.png")
                    .Select(asset => asset.AssetId)
                    .Single())));
            throw new InvalidOperationException("force rollback");
        });

        Assert.False(rollback.IsSuccess);
        ContentAssetReference reference = Assert.Single(db.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(shared.Value, reference.AssetId);
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
    }

    [Fact]
    public async Task RevisionRollback_ReplacesCurrentAndAppendsRevisionInOneTransaction()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId original = SeedAsset(db, "illustration/original.png");
        AssetId restored = SeedAsset(db, "illustration/restored.png");
        var store = new ArticleAssetReferenceStore(db);
        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Writes(original));
            await store.ReplaceRevisionAsync(1001, 42, Writes(original));
        });

        await InTransactionAsync(db, async () =>
        {
            await store.ReplaceCurrentArticleAsync(42, Writes(restored));
            await store.ReplaceRevisionAsync(1002, 42, Writes(restored));
        });

        ContentAssetReference[] references = db.Queryable<ContentAssetReference>().ToArray();
        Assert.Equal(3, references.Length);
        Assert.Equal(
            restored.Value,
            references.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Article).AssetId);
        Assert.Equal(
            original.Value,
            references.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Revision
                && reference.SourceKey == "1001").AssetId);
        Assert.Equal(
            restored.Value,
            references.Single(static reference => reference.SourceKind == ContentAssetSourceKinds.Revision
                && reference.SourceKey == "1002").AssetId);
    }

    [Fact]
    public async Task ConcurrentArticleUpdates_AreSerializedBySourceIdentity()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        AssetId first;
        AssetId second;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            first = SeedAsset(setupDb, "illustration/first.png");
            second = SeedAsset(setupDb, "illustration/second.png");
        }

        using var barrier = new Barrier(2);
        await Task.WhenAll(
            StartBarrierReplaceTaskAsync(barrier, connectionString, 42, Writes(first)),
            StartBarrierReplaceTaskAsync(barrier, connectionString, 42, Writes(second)))
            .WaitAsync(TimeSpan.FromSeconds(20));

        using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
        ContentAssetReference reference = Assert.Single(assertDb.Queryable<ContentAssetReference>().ToList());
        Assert.Equal(ContentAssetSourceKinds.Article, reference.SourceKind);
        Assert.Contains(reference.AssetId, new[] { first.Value, second.Value });
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
                await store.ReplaceCurrentArticleAsync(41, Writes(assetId));
                await store.ReplaceCurrentArticleAsync(42, Writes(assetId));
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
                Substitute.For<IPrivateAssetStore>(),
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

    private static Task StartBarrierReplaceTaskAsync(
        Barrier barrier,
        string connectionString,
        int articleId,
        ArticleAssetReferenceWrite[] writes)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(20)));
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var store = new ArticleAssetReferenceStore(db);
                await InTransactionAsync(db, () => store.ReplaceCurrentArticleAsync(articleId, writes));
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static ArticleAssetReferenceWrite[] Writes(
        AssetId assetId,
        int referenceCount = 1,
        string? altText = null)
        => [new(assetId, referenceCount, altText)];
}

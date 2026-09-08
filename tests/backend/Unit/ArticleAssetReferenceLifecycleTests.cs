using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
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
        Assert.Equal(typeof(Task<AssetDeleteOutcome>), method.ReturnType);
        Assert.DoesNotContain(
            typeof(AssetDeleteOutcome).GetMethods(
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static),
            static candidate => candidate.Name == "op_Implicit");
        Assert.DoesNotContain(
            typeof(AssetDeleteOutcome)
                .GetProperties()
                .Concat(typeof(AssetDeleteReferenceSummary).GetProperties())
                .Concat(typeof(AssetDeleteReferenceLocation).GetProperties()),
            static property => property.Name.Contains("Url", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Path", StringComparison.OrdinalIgnoreCase)
                || property.PropertyType == typeof(AssetStorageKey));
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
    public async Task ReferencedDeleteReturnsDeterministicLocatableSourceSummary()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/referenced.png");
        db.Insertable(new[]
        {
            Reference(assetId, ContentAssetSourceKinds.Revision, "1001", 42, 1),
            Reference(assetId, ContentAssetSourceKinds.Article, "42", 42, 2),
            Reference(assetId, ContentAssetSourceKinds.Draft, "7:draft", 42, 3)
        }).ExecuteCommand();
        var store = new LocalContentAssetStore(
            db,
            ReleaseStorageTestPaths.Create(Path.Combine(Path.GetTempPath(), $"fsusblog-delete-summary-{Guid.NewGuid():N}")),
            NullLogger<LocalContentAssetStore>.Instance);

        AssetDeleteOutcome outcome = await store.DeleteAsync(assetId);

        Assert.Equal(AssetDeleteResult.Referenced, outcome.Result);
        AssetDeleteReferenceSummary summary = Assert.IsType<AssetDeleteReferenceSummary>(outcome.ReferenceSummary);
        Assert.Equal(3, summary.SourceCount);
        Assert.False(summary.IsTruncated);
        Assert.Equal(
            [ContentAssetSourceKinds.Article, ContentAssetSourceKinds.Draft, ContentAssetSourceKinds.Revision],
            summary.Locations.Select(static location => location.SourceKind).ToArray());
        Assert.Equal(["42", "7:draft", "1001"], summary.Locations.Select(static location => location.SourceKey).ToArray());
        Assert.Equal([2, 3, 1], summary.Locations.Select(static location => location.ReferenceCount).ToArray());
        Assert.NotNull(db.Queryable<ContentAsset>().InSingle(assetId.Value));
    }

    [Fact]
    public async Task LocalStoreDeleteIsIdempotentForRepeatedDelivery()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/idempotent.png");
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-delete-idempotent-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(root);
            string file = WriteAssetFile(paths, "illustration/idempotent.png");
            var store = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);

            AssetDeleteOutcome first = await store.DeleteAsync(assetId);
            AssetDeleteOutcome replay = await store.DeleteAsync(assetId);

            Assert.Equal(AssetDeleteResult.Deleted, first.Result);
            Assert.Equal(AssetDeleteResult.NotFound, replay.Result);
            Assert.False(File.Exists(file));
            Assert.Empty(db.Queryable<ContentAsset>().ToList());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ReferencedDeleteReportsTotalCountWhenLocationsAreTruncated()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/many-references.png");
        db.Insertable(Enumerable.Range(1, 17)
            .Select(index => Reference(assetId, ContentAssetSourceKinds.Article,
                index.ToString("D2", System.Globalization.CultureInfo.InvariantCulture), index, 1))
            .ToArray()).ExecuteCommand();
        var store = new LocalContentAssetStore(
            db,
            ReleaseStorageTestPaths.Create(Path.Combine(Path.GetTempPath(), $"fsusblog-summary-{Guid.NewGuid():N}")),
            NullLogger<LocalContentAssetStore>.Instance);

        AssetDeleteOutcome outcome = await store.DeleteAsync(assetId);

        Assert.Equal(AssetDeleteResult.Referenced, outcome.Result);
        AssetDeleteReferenceSummary summary = Assert.IsType<AssetDeleteReferenceSummary>(outcome.ReferenceSummary);
        Assert.Equal(17, summary.SourceCount);
        Assert.True(summary.IsTruncated);
        Assert.Equal(16, summary.Locations.Count);
        Assert.Equal("01", summary.Locations[0].SourceKey);
        Assert.Equal("16", summary.Locations[^1].SourceKey);
        Assert.Equal(17, db.Queryable<ContentAssetReference>().Count());
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
    }

    [Theory]
    [InlineData(ContentAssetSourceKinds.Article)]
    [InlineData(ContentAssetSourceKinds.Draft)]
    [InlineData(ContentAssetSourceKinds.Revision)]
    public async Task ReferenceRestoredAfterClaimPreventsPhysicalDeletion(string sourceKind)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        CreateTables(db);
        AssetId assetId = SeedAsset(db, "illustration/claim-restore.png");
        QueueAsset(db, assetId, DateTime.UtcNow.AddMinutes(-1));
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-claim-restore-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(root);
            string file = WriteAssetFile(paths, "illustration/claim-restore.png");
            var physicalStore = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);
            var store = new DelegateAssetStore(async (requested, cancellationToken) =>
            {
                Assert.Equal(assetId, requested);
                Assert.True(db.Queryable<ContentAssetCleanupQueueItem>()
                    .InSingle(assetId.Value).NotBeforeUtc > DateTime.UtcNow);
                using SqlSugarClient restoreDb = PostgresSqlSugarTestClient.Create(connectionString);
                var references = new ArticleAssetReferenceStore(restoreDb);
                await InTransactionAsync(restoreDb, () => sourceKind switch
                {
                    ContentAssetSourceKinds.Article => references.ReplaceCurrentArticleAsync(42, Writes(assetId)),
                    ContentAssetSourceKinds.Draft => references.ReplaceDraftAsync(7, "draft", 42, Writes(assetId)),
                    ContentAssetSourceKinds.Revision => references.ReplaceRevisionAsync(1001, 42, Writes(assetId)),
                    _ => throw new InvalidOperationException("Unexpected source kind.")
                });
                return await physicalStore.DeleteAsync(requested, cancellationToken);
            });
            var cleanup = new ArticleAssetCleanupService(
                db, store, TimeProvider.System, NullLogger<ArticleAssetCleanupService>.Instance);

            Assert.Equal(1, await cleanup.ProcessDueAsync(maxItems: 1));

            Assert.True(File.Exists(file));
            Assert.Equal(ContentAssetStates.Active, db.Queryable<ContentAsset>().InSingle(assetId.Value).State);
            Assert.Equal(sourceKind, Assert.Single(db.Queryable<ContentAssetReference>().ToList()).SourceKind);
            Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task DatabaseDeleteFailureMustNotLeaveActiveAssetWithoutBytes()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/delete-rollback.png");
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-delete-rollback-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(root);
            string file = WriteAssetFile(paths, "illustration/delete-rollback.png");
            await db.Ado.ExecuteCommandAsync("""
                CREATE FUNCTION reject_asset_delete() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'injected asset metadata delete failure';
                END;
                $$;
                CREATE TRIGGER reject_asset_delete BEFORE DELETE ON content_asset
                    FOR EACH ROW EXECUTE FUNCTION reject_asset_delete();
                """);
            var store = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);

            await Assert.ThrowsAsync<InvalidOperationException>(() => store.DeleteAsync(assetId));

            ContentAsset remaining = Assert.IsType<ContentAsset>(
                db.Queryable<ContentAsset>().InSingle(assetId.Value));
            Assert.True(
                File.Exists(file) || remaining.State != ContentAssetStates.Active,
                "A failed metadata transaction must not leave an active asset whose bytes were deleted.");
            if (!File.Exists(file))
            {
                ContentAssetCleanupQueueItem pending = Assert.IsType<ContentAssetCleanupQueueItem>(
                    db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
                Assert.Equal(ContentAssetCleanupMarkers.DeletePending, pending.LastError);
                var references = new ArticleAssetReferenceStore(db);
                var restore = await db.Ado.UseTranAsync(
                    () => references.ReplaceCurrentArticleAsync(42, Writes(assetId)));
                Assert.False(restore.IsSuccess);
                Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
            }

            await db.Ado.ExecuteCommandAsync("DROP TRIGGER reject_asset_delete ON content_asset;");
            AssetDeleteOutcome retried = await store.DeleteAsync(assetId);
            Assert.Equal(AssetDeleteResult.Deleted, retried.Result);
            Assert.False(File.Exists(file));
            Assert.Empty(db.Queryable<ContentAsset>().ToList());
            Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ConcurrentCleanupWorkersClaimDistinctAssetIdsAndDeleteEachOnce()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        AssetId first;
        AssetId second;
        using (SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString))
        {
            CreateTables(setupDb);
            first = SeedAsset(setupDb, "illustration/worker-first.png");
            second = SeedAsset(setupDb, "illustration/worker-second.png");
            QueueAsset(setupDb, first, DateTime.UtcNow.AddMinutes(-2));
            QueueAsset(setupDb, second, DateTime.UtcNow.AddMinutes(-1));
        }

        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-cleanup-workers-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(root);
            string firstFile = WriteAssetFile(paths, "illustration/worker-first.png");
            string secondFile = WriteAssetFile(paths, "illustration/worker-second.png");
            using var barrier = new Barrier(2);

            int[] processed = await Task.WhenAll(
                StartCleanupTaskAsync(barrier, connectionString, paths),
                StartCleanupTaskAsync(barrier, connectionString, paths)).WaitAsync(TimeSpan.FromSeconds(20));

            Assert.Equal([1, 1], processed.Order().ToArray());
            Assert.False(File.Exists(firstFile));
            Assert.False(File.Exists(secondFile));
            using SqlSugarClient assertDb = PostgresSqlSugarTestClient.Create(connectionString);
            Assert.Empty(assertDb.Queryable<ContentAssetCleanupQueueItem>().ToList());
            Assert.Empty(assertDb.Queryable<ContentAsset>().ToList());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupFailureRecordsRetryWithoutPoisoningNextDueAsset()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId poison = SeedAsset(db, "illustration/poison.png");
        AssetId healthy = SeedAsset(db, "illustration/healthy.png");
        DateTime now = DateTime.UtcNow;
        QueueAsset(db, poison, now.AddMinutes(-2));
        QueueAsset(db, healthy, now.AddMinutes(-1));
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-cleanup-retry-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(root);
            string poisonFile = WriteAssetFile(paths, "illustration/poison.png");
            string healthyFile = WriteAssetFile(paths, "illustration/healthy.png");
            var localStore = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);
            var store = new DelegateAssetStore((assetId, cancellationToken) =>
                assetId == poison
                    ? Task.FromException<AssetDeleteOutcome>(new InvalidOperationException("simulated poison item"))
                    : localStore.DeleteAsync(assetId, cancellationToken));
            var cleanup = new ArticleAssetCleanupService(
                db,
                store,
                TimeProvider.System,
                NullLogger<ArticleAssetCleanupService>.Instance);

            Assert.Equal(0, await cleanup.ProcessDueAsync(maxItems: 2));
            ContentAssetCleanupQueueItem retry = db.Queryable<ContentAssetCleanupQueueItem>()
                .InSingle(poison.Value);
            Assert.Equal(1, retry.AttemptCount);
            Assert.Equal("simulated poison item", retry.LastError);
            Assert.True(retry.NotBeforeUtc > now.AddMinutes(10));
            Assert.True(File.Exists(poisonFile));

            Assert.Equal(1, await cleanup.ProcessDueAsync(maxItems: 2));
            Assert.False(File.Exists(healthyFile));
            Assert.NotNull(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(poison.Value));
            Assert.Null(db.Queryable<ContentAssetCleanupQueueItem>().InSingle(healthy.Value));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task CleanupQueueRejectsStaleIdentityAndPassesExactQueuedAssetId()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId queued = SeedAsset(db, "illustration/queued.png");
        AssetId unrelated = SeedAsset(db, "illustration/unrelated.png");
        DateTime due = DateTime.UtcNow.AddMinutes(-1);
        await Assert.ThrowsAnyAsync<Exception>(() => db.Insertable(new ContentAssetCleanupQueueItem
        {
            AssetId = AssetId.New().Value,
            NotBeforeUtc = due,
            AttemptCount = 0,
            UpdatedAtUtc = due
        }).ExecuteCommandAsync());
        QueueAsset(db, queued, due);
        var requested = new List<AssetId>();
        var store = new DelegateAssetStore((assetId, _) =>
        {
            requested.Add(assetId);
            return Task.FromResult<AssetDeleteOutcome>(new(
                AssetDeleteResult.Referenced,
                new AssetDeleteReferenceSummary(
                    1,
                    [new(ContentAssetSourceKinds.Revision, "1001", 42, 1)])));
        });
        var cleanup = new ArticleAssetCleanupService(
            db,
            store,
            TimeProvider.System,
            NullLogger<ArticleAssetCleanupService>.Instance);

        Assert.Equal(1, await cleanup.ProcessDueAsync(maxItems: 1));

        Assert.Equal([queued], requested);
        Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
        Assert.NotNull(db.Queryable<ContentAsset>().InSingle(queued.Value));
        Assert.NotNull(db.Queryable<ContentAsset>().InSingle(unrelated.Value));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CleanupCompletionPreservesNewerDurableDeletionMarker(bool storageFails)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        AssetId assetId = SeedAsset(db, "illustration/cleanup-fence.png");
        QueueAsset(db, assetId, DateTime.UtcNow.AddMinutes(-1));
        var store = new DelegateAssetStore(async (requested, cancellationToken) =>
        {
            Assert.Equal(assetId, requested);
            await db.Updateable<ContentAssetCleanupQueueItem>()
                .SetColumns(item => item.LastError == ContentAssetCleanupMarkers.DeletePending)
                .Where(item => item.AssetId == assetId.Value)
                .ExecuteCommandAsync(cancellationToken);
            if (storageFails)
            {
                throw new IOException("injected storage failure after deletion preparation");
            }

            return new AssetDeleteOutcome(AssetDeleteResult.Referenced);
        });
        var cleanup = new ArticleAssetCleanupService(
            db, store, TimeProvider.System, NullLogger<ArticleAssetCleanupService>.Instance);

        Assert.Equal(storageFails ? 0 : 1, await cleanup.ProcessDueAsync(maxItems: 1));

        ContentAssetCleanupQueueItem pending = Assert.IsType<ContentAssetCleanupQueueItem>(
            db.Queryable<ContentAssetCleanupQueueItem>().InSingle(assetId.Value));
        Assert.Equal(ContentAssetCleanupMarkers.DeletePending, pending.LastError);
        Assert.Equal(storageFails ? 1 : 0, pending.AttemptCount);
        var references = new ArticleAssetReferenceStore(db);
        var restore = await db.Ado.UseTranAsync(
            () => references.ReplaceCurrentArticleAsync(42, Writes(assetId)));
        Assert.False(restore.IsSuccess);
        Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
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
    {
        foreach (EnsureTableStep table in ContentAssetCutoverMigrationDefinitions.BuildMigration()
            .Steps.OfType<EnsureTableStep>())
        {
            db.Ado.ExecuteCommand(table.CreateSql);
        }
    }

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

    private static ContentAssetReference Reference(
        AssetId assetId,
        string sourceKind,
        string sourceKey,
        int? articleId,
        int referenceCount)
        => new()
        {
            AssetId = assetId.Value,
            SourceKind = sourceKind,
            SourceKey = sourceKey,
            ArticleId = articleId,
            ReferenceCount = referenceCount,
            UpdatedAtUtc = DateTime.UtcNow
        };

    private static void QueueAsset(SqlSugarClient db, AssetId assetId, DateTime notBeforeUtc)
    {
        db.Updateable<ContentAsset>()
            .SetColumns(asset => new ContentAsset
            {
                State = ContentAssetStates.PendingDelete,
                UpdatedAtUtc = DateTime.UtcNow
            })
            .Where(asset => asset.AssetId == assetId.Value)
            .ExecuteCommand();
        db.Insertable(new ContentAssetCleanupQueueItem
        {
            AssetId = assetId.Value,
            NotBeforeUtc = notBeforeUtc,
            AttemptCount = 0,
            UpdatedAtUtc = DateTime.UtcNow
        }).ExecuteCommand();
    }

    private static string WriteAssetFile(ReleaseStoragePaths paths, string storageKey)
    {
        string path = Path.Combine(paths.PublicAssetRoot, storageKey.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, [1, 2, 3]);
        return path;
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

    private static Task<int> StartCleanupTaskAsync(
        Barrier barrier,
        string connectionString,
        ReleaseStoragePaths paths)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(20)));
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                var store = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);
                var cleanup = new ArticleAssetCleanupService(
                    db,
                    store,
                    TimeProvider.System,
                    NullLogger<ArticleAssetCleanupService>.Instance);
                return await cleanup.ProcessDueAsync(maxItems: 1);
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static ArticleAssetReferenceWrite[] Writes(
        AssetId assetId,
        int referenceCount = 1,
        string? altText = null)
        => [new(assetId, referenceCount, altText)];

    private sealed class DelegateAssetStore(
        Func<AssetId, CancellationToken, Task<AssetDeleteOutcome>> delete) : IAssetStore
    {
        public Task<AssetDeleteOutcome> DeleteAsync(
            AssetId assetId,
            CancellationToken cancellationToken = default)
            => delete(assetId, cancellationToken);
    }
}

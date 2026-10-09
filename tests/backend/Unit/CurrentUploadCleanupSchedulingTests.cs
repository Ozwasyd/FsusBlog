using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.Articles;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary isolated ledger transactions; no native deletion, token policy or audit replay.</summary>
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentUploadCleanupSchedulingTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Schedule_PreservesReferencesDelayAndRestoredDraftAcrossRepeatedCalls()
    {
        using SqlSugarClient db = await CreateAsync();
        var clock = new Clock();
        var store = new ArticleAssetReferenceStore(db, clock);
        AssetId orphan = await InsertAssetAsync(db, 7);
        AssetId referenced = await InsertAssetAsync(db, 7);
        await db.Insertable(new ContentAssetReference
        {
            AssetId = referenced.Value,
            SourceKind = ContentAssetSourceKinds.Draft,
            SourceKey = "7:existing-draft",
            ReferenceCount = 1
        }).ExecuteCommandAsync();
        var first = await db.Ado.UseTranAsync(() => store.ScheduleUnreferencedOwnedAssetsAsync(7, [referenced, orphan, orphan]));
        Assert.True(first.IsSuccess, first.ErrorMessage);
        ContentAssetCleanupQueueItem queued = Assert.Single(await db.Queryable<ContentAssetCleanupQueueItem>().ToListAsync());
        Assert.Equal(orphan.Value, queued.AssetId);
        Assert.Equal(clock.Now.UtcDateTime + TimeSpan.FromHours(24), queued.NotBeforeUtc);
        Assert.Equal(ContentAssetStates.Active, (await db.Queryable<ContentAsset>().InSingleAsync(referenced.Value)).State);

        clock.Now = clock.Now.AddHours(1);
        var repeated = await db.Ado.UseTranAsync(() => store.ScheduleUnreferencedOwnedAssetsAsync(7, [orphan, referenced]));
        Assert.True(repeated.IsSuccess, repeated.ErrorMessage);
        Assert.Equal(queued.NotBeforeUtc, (await db.Queryable<ContentAssetCleanupQueueItem>().InSingleAsync(orphan.Value)).NotBeforeUtc);
        Assert.Equal(1, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());

        var restored = await db.Ado.UseTranAsync(() => store.ReplaceDraftAsync(7, "restored-draft", null, [new(orphan, 1, null)]));
        Assert.True(restored.IsSuccess, restored.ErrorMessage);
        Assert.Equal(0, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        Assert.Equal(ContentAssetStates.Active, (await db.Queryable<ContentAsset>().InSingleAsync(orphan.Value)).State);
        Assert.Equal(2, await db.Queryable<ContentAssetReference>().CountAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Schedule_MissingOrForeignAssetCannotPartiallyQueueOwnedCandidate(bool missing)
    {
        using SqlSugarClient db = await CreateAsync();
        AssetId owned = await InsertAssetAsync(db, 7);
        AssetId other = missing ? AssetId.New() : await InsertAssetAsync(db, 8);
        var store = new ArticleAssetReferenceStore(db);
        var transaction = await db.Ado.UseTranAsync(() => store.ScheduleUnreferencedOwnedAssetsAsync(7, [owned, other]));
        Assert.False(transaction.IsSuccess);
        Assert.Equal("content_asset_cleanup_owner_or_asset_changed", transaction.ErrorException!.Message);
        Assert.Equal(0, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        Assert.Equal(ContentAssetStates.Active, (await db.Queryable<ContentAsset>().InSingleAsync(owned.Value)).State);
    }

    [Fact]
    public async Task Schedule_OuterTransactionRollbackRestoresBothAssetAndQueue()
    {
        using SqlSugarClient db = await CreateAsync();
        AssetId owned = await InsertAssetAsync(db, 7);
        var store = new ArticleAssetReferenceStore(db);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await store.ScheduleUnreferencedOwnedAssetsAsync(7, [owned]);
            Assert.Equal(1, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
            throw new InvalidOperationException("controlled-outer-rollback");
        });
        Assert.False(transaction.IsSuccess);
        Assert.Equal("controlled-outer-rollback", transaction.ErrorException!.Message);
        Assert.Equal(0, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        Assert.Equal(ContentAssetStates.Active, (await db.Queryable<ContentAsset>().InSingleAsync(owned.Value)).State);
    }

    [Fact]
    public async Task Schedule_RequiresCallerTransactionBeforeAnyQueueMutation()
    {
        using SqlSugarClient db = await CreateAsync();
        AssetId owned = await InsertAssetAsync(db, 7);
        var store = new ArticleAssetReferenceStore(db);
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.ScheduleUnreferencedOwnedAssetsAsync(7, [owned]));
        Assert.Equal("content_asset_cleanup_transaction_required", failure.Message);
        Assert.Equal(0, await db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        Assert.Equal(ContentAssetStates.Active, (await db.Queryable<ContentAsset>().InSingleAsync(owned.Value)).State);
    }

    private async Task<SqlSugarClient> CreateAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        db.CodeFirst.InitTables<ContentAsset, ContentAssetReference, ContentAssetCleanupQueueItem>();
        return db;
    }

    private static async Task<AssetId> InsertAssetAsync(SqlSugarClient db, long owner)
    {
        AssetId assetId = AssetId.New();
        await db.Insertable(new ContentAsset
        {
            AssetId = assetId.Value,
            StorageClass = "public",
            StorageKey = "illustration/" + assetId.Value.ToString("N") + ".png",
            MimeType = "image/png",
            Extension = ".png",
            SizeBytes = 68,
            Sha256 = new('a', 64),
            OwnerAdminPrincipalId = owner,
            State = ContentAssetStates.Active
        }).ExecuteCommandAsync();
        return assetId;
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = new(2026, 10, 9, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }
}

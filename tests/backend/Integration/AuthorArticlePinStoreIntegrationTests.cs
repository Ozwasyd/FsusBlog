using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorArticlePinStoreIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Fact]
    public async Task Store_EnforcesCasIdempotencyOrderingIsolationAndZeroArticleMutation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync(64);
        var store = new AuthorArticlePinStore(db, TimeProvider.System);
        ArticleMetadata baseline = await ReadArticleMetadataAsync(db, 1);

        AuthorArticlePinCollectionSnapshot empty = await store.GetAuthoritySnapshotAsync(s_owner);
        Assert.Equal(0, empty.Revision);
        Assert.Empty(empty.Pins);
        await Assert.ThrowsAsync<AuthorArticlePinAccessDeniedException>(() => store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 9999, 0, Guid.CreateVersion7())));
        await db.Ado.ExecuteCommandAsync("UPDATE article SET isdeleted = TRUE, status = 4 WHERE id = 8;");
        await Assert.ThrowsAsync<AuthorArticlePinAccessDeniedException>(() => store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 8, 0, Guid.CreateVersion7())));

        Guid firstRequest = Guid.CreateVersion7();
        var firstCommand = new AddAuthorArticlePinCommand(s_owner, 1, 0, firstRequest);
        AuthorArticlePinWriteReceipt first = await store.AddAsync(firstCommand);
        AuthorArticlePinWriteReceipt replay = await store.AddAsync(firstCommand);
        Assert.Equal("applied", first.Status);
        Assert.Equal(1, first.Revision);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(first.ReceiptId, replay.ReceiptId);
        await Assert.ThrowsAsync<AuthorArticlePinIdempotencyConflictException>(() => store.AddAsync(
            firstCommand with
            {
                ArticleId = 2
            }));

        AuthorArticlePinWriteReceipt duplicate = await store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 1, 1, Guid.CreateVersion7()));
        Assert.Equal("noop", duplicate.Status);
        Assert.Equal("already-present", duplicate.ReasonCode);
        Assert.Equal(1, duplicate.Revision);

        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(
            db.CurrentConnectionConfig.ConnectionString);
        var secondStore = new AuthorArticlePinStore(secondDb, TimeProvider.System);
        var rapidCommand = new AddAuthorArticlePinCommand(s_owner, 2, 1, Guid.CreateVersion7());
        AuthorArticlePinWriteReceipt[] rapid = await Task.WhenAll(
            store.AddAsync(rapidCommand),
            secondStore.AddAsync(rapidCommand));
        Assert.Equal(rapid[0].ReceiptId, rapid[1].ReceiptId);
        Assert.Single(rapid, static receipt => receipt.IdempotentReplay);

        long revision = rapid[0].Revision;
        for (int articleId = 3; articleId <= 4; articleId++)
        {
            AuthorArticlePinWriteReceipt added = await store.AddAsync(
                new AddAuthorArticlePinCommand(s_owner, articleId, revision, Guid.CreateVersion7()));
            revision = added.Revision;
        }
        await Assert.ThrowsAsync<AuthorArticlePinRevisionConflictException>(() => secondStore.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 5, 1, Guid.CreateVersion7())));

        revision = (await store.ReorderAsync(new ReorderAuthorArticlePinsCommand(
            s_owner, revision, Guid.CreateVersion7(), [4], null))).Revision;
        Assert.Equal(new[] { 4, 1, 2, 3 }, await ReadOrderAsync(store));
        revision = (await store.ReorderAsync(new ReorderAuthorArticlePinsCommand(
            s_owner, revision, Guid.CreateVersion7(), [4], 1))).Revision;
        Assert.Equal(new[] { 1, 4, 2, 3 }, await ReadOrderAsync(store));
        revision = (await store.ReorderAsync(new ReorderAuthorArticlePinsCommand(
            s_owner, revision, Guid.CreateVersion7(), [4], 3))).Revision;
        Assert.Equal(new[] { 1, 2, 3, 4 }, await ReadOrderAsync(store));
        AuthorArticlePinWriteReceipt batch = await store.ReorderAsync(new ReorderAuthorArticlePinsCommand(
            s_owner, revision, Guid.CreateVersion7(), [3, 4], null));
        revision = batch.Revision;
        Assert.Equal(new[] { 3, 4, 1, 2 }, await ReadOrderAsync(store));
        Assert.Equal([3, 4], batch.ArticleIds);
        Assert.Null(batch.AfterArticleId);

        AuthorArticlePinWriteReceipt missing = await store.RemoveAsync(
            new RemoveAuthorArticlePinCommand(s_owner, 60, revision, Guid.CreateVersion7()));
        Assert.Equal("noop", missing.Status);
        Assert.Equal(revision, missing.Revision);
        AuthorArticlePinWriteReceipt removed = await store.RemoveAsync(
            new RemoveAuthorArticlePinCommand(s_owner, 4, revision, Guid.CreateVersion7()));
        revision = removed.Revision;
        Assert.DoesNotContain(4, await ReadOrderAsync(store));

        Assert.Empty((await store.GetAuthoritySnapshotAsync(new AuthorArticlePinOwner(2, "primary-site"))).Pins);
        Assert.Empty((await store.GetAuthoritySnapshotAsync(new AuthorArticlePinOwner(1, "secondary-site"))).Pins);
        Assert.Equal(baseline, await ReadArticleMetadataAsync(db, 1));

        AuthorArticlePinVerificationResult valid = await store.VerifyAsync(s_owner);
        Assert.True(valid.Valid, string.Join(',', valid.Reasons));
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_article_pin_idempotency SET content_digest = @Digest WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site' AND request_id = @RequestId;",
            new SugarParameter("@Digest", new string('f', 64)),
            new SugarParameter("@RequestId", firstRequest));
        AuthorArticlePinVerificationResult receiptTamper = await store.VerifyAsync(s_owner);
        Assert.Contains(receiptTamper.Reasons, reason => reason == $"receipt_idempotency_mismatch:{firstRequest:D}");
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_article_pin_idempotency SET content_digest = @Digest WHERE owner_admin_principal_id = 1 AND site_scope = 'primary-site' AND request_id = @RequestId;",
            new SugarParameter("@Digest", first.ContentDigest),
            new SugarParameter("@RequestId", firstRequest));

        AuthorArticlePinCollectionSnapshot snapshot = await store.GetAuthoritySnapshotAsync(s_owner);
        Guid tamperedPin = snapshot.Pins[0].PinId;
        await db.Ado.ExecuteCommandAsync(
            "UPDATE author_article_pin SET content_digest = @Digest WHERE pin_id = @PinId;",
            new SugarParameter("@Digest", new string('e', 64)),
            new SugarParameter("@PinId", tamperedPin));
        AuthorArticlePinVerificationResult pinTamper = await store.VerifyAsync(s_owner);
        Assert.Contains(pinTamper.Reasons, reason => reason == $"pin_digest_mismatch:{tamperedPin:D}");
        await Assert.ThrowsAsync<AuthorArticlePinTamperDetectedException>(() => store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 5, revision, Guid.CreateVersion7())));
    }

    [Fact]
    public async Task Snapshot_IsAtomicAcrossConcurrentWrites_AndCancellationRollsBackBeforeCommit()
    {
        using SqlSugarClient db = await CreateDatabaseAsync(64);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient readerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var writer = new AuthorArticlePinStore(writerDb, TimeProvider.System);
        var reader = new AuthorArticlePinStore(readerDb, TimeProvider.System);

        Task writerTask = Task.Run(async () =>
        {
            long revision = 0;
            for (int articleId = 1; articleId <= 32; articleId++)
            {
                revision = (await writer.AddAsync(new AddAuthorArticlePinCommand(
                    s_owner, articleId, revision, Guid.CreateVersion7()))).Revision;
            }
        });
        Task readerTask = Task.Run(async () =>
        {
            for (int iteration = 0; iteration < 48; iteration++)
            {
                AuthorArticlePinCollectionSnapshot snapshot = await reader.GetAuthoritySnapshotAsync(s_owner);
                Assert.Equal(snapshot.ItemCount, snapshot.Pins.Count);
                Assert.Equal(
                    snapshot.ContentDigest,
                    AuthorArticlePinContract.ComputeCollectionDigest(s_owner, snapshot.Revision, snapshot.Pins));
            }
        });
        await Task.WhenAll(writerTask, readerTask);

        AuthorArticlePinOwner cancelledOwner = new(1, "cancelled-site");
        using SqlSugarClient lockHolder = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        lockHolder.Ado.BeginTran();
        _ = await lockHolder.Ado.GetScalarAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
            new SugarParameter("@Identity", "author-article-pins:1:cancelled-site"));
        using var cancellation = new CancellationTokenSource();
        Task<AuthorArticlePinWriteReceipt> pending = writer.AddAsync(
            new AddAuthorArticlePinCommand(cancelledOwner, 40, 0, Guid.CreateVersion7()),
            cancellation.Token);
        await Task.Delay(100);
        Assert.False(pending.IsCompleted);
        cancellation.Cancel();
        lockHolder.Ado.RollbackTran();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Empty((await reader.GetAuthoritySnapshotAsync(cancelledOwner)).Pins);
    }

    [Fact]
    public async Task Store_UsesBoundedSetOperationsAtOneThousandPins_AndMigrationIsIdempotent()
    {
        using SqlSugarClient db = await CreateDatabaseAsync(1_100);
        var store = new AuthorArticlePinStore(db, TimeProvider.System);
        Guid[] pinIds = Enumerable.Range(1, AuthorArticlePinContract.MaxPinsPerOwner)
            .Select(index => Guid.Parse($"01991f50-8850-7f63-82ab-{index:000000000000}"))
            .ToArray();
        int[] articleIds = Enumerable.Range(1, AuthorArticlePinContract.MaxPinsPerOwner).ToArray();
        long[] orderKeys = articleIds.Select(index => index * AuthorArticlePinContract.OrderKeyGap).ToArray();
        AuthorArticlePin[] pins = articleIds.Select((articleId, index) => new AuthorArticlePin(
            pinIds[index],
            articleId,
            orderKeys[index],
            1,
            1,
            AuthorArticlePinContract.ComputePinDigest(s_owner, pinIds[index], articleId, orderKeys[index], 1, 1)))
            .ToArray();
        string digest = AuthorArticlePinContract.ComputeCollectionDigest(s_owner, 1, pins);
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_article_pin_collection(
                owner_admin_principal_id, site_scope, schema_version, revision,
                item_count, updated_at_utc, content_digest)
            VALUES (1, 'primary-site', 1, 1, 1000, CURRENT_TIMESTAMP, @CollectionDigest);
            """,
            new SugarParameter("@CollectionDigest", digest));
        await SeedPinsAsync(db, pins);

        Assert.Equal(1_000, (await store.GetAuthoritySnapshotAsync(s_owner)).ItemCount);
        await Assert.ThrowsAsync<AuthorArticlePinBudgetExceededException>(() => store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 1_001, 1, Guid.CreateVersion7())));

        int[] moved = Enumerable.Range(937, 64).ToArray();
        AuthorArticlePinWriteReceipt reordered = await store.ReorderAsync(
            new ReorderAuthorArticlePinsCommand(s_owner, 1, Guid.CreateVersion7(), moved, null));
        Assert.Equal(2, reordered.Revision);
        Assert.False(reordered.Rebalanced);
        Assert.Equal(moved, (await ReadOrderAsync(store)).Take(64));
        AuthorArticlePinWriteReceipt removed = await store.RemoveAsync(
            new RemoveAuthorArticlePinCommand(s_owner, 500, reordered.Revision, Guid.CreateVersion7()));
        AuthorArticlePinWriteReceipt restored = await store.AddAsync(
            new AddAuthorArticlePinCommand(s_owner, 1_001, removed.Revision, Guid.CreateVersion7()));
        Assert.Equal(1_000, restored.ItemCount);
        Assert.True((await store.VerifyAsync(s_owner)).Valid);

        await ApplyMigrationAsync(db);
        Assert.Equal(4, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'author_article_pin%';"));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync(int articleCount)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            $"""
            CREATE TABLE admin_principal(id bigint PRIMARY KEY);
            INSERT INTO admin_principal(id) VALUES (1), (2);
            CREATE TABLE article(
                id integer PRIMARY KEY,
                title varchar(256) NOT NULL,
                slug varchar(256) NOT NULL,
                source_hash varchar(64) NOT NULL,
                category_id integer NOT NULL,
                status integer NOT NULL,
                isdeleted boolean NOT NULL,
                views integer NOT NULL,
                current_revision_id bigint NULL,
                metadata_updated_at timestamp without time zone NOT NULL);
            INSERT INTO article(
                id, title, slug, source_hash, category_id, status, isdeleted,
                views, current_revision_id, metadata_updated_at)
            SELECT value,
                   CASE WHEN value <= 2 THEN 'duplicate title' ELSE 'article-' || value END,
                   CASE WHEN value <= 2 THEN 'duplicate-slug' ELSE 'article-' || value END,
                   CASE WHEN value <= 2 THEN 'same-source' ELSE md5(value::text) END,
                   7, 0, FALSE, 31, 700 + value, TIMESTAMP '2026-09-04 00:00:00'
            FROM generate_series(1, {articleCount}) AS value;
            """);
        await ApplyMigrationAsync(db);
        return db;
    }

    private static async Task ApplyMigrationAsync(SqlSugarClient db)
    {
        ISchemaMigrationDescriptor migration = AuthorArticlePinMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
    }

    private static async Task SeedPinsAsync(SqlSugarClient db, IReadOnlyList<AuthorArticlePin> pins)
    {
        const int BatchSize = 250;
        for (int offset = 0; offset < pins.Count; offset += BatchSize)
        {
            int count = Math.Min(BatchSize, pins.Count - offset);
            var values = new System.Text.StringBuilder();
            var parameters = new List<SugarParameter>(count * 4);
            for (int index = 0; index < count; index++)
            {
                int parameterIndex = offset + index;
                if (index > 0)
                {
                    values.Append(',');
                }
                values.Append($"(@PinId{parameterIndex}, 1, 'primary-site', @ArticleId{parameterIndex}, @OrderKey{parameterIndex}, 1, 1, @Digest{parameterIndex})");
                AuthorArticlePin pin = pins[parameterIndex];
                parameters.Add(new SugarParameter($"@PinId{parameterIndex}", pin.PinId));
                parameters.Add(new SugarParameter($"@ArticleId{parameterIndex}", pin.ArticleId));
                parameters.Add(new SugarParameter($"@OrderKey{parameterIndex}", pin.OrderKey));
                parameters.Add(new SugarParameter($"@Digest{parameterIndex}", pin.ContentDigest));
            }

            await db.Ado.ExecuteCommandAsync(
                $"""
                INSERT INTO author_article_pin(
                    pin_id, owner_admin_principal_id, site_scope, article_id, order_key,
                    created_revision, updated_revision, content_digest)
                VALUES {values};
                """,
                parameters.ToArray());
        }
    }

    private static async Task<int[]> ReadOrderAsync(IAuthorArticlePinStore store)
        => [.. (await store.GetAuthoritySnapshotAsync(s_owner)).Pins.Select(static pin => pin.ArticleId)];

    private static async Task<ArticleMetadata> ReadArticleMetadataAsync(SqlSugarClient db, int articleId)
    {
        System.Data.DataTable table = await db.Ado.GetDataTableAsync(
            """
            SELECT title, slug, source_hash, category_id, status, isdeleted,
                   views, current_revision_id, metadata_updated_at
            FROM article WHERE id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", articleId));
        System.Data.DataRow row = table.Rows[0];
        return new ArticleMetadata(
            (string)row["title"],
            (string)row["slug"],
            (string)row["source_hash"],
            (int)row["category_id"],
            (int)row["status"],
            (bool)row["isdeleted"],
            (int)row["views"],
            Convert.ToInt64(row["current_revision_id"], System.Globalization.CultureInfo.InvariantCulture),
            (DateTime)row["metadata_updated_at"]);
    }

    private sealed record ArticleMetadata(
        string Title,
        string Slug,
        string SourceHash,
        int CategoryId,
        int Status,
        bool IsDeleted,
        int Views,
        long CurrentRevisionId,
        DateTime MetadataUpdatedAt);
}

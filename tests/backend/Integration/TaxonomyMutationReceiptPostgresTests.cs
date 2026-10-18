using System.Collections.Immutable;
using System.Data;
using System.Text.Json;

using Npgsql;

using SqlSugar;

using static FsusBlog.Server.Services.Taxonomy.TaxonomyMutationReceiptPersistence;

using ArticleSourceGenerationAuthority = FsusBlog.Server.Services.Articles.ArticleSourceGenerationAuthority;
using BinaryEndpoints = FsusBlog.Server.Modules.Endpoints.Binary.BinaryEndpoints;
using RawSqlStep = FsusBlog.Migration.RawSqlStep;
using TaxonomyMutationReceiptMigrationDefinitions = FsusBlog.Migration.Definitions.TaxonomyMutationReceiptMigrationDefinitions;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class TaxonomyMutationReceiptPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task OriginalCreate_SameTransactionReceiptVisibleOnlyAfterCommit_WithoutCounterAllocation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        object transaction = db.Ado.Transaction;
        Capture capture = await CaptureCreateAsync(db, TargetKind.Category, "original category");
        int id = await BinaryEndpoints.CreateCategoryAsync(db, "original category", "real description", CancellationToken.None);
        Receipt receipt = await PersistAsync(db, capture, id, 1);
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Null(receipt.Before);
        Assert.Equal(new Identity(id, "original category", "real description"), receipt.After);
        Assert.Empty(receipt.AffectedArticleIds);
        Assert.Equal(1, await CountAsync(db));
        Assert.Equal(0, await CountAsync(observer));
        Assert.Equal(0, await observer.Queryable<Category>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(observer));
        Assert.Equal(id, (await observer.Queryable<Category>().SingleAsync()).Id);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        using JsonDocument facts = JsonDocument.Parse(await observer.Ado.GetStringAsync(
            "SELECT receipt_facts FROM taxonomy_mutation_receipt;"));
        Assert.Equal("create", facts.RootElement.GetProperty("Operation").GetString());
        Assert.Equal(receipt.ReceiptId, facts.RootElement.GetProperty("ReceiptId").GetGuid());
    }

    [Fact]
    public async Task DescriptionOnly_CapturesExactBeforeAfterAndRealArticleIds()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = await BinaryEndpoints.CreateCategoryAsync(db, "category", "before", CancellationToken.None);
        int first = await InsertArticleAsync(db, id, "first");
        int second = await InsertArticleAsync(db, id, "second");
        int other = await BinaryEndpoints.CreateCategoryAsync(db, "other", null, CancellationToken.None);
        _ = await InsertArticleAsync(db, other, "unrelated");
        db.Ado.BeginTran();
        Capture capture = await CaptureExistingAsync(db, TargetKind.Category, MutationOperation.Update, id);
        int affected = await db.Updateable<Category>().SetColumns(row => row.Description == "after")
            .Where(row => row.Id == id).ExecuteCommandAsync();
        Receipt receipt = await PersistAsync(db, capture, id, affected);
        Assert.Equal(new Identity(id, "category", "before"), receipt.Before);
        Assert.Equal(new Identity(id, "category", "after"), receipt.After);
        Assert.Equal([first, second], receipt.AffectedArticleIds.ToArray());
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task OriginalUnlinkedTagDelete_PreservesActualDeletedIdentity()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = await BinaryEndpoints.CreateTagAsync(db, "真实标签", "retained identity", CancellationToken.None);
        db.Ado.BeginTran();
        Capture capture = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Delete, id);
        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, id));
        Receipt receipt = await PersistAsync(db, capture, id, 1);
        Assert.Equal(new Identity(id, "真实标签", "retained identity"), receipt.Before);
        Assert.Null(receipt.After);
        Assert.Empty(receipt.AffectedArticleIds);
        db.Ado.CommitTran();
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
        Assert.Equal("真实标签", await db.Ado.GetStringAsync(
            "SELECT before_identity->>'Name' FROM taxonomy_mutation_receipt;"));
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Delete, id));
        db.Ado.RollbackTran();
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task RollbackAndRetry_RequireFreshCaptureAndRetainOnlyCommittedReceipt()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        Capture abandoned = await CaptureCreateAsync(db, TargetKind.Tag, "retry");
        int abandonedId = await BinaryEndpoints.CreateTagAsync(db, "retry", "before rollback", CancellationToken.None);
        Receipt rolledBack = await PersistAsync(db, abandoned, abandonedId, 1);
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, abandoned, abandonedId, 1));
        Capture retry = await CaptureCreateAsync(db, TargetKind.Tag, "retry");
        int id = await BinaryEndpoints.CreateTagAsync(db, "retry", "committed retry", CancellationToken.None);
        Receipt committed = await PersistAsync(db, retry, id, 1);
        Assert.NotEqual(rolledBack.ReceiptId, committed.ReceiptId);
        Receipt replay = await PersistAsync(db, retry, id, 1);
        Assert.Equal(committed.ReceiptId, replay.ReceiptId);
        Assert.Equal(committed.After, replay.After);
        Assert.Equal(1, await CountAsync(db));
        db.Ado.CommitTran();
        Assert.Equal("committed retry", (await db.Queryable<Tag>().SingleAsync()).Description);
    }

    [Fact]
    public async Task CasFailureAndSuccessfulSqlNoOp_ProduceNoReceipt()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = await BinaryEndpoints.CreateCategoryAsync(db, "CAS", "current", CancellationToken.None);
        db.Ado.BeginTran();
        Capture capture = await CaptureExistingAsync(db, TargetKind.Category, MutationOperation.Update, id);
        int affected = await db.Updateable<Category>().SetColumns(row => row.Description == "stale write")
            .Where(row => row.Id == id && row.Description == "stale").ExecuteCommandAsync();
        Assert.Equal(0, affected);
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, capture, id, affected));
        int noOp = await db.Updateable<Category>().SetColumns(row => row.Description == "current")
            .Where(row => row.Id == id).ExecuteCommandAsync();
        Assert.Equal(1, noOp);
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, capture, id, noOp));
        Assert.Equal(0, await CountAsync(db));
        db.Ado.RollbackTran();
    }

    [Fact]
    public async Task RolledBackCapture_CannotMisidentifySubsequentlyDeletedRow()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient foreign = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        int id = await BinaryEndpoints.CreateTagAsync(db, "captured identity", "captured description", CancellationToken.None);
        db.Ado.BeginTran();
        await db.Ado.ExecuteCommandAsync("SAVEPOINT before_capture;");
        Capture stale = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Delete, id);
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT before_capture;");
        Assert.Equal(1, await foreign.Updateable<Tag>().SetColumns(row => row.Name == "actual latest identity")
            .Where(row => row.Id == id).ExecuteCommandAsync());
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, id));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, stale, id, 1));
        Assert.Equal("taxonomy_receipt_capture_rolled_back", error.Message);
        db.Ado.RollbackTran();
        Assert.Equal("actual latest identity", (await db.Queryable<Tag>().SingleAsync()).Name);
        Assert.Equal(0, await CountAsync(db));
    }

    [Fact]
    public async Task ForeignClientAndForeignTransaction_RefuseCapturedIdentity()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient foreign = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "owner");
        int id = await BinaryEndpoints.CreateTagAsync(db, "owner", null, CancellationToken.None);
        foreign.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(foreign, capture, id, 1));
        foreign.Ado.RollbackTran();
        // A second SqlSugar client pointing at the very same connection/transaction is still not the owner.
        System.Data.IDbConnection foreignConnection = foreign.Ado.Connection;
        foreign.Ado.Connection = db.Ado.Connection;
        foreign.Ado.Transaction = db.Ado.Transaction;
        try
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(foreign, capture, id, 1));
        }
        finally
        {
            foreign.Ado.Transaction = null;
            foreign.Ado.Connection = foreignConnection;
        }
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    public async Task UnsupportedIsolation_RefusesBeforeDml(IsolationLevel isolation)
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran(isolation);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CaptureCreateAsync(db, TargetKind.Category, "invalid"));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
    }

    [Fact]
    public async Task MissingTransactionWrongProviderAndPreCanceledCalls_RefuseWithoutReceipts()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => CaptureCreateAsync(db, TargetKind.Category, "no transaction"));
        using var wrongProvider = new SqlSugarClient(new ConnectionConfig
        {
            DbType = SqlSugar.DbType.Sqlite,
            ConnectionString = "Data Source=:memory:",
            InitKeyType = InitKeyType.Attribute
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => CaptureCreateAsync(wrongProvider, TargetKind.Tag, "wrong"));
        db.Ado.BeginTran();
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CaptureCreateAsync(db, TargetKind.Tag, "cancel", canceled.Token));
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "cancel");
        int id = await BinaryEndpoints.CreateTagAsync(db, "cancel", null, CancellationToken.None);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PersistAsync(db, capture, id, 1, canceled.Token));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
    }

    [Fact]
    public async Task Batch_UsesEveryRealTargetAndSortedDistinctActualLinks()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int category = await BinaryEndpoints.CreateCategoryAsync(db, "linked", null, CancellationToken.None);
        int first = await InsertArticleAsync(db, category, "first");
        int second = await InsertArticleAsync(db, category, "second");
        var completions = new List<Completion>();
        db.Ado.BeginTran();
        for (int i = 0; i < 105; i++)
        {
            string name = $"batch-{i}";
            Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, name);
            int id = await BinaryEndpoints.CreateTagAsync(db, name, null, CancellationToken.None);
            if (i == 0)
            {
                await db.Insertable(new[]
                {
                    new ArticleTag { ArticleId = second, TagId = id },
                    new ArticleTag { ArticleId = first, TagId = id }
                }).ExecuteCommandAsync();
            }
            completions.Add(new Completion(capture, id, 1));
        }
        ImmutableArray<Receipt> receipts = await PersistBatchAsync(db, completions);
        Assert.Equal(105, receipts.Length);
        Assert.Equal(105, receipts.Select(row => row.ReceiptId).Distinct().Count());
        Assert.Equal([first, second], receipts[0].AffectedArticleIds.ToArray());
        Assert.All(receipts.Skip(1), row => Assert.Empty(row.AffectedArticleIds));
        Assert.Equal(105, await CountAsync(db));
        db.Ado.CommitTran();
        Assert.Equal(105, await CountAsync(db));
    }

    [Fact]
    public async Task InvalidBatchAndLateInsertFailure_RollBackOriginalDmlAndAllReceipts()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        Capture first = await CaptureCreateAsync(db, TargetKind.Tag, "first");
        int firstId = await BinaryEndpoints.CreateTagAsync(db, "first", null, CancellationToken.None);
        Capture second = await CaptureCreateAsync(db, TargetKind.Tag, "second");
        int secondId = await BinaryEndpoints.CreateTagAsync(db, "second", null, CancellationToken.None);
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistBatchAsync(db,
            [new Completion(first, firstId, 1), new Completion(second, secondId, 0)]));
        Assert.Equal(0, await CountAsync(db));
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistBatchAsync(db,
            [new Completion(first, firstId, 1), new Completion(first, firstId, 1)]));
        await db.Ado.ExecuteCommandAsync("""
            ALTER TABLE taxonomy_mutation_receipt ADD CONSTRAINT reject_second
                CHECK (after_identity->>'Name' <> 'second');
            """);
        await db.Ado.ExecuteCommandAsync("SAVEPOINT before_receipt_batch;");
        await Assert.ThrowsAsync<PostgresException>(() => PersistBatchAsync(db,
            [new Completion(first, firstId, 1), new Completion(second, secondId, 1)]));
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT before_receipt_batch;");
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(2, await db.Queryable<Tag>().CountAsync());
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
    }

    [Fact]
    public async Task InFlightReceiptInsertCancellation_RollsBackOriginalDml()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION delay_taxonomy_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_sleep(5);
                RETURN NEW;
            END $$;
            CREATE TRIGGER delay_taxonomy_receipt_test BEFORE INSERT ON taxonomy_mutation_receipt
                FOR EACH ROW EXECUTE FUNCTION delay_taxonomy_receipt_test();
            """);
        db.Ado.BeginTran();
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "cancel during insert");
        int id = await BinaryEndpoints.CreateTagAsync(db, "cancel during insert", null, CancellationToken.None);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PersistAsync(db, capture, id, 1, cancellation.Token));
        Assert.True(cancellation.IsCancellationRequested);
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
    }

    [Fact]
    public async Task MixedBatch_CapturesCreateRenameAndPhysicalDeleteIdentities()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int category = await BinaryEndpoints.CreateCategoryAsync(db, "existing category", null, CancellationToken.None);
        int article = await InsertArticleAsync(db, category, "linked article");
        int renameId = await BinaryEndpoints.CreateTagAsync(db, "old tag", "old description", CancellationToken.None);
        int deleteId = await BinaryEndpoints.CreateTagAsync(db, "deleted tag", "deleted description", CancellationToken.None);
        await db.Insertable(new ArticleTag { ArticleId = article, TagId = renameId }).ExecuteCommandAsync();
        db.Ado.BeginTran();
        Capture create = await CaptureCreateAsync(db, TargetKind.Category, "new category");
        Capture rename = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Update, renameId);
        Capture delete = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Delete, deleteId);
        int createId = await BinaryEndpoints.CreateCategoryAsync(db, "new category", "created description", CancellationToken.None);
        int renamed = await db.Updateable<Tag>().SetColumns(row => row.Name == "renamed tag")
            .Where(row => row.Id == renameId).ExecuteCommandAsync();
        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, deleteId));
        ImmutableArray<Receipt> receipts = await PersistBatchAsync(db,
            [new Completion(create, createId, 1), new Completion(rename, renameId, renamed), new Completion(delete, deleteId, 1)]);
        Assert.Equal(new Identity(createId, "new category", "created description"), receipts[0].After);
        Assert.Equal(new Identity(renameId, "old tag", "old description"), receipts[1].Before);
        Assert.Equal(new Identity(renameId, "renamed tag", "old description"), receipts[1].After);
        Assert.Equal([article], receipts[1].AffectedArticleIds.ToArray());
        Assert.Equal(new Identity(deleteId, "deleted tag", "deleted description"), receipts[2].Before);
        Assert.Null(receipts[2].After);
        db.Ado.CommitTran();
        Assert.Equal(3, await CountAsync(db));
    }

    [Fact]
    public async Task AbsentOriginalDmlAndWrongTarget_CannotProduceReceipt()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = await BinaryEndpoints.CreateTagAsync(db, "existing", "unchanged", CancellationToken.None);
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() => CaptureCreateAsync(db, TargetKind.Tag, "existing"));
        Capture create = await CaptureCreateAsync(db, TargetKind.Tag, "not inserted");
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, create, id, 1));
        Capture update = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Update, id);
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, update, id, 1));
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, update, id + 1, 1));
        Capture delete = await CaptureExistingAsync(db, TargetKind.Tag, MutationOperation.Delete, id);
        await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, delete, id, 1));
        Assert.Equal(0, await CountAsync(db));
        db.Ado.RollbackTran();
    }

    [Theory]
    [InlineData("UPDATE taxonomy_mutation_receipt SET target_id = target_id;")]
    [InlineData("DELETE FROM taxonomy_mutation_receipt;")]
    [InlineData("TRUNCATE taxonomy_mutation_receipt;")]
    public async Task PersistedReceipts_AreImmutable(string sql)
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "immutable");
        int id = await BinaryEndpoints.CreateTagAsync(db, "immutable", "retained", CancellationToken.None);
        _ = await PersistAsync(db, capture, id, 1);
        db.Ado.CommitTran();
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(sql));
        Assert.Contains("taxonomy_mutation_receipt_immutable", error.Message, StringComparison.Ordinal);
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task CreateCapture_MispairedUpdateProbe_DemonstratesTrustedStatementKindBoundary()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = await BinaryEndpoints.CreateTagAsync(db, "existing target", "before", CancellationToken.None);
        db.Ado.BeginTran();
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "intended insert name");
        int updated = await db.Updateable<Tag>().SetColumns(row => row.Name == "intended insert name")
            .Where(row => row.Id == id).ExecuteCommandAsync();
        Assert.Equal(1, updated);

        // Deliberate caller-contract violation, not an original endpoint defect: native writer
        // ownership authenticates neither INSERT kind nor the caller's claimed absent identity.
        Receipt probe = await PersistAsync(db, capture, id, updated);
        Assert.Equal(MutationOperation.Create, probe.Operation);
        Assert.Null(probe.Before);
        Assert.Equal(new Identity(id, "intended insert name", "before"), probe.After);
        db.Ado.RollbackTran();
        Assert.Equal("existing target", (await db.Queryable<Tag>().SingleAsync()).Name);
        Assert.Equal(0, await CountAsync(db));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CreateCapture_RejectsCommittedForeignWriter_EvenAfterForeignSavepoint(bool useSavepoint)
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient foreign = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        db.Ado.BeginTran();
        Capture capture = await CaptureCreateAsync(db, TargetKind.Tag, "foreign inserted row");
        foreign.Ado.BeginTran();
        if (useSavepoint)
        {
            await foreign.Ado.ExecuteCommandAsync("SAVEPOINT foreign_write;");
        }
        int id = await BinaryEndpoints.CreateTagAsync(foreign, "foreign inserted row", "foreign facts", CancellationToken.None);
        if (useSavepoint)
        {
            await foreign.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT foreign_write;");
        }
        foreign.Ado.CommitTran();

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, capture, id, 1));
        Assert.Equal("taxonomy_receipt_original_dml_required", error.Message);
        Assert.Equal(0, await CountAsync(db));
        db.Ado.RollbackTran();
        Assert.Equal(new Identity(id, "foreign inserted row", "foreign facts"),
            await ReadTagIdentityAsync(db, id));
    }

    [Theory]
    [InlineData(MutationOperation.Create, false, false)]
    [InlineData(MutationOperation.Create, false, true)]
    [InlineData(MutationOperation.Create, true, false)]
    [InlineData(MutationOperation.Create, true, true)]
    [InlineData(MutationOperation.Update, false, false)]
    [InlineData(MutationOperation.Update, false, true)]
    [InlineData(MutationOperation.Update, true, false)]
    [InlineData(MutationOperation.Update, true, true)]
    [InlineData(MutationOperation.Delete, false, false)]
    [InlineData(MutationOperation.Delete, false, true)]
    [InlineData(MutationOperation.Delete, true, false)]
    [InlineData(MutationOperation.Delete, true, true)]
    public async Task OriginalTransactionSavepoint_AcceptsRealDmlAndCaptureBeforeOrAfterRelease(
        MutationOperation operation, bool captureInsideSavepoint, bool releaseBeforePersist)
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        int id = operation == MutationOperation.Create ? 0
            : await BinaryEndpoints.CreateTagAsync(db, "savepoint tag", "before", CancellationToken.None);
        db.Ado.BeginTran();
        object originalTransaction = db.Ado.Transaction;
        Capture? capture = captureInsideSavepoint ? null : await CaptureTagAsync(db, operation, id);
        await db.Ado.ExecuteCommandAsync("SAVEPOINT original_mutation;");
        capture ??= await CaptureTagAsync(db, operation, id);
        (id, int affected) = await ExecuteTagMutationAsync(db, operation, id, "after");
        if (releaseBeforePersist)
        {
            await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT original_mutation;");
        }
        Receipt receipt = await PersistAsync(db, capture, id, affected);
        Assert.Same(originalTransaction, db.Ado.Transaction);
        Assert.Equal(operation, receipt.Operation);
        Assert.Equal(id, receipt.TargetId);
        Assert.Equal(operation == MutationOperation.Create ? null : new Identity(id, "savepoint tag", "before"), receipt.Before);
        Assert.Equal(operation == MutationOperation.Delete ? null : new Identity(id, "savepoint tag", "after"), receipt.After);
        Assert.Equal(0, await CountAsync(observer));
        if (!releaseBeforePersist)
        {
            await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT original_mutation;");
        }
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(observer));
        Assert.Equal(receipt.After, await ReadTagIdentityAsync(observer, id));
    }

    [Theory]
    [InlineData(MutationOperation.Create)]
    [InlineData(MutationOperation.Update)]
    [InlineData(MutationOperation.Delete)]
    public async Task RollbackToSavepoint_RemovesDmlAndReceipt_AndRetainedCaptureCanRetry(MutationOperation operation)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = operation == MutationOperation.Create ? 0
            : await BinaryEndpoints.CreateTagAsync(db, "savepoint tag", "before", CancellationToken.None);
        db.Ado.BeginTran();
        Capture capture = await CaptureTagAsync(db, operation, id);
        await db.Ado.ExecuteCommandAsync("SAVEPOINT original_mutation;");
        (id, int affected) = await ExecuteTagMutationAsync(db, operation, id, "rolled back");
        Receipt rolledBack = await PersistAsync(db, capture, id, affected);
        Assert.Equal(1, await CountAsync(db));
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT original_mutation;");
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(operation == MutationOperation.Create ? null : new Identity(id, "savepoint tag", "before"),
            await ReadTagIdentityAsync(db, id));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, capture, id, affected));
        Assert.Equal("taxonomy_receipt_no_actual_mutation", error.Message);

        (id, affected) = await ExecuteTagMutationAsync(db, operation, id, "retry");
        Receipt retry = await PersistAsync(db, capture, id, affected);
        Assert.Equal(rolledBack.ReceiptId, retry.ReceiptId);
        Assert.Equal(operation == MutationOperation.Delete ? null : new Identity(id, "savepoint tag", "retry"), retry.After);
        await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT original_mutation;");
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(db));
        Assert.Equal(retry.After, await ReadTagIdentityAsync(db, id));
    }

    [Theory]
    [InlineData(MutationOperation.Create)]
    [InlineData(MutationOperation.Update)]
    [InlineData(MutationOperation.Delete)]
    public async Task RollbackPastCapture_RefusesAllOperationsAfterFamilyReacquisition(MutationOperation operation)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = operation == MutationOperation.Create ? 0
            : await BinaryEndpoints.CreateTagAsync(db, "savepoint tag", "before", CancellationToken.None);
        db.Ado.BeginTran();
        await db.Ado.ExecuteCommandAsync("SAVEPOINT before_capture;");
        Capture capture = await CaptureTagAsync(db, operation, id);
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT before_capture;");
        await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT before_capture;");
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        (id, int affected) = await ExecuteTagMutationAsync(db, operation, id, "unreceipted");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(db, capture, id, affected));
        Assert.Equal("taxonomy_receipt_capture_rolled_back", error.Message);
        Assert.Equal(0, await CountAsync(db));
        db.Ado.RollbackTran();
        Assert.Equal(operation == MutationOperation.Create ? null : new Identity(id, "savepoint tag", "before"),
            await ReadTagIdentityAsync(db, id));
    }

    private static Task<Capture> CaptureTagAsync(SqlSugarClient db, MutationOperation operation, int id)
        => operation == MutationOperation.Create
            ? CaptureCreateAsync(db, TargetKind.Tag, "savepoint tag")
            : CaptureExistingAsync(db, TargetKind.Tag, operation, id);

    private static async Task<(int Id, int Affected)> ExecuteTagMutationAsync(
        SqlSugarClient db, MutationOperation operation, int id, string description)
    {
        if (operation == MutationOperation.Create)
        {
            int insertedId = await BinaryEndpoints.CreateTagAsync(db, "savepoint tag", description, CancellationToken.None);
            Assert.True(insertedId > 0);
            return (insertedId, 1);
        }
        if (operation == MutationOperation.Update)
        {
            int updated = await db.Updateable<Tag>().SetColumns(row => row.Description == description)
                .Where(row => row.Id == id).ExecuteCommandAsync();
            return (id, updated);
        }
        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, id));
        return (id, 1);
    }

    private static async Task<Identity?> ReadTagIdentityAsync(SqlSugarClient db, int id)
    {
        Tag? tag = await db.Queryable<Tag>().Where(row => row.Id == id).SingleAsync();
        return tag is null ? null : new Identity(tag.Id, tag.Name, tag.Description);
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(Category), typeof(Tag), typeof(Article), typeof(ArticleTag));
            string sql = Assert.IsType<RawSqlStep>(Assert.Single(
                TaxonomyMutationReceiptMigrationDefinitions.BuildMigration().Steps)).Sql;
            await db.Ado.ExecuteCommandAsync(sql);
            await db.Ado.ExecuteCommandAsync(sql);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static Task<int> InsertArticleAsync(SqlSugarClient db, int categoryId, string title)
        => db.Insertable(new Article { CategoryId = categoryId, Title = title }).ExecuteReturnIdentityAsync();

    private static Task<int> CountAsync(SqlSugarClient db)
        => db.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;");
}

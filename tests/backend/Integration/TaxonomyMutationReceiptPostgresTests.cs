using System.Collections.Immutable;
using System.Data;
using System.Text.Json;

using Npgsql;

using SqlSugar;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Tests.TestInfrastructure;

using static FsusBlog.Server.Services.Taxonomy.TaxonomyMutationReceiptPersistence;

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
        foreign.Ado.Connection = db.Ado.Connection;
        foreign.Ado.Transaction = db.Ado.Transaction;
        try
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => PersistAsync(foreign, capture, id, 1));
        }
        finally
        {
            foreign.Ado.Transaction = null;
            foreign.Ado.Connection = new NpgsqlConnection(foreign.CurrentConnectionConfig.ConnectionString);
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
        await Assert.ThrowsAsync<PostgresException>(() => PersistBatchAsync(db,
            [new Completion(first, firstId, 1), new Completion(second, secondId, 1)]));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
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

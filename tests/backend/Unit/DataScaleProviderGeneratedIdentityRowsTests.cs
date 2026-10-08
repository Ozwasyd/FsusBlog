using System.Data;
using System.Data.Common;
using System.Reflection;

using FsusBlog.Server.Services.Fixtures.DataScale;

using Microsoft.Data.Sqlite;

using SqlSugar;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual current-style identity table staging. Caller commit and full graph custody are separate.</summary>
public class DataScaleProviderGeneratedIdentityRowsTests(Xunit.Abstractions.ITestOutputHelper output) : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "fsus-generated-rows-" + Guid.NewGuid().ToString("N"));
    private protected virtual DataScaleBulkProvider Provider => DataScaleBulkProvider.Sqlite;
    protected virtual DbConnection Connection() => new SqliteConnection("Data Source=" + Path.Combine(_root, "rows.db") + ";Pooling=false;Default Timeout=15");

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbCommand setup = db.CreateCommand();
        setup.CommandText = "DROP TABLE IF EXISTS article;CREATE TABLE article(id "
            + (Provider == DataScaleBulkProvider.MySql ? "INT NOT NULL AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT")
            + ",title TEXT NOT NULL,summary TEXT NULL)" + (Provider == DataScaleBulkProvider.MySql ? " ENGINE=InnoDB" : "");
        await setup.ExecuteNonQueryAsync();
        setup.CommandText = Provider == DataScaleBulkProvider.MySql ? "SELECT VERSION()" : "SELECT sqlite_version()";
        output.WriteLine("NativeVersion=" + Provider + ":" + await setup.ExecuteScalarAsync());
    }

    public Task DisposeAsync()
    {
        Directory.Delete(_root, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task IdenticalRows_NativeTaggedIdsDoNotNeedUniqueBusinessValuesOrRanges()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        if (Provider == DataScaleBulkProvider.MySql)
        {
            await SqlAsync(db, "SET SESSION auto_increment_increment=7;SET SESSION auto_increment_offset=3");
        }
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var result = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, Rows(2), CancellationToken.None);
        Assert.Equal(1, result.InsertCommands);
        Assert.Equal(2 * (Provider == DataScaleBulkProvider.MySql ? 2 : 1), result.NativeStatements);
        Assert.NotEqual(result.RoleIds["role/0"], result.RoleIds["role/1"]);
        Assert.Equal(result.RoleIds["role/0"], result.RoleIds["alias/0"]);
        await transaction.CommitAsync();
        await using DbTransaction replay = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var repeated = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, replay, Provider, Rows(2), CancellationToken.None, result);
        Assert.True(repeated.AlreadyPresent);
        Assert.Equal(0, repeated.InsertCommands);
        Assert.Equal(result.RoleIds.OrderBy(pair => pair.Key), repeated.RoleIds.OrderBy(pair => pair.Key));
        await replay.CommitAsync();
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task CurrentArticleModel_StagesCompleteCanonicalColumnsWithNativePk(ArticleScaleVariant variant)
    {
        var (plan, graph, bindings) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        var projected = DataScaleArticlePhysicalProjection.Compile(plan, [graph], bindings, schema,
            DataScaleArticlePhysicalProjectionTests.Principals(plan));
        DataScaleBulkTableRows article = DataScaleArticlePhysicalProjection.PrepareWrites(projected).Inserts.Single(table => table.Table == "article");
        int key = article.Columns.ToList().FindIndex(column => column.Name == "id");
        var complete = new DataScaleBulkTableRows("article", article.Columns.Where((_, index) => index != key).ToArray(),
            article.Rows.Select(row => (IReadOnlyList<object?>)row.Where((_, index) => index != key).ToArray()).ToArray());
        await using DbConnection db = Connection();
        await db.OpenAsync();
        var model = DataScaleArticlePhysicalProjection.EntityModels.Single(item => item.Kind == ArticleScaleRowKind.Article);
        var definitions = new List<string>();
        string Quote(string name) => Provider == DataScaleBulkProvider.MySql ? "`" + name + "`" : "\"" + name + "\"";
        foreach (PropertyInfo property in model.Entity.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true))
        {
            string column = schema[ArticleScaleRowKind.Article].Columns[property.Name];
            if (column == "id")
            {
                definitions.Add(Quote(column) + (Provider == DataScaleBulkProvider.MySql ? " INT NOT NULL AUTO_INCREMENT PRIMARY KEY" : " INTEGER PRIMARY KEY AUTOINCREMENT"));
                continue;
            }
            Type type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
            string sqlType = type == typeof(long) ? "BIGINT" : type.IsEnum || type == typeof(int) ? "INTEGER" : type == typeof(bool) ? "BOOLEAN"
                : type == typeof(DateTime) && Provider == DataScaleBulkProvider.MySql ? "DATETIME(6)" : "TEXT";
            definitions.Add(Quote(column) + " " + sqlType + (property.GetCustomAttribute<SugarColumn>()?.IsNullable == true ? "" : " NOT NULL"));
        }
        await SqlAsync(db, "DROP TABLE article;CREATE TABLE article(" + string.Join(',', definitions) + ")"
            + (Provider == DataScaleBulkProvider.MySql ? " ENGINE=InnoDB" : ""));
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var result = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider,
            new(complete, article.Columns[key], [new(graph.SemanticArticleId, [graph.SemanticArticleId])]), CancellationToken.None);
        Assert.Equal(1L, result.RoleIds[graph.SemanticArticleId]);
        Assert.Equal(article.Columns.Count, result.InsertedRows.Columns.Count);
        await transaction.CommitAsync();
        Assert.Equal(1L, await CountAsync(db));
        // This is the actual current Article model's first stage, not a complete graph/seed.
    }

    [Fact]
    public async Task NativePacket_ExceedsOneChunkWithExplicitRoleIdentityForEveryRow()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var result = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, Rows(513), CancellationToken.None);
        Assert.Equal(3, result.InsertCommands);
        Assert.Equal(513, result.RoleIds.Values.Distinct().Count());
        Assert.Equal(513, result.InsertedRows.Rows.Count);
        await transaction.CommitAsync();
    }

    [Fact]
    public async Task CallerRollback_DoesNotLeaveProvisionalProductRows()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        Assert.Equal(2, (await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, Rows(2), CancellationToken.None)).InsertedRows.Rows.Count);
        await transaction.RollbackAsync();
        Assert.Equal(0L, await CountAsync(db));
    }

    [Theory]
    [InlineData("changed")]
    [InlineData("missing")]
    public async Task OriginalReplay_TamperRefusesWithoutNativeReallocation(string scenario)
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        DataScaleGeneratedIdentityExecution original;
        await using (DbTransaction first = await db.BeginTransactionAsync(IsolationLevel.Serializable))
        {
            original = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, first, Provider, Rows(2), CancellationToken.None);
            await first.CommitAsync();
        }
        await SqlAsync(db, scenario == "changed" ? "UPDATE article SET title='tampered'" : "DELETE FROM article");
        await using DbTransaction replay = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(
            db, replay, Provider, Rows(2), CancellationToken.None, original));
        await replay.CommitAsync();
        Assert.Equal(scenario == "missing" ? 0L : 2L, await CountAsync(db));
    }

    [Fact]
    public async Task LaterNativeStatementFailure_RollsBackPacketAndKeepsEarlierCallerRows()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        await SqlAsync(db, "INSERT INTO article(title,summary) VALUES('caller','prior')", transaction);
        DataScaleGeneratedIdentityRows valid = Rows(2);
        var invalid = valid with
        {
            Values = valid.Values with
            {
                Rows = [valid.Values.Rows[0], new object?[] { null, null }]
            }
        };
        await Assert.ThrowsAnyAsync<DbException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, invalid, CancellationToken.None));
        await transaction.CommitAsync();
        Assert.Equal(1L, await CountAsync(db));
    }

    [Fact]
    public async Task IncompleteCanonicalColumns_RefusesBeforeProductRows()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var incomplete = Rows(1) with
        {
            Values = new("article", [new("title", DbType.String)], [new object?[] { "same" }])
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, incomplete, CancellationToken.None));
        await transaction.CommitAsync();
        Assert.Equal(0L, await CountAsync(db));
    }

    [Fact]
    public async Task NativeBigIntKey_IsReturnedWithoutChangingCurrentGeneration()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await SqlAsync(db, "DROP TABLE article;CREATE TABLE article(id "
            + (Provider == DataScaleBulkProvider.MySql ? "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT")
            + ",title TEXT NOT NULL,summary TEXT NULL)" + (Provider == DataScaleBulkProvider.MySql ? " ENGINE=InnoDB" : ""));
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var result = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider,
            Rows(2) with
            {
                PrimaryKey = new("id", DbType.Int64)
            }, CancellationToken.None);
        Assert.Equal(2, result.RoleIds.Values.Distinct().Count());
        await transaction.CommitAsync();
        Assert.Equal(2L, await CountAsync(db));
    }

    [Fact]
    public async Task NonGeneratedTarget_RefusesWithoutInsertingRows()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await SqlAsync(db, "DROP TABLE article;CREATE TABLE article(id "
            + (Provider == DataScaleBulkProvider.MySql ? "INT NOT NULL PRIMARY KEY" : "INTEGER PRIMARY KEY")
            + ",title TEXT NOT NULL,summary TEXT NULL)" + (Provider == DataScaleBulkProvider.MySql ? " ENGINE=InnoDB" : " WITHOUT ROWID"));
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(
            db, transaction, Provider, Rows(2), CancellationToken.None));
        await transaction.CommitAsync();
        Assert.Equal(0L, await CountAsync(db));
    }

    [Fact]
    public async Task TemporaryShadow_RefusesBeforeWritingEitherTable()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await SqlAsync(db, "CREATE TEMPORARY TABLE article(id "
            + (Provider == DataScaleBulkProvider.MySql ? "INT NOT NULL AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT")
            + ",title TEXT NOT NULL,summary TEXT NULL)");
        await using (DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable))
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(
                db, transaction, Provider, Rows(2), CancellationToken.None));
            await transaction.CommitAsync();
        }
        Assert.Equal(0L, await CountAsync(db));
        await SqlAsync(db, "DROP TABLE article");
        Assert.Equal(0L, await CountAsync(db));
    }

    [Fact]
    public async Task CancelledRead_LeavesCallerTransactionAndRowsUnchanged()
    {
        await using DbConnection db = Connection();
        await db.OpenAsync();
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        await SqlAsync(db, "INSERT INTO article(title,summary) VALUES('caller','prior')", transaction);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(
            db, transaction, Provider, Rows(2), cancelled.Token));
        await transaction.CommitAsync();
        Assert.Equal(1L, await CountAsync(db));
    }

    [Fact]
    public async Task ConcurrentPackets_PreserveRoleMappingsWithoutSharedCountersInClient()
    {
        async Task<DataScaleGeneratedIdentityExecution> Worker()
        {
            await using DbConnection db = Connection();
            await db.OpenAsync();
            await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
            var result = await DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(db, transaction, Provider, Rows(2), CancellationToken.None);
            await transaction.CommitAsync();
            return result;
        }
        var results = await Task.WhenAll(Task.Run(Worker), Task.Run(Worker));
        Assert.Equal(4, results.SelectMany(result => result.RoleIds.Values.Distinct()).Distinct().Count());
        await using DbConnection observed = Connection();
        await observed.OpenAsync();
        Assert.Equal(4L, await CountAsync(observed));
    }

    private static DataScaleGeneratedIdentityRows Rows(int count)
        => new(new("article", [new("title", DbType.String), new("summary", DbType.String)],
            Enumerable.Range(0, count).Select(_ => (IReadOnlyList<object?>)new object?[] { "identical", null }).ToArray()),
            new("id", DbType.Int32), Enumerable.Range(0, count).Select(index => new DataScaleNativeIdentityRoleGroup(
                "role/" + index, new[] { "role/" + index, "alias/" + index })).ToArray());

    private static async Task SqlAsync(DbConnection db, string sql, DbTransaction? transaction = null)
    {
        await using DbCommand command = db.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<long> CountAsync(DbConnection db)
    {
        await using DbCommand command = db.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM article";
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }
}

public class DataScaleProviderGeneratedIdentityRowsSqliteTests
{
    [Fact]
    public async Task AfterInsertTriggerTamper_RollsBackOnlyTheGeneratedOperation()
    {
        await using var db = new SqliteConnection("Data Source=:memory:");
        await db.OpenAsync();
        await using (var setup = db.CreateCommand())
        {
            setup.CommandText = "CREATE TABLE article(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL);"
                + "INSERT INTO article(title) VALUES('caller');"
                + "CREATE TRIGGER change_title AFTER INSERT ON article BEGIN UPDATE article SET title='tampered' WHERE id=NEW.id; END;";
            await setup.ExecuteNonQueryAsync();
        }
        await using DbTransaction transaction = await db.BeginTransactionAsync(IsolationLevel.Serializable);
        var input = new DataScaleGeneratedIdentityRows(new("article", [new("title", DbType.String)],
            [new object?[] { "canonical" }]), new("id", DbType.Int32), [new("role", ["role"])]);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.InsertGeneratedRowsAsync(
            db, transaction, DataScaleBulkProvider.Sqlite, input, CancellationToken.None));
        Assert.Equal("generated_identity_inserted_values_not_exact", error.Message);
        await transaction.CommitAsync();
        await using var observed = db.CreateCommand();
        observed.CommandText = "SELECT title FROM article";
        await using var reader = await observed.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal("caller", reader.GetString(0));
        Assert.False(await reader.ReadAsync());
    }
}

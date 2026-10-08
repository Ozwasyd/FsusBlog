using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Data.Sqlite;

using FsusBlog.Server.Services.Fixtures.DataScale;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Exercises native SQLite transport primitives, without claiming complete factory graph acceptance.</summary>
public sealed class DataScaleProviderBulkTransportTests : IDisposable
{
    private readonly CancellationTokenSource _cancellation = new();

    public void Dispose() => _cancellation.Dispose();

    [Fact]
    public async Task DeferredCyclePointers_ArePatchedBeforeReadbackInOneTransaction()
    {
        await using SqliteConnection connection = await OpenAsync();
        await using (DbCommand schema = connection.CreateCommand())
        {
            schema.CommandText = "ALTER TABLE bulk_parent ADD COLUMN child_id INTEGER NULL REFERENCES bulk_child(id)";
            await schema.ExecuteNonQueryAsync(_cancellation.Token);
        }
        DataScaleBulkTableRows[] tables = Tables(2);
        tables[0] = tables[0] with
        {
            Columns = tables[0].Columns.Concat([new DataScaleBulkColumn("child_id", DbType.Int64)]).ToArray(),
            Rows = tables[0].Rows.Select(row => (IReadOnlyList<object?>)row.Concat([null]).ToArray()).ToArray()
        };
        DataScaleBulkTableRows[] patches = [new("bulk_parent", [new("id", DbType.Int64), new("child_id", DbType.Int64)],
            [new object?[] { 1L, 1L }, new object?[] { 2L, null }])];
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, tables, patches, ExpectedDigest(2),
            async (db, transaction, token) =>
            {
                await using DbCommand pointer = db.CreateCommand();
                pointer.Transaction = transaction;
                pointer.CommandText = "SELECT child_id FROM bulk_parent WHERE id = 1";
                Assert.Equal(1L, await pointer.ExecuteScalarAsync(token));
                return await ObserveAsync(db, transaction, token);
            }, _cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        Assert.Equal(3, result.WriteCommands);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DeferredUpdate_RejectsNonownedKeysAndNonPrimaryKeys(bool nonowned)
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] patches = nonowned
            ? [new("bulk_child", [new("id", DbType.Int64), new("parent_id", DbType.Int64)], [new object?[] { 9001L, 1L }])]
            : [new("bulk_child", [new("parent_id", DbType.Int64), new("id", DbType.Int64)], [new object?[] { 2L, 1L }])];
        if (nonowned)
        {
            await Assert.ThrowsAsync<ArgumentException>(() => DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
                connection, DataScaleBulkProvider.Sqlite, Tables(2), patches, ExpectedDigest(2), ObserveAsync, _cancellation.Token));
        }
        else
        {
            DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
                connection, DataScaleBulkProvider.Sqlite, Tables(2), patches, ExpectedDigest(2), ObserveAsync, _cancellation.Token);
            Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
            Assert.Equal(0, result.WriteCommands);
        }
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task DeferredForeignKeyFailure_RollsBackAllInsertedRowsBeforeVerifier()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] patches = [new("bulk_child", [new("id", DbType.Int64), new("parent_id", DbType.Int64)],
            [new object?[] { 1L, 9001L }])];
        bool verifierCalled = false;
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), patches, ExpectedDigest(2),
            (db, transaction, token) =>
            {
                verifierCalled = true;
                return ObserveAsync(db, transaction, token);
            }, _cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.False(verifierCalled);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task MultipleCommandsAndDependentTables_CommitOneExactTransaction()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] tables = Tables(600);
        string expected = ExpectedDigest(600);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, tables, expected, ObserveAsync, _cancellation.Token);

        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        Assert.Equal(expected, result.SemanticDigest);
        Assert.Equal(4, result.WriteCommands);
        Assert.Equal(601, result.RowsSubmitted);
        Assert.Null(result.Failure);
        Assert.Equal(expected, (await ObserveAsync(connection, null, _cancellation.Token)).SemanticDigest);
    }

    [Fact]
    public async Task LaterUniqueFailure_RollsBackPreviouslyExecutedCommands()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] tables = Tables(600);
        tables[1] = tables[1] with
        {
            Rows = [new object?[] { 1, 600 }, new object?[] { 1, 600 }]
        };
        bool verifierCalled = false;
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, tables, ExpectedDigest(600),
            (db, transaction, token) =>
            {
                verifierCalled = true;
                return ObserveAsync(db, transaction, token);
            }, _cancellation.Token);

        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.Equal(4, result.WriteCommands);
        Assert.False(verifierCalled);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task DuplicateRerun_PreservesPreviouslyCommittedProjection()
    {
        await using SqliteConnection connection = await OpenAsync();
        string expected = ExpectedDigest(2);
        DataScaleBulkExecution first = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), expected, ObserveAsync, _cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.Committed, first.State);
        DataScaleBulkExecution repeated = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), expected, ObserveAsync, _cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, repeated.State);
        Assert.Equal(expected, (await ObserveAsync(connection, null, _cancellation.Token)).SemanticDigest);
        Assert.Equal(3, await CountAsync(connection));
    }

    [Fact]
    public async Task ViolationWithMatchingDigest_StillRollsBackAllRows()
    {
        await using SqliteConnection connection = await OpenAsync();
        string expected = ExpectedDigest(2);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), expected,
            (_, _, _) => Task.FromResult(new DataScaleBulkPostconditions(expected, ["orphan_relation"])), _cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task ForeignKeyOrderFailure_LeavesNoPartialRows()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] tables = Tables(2).Reverse().ToArray();
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, tables, ExpectedDigest(2), ObserveAsync, _cancellation.Token);

        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.Equal(1, result.WriteCommands);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task DigestMismatch_RollsBackAllRows()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), ExpectedDigest(3), ObserveAsync, _cancellation.Token);

        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task CancellationAfterReadback_RollsBackAllRows()
    {
        await using SqliteConnection connection = await OpenAsync();
        using var cancellation = new CancellationTokenSource();
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, Tables(2), ExpectedDigest(2),
            async (db, transaction, token) =>
            {
                DataScaleBulkPostconditions observed = await ObserveAsync(db, transaction, token);
                cancellation.Cancel();
                return observed;
            }, cancellation.Token);

        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        Assert.Equal(0, await CountAsync(connection));
    }

    [Fact]
    public async Task InvalidIdentifierAndDriverMismatch_FailBeforeWrites()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleBulkTableRows[] tables = Tables(2);
        tables[0] = tables[0] with
        {
            Table = "bulk_parent; DROP TABLE bulk_child"
        };
        await Assert.ThrowsAsync<ArgumentException>(() => DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, tables, ExpectedDigest(2), ObserveAsync, _cancellation.Token));
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.PostgreSql, Tables(2), ExpectedDigest(2), ObserveAsync, _cancellation.Token));
        Assert.Equal(0, await CountAsync(connection));
    }

    private static DataScaleBulkTableRows[] Tables(int count)
        =>
        [
            new("bulk_parent", [new("id", DbType.Int64), new("value", DbType.String)],
                Enumerable.Range(1, count).Select(index => (IReadOnlyList<object?>)new object?[] { index, $"value '{index} 中文" }).ToArray()),
            new("bulk_child", [new("id", DbType.Int64), new("parent_id", DbType.Int64)], [new object?[] { 1, count }])
        ];

    private async Task<SqliteConnection> OpenAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        try
        {
            await connection.OpenAsync(_cancellation.Token);
            await using DbCommand command = connection.CreateCommand();
            command.CommandText = """
                PRAGMA foreign_keys = ON;
                CREATE TABLE bulk_parent(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE bulk_child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES bulk_parent(id));
                """;
            await command.ExecuteNonQueryAsync(_cancellation.Token);
            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private static async Task<DataScaleBulkPostconditions> ObserveAsync(
        DbConnection connection, DbTransaction? transaction, CancellationToken cancellationToken)
    {
        var projection = new StringBuilder();
        foreach (string query in new[] { "SELECT id, value FROM bulk_parent ORDER BY id", "SELECT id, parent_id FROM bulk_child ORDER BY id" })
        {
            await using DbCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = query;
            await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                projection.Append(reader.GetInt64(0)).Append('|').Append(reader.GetValue(1)).Append('\n');
            }
        }
        return new(Digest(projection.ToString()), []);
    }

    private static string ExpectedDigest(int count)
    {
        var projection = new StringBuilder();
        foreach (int index in Enumerable.Range(1, count))
        {
            projection.Append(index).Append('|').Append($"value '{index} 中文").Append('\n');
        }
        projection.Append("1|").Append(count).Append('\n');
        return Digest(projection.ToString());
    }

    private static string Digest(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private async Task<long> CountAsync(DbConnection connection)
    {
        await using DbCommand command = connection.CreateCommand();
        command.CommandText = "SELECT (SELECT COUNT(*) FROM bulk_parent) + (SELECT COUNT(*) FROM bulk_child)";
        return Convert.ToInt64(await command.ExecuteScalarAsync(_cancellation.Token));
    }
}

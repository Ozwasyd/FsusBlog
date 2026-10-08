using System.Data.Common;

using Microsoft.Data.Sqlite;

using FsusBlog.Server.Services.Fixtures.DataScale;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Native physical readback diagnostics, not a qualified full graph seed.</summary>
public sealed class DataScalePhysicalBatchReadbackTests
{
    [Theory]
    [InlineData(false, null, (int)DataScalePhysicalRecoveryState.Empty, 0)]
    [InlineData(true, null, (int)DataScalePhysicalRecoveryState.Exact, 2)]
    [InlineData(true, "DELETE FROM readback_rows WHERE id = 1", (int)DataScalePhysicalRecoveryState.Conflict, 1)]
    [InlineData(true, "UPDATE readback_rows SET text_value = 'tampered' WHERE id = 1", (int)DataScalePhysicalRecoveryState.Conflict, 2)]
    public async Task RecoveryObservation_DistinguishesEmptyExactPartialAndTamperWithoutWriting(
        bool insert, string? tamper, int expectedState, long rows)
    {
        var state = (DataScalePhysicalRecoveryState)expectedState;
        await using SqliteConnection connection = await OpenAsync();
        await using (DbCommand sentinel = connection.CreateCommand())
        {
            sentinel.CommandText = "INSERT INTO readback_rows VALUES (9001, 7, 1, 'nonowned', NULL, '2026-01-01T00:00:00Z')";
            await sentinel.ExecuteNonQueryAsync();
        }
        DataScaleArticlePhysicalBatch batch = Batch(2);
        if (insert)
        {
            DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
                connection, DataScaleBulkProvider.Sqlite, batch.Tables, DataScalePhysicalBatchReadback.ExpectedDigest(batch),
                (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction,
                    DataScaleBulkProvider.Sqlite, batch, token), CancellationToken.None);
            Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        }
        if (tamper is not null)
        {
            await using DbCommand command = connection.CreateCommand();
            command.CommandText = tamper;
            await command.ExecuteNonQueryAsync();
        }
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        for (int attempt = 0; attempt < 2; attempt++)
        {
            DataScalePhysicalRecoveryObservation observation = await DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
                connection, transaction, DataScaleBulkProvider.Sqlite, batch, CancellationToken.None);
            Assert.Equal(state, observation.State);
            Assert.Equal(rows, observation.RowsObserved);
            Assert.Equal(state == DataScalePhysicalRecoveryState.Exact, observation.Violations.Count == 0);
            Assert.Equal(DataScalePhysicalBatchReadback.ExpectedDigest(batch), observation.ExpectedDigest);
            Assert.Equal(state == DataScalePhysicalRecoveryState.Exact, observation.ExpectedDigest == observation.ObservedDigest);
        }
        await using DbCommand count = connection.CreateCommand();
        count.Transaction = transaction;
        count.CommandText = "SELECT COUNT(*) FROM readback_rows";
        Assert.Equal(rows + 1, await count.ExecuteScalarAsync());
        count.CommandText = "SELECT text_value FROM readback_rows WHERE id = 9001";
        Assert.Equal("nonowned", await count.ExecuteScalarAsync());
    }

    [Fact]
    public async Task RecoveryObservation_OnePresentTableCannotAcceptAMissingDependentTable()
    {
        await using SqliteConnection connection = await OpenAsync();
        await using (DbCommand create = connection.CreateCommand())
        {
            create.CommandText = "CREATE TABLE readback_children(id INTEGER PRIMARY KEY, number INTEGER NOT NULL, flag INTEGER NOT NULL, text_value TEXT NOT NULL, nullable_value TEXT NULL, instant TEXT NOT NULL)";
            await create.ExecuteNonQueryAsync();
        }
        DataScaleArticlePhysicalBatch parent = Batch(2);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, parent.Tables, DataScalePhysicalBatchReadback.ExpectedDigest(parent),
            (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction,
                DataScaleBulkProvider.Sqlite, parent, token), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        var expected = parent with
        {
            Tables = [parent.Tables[0], parent.Tables[0] with { Table = "readback_children" }],
            PrimaryKeyColumns = new Dictionary<string, int> { ["readback_rows"] = 0, ["readback_children"] = 0 }
        };
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        DataScalePhysicalRecoveryObservation observation = await DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, expected, CancellationToken.None);
        Assert.Equal(DataScalePhysicalRecoveryState.Conflict, observation.State);
        Assert.Equal(2, observation.RowsObserved);
        Assert.Contains("physical_key_set_mismatch:readback_children", observation.Violations);
    }

    [Fact]
    public async Task RecoveryObservation_MissingTableAndCancellationDoNotBecomeEmptyEvidence()
    {
        await using SqliteConnection connection = await OpenAsync();
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        DataScaleArticlePhysicalBatch batch = Batch(2);
        var missing = batch with
        {
            Tables = [batch.Tables[0] with { Table = "missing_rows" }],
            PrimaryKeyColumns = new Dictionary<string, int> { ["missing_rows"] = 0 }
        };
        await Assert.ThrowsAsync<SqliteException>(() => DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, missing, CancellationToken.None));
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, batch, cancelled.Token));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(2)]
    public async Task RecoveryObservation_RefusesNonpositiveOrDuplicateCheckpointKeys(long invalidId)
    {
        await using SqliteConnection connection = await OpenAsync();
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        DataScaleArticlePhysicalBatch batch = Batch(2);
        object?[] row = batch.Tables[0].Rows[0].ToArray();
        row[0] = invalidId;
        batch = batch with { Tables = [batch.Tables[0] with { Rows = [row, batch.Tables[0].Rows[1]] }] };
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, batch, CancellationToken.None));
    }

    [Fact]
    public async Task RecoveryObservation_EmptyExpectedBatchCannotBecomeAnExactCheckpoint()
    {
        await using SqliteConnection connection = await OpenAsync();
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScalePhysicalBatchReadback.ObserveRecoveryAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, Batch(0), CancellationToken.None));
    }

    [Theory]
    [InlineData(DateTimeKind.Local)]
    [InlineData(DateTimeKind.Unspecified)]
    public void NonUtcExpectedTimestamp_IsRefusedBeforeDatabaseWrite(DateTimeKind kind)
    {
        DataScaleArticlePhysicalBatch batch = Batch(1);
        object?[] row = batch.Tables[0].Rows[0].ToArray();
        row[^1] = DateTime.SpecifyKind((DateTime)row[^1]!, kind);
        batch = batch with
        {
            Tables = [batch.Tables[0] with { Rows = [row] }]
        };
        Assert.Throws<InvalidOperationException>(() => DataScalePhysicalBatchReadback.ExpectedDigest(batch));
    }

    [Fact]
    public async Task EverySupportedTypeAndChunk_ReadsExactValuesIndependentOfRowOrder()
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleArticlePhysicalBatch batch = Batch(1100);
        string expected = DataScalePhysicalBatchReadback.ExpectedDigest(batch);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, batch.Tables, expected,
            (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction,
                DataScaleBulkProvider.Sqlite, batch, token), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        Assert.Equal(expected, result.SemanticDigest);
        DataScaleArticlePhysicalBatch reordered = batch with
        {
            Tables = batch.Tables.Select(table => table with { Rows = table.Rows.Reverse().ToArray() }).ToArray()
        };
        Assert.Equal(expected, DataScalePhysicalBatchReadback.ExpectedDigest(reordered));
        await using DbTransaction transaction = await connection.BeginTransactionAsync();
        DataScaleBulkPostconditions observed = await DataScalePhysicalBatchReadback.ObserveAsync(
            connection, transaction, DataScaleBulkProvider.Sqlite, reordered, CancellationToken.None);
        Assert.Empty(observed.Violations);
        Assert.Equal(expected, observed.SemanticDigest);
    }

    [Theory]
    [InlineData("UPDATE readback_rows SET text_value = 'tampered' WHERE id = 1", false)]
    [InlineData("UPDATE readback_rows SET nullable_value = 'changed' WHERE id = 1", false)]
    [InlineData("UPDATE readback_rows SET instant = '2026-01-01T00:00:00Z' WHERE id = 1", false)]
    [InlineData("DELETE FROM readback_rows WHERE id = 1", true)]
    public async Task IndependentReadback_RejectsMissingAndChangedPersistedFields(string tamper, bool missing)
    {
        await using SqliteConnection connection = await OpenAsync();
        DataScaleArticlePhysicalBatch batch = Batch(2);
        string expected = DataScalePhysicalBatchReadback.ExpectedDigest(batch);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, batch.Tables, expected,
            async (db, transaction, token) =>
            {
                await using DbCommand command = db.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = tamper;
                await command.ExecuteNonQueryAsync(token);
                DataScaleBulkPostconditions observed = await DataScalePhysicalBatchReadback.ObserveAsync(
                    db, transaction, DataScaleBulkProvider.Sqlite, batch, token);
                Assert.Contains("physical_value_digest_mismatch", observed.Violations);
                Assert.Equal(missing, observed.Violations.Contains("physical_key_set_mismatch:readback_rows"));
                return observed;
            }, CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.RolledBack, result.State);
        await using DbCommand count = connection.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM readback_rows";
        Assert.Equal(0L, await count.ExecuteScalarAsync());
    }

    [Fact]
    public async Task BoundKeySelection_PreservesNonownedRowsWithoutClaimingWholeTableAcceptance()
    {
        await using SqliteConnection connection = await OpenAsync();
        await using (DbCommand command = connection.CreateCommand())
        {
            command.CommandText = "INSERT INTO readback_rows VALUES (9001, 7, 1, 'nonowned', NULL, '2026-01-01T00:00:00Z')";
            await command.ExecuteNonQueryAsync();
        }
        DataScaleArticlePhysicalBatch batch = Batch(2);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, batch.Tables, DataScalePhysicalBatchReadback.ExpectedDigest(batch),
            (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction,
                DataScaleBulkProvider.Sqlite, batch, token), CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        await using DbCommand read = connection.CreateCommand();
        read.CommandText = "SELECT text_value FROM readback_rows WHERE id = 9001";
        Assert.Equal("nonowned", await read.ExecuteScalarAsync());
    }

    private static DataScaleArticlePhysicalBatch Batch(int count)
        => new([
            new("readback_rows", [new("id", DbType.Int64), new("number", DbType.Int32),
                new("flag", DbType.Boolean), new("text_value", DbType.String),
                new("nullable_value", DbType.String), new("instant", DbType.DateTime)],
                Enumerable.Range(1, count).Select(index => (IReadOnlyList<object?>)new object?[]
                {
                    (long)index, index * -1, index % 2 == 0, $"中文 '{index}' \n😀",
                    index % 2 == 0 ? "" : null, new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc).AddTicks(index)
                }).ToArray())
        ], new Dictionary<string, int> { ["readback_rows"] = 0 }, [], new Dictionary<string, long>());

    private static async Task<SqliteConnection> OpenAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        try
        {
            await connection.OpenAsync();
            await using DbCommand command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE readback_rows(id INTEGER PRIMARY KEY, number INTEGER NOT NULL, flag INTEGER NOT NULL, text_value TEXT NOT NULL, nullable_value TEXT NULL, instant TEXT NOT NULL)";
            await command.ExecuteNonQueryAsync();
            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }
}

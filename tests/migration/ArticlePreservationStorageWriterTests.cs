using System.Collections.Immutable;
using System.Data;
using System.Data.Common;

using Npgsql;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Command/transaction unit controls only; no original-owner capability, actual
// PostgreSQL I/O, media journal or provider qualification is claimed by these fakes.
public sealed class ArticlePreservationStorageWriterTests
{
    private const string Owner = "FsusBlog.Server.Entities.Article";
    private static readonly ArticlePreservationWriteLimits s_limits = new(100, 10, 100, 1_000_000, TimeSpan.FromSeconds(1));

    [Fact]
    public void InsertUsesOwnedNamesAndParametersWithInitialNullPointers()
    {
        using var command = new TestCommand(null);
        ArticlePreservationStorageRow row = Row();
        ArticlePreservationStorageWriter.ConfigureInsert(command, [row]);
        Assert.Contains("public.\"source-owned-table\"", command.CommandText);
        Assert.DoesNotContain("raw title", command.CommandText);
        Assert.Equal(" raw title\n", command.Parameters[1].Value);
        Assert.Equal(DBNull.Value, command.Parameters[2].Value);
        Assert.Equal(DBNull.Value, command.Parameters[3].Value);
        Assert.Equal(DbType.Int64, command.Parameters[2].DbType);
        Assert.Equal(4, command.Parameters.Count);
    }

    [Fact]
    public void FinalPointerUpdateIsAnExactNullPreconditionCas()
    {
        using var command = new TestCommand(null);
        ArticlePreservationStorageWriter.ConfigurePointerCas(command, Row());
        Assert.Contains("\"source-owned-revision\" IS NULL", command.CommandText);
        Assert.Contains("\"source-owned-publication\" IS NULL", command.CommandText);
        Assert.Contains("\"source-owned-id\"=", command.CommandText);
        Assert.Equal(new object[] { 101L, 201L, 1 }, command.Parameters.Cast<DbParameter>().Select(static value => value.Value).ToArray());
    }

    [Theory]
    [InlineData("rows")]
    [InlineData("batch")]
    [InlineData("parameters")]
    [InlineData("bytes")]
    [InlineData("budget")]
    [InlineData("infinite-budget")]
    public void MissingWriteLimitsAreRefusedBeforeAnyCommand(string missing)
    {
        ArticlePreservationWriteLimits changed = missing switch
        {
            "rows" => s_limits with { MaximumRows = 0 },
            "batch" => s_limits with { MaximumBatchRows = 0 },
            "parameters" => s_limits with { MaximumBatchParameters = 0 },
            "bytes" => s_limits with { MaximumArtifactBytes = 0 },
            "budget" => s_limits with { OperationBudget = TimeSpan.Zero },
            "infinite-budget" => s_limits with { OperationBudget = Timeout.InfiniteTimeSpan },
            _ => throw new ArgumentOutOfRangeException(nameof(missing))
        };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageWriter.RequireLimits(changed));
    }

    [Fact]
    public async Task APreCancelledBodyDoesNotReadOrWriteOrOwnTheCallerTransaction()
    {
        using var connection = new TestConnection();
        using var transaction = new TestTransaction(connection);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Row()], connection, transaction, s_limits, cancelled.Token));
        Assert.Empty(connection.Commands);
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
        Assert.Equal(0, transaction.Disposals);
        Assert.Equal(0, connection.Opens);
        Assert.Equal(0, connection.Closes);
    }

    [Fact]
    public async Task UnknownScalarTypeIsRejectedBeforeReadingAnyTargetRows()
    {
        using var connection = new TestConnection();
        using var transaction = new TestTransaction(connection);
        ArticlePreservationStorageRow row = Row();
        row = row with
        {
            Columns = row.Columns.SetItem(1, row.Columns[1] with
            {
                DataType = "uuid"
            })
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [row], connection, transaction, s_limits, default));
        Assert.Empty(connection.Commands);
    }

    [Fact]
    public async Task DuplicatePrimaryKeysAreRejectedBeforeAnyTargetCommand()
    {
        using var connection = new TestConnection();
        using var transaction = new TestTransaction(connection);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticlePreservationStorageWriter.StageRowsAsync([Row(), Row()], connection, transaction, s_limits, default));
        Assert.Equal("article_preservation_native_primary_key_duplicate", failure.Message);
        Assert.Empty(connection.Commands);
    }

    [Fact]
    public async Task MissingFinalPointerIsRejectedBeforeInsertingAnyGraphRow()
    {
        using var connection = new TestConnection();
        using var transaction = new TestTransaction(connection);
        ArticlePreservationStorageRow row = Row();
        row = row with
        {
            Columns = row.Columns.RemoveAt(3)
        };
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticlePreservationStorageWriter.StageRowsAsync([row], connection, transaction, s_limits, default));
        Assert.Equal("article_preservation_native_initial_pointer_shape_invalid", failure.Message);
        Assert.Empty(connection.Commands);
    }

    [Fact]
    public async Task PartialExistingTargetCannotBeFilledOverwrittenOrTreatedAsRecovery()
    {
        using var connection = new TestConnection { ExistingCount = 2 };
        using var transaction = new TestTransaction(connection);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticlePreservationStorageWriter.StageRowsAsync([Row()], connection, transaction, s_limits, default));
        Assert.Equal("article_preservation_native_partial_target_refused", failure.Message);
        Assert.All(connection.Commands, command => Assert.Same(transaction, command.Transaction));
        Assert.Equal(0, connection.Writes);
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
    }

    [Fact]
    public async Task ExistingCompleteGraphIsReadBackWithoutWritingOrCommitting()
    {
        ArticlePreservationStorageRow row = Row();
        using var connection = new TestConnection { ExistingCount = 1, ReaderRows = [row] };
        using var transaction = new TestTransaction(connection);
        Assert.True(await ArticlePreservationStorageWriter.StageRowsAsync([row], connection, transaction, s_limits, default));
        Assert.Equal(0, connection.Writes);
        Assert.All(connection.Commands, command => Assert.Same(transaction, command.Transaction));
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
        Assert.Equal(0, transaction.Disposals);
    }

    [Fact]
    public async Task ExistingCountAloneCannotApproveAMissingOrChangedGraph()
    {
        using var connection = new TestConnection
        {
            ExistingCount = 1,
            ReaderRows = [Row() with
        {
            Columns = Row().Columns.SetItem(1, Row().Columns[1] with { Value = "different actual text" })
        }]
        };
        using var transaction = new TestTransaction(connection);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticlePreservationStorageWriter.StageRowsAsync([Row()], connection, transaction, s_limits, default));
        Assert.Equal("article_preservation_native_row_value_changed", failure.Message);
        Assert.Equal(0, connection.Writes);
    }

    [Fact]
    public async Task EmptyTargetBodyInsertsThenFillsPointersOnTheOriginalTransactionOnly()
    {
        ArticlePreservationStorageRow row = Row();
        using var connection = new TestConnection { ReaderRows = [row] };
        using var transaction = new TestTransaction(connection);
        Assert.False(await ArticlePreservationStorageWriter.StageRowsAsync([row], connection, transaction, s_limits, default));
        Assert.Equal(2, connection.Writes);
        TestCommand insert = Assert.Single(connection.Commands, static command => command.CommandText.StartsWith("INSERT", StringComparison.Ordinal));
        TestCommand cas = Assert.Single(connection.Commands, static command => command.CommandText.StartsWith("UPDATE", StringComparison.Ordinal));
        Assert.True(connection.Commands.IndexOf(insert) < connection.Commands.IndexOf(cas));
        Assert.Equal(DBNull.Value, insert.Parameters[2].Value);
        Assert.Equal(101L, cas.Parameters[0].Value);
        Assert.All(connection.Commands, command => Assert.Same(transaction, command.Transaction));
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
        Assert.Equal(0, transaction.Disposals);
        Assert.Equal(0, connection.Opens);
        Assert.Equal(0, connection.Closes);
    }

    [Fact]
    public async Task InFlightCancellationNeverCommitsOrCompletesThePointerCas()
    {
        using var cancelled = new CancellationTokenSource();
        using var connection = new TestConnection { CancelOnWrite = cancelled };
        using var transaction = new TestTransaction(connection);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Row()], connection, transaction, s_limits, cancelled.Token));
        Assert.Equal(1, connection.Writes);
        Assert.DoesNotContain(connection.Commands, static command => command.CommandText.StartsWith("UPDATE", StringComparison.Ordinal));
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
        Assert.Equal(0, transaction.Disposals);
    }

    [Fact]
    public async Task CommandDisposalFailureDoesNotReplaceTheOriginalCancellation()
    {
        using var connection = new TestConnection { FailCommandDisposal = true };
        using var transaction = new TestTransaction(connection);
        var first = new OperationCanceledException("fixture_main_cancel");
        OperationCanceledException actual = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            ArticlePreservationStorageWriter.CommandAsync<bool>(connection, transaction, s_limits, _ => Task.FromException<bool>(first)));
        Assert.Same(first, actual);
        Assert.Equal(new[] { "article_preservation_native_command_disposal_failed" },
            Assert.IsType<ImmutableArray<string>>(actual.Data[ArticlePreservationStorageWriter.CleanupFailuresKey]).ToArray());
        Assert.Equal(0, transaction.Commits);
        Assert.Equal(0, transaction.Rollbacks);
    }

    private static ArticlePreservationStorageRow Row()
        => new("source-owned-table", Owner,
        [new("source-owned-id", Owner + ".Id", 1, true, false, "int32", false),
            new("source-owned-title", Owner + ".Title", " raw title\n", false, false, "string", false),
            new("source-owned-revision", Owner + ".CurrentRevisionId", 101L, false, false, "int64", true),
            new("source-owned-publication", Owner + ".CurrentPublicationId", 201L, false, false, "int64", true)]);

    private sealed class TestConnection : DbConnection
    {
        public List<TestCommand> Commands { get; } = [];
        public long ExistingCount
        {
            get; init;
        }
        public ImmutableArray<ArticlePreservationStorageRow> ReaderRows { get; init; } = [];
        public bool FailCommandDisposal
        {
            get; init;
        }
        public CancellationTokenSource? CancelOnWrite
        {
            get; init;
        }
        public int Writes
        {
            get; set;
        }
        public int Opens
        {
            get; private set;
        }
        public int Closes
        {
            get; private set;
        }
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "unit";
        public override string DataSource => "unit";
        public override string ServerVersion => "unit";
        public override ConnectionState State => ConnectionState.Open;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close() => Closes++;
        public override void Open() => Opens++;
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => throw new NotSupportedException();
        protected override DbCommand CreateDbCommand()
        {
            var command = new TestCommand(this);
            Commands.Add(command);
            return command;
        }
    }

    private sealed class TestTransaction(TestConnection connection) : DbTransaction
    {
        public int Commits
        {
            get; private set;
        }
        public int Rollbacks
        {
            get; private set;
        }
        public int Disposals
        {
            get; private set;
        }
        public override IsolationLevel IsolationLevel => IsolationLevel.RepeatableRead;
        protected override DbConnection DbConnection => connection;
        public override void Commit() => Commits++;
        public override void Rollback() => Rollbacks++;
        protected override void Dispose(bool disposing)
        {
            Disposals++;
            base.Dispose(disposing);
        }
    }

    private sealed class TestCommand(TestConnection? connection) : DbCommand
    {
        private readonly NpgsqlCommand _parameterOwner = new();
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public override string CommandText { get; set; } = string.Empty;
        public override int CommandTimeout
        {
            get; set;
        }
        public override CommandType CommandType
        {
            get; set;
        }
        public override bool DesignTimeVisible
        {
            get; set;
        }
        public override UpdateRowSource UpdatedRowSource
        {
            get; set;
        }
        protected override DbConnection? DbConnection { get; set; } = connection;
        protected override DbTransaction? DbTransaction
        {
            get; set;
        }
        protected override DbParameterCollection DbParameterCollection => _parameterOwner.Parameters;
        public override void Cancel() => throw new NotSupportedException();
        public override void Prepare()
        {
        }
        protected override DbParameter CreateDbParameter() => new NpgsqlParameter();
        public override object ExecuteScalar() => connection!.ExistingCount;
        public override int ExecuteNonQuery()
        {
            connection!.Writes++;
            connection.CancelOnWrite?.Cancel();
            return 1;
        }
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            var table = new DataTable();
            ArticlePreservationStorageColumn[] columns = connection!.ReaderRows[0].Columns.OrderByDescending(static column => column.IsPrimaryKey)
                .ThenBy(static column => column.Name, StringComparer.Ordinal).ToArray();
            foreach (ArticlePreservationStorageColumn column in columns)
                table.Columns.Add(column.Name, column.Value!.GetType());
            foreach (ArticlePreservationStorageRow row in connection.ReaderRows)
                table.Rows.Add(columns.Select(column => row.Columns.Single(value => value.Name == column.Name).Value).ToArray());
            return table.CreateDataReader();
        }
        public override ValueTask DisposeAsync()
        {
            _parameterOwner.Dispose();
            return connection?.FailCommandDisposal == true
                ? ValueTask.FromException(new InvalidOperationException("fixture_private_disposal_detail"))
                : ValueTask.CompletedTask;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
                _parameterOwner.Dispose();
            base.Dispose(disposing);
        }
    }
}

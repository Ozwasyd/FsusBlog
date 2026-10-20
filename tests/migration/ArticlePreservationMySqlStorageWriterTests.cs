using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using System.Text;

using MySqlConnector;

using Xunit;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration.Tests;

// Direct command/reader simulations. None of these objects mint the original
// native RW context or qualify a MySQL database, transaction or whole operation.
public sealed class ArticlePreservationMySqlStorageWriterTests
{
    private const string ArticleOwner = "FsusBlog.Server.Entities.Article";
    private const string ProbeOwner = "FsusBlog.Server.Entities.WriterProbe";

    [Fact]
    public void MySqlInsertPreservesValuesAndEscapesIdentifiersWithoutPgIdentitySyntax()
    {
        using var command = new MySqlCommand();
        ArticlePreservationStorageRow row = Probe("exact\r\nMarkdown ' ; --", true) with
        {
            Table = "probe`name"
        };
        ArticlePreservationStorageWriter.ConfigureMySqlInsert(command, [row, row]);
        Assert.StartsWith("INSERT INTO `probe``name`", command.CommandText);
        Assert.DoesNotContain("public.", command.CommandText);
        Assert.DoesNotContain("OVERRIDING", command.CommandText);
        Assert.DoesNotContain("Markdown", command.CommandText);
        Assert.Equal(10, command.Parameters.Count);
        Assert.Equal("exact\r\nMarkdown ' ; --", command.Parameters[1].Value);
        Assert.Equal(DBNull.Value, command.Parameters[4].Value);
        Assert.Equal(DbType.Boolean, command.Parameters[2].DbType);
    }

    [Fact]
    public void MySqlArticleInsertDefersBothPointersUntilCompleteGraphIsPresent()
    {
        using var command = new MySqlCommand();
        ArticlePreservationStorageWriter.ConfigureMySqlInsert(command, [Article(7), Article(8)]);
        Assert.Equal(6, command.Parameters.Count);
        Assert.Equal(DBNull.Value, command.Parameters[1].Value);
        Assert.Equal(DBNull.Value, command.Parameters[2].Value);
        Assert.Equal(DBNull.Value, command.Parameters[4].Value);
        Assert.Equal(DBNull.Value, command.Parameters[5].Value);
    }

    [Fact]
    public void MySqlPointerBatchUsesOneBoundedSetBasedCasForBothArticles()
    {
        using var command = new MySqlCommand();
        ArticlePreservationStorageWriter.ConfigureMySqlPointerBatch(command, [Article(7), Article(8)]);
        Assert.StartsWith("UPDATE `article` AS target JOIN (SELECT ", command.CommandText);
        Assert.Contains(" UNION ALL SELECT ", command.CommandText);
        Assert.Contains("target.`id`=desired.`id`", command.CommandText);
        Assert.Contains("target.`revision` IS NULL AND target.`publication` IS NULL", command.CommandText);
        Assert.Equal(6, command.Parameters.Count);
        Assert.Equal(7, command.Parameters[0].Value);
        Assert.Equal(71L, command.Parameters[1].Value);
        Assert.Equal(82L, command.Parameters[5].Value);
        Assert.DoesNotContain("ALTER", command.CommandText);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void MySqlPointerBatchRefusesEmptyNullPointerAndForeignShape(int fault)
    {
        using var command = new MySqlCommand();
        ArticlePreservationStorageRow row = Article(7);
        ArticlePreservationStorageRow broken = fault == 1
            ? row with
            {
                Columns = row.Columns.SetItem(1, row.Columns[1] with
                {
                    Value = null
                })
            }
            : row with
            {
                EntityOwner = ProbeOwner
            };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageWriter.ConfigureMySqlPointerBatch(
            command, fault == 0 ? Array.Empty<ArticlePreservationStorageRow>() : [row, broken]));
    }

    [Theory]
    [InlineData("boolean")]
    [InlineData("tinyint-zero")]
    [InlineData("tinyint-one")]
    [InlineData("signed-zero")]
    [InlineData("signed-one")]
    public async Task MySqlCompleteRowOracleAcceptsOnlyExactExpectedValues(string booleanForm)
    {
        bool enabled = booleanForm is not ("tinyint-zero" or "signed-zero");
        object actualBoolean = booleanForm == "boolean" ? enabled
            : booleanForm.StartsWith("signed", StringComparison.Ordinal) ? (object)(enabled ? 1L : 0L) : (sbyte)(enabled ? 1 : 0);
        using DataTable actual = Actual("original\r\nMarkdown", actualBoolean, DBNull.Value);
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [Probe("original\r\nMarkdown", enabled)];
        await ArticlePreservationStorageWriter.VerifyRowsAsync(rows.GroupBy(row => row.Table),
            connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql);
        Assert.Equal("SELECT OCTET_LENGTH(`markdown`),OCTET_LENGTH(`nullable`),`id`,CAST(`enabled` AS SIGNED) AS `enabled`,CASE WHEN OCTET_LENGTH(`markdown`)<=@length0 THEN `markdown` ELSE NULL END AS `markdown`,CASE WHEN OCTET_LENGTH(`nullable`)<=@length1 THEN `nullable` ELSE NULL END AS `nullable`,`value` FROM `probe`;", connection.LastSql);
        Assert.Same(transaction, connection.LastTransaction);
        Assert.Equal(1, connection.DisposedCommands);
        Assert.Equal(0, connection.CloseCount);
        Assert.Equal(0, connection.CommitCount);
        Assert.Equal(0, connection.RollbackCount);
    }

    [Theory]
    [InlineData("newline")]
    [InlineData("null-empty")]
    [InlineData("value")]
    [InlineData("boolean-two")]
    [InlineData("signed-boolean-two")]
    [InlineData("extra")]
    [InlineData("missing")]
    [InlineData("duplicate")]
    public async Task MySqlCompleteRowOracleRefusesLossAndExtraOrMissingRows(string fault)
    {
        using DataTable actual = Actual(fault == "newline" ? "original\nMarkdown" : "original\r\nMarkdown",
            fault == "boolean-two" ? (object)(sbyte)2 : fault == "signed-boolean-two" ? (object)2L : true,
            fault == "null-empty" ? string.Empty : DBNull.Value,
            fault == "value" ? 12L : 11L);
        if (fault == "extra")
            actual.Rows.Add(18L, DBNull.Value, 2, true, "original\r\nMarkdown", DBNull.Value, 11L);
        if (fault == "duplicate")
            actual.Rows.Add(18L, DBNull.Value, 1, true, "original\r\nMarkdown", DBNull.Value, 11L);
        if (fault == "missing")
            actual.Rows.Clear();
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [Probe("original\r\nMarkdown", true)];
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.VerifyRowsAsync(
            rows.GroupBy(row => row.Table), connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal(1, connection.DisposedCommands);
        Assert.Equal(0, connection.CloseCount);
    }

    [Fact]
    public async Task MySqlDataStageRefusesPartialExistingTargetWithoutInsertOrPointerWrites()
    {
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual)
        {
            ExistingCount = 2
        };
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Probe("text", true)], connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal(0, connection.NonQueryCount);
        Assert.Equal("SELECT count(*) FROM `probe`;", connection.LastSql);
    }

    [Fact]
    public async Task MySqlDataStageBoundsInsertBatchesAndUsesTheOriginalCompleteOracle()
    {
        using DataTable actual = Actual("text", true, DBNull.Value);
        actual.Rows.Add(4L, DBNull.Value, 2, true, "text", DBNull.Value, 11L);
        using var connection = new CommandConnection(actual);
        connection.AffectedCounts.Enqueue(1);
        connection.AffectedCounts.Enqueue(1);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ArticlePreservationStorageRow first = Probe("text", true);
        ArticlePreservationStorageRow second = first with
        {
            Columns = first.Columns.SetItem(0, first.Columns[0] with
            {
                Value = 2
            })
        };
        bool resumed = await ArticlePreservationStorageWriter.StageRowsAsync([first, second], connection, transaction,
            Limits() with
            {
                MaximumBatchRows = 1,
                MaximumBatchParameters = 5
            }, CancellationToken.None, SchemaProviderKind.MySql);
        Assert.False(resumed);
        Assert.Equal(2, connection.NonQueryCount);
        Assert.All(connection.ParameterCounts, count => Assert.Equal(5, count));
        Assert.Equal(4, connection.DisposedCommands);
        Assert.Equal(0, connection.CommitCount);
        Assert.Equal(0, connection.RollbackCount);
        Assert.Equal(0, connection.CloseCount);
    }

    [Fact]
    public async Task MySqlDataStageBoundsPointerCasAndReadsBackBothGraphCoordinates()
    {
        using var actual = new DataTable();
        actual.Columns.Add("id", typeof(int));
        actual.Columns.Add("publication", typeof(long));
        actual.Columns.Add("revision", typeof(long));
        actual.Rows.Add(7, 72L, 71L);
        actual.Rows.Add(8, 82L, 81L);
        using var connection = new CommandConnection(actual);
        foreach (int affected in new[] { 1, 1, 1, 1 })
            connection.AffectedCounts.Enqueue(affected);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        Assert.False(await ArticlePreservationStorageWriter.StageRowsAsync([Article(7), Article(8)], connection, transaction,
            Limits() with
            {
                MaximumBatchRows = 1,
                MaximumBatchParameters = 3
            }, CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal(2, connection.WriteSql.Count(sql => sql.StartsWith("INSERT", StringComparison.Ordinal)));
        Assert.Equal(2, connection.WriteSql.Count(sql => sql.StartsWith("UPDATE", StringComparison.Ordinal)));
        Assert.All(connection.ParameterCounts, count => Assert.Equal(3, count));
        Assert.Equal(0, connection.CommitCount);
        Assert.Equal(0, connection.RollbackCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task MySqlDataStageRefusesWrongAffectedCount(int affected)
    {
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual);
        connection.AffectedCounts.Enqueue(affected);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Probe("text", true)], connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal("article_preservation_native_batch_count_changed", failure.Message);
        Assert.Equal(1, connection.NonQueryCount);
        Assert.Equal(0, connection.CommitCount);
    }

    [Fact]
    public async Task MySqlDataStageRefusesCancellationRaisedByFinalCommandDisposal()
    {
        using var cancellation = new CancellationTokenSource();
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual)
        {
            ExistingCount = 1,
            OnOracleDisposal = cancellation.Cancel
        };
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Probe("text", true)], connection, transaction, Limits(), cancellation.Token, SchemaProviderKind.MySql));
        Assert.Equal(2, connection.DisposedCommands);
        Assert.Equal(0, connection.CloseCount);
    }

    [Fact]
    public async Task MySqlRowOraclePreservesBodyFailureAndRecordsCommandDisposalFailure()
    {
        using DataTable actual = Actual("changed", true, DBNull.Value);
        using var connection = new CommandConnection(actual)
        {
            DisposalFailure = new IOException("private diagnostic")
        };
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [Probe("original", true)];
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.VerifyRowsAsync(
            rows.GroupBy(row => row.Table), connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal("article_preservation_native_row_value_changed", failure.Message);
        Assert.Contains("article_preservation_native_command_disposal_failed",
            Assert.IsType<ImmutableArray<string>>(failure.Data[ArticlePreservationStorageWriter.CleanupFailuresKey]));
    }

    [Fact]
    public async Task MySqlRowOracleRefusesMeasuredOversizeEvenWhenSqlSuppressesTextToNull()
    {
        using DataTable actual = Actual("placeholder", true, DBNull.Value);
        actual.Rows[0]["markdown_length"] = 5_000_000L;
        actual.Rows[0]["markdown"] = DBNull.Value;
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [Probe("original", true)];
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.VerifyRowsAsync(
            rows.GroupBy(row => row.Table), connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal("article_preservation_mysql_row_text_budget_exceeded", failure.Message);
        Assert.Equal(1, connection.DisposedCommands);
    }

    [Fact]
    public async Task MySqlRowOracleRefusesOversizeExpectedTextBeforeSql()
    {
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [Probe(new string('x', 4097), true)];
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.VerifyRowsAsync(
            rows.GroupBy(row => row.Table), connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Null(connection.LastSql);
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(10, false)]
    public async Task MySqlRowOraclePreservesTimestampMicroseconds(long changedTicks, bool accepted)
    {
        DateTime expected = new(2026, 10, 3, 1, 2, 3, DateTimeKind.Unspecified);
        expected = expected.AddTicks(123_450);
        using var actual = new DataTable();
        actual.Columns.Add("id", typeof(int));
        actual.Columns.Add("timestamp", typeof(DateTime));
        actual.Columns["timestamp"]!.DateTimeMode = DataSetDateTime.Unspecified;
        actual.Rows.Add(1, expected.AddTicks(changedTicks));
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        ImmutableArray<ArticlePreservationStorageRow> rows = [new("probe", ProbeOwner,
            [new("id", ProbeOwner + ".Id", 1, true, false, "int32", false),
                new("timestamp", ProbeOwner + ".Timestamp", expected, false, false, "timestamp", false)])];
        Task read = ArticlePreservationStorageWriter.VerifyRowsAsync(rows.GroupBy(row => row.Table), connection, transaction,
            Limits(), CancellationToken.None, SchemaProviderKind.MySql);
        if (accepted)
            await read;
        else
            await Assert.ThrowsAsync<InvalidOperationException>(() => read);
        Assert.Equal(0, connection.CloseCount);
    }

    [Fact]
    public async Task MySqlNativeEntryRefusesMissingCapabilityWithoutBorrowingRawPorts()
        => await Assert.ThrowsAsync<ArgumentNullException>(() => ArticlePreservationStorageWriter.StageMySqlAsync(
            null!, null!, null!, null!, null!, null!, null!, Limits(), CancellationToken.None));

    [Fact]
    public async Task MySqlDataStageRefusesCallerCancellationBeforeAnySql()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Probe("text", true)], connection, transaction, Limits(), cancellation.Token, SchemaProviderKind.MySql));
        Assert.Null(connection.LastSql);
        Assert.Equal(0, connection.CloseCount);
    }

    [Fact]
    public async Task UnsupportedDataDialectRefusesBeforeAnySql()
    {
        using DataTable actual = Actual("text", true, DBNull.Value);
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationStorageWriter.StageRowsAsync(
            [Probe("text", true)], connection, transaction, Limits(), CancellationToken.None, SchemaProviderKind.Sqlite));
        Assert.Null(connection.LastSql);
    }

    [Fact]
    public void PostgreSqlInsertRetainsOriginalSchemaAndIdentityClause()
    {
        using var command = new MySqlCommand();
        ArticlePreservationStorageWriter.ConfigureInsert(command, [Probe("text", true)]);
        Assert.StartsWith("INSERT INTO public.\"probe\"", command.CommandText);
        Assert.Contains(" OVERRIDING SYSTEM VALUE VALUES ", command.CommandText);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    public async Task MySqlPointerStageRejectsPartialOrExtraAffectedRows(int affected)
    {
        using var actual = new DataTable();
        using var connection = new CommandConnection(actual);
        connection.AffectedCounts.Enqueue(2);
        connection.AffectedCounts.Enqueue(affected);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ArticlePreservationStorageWriter.StageRowsAsync([Article(7), Article(8)], connection, transaction,
                Limits(), CancellationToken.None, SchemaProviderKind.MySql));
        Assert.Equal("article_preservation_native_pointer_cas_failed", failure.Message);
        Assert.Equal(2, connection.NonQueryCount);
        Assert.Equal(1, connection.WriteSql.Count(sql => sql.StartsWith("UPDATE", StringComparison.Ordinal)));
        Assert.Equal(0, connection.CommitCount);
        Assert.Equal(0, connection.RollbackCount);
    }

    [Fact]
    public void CallerOwnedSessionAndTransactionCannotMintTheWriteCapability()
    {
        using var cancellation = new CancellationTokenSource();
        using var actual = new DataTable();
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        var session = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.MySql, cancellation.Token);
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationApplyNativeSession.OwnedReadContext.Mint(session, transaction, cancellation.Token));
        Assert.Equal("offline_apply_original_transaction_required", failure.Message);
        Assert.Equal(0, connection.NonQueryCount);
        Assert.Null(connection.LastSql);
    }

    [Fact]
    public async Task CancelledCreatorCannotEnterAStageWithAFreshBorrowerToken()
    {
        using var creator = new CancellationTokenSource();
        using var borrower = new CancellationTokenSource();
        creator.Cancel();
        using var actual = new DataTable();
        using var connection = new CommandConnection(actual);
        using DbTransaction transaction = connection.BeginTransaction(IsolationLevel.RepeatableRead);
        var session = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.MySql, creator.Token);
        bool entered = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => session.WithOwnedReadScopeAsync(transaction, (_, _) =>
        {
            entered = true;
            throw new InvalidOperationException("A cancelled creator cannot enter the original write scope.");
        }, borrower.Token));
        Assert.False(entered);
        Assert.False(borrower.IsCancellationRequested);
        Assert.Null(connection.LastSql);
        Assert.Equal(0, connection.NonQueryCount);
    }

    private static ArticlePreservationWriteLimits Limits() => new(100, 2, 100, 4096, TimeSpan.FromSeconds(5));
    private static ArticlePreservationStorageRow Probe(string markdown, bool enabled) => new("probe", ProbeOwner,
        [new("id", ProbeOwner + ".Id", 1, true, true, "int32", false),
            new("markdown", ProbeOwner + ".Markdown", markdown, false, false, "string", false),
            new("enabled", ProbeOwner + ".Enabled", enabled, false, false, "boolean", false),
            new("value", ProbeOwner + ".Value", 11L, false, false, "int64", false),
            new("nullable", ProbeOwner + ".Nullable", null, false, false, "string", true)]);
    private static ArticlePreservationStorageRow Article(int id) => new("article", ArticleOwner,
        [new("id", ArticleOwner + ".Id", id, true, true, "int32", false),
            new("revision", ArticleOwner + ".CurrentRevisionId", id * 10L + 1, false, false, "int64", true),
            new("publication", ArticleOwner + ".CurrentPublicationId", id * 10L + 2, false, false, "int64", true)]);
    private static DataTable Actual(string markdown, object enabled, object nullable, long value = 11)
    {
        var table = new DataTable();
        table.Columns.Add("markdown_length", typeof(long));
        table.Columns.Add("nullable_length", typeof(long));
        table.Columns.Add("id", typeof(int));
        table.Columns.Add("enabled", typeof(object));
        table.Columns.Add("markdown", typeof(string));
        table.Columns.Add("nullable", typeof(string));
        table.Columns.Add("value", typeof(long));
        table.Rows.Add(Encoding.UTF8.GetByteCount(markdown), nullable is string text ? Encoding.UTF8.GetByteCount(text) : DBNull.Value,
            1, enabled, markdown, nullable, value);
        return table;
    }

    private sealed class CommandConnection(DataTable rows) : DbConnection
    {
        public long ExistingCount
        {
            get; init;
        }
        public string? LastSql
        {
            get; private set;
        }
        public DbTransaction? LastTransaction
        {
            get; private set;
        }
        public int DisposedCommands
        {
            get; private set;
        }
        public int NonQueryCount
        {
            get; private set;
        }
        public int CloseCount
        {
            get; private set;
        }
        public int CommitCount
        {
            get; private set;
        }
        public int RollbackCount
        {
            get; private set;
        }
        public Action? OnOracleDisposal
        {
            get; init;
        }
        public Exception? DisposalFailure
        {
            get; init;
        }
        public Queue<int> AffectedCounts { get; } = new();
        public List<int> ParameterCounts { get; } = [];
        public List<string> WriteSql { get; } = [];
        [AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "simulation";
        public override string DataSource => "simulation";
        public override string ServerVersion => "simulation";
        public override ConnectionState State => ConnectionState.Open;
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        public override void Close() => CloseCount++;
        public override void Open() => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => new CommandTransaction(this, isolationLevel);
        protected override DbCommand CreateDbCommand() => new ReaderCommand(this, rows);

        private sealed class CommandTransaction(CommandConnection owner, IsolationLevel isolation) : DbTransaction
        {
            public override IsolationLevel IsolationLevel => isolation;
            protected override DbConnection DbConnection => owner;
            public override void Commit() => owner.CommitCount++;
            public override void Rollback() => owner.RollbackCount++;
        }

        private sealed class ReaderCommand(CommandConnection owner, DataTable rows) : DbCommand
        {
            private readonly MySqlCommand _parameters = new();
            [AllowNull]
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
            protected override DbConnection? DbConnection { get; set; } = owner;
            protected override DbTransaction? DbTransaction
            {
                get; set;
            }
            protected override DbParameterCollection DbParameterCollection => _parameters.Parameters;
            public override void Cancel() => throw new NotSupportedException();
            public override void Prepare() => throw new NotSupportedException();
            protected override DbParameter CreateDbParameter() => new MySqlParameter();
            private void Record()
            {
                owner.LastSql = CommandText;
                owner.LastTransaction = DbTransaction;
            }
            public override int ExecuteNonQuery()
            {
                Record();
                owner.NonQueryCount++;
                owner.ParameterCounts.Add(Parameters.Count);
                owner.WriteSql.Add(CommandText);
                return owner.AffectedCounts.Dequeue();
            }
            public override object ExecuteScalar()
            {
                Record();
                return owner.ExistingCount;
            }
            protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
            {
                Record();
                Assert.Equal(CommandBehavior.SequentialAccess, behavior);
                return rows.CreateDataReader();
            }
            public override ValueTask DisposeAsync()
            {
                owner.DisposedCommands++;
                _parameters.Dispose();
                if (CommandText.StartsWith("SELECT OCTET_LENGTH", StringComparison.Ordinal))
                    owner.OnOracleDisposal?.Invoke();
                return owner.DisposalFailure is null ? ValueTask.CompletedTask : ValueTask.FromException(owner.DisposalFailure);
            }
        }
    }
}

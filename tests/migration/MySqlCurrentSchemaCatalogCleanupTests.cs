using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Reflection;

using MySqlConnector;

using NSubstitute;

using Xunit;

namespace FsusBlog.Migration.Tests;

// The actual original private query body, not another catalog implementation.
// Test doubles do not bypass the public reader's exact native driver/session guard.
public sealed class MySqlCurrentSchemaCatalogCleanupTests
{
    private static readonly MethodInfo s_executeDbDataReader = typeof(DbCommand).GetMethod(
        "ExecuteDbDataReader", BindingFlags.Instance | BindingFlags.NonPublic,
        binder: null, types: [typeof(CommandBehavior)], modifiers: null)!;
    private static readonly MethodInfo s_executeDbDataReaderAsync = typeof(DbCommand).GetMethod(
        "ExecuteDbDataReaderAsync", BindingFlags.Instance | BindingFlags.NonPublic,
        binder: null, types: [typeof(CommandBehavior), typeof(CancellationToken)], modifiers: null)!;

    [Theory]
    [InlineData("execute")]
    [InlineData("read")]
    [InlineData("shape")]
    [InlineData("cell-budget")]
    [InlineData("row-budget")]
    [InlineData("total-budget")]
    [InlineData("read-cancel")]
    [InlineData("eof-cancel")]
    public async Task ActualCatalogRefusalSurvivesBothDisposalFailures(string stage)
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        Exception primary = stage == "read-cancel" ? new OperationCanceledException(cancellation.Token)
            : new IOException("private original query detail");
        if (stage == "execute")
            fixture.Command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, Arg.Any<CancellationToken>())
                .Returns(Task.FromException<DbDataReader>(primary));
        else if (stage is "read" or "read-cancel")
            fixture.Reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                if (stage == "read-cancel")
                    cancellation.Cancel();
                return Task.FromException<bool>(primary);
            });
        else if (stage == "eof-cancel")
            fixture.Reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                cancellation.Cancel();
                return Task.FromResult(false); // Deliberately noncooperative port.
            });
        else if (stage == "shape")
            fixture.Reader.FieldCount.Returns(3);
        else if (stage == "cell-budget")
            fixture.Reader.GetString(0).Returns(new string('x', OfflineMigrationSourceObserver.MaximumCellCharacters + 1));
        else if (stage == "row-budget")
            for (int index = 0; index < OfflineMigrationSourceObserver.MaximumMetadataRows; index++)
                fixture.Budget.AddRow();
        else
        {
            string cell = new('x', OfflineMigrationSourceObserver.MaximumCellCharacters);
            for (int index = 0; index < OfflineMigrationSourceObserver.MaximumMetadataCharacters / cell.Length; index++)
                fixture.Budget.ReadCell(cell);
        }
        fixture.Reader.DisposeAsync().Returns(ValueTask.FromException(fixture.ReaderCleanup));
        fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanup));
        Exception actual = await Assert.ThrowsAnyAsync<Exception>(() => ReadActualQueryAsync(fixture, cancellation.Token));
        if (stage is "execute" or "read" or "read-cancel")
            Assert.Same(primary, actual);
        else if (stage == "eof-cancel")
            Assert.IsAssignableFrom<OperationCanceledException>(actual);
        else
            Assert.Equal(stage == "shape" ? "mysql_current_catalog_native_metadata_shape_invalid"
            : "mysql_current_catalog_metadata_budget_exceeded", actual.Message);
        AssertCleanupCodes(actual, stage != "execute", true);
        AssertLifecycle(fixture, stage != "execute");
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task SuccessfulBodyCannotQualifyFailedCleanup(bool readerFails, bool commandFails)
    {
        Fixture fixture = CreateFixture();
        if (readerFails)
            fixture.Reader.DisposeAsync().Returns(ValueTask.FromException(fixture.ReaderCleanup));
        if (commandFails)
            fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanup));
        Exception actual = await Assert.ThrowsAnyAsync<Exception>(() => ReadActualQueryAsync(fixture, default));
        Assert.Same(readerFails ? fixture.ReaderCleanup : fixture.CommandCleanup, actual);
        AssertCleanupCodes(actual, readerFails, commandFails);
        AssertLifecycle(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualQueryJoinsReaderThenCommandBeforeReturningOrThrowing(bool bodyRefuses)
    {
        Fixture fixture = CreateFixture();
        if (bodyRefuses)
            fixture.Reader.FieldCount.Returns(3);
        var readerEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readerTerminal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commandEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commandTerminal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Reader.DisposeAsync().Returns(_ =>
        {
            readerEntered.TrySetResult();
            return new ValueTask(readerTerminal.Task);
        });
        fixture.Command.DisposeAsync().Returns(_ =>
        {
            commandEntered.TrySetResult();
            return new ValueTask(commandTerminal.Task);
        });
        Task<ImmutableArray<ImmutableArray<MySqlCatalogCell>>> actual = ReadActualQueryAsync(fixture, default);
        try
        {
            await readerEntered.Task;
            Assert.False(actual.IsCompleted);
            Assert.False(commandEntered.Task.IsCompleted);
            readerTerminal.TrySetResult();
            await commandEntered.Task;
            Assert.False(actual.IsCompleted);
            commandTerminal.TrySetResult();
            if (bodyRefuses)
            {
                InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() => actual);
                Assert.Equal("mysql_current_catalog_native_metadata_shape_invalid", refusal.Message);
                Assert.False(refusal.Data.Contains(MySqlCurrentSchemaCatalogObserver.CleanupFailuresKey));
            }
            else
                Assert.Equal("fixture-cell", Assert.Single(await actual)[0].Value);
            AssertLifecycle(fixture);
        }
        finally
        {
            readerTerminal.TrySetResult();
            commandTerminal.TrySetResult();
            try
            {
                await actual;
            }
            catch (InvalidOperationException failure) when (bodyRefuses && failure.Message == "mysql_current_catalog_native_metadata_shape_invalid")
            {
            }
        }
    }

    [Theory]
    [InlineData("reader")]
    [InlineData("command")]
    public async Task QueryRefusesCancellationRaisedByAwaitedDisposal(string stage)
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        if (stage == "reader")
            fixture.Reader.DisposeAsync().Returns(_ =>
        {
            cancellation.Cancel();
            return ValueTask.CompletedTask;
        });
        else
            fixture.Command.DisposeAsync().Returns(_ =>
        {
            cancellation.Cancel();
            return ValueTask.CompletedTask;
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ReadActualQueryAsync(fixture, cancellation.Token));
        AssertLifecycle(fixture);
    }

    [Fact]
    public async Task EarlyCancellationDisposesOnlyCreatedCommandAndPreservesCancellation()
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanup));
        Exception actual = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ReadActualQueryAsync(fixture, cancellation.Token));
        AssertCleanupCodes(actual, false, true);
        AssertLifecycle(fixture, false);
        AssertNoReaderExecution(fixture.Command);
    }

    [Theory]
    [InlineData(false, 1)]
    [InlineData(false, 2)]
    [InlineData(true, 1)]
    [InlineData(true, 2)]
    public async Task NoReaderExecutionAssertionRejectsActualReaderExecution(bool asynchronous, int executions)
    {
        Fixture fixture = CreateFixture();
        fixture.Command.ExecuteReader(CommandBehavior.SequentialAccess).Returns(fixture.Reader);
        fixture.Command.ClearReceivedCalls();
        fixture.Command.ExecuteNonQuery();
        for (int index = 0; index < executions; index++)
        {
            DbDataReader reader = asynchronous
                ? await fixture.Command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, default)
                : fixture.Command.ExecuteReader(CommandBehavior.SequentialAccess);
            Assert.Same(fixture.Reader, reader);
        }
        fixture.Command.ExecuteScalar();

        MethodInfo expected = asynchronous ? s_executeDbDataReaderAsync : s_executeDbDataReader;
        Assert.Equal(executions, fixture.Command.ReceivedCalls().Count(call => call.GetMethodInfo().GetBaseDefinition() == expected));
        Assert.Throws<Xunit.Sdk.DoesNotContainException>(() => AssertNoReaderExecution(fixture.Command));
    }

    [Fact]
    public async Task NoReaderExecutionAssertionAllowsUnrelatedCommandCalls()
    {
        Fixture fixture = CreateFixture();
        fixture.Command.ClearReceivedCalls();
        fixture.Command.ExecuteNonQuery();
        fixture.Command.ExecuteScalar();
        await fixture.Command.DisposeAsync();

        Assert.Contains(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteNonQuery));
        Assert.Contains(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.ExecuteScalar));
        Assert.Contains(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.DisposeAsync));
        AssertNoReaderExecution(fixture.Command);
    }

    [Fact]
    public async Task OriginalMetadataCellsAndCommandCustodyArePreserved()
    {
        Fixture fixture = CreateFixture();
        ImmutableArray<MySqlCatalogCell> row = Assert.Single(await ReadActualQueryAsync(fixture, default));
        Assert.Equal(new MySqlCatalogCell("first", "fixture-cell"), row[0]);
        Assert.Equal(new MySqlCatalogCell("second", null), row[1]);
        Assert.Same(fixture.Transaction, fixture.Command.Transaction);
        Assert.Equal("SOURCE catalog lifecycle fixture only", fixture.Command.CommandText);
        Assert.Equal(30, fixture.Command.CommandTimeout);
        AssertLifecycle(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PublicCatalogReaderRetainsExactNativeDriverSessionGuard(bool nativeConnection)
    {
        DbConnection connection = nativeConnection ? new MySqlConnection() : Substitute.For<DbConnection>();
        using var cancellation = new CancellationTokenSource();
        try
        {
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => MySqlCurrentSchemaCatalogObserver.ReadAsync(
                connection, Substitute.For<DbTransaction>(), cancellation.Token));
            Assert.Equal("mysql_current_catalog_original_native_transaction_required", failure.Message);
        }
        finally
        {
            await connection.DisposeAsync();
        }
    }

    private static Task<ImmutableArray<ImmutableArray<MySqlCatalogCell>>> ReadActualQueryAsync(Fixture fixture, CancellationToken token)
    {
        MethodInfo original = typeof(MySqlCurrentSchemaCatalogObserver).GetMethod("QueryAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        return (Task<ImmutableArray<ImmutableArray<MySqlCatalogCell>>>)original.Invoke(null,
            [fixture.Connection, fixture.Transaction, "SOURCE catalog lifecycle fixture only", new[] { "first", "second" }, fixture.Budget, token])!;
    }

    private static void AssertNoReaderExecution(DbCommand command)
    {
        // Public ExecuteReader wrappers dispatch to these protected virtual methods.
        // Match the recorded base identity, including synchronous reader creation.
        Assert.DoesNotContain(command.ReceivedCalls(), call =>
        {
            MethodInfo original = call.GetMethodInfo().GetBaseDefinition();
            return original == s_executeDbDataReader || original == s_executeDbDataReaderAsync;
        });
    }

    private static Fixture CreateFixture()
    {
        DbConnection connection = Substitute.For<DbConnection>();
        DbTransaction transaction = Substitute.For<DbTransaction>();
        DbCommand command = Substitute.For<DbCommand>();
        DbDataReader reader = Substitute.For<DbDataReader>();
        connection.CreateCommand().Returns(command);
        command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, Arg.Any<CancellationToken>()).Returns(Task.FromResult(reader));
        reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(true), Task.FromResult(false));
        reader.FieldCount.Returns(2);
        reader.IsDBNull(0).Returns(false);
        reader.GetString(0).Returns("fixture-cell");
        reader.IsDBNull(1).Returns(true);
        reader.DisposeAsync().Returns(ValueTask.CompletedTask);
        command.DisposeAsync().Returns(ValueTask.CompletedTask);
        return new(connection, transaction, command, reader, new(),
            new IOException("fixture_reader_secondary_secret"), new IOException("fixture_command_secondary_secret"));
    }

    private static void AssertCleanupCodes(Exception failure, bool readerFailed, bool commandFailed)
    {
        ImmutableArray<string> actual = Assert.IsType<ImmutableArray<string>>(failure.Data[MySqlCurrentSchemaCatalogObserver.CleanupFailuresKey]);
        var expected = ImmutableArray.CreateBuilder<string>();
        if (readerFailed)
            expected.Add("mysql_current_catalog_reader_cleanup_failed");
        if (commandFailed)
            expected.Add("mysql_current_catalog_command_cleanup_failed");
        Assert.Equal<string>(expected.ToImmutable(), actual);
        Assert.All(failure.Data.Values.Cast<object>(), value => Assert.IsType<ImmutableArray<string>>(value));
        Assert.DoesNotContain(actual, code => code.Contains("secret", StringComparison.Ordinal));
    }

    private static void AssertLifecycle(Fixture fixture, bool readerCreated = true)
    {
        Assert.Equal(readerCreated ? 1 : 0,
            fixture.Reader.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(DbDataReader.DisposeAsync)));
        Assert.Single(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.DisposeAsync));
        Assert.Empty(fixture.Transaction.ReceivedCalls());
        fixture.Connection.DidNotReceive().Open();
        fixture.Connection.DidNotReceive().Close();
        Assert.DoesNotContain(fixture.Connection.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbConnection.DisposeAsync));
    }

    private sealed record Fixture(DbConnection Connection, DbTransaction Transaction, DbCommand Command,
        DbDataReader Reader, MySqlCurrentSchemaCatalogObserver.MetadataBudget Budget, Exception ReaderCleanup, Exception CommandCleanup);
}

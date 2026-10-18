using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Reflection;

using MySqlConnector;
using NSubstitute;
using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationSourceMaterialCleanupTests
{
    [Theory]
    [InlineData("execute")]
    [InlineData("read")]
    [InlineData("cancel")]
    [InlineData("field-budget")]
    [InlineData("cell-budget")]
    public async Task MaterialBodyFailureSurvivesBothCleanupFailures(string stage)
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        Exception first = stage == "cancel" ? new OperationCanceledException(cancellation.Token)
            : new IOException("fixture_primary_private_detail");
        if (stage == "execute")
        {
            fixture.Command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, Arg.Any<CancellationToken>())
                .Returns(Task.FromException<DbDataReader>(first));
        }
        else if (stage is "read" or "cancel")
        {
            fixture.Reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(_ =>
            {
                if (stage == "cancel") cancellation.Cancel();
                return Task.FromException<bool>(first);
            });
        }
        else if (stage == "field-budget")
        {
            fixture.Reader.FieldCount.Returns(17);
        }
        else
        {
            fixture.Reader.GetValue(0).Returns(new string('x', 4097));
        }
        fixture.Reader.DisposeAsync().Returns(ValueTask.FromException(fixture.ReaderCleanup));
        fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanup));

        Exception actual = await Assert.ThrowsAnyAsync<Exception>(() => ReadActualPrivateHelperAsync(fixture, cancellation.Token));
        if (stage is "field-budget" or "cell-budget")
        {
            Assert.IsType<InvalidOperationException>(actual);
            Assert.Equal("offline_source_metadata_budget_exceeded", actual.Message);
        }
        else
        {
            Assert.Same(first, actual);
        }
        AssertCleanupCodes(actual, readerFailed: stage != "execute", commandFailed: true);
        AssertLifecycle(fixture, readerCreated: stage != "execute");
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task SuccessfulBodyDoesNotReturnRowsWhenCleanupFails(bool readerFails, bool commandFails)
    {
        Fixture fixture = CreateFixture();
        if (readerFails) fixture.Reader.DisposeAsync().Returns(ValueTask.FromException(fixture.ReaderCleanup));
        if (commandFails) fixture.Command.DisposeAsync().Returns(ValueTask.FromException(fixture.CommandCleanup));

        Exception actual = await Assert.ThrowsAnyAsync<Exception>(() => ReadActualPrivateHelperAsync(fixture, default));
        Assert.Same(readerFails ? fixture.ReaderCleanup : fixture.CommandCleanup, actual);
        AssertCleanupCodes(actual, readerFails, commandFails);
        AssertLifecycle(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MaterialHelperAwaitsReaderThenCommandBeforeReturningOrThrowing(bool bodyRefuses)
    {
        Fixture fixture = CreateFixture();
        if (bodyRefuses) fixture.Reader.FieldCount.Returns(17);
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
        Task<ImmutableArray<ImmutableArray<string>>> actual = ReadActualPrivateHelperAsync(fixture, default);
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
                Assert.Equal("offline_source_metadata_budget_exceeded", refusal.Message);
                Assert.False(refusal.Data.Contains(OfflineMigrationSourceObserver.SourceMaterialCleanupFailuresKey));
            }
            else
            {
                Assert.Equal("fixture-cell", Assert.Single(Assert.Single(await actual)));
            }
            AssertLifecycle(fixture);
        }
        finally
        {
            readerTerminal.TrySetResult();
            commandTerminal.TrySetResult();
            try { await actual; }
            catch (InvalidOperationException failure) when (bodyRefuses && failure.Message == "offline_source_metadata_budget_exceeded") { }
        }
    }

    [Fact]
    public async Task OrdinaryRowsAndOriginalCommandConfigurationRemainUnchanged()
    {
        Fixture fixture = CreateFixture();
        ImmutableArray<ImmutableArray<string>> rows = await ReadActualPrivateHelperAsync(fixture, default);
        Assert.Equal("fixture-cell", Assert.Single(Assert.Single(rows)));
        Assert.Same(fixture.Transaction, fixture.Command.Transaction);
        Assert.Equal("SOURCE lifecycle fixture only", fixture.Command.CommandText);
        Assert.Equal(30, fixture.Command.CommandTimeout);
        AssertLifecycle(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MaterialEntryRetainsExactNativeDriverGuards(bool nativeConnection)
    {
        DbConnection connection = nativeConnection ? new MySqlConnection() : Substitute.For<DbConnection>();
        try
        {
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                OfflineMigrationSourceObserver.ReadMySqlNativeIdentityMaterialAsync(connection, Substitute.For<DbTransaction>(), default));
            Assert.Equal("offline_source_native_streaming_driver_required", failure.Message);
        }
        finally { await connection.DisposeAsync(); }
    }

    private static Task<ImmutableArray<ImmutableArray<string>>> ReadActualPrivateHelperAsync(Fixture fixture, CancellationToken token)
    {
        // SOURCE lifecycle doubles enter the original private implementation.
        // No production visibility, native driver guard, identity or capability is changed.
        Type observer = typeof(OfflineMigrationSourceObserver);
        Type budgetType = observer.GetNestedType("ObservationBudget", BindingFlags.NonPublic)!;
        object budget = Activator.CreateInstance(budgetType, nonPublic: true)!;
        MethodInfo method = observer.GetMethod("ReadProviderRowsAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        return (Task<ImmutableArray<ImmutableArray<string>>>)method.Invoke(null,
            [fixture.Connection, fixture.Transaction, "SOURCE lifecycle fixture only", budget, token])!;
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
        reader.FieldCount.Returns(1);
        reader.IsDBNull(0).Returns(false);
        reader.GetValue(0).Returns("fixture-cell");
        reader.DisposeAsync().Returns(ValueTask.CompletedTask);
        command.DisposeAsync().Returns(ValueTask.CompletedTask);
        return new(connection, transaction, command, reader,
            new IOException("fixture_reader_secondary_secret"), new IOException("fixture_command_secondary_secret"));
    }

    private static void AssertCleanupCodes(Exception failure, bool readerFailed, bool commandFailed)
    {
        ImmutableArray<string> actual = Assert.IsType<ImmutableArray<string>>(
            failure.Data[OfflineMigrationSourceObserver.SourceMaterialCleanupFailuresKey]);
        var expected = ImmutableArray.CreateBuilder<string>();
        if (readerFailed) expected.Add("offline_source_material_reader_cleanup_failed");
        if (commandFailed) expected.Add("offline_source_material_command_cleanup_failed");
        Assert.Equal(expected.ToImmutable(), actual);
        Assert.DoesNotContain(actual, code => code.Contains("secret", StringComparison.Ordinal));
        Assert.All(failure.Data.Values.Cast<object>(), value => Assert.IsType<ImmutableArray<string>>(value));
    }

    private static void AssertLifecycle(Fixture fixture, bool readerCreated = true)
    {
        Assert.Equal(readerCreated ? 1 : 0,
            fixture.Reader.ReceivedCalls().Count(call => call.GetMethodInfo().Name == nameof(DbDataReader.DisposeAsync)));
        Assert.Single(fixture.Command.ReceivedCalls(), call => call.GetMethodInfo().Name == nameof(DbCommand.DisposeAsync));
        Assert.Empty(fixture.Transaction.ReceivedCalls());
        fixture.Connection.DidNotReceive().Open();
    }

    private sealed record Fixture(DbConnection Connection, DbTransaction Transaction, DbCommand Command,
        DbDataReader Reader, Exception ReaderCleanup, Exception CommandCleanup);
}

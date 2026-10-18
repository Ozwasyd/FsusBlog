using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;
using NSubstitute;
using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationOwnedWriterReadScopeTests
{
    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public async Task DriverTupleWithoutOriginalBeginCannotEnterTheWriterReadCallback(CurrentSchemaProviderKind provider)
    {
        using DbConnection connection = Connection(provider);
        using var creator = new CancellationTokenSource();
        using var cleanup = new CancellationTokenSource();
        var native = new OfflineMigrationApplyNativeSession(connection, provider, creator.Token, () => cleanup.Token);
        var transaction = Substitute.For<DbTransaction>();
        transaction.Connection.Returns(connection);
        transaction.IsolationLevel.Returns(provider == CurrentSchemaProviderKind.Sqlite
            ? IsolationLevel.Serializable : IsolationLevel.RepeatableRead);
        bool called = false;
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            native.WithOwnedReadScopeAsync(transaction, (_, _) => { called = true; return Task.CompletedTask; }, default));
        Assert.Equal("offline_apply_original_transaction_required", failure.Message);
        Assert.False(called);
        Assert.Equal(ConnectionState.Closed, connection.State);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public async Task FreshBorrowerTokenCannotEscapeTheCancelledCreatorBeforeAnyNativeIo(CurrentSchemaProviderKind provider)
    {
        using DbConnection connection = Connection(provider);
        using var creator = new CancellationTokenSource();
        using var borrower = new CancellationTokenSource();
        using var cleanup = new CancellationTokenSource();
        var native = new OfflineMigrationApplyNativeSession(connection, provider, creator.Token, () => cleanup.Token);
        creator.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await native.BeginOwnedReadAsync(borrower.Token));
        bool called = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => native.WithOwnedReadScopeAsync(
            Substitute.For<DbTransaction>(), (_, _) => { called = true; return Task.CompletedTask; }, borrower.Token));
        Assert.False(called);
        Assert.False(borrower.IsCancellationRequested);
        Assert.Equal(ConnectionState.Closed, connection.State);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public async Task MissingCreatorCancellationCannotMintANativeReadScope(CurrentSchemaProviderKind provider)
    {
        using DbConnection connection = Connection(provider);
        using var borrower = new CancellationTokenSource();
        var native = new OfflineMigrationApplyNativeSession(connection, provider);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await native.BeginOwnedReadAsync(borrower.Token));
        Assert.Equal("offline_apply_owned_creator_token_required", failure.Message);
        Assert.Equal(ConnectionState.Closed, connection.State);
    }

    [Fact]
    public async Task SqliteTransactionStateIsNotAdmittedAsATransactionEpoch()
    {
        using var connection = new SqliteConnection();
        using var creator = new CancellationTokenSource();
        using var cleanup = new CancellationTokenSource();
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.Sqlite,
            creator.Token, () => cleanup.Token);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await native.BeginOwnedReadAsync(creator.Token));
        Assert.Equal("offline_apply_sqlite_transaction_epoch_unavailable", failure.Message);
        Assert.Equal(ConnectionState.Closed, connection.State);
        Assert.False(native.CleanupRequired); // No Begin, pragma, lock or connection creation occurred.
    }

    private static DbConnection Connection(CurrentSchemaProviderKind provider) => provider switch
    {
        CurrentSchemaProviderKind.PostgreSql => new NpgsqlConnection(),
        CurrentSchemaProviderKind.MySql => new MySqlConnection(),
        CurrentSchemaProviderKind.Sqlite => new SqliteConnection(),
        _ => throw new ArgumentOutOfRangeException(nameof(provider))
    };
}

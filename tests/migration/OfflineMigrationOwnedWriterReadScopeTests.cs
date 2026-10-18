using System.Data;
using System.Data.Common;

using Microsoft.Data.Sqlite;

using MySqlConnector;

using Npgsql;

using NSubstitute;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationOwnedWriterReadScopeTests
{
    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public async Task Driver_tuple_without_original_Begin_cannot_enter_the_writer_read_callback(CurrentSchemaProviderKind provider)
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
    public async Task Fresh_borrower_token_cannot_escape_the_cancelled_creator_before_any_native_IO(CurrentSchemaProviderKind provider)
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
    public async Task Missing_creator_cancellation_cannot_mint_a_native_read_scope(CurrentSchemaProviderKind provider)
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
    public async Task Sqlite_transaction_state_is_not_admitted_as_a_transaction_epoch()
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

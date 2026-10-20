using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Migration;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

using Xunit;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class OfflineMigrationOwnedWriterReadScopeIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Original_native_Begin_context_matches_real_database_and_expires_after_awaited_callback()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        try
        {
            await using DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token);
            OfflineMigrationApplyNativeSession.OwnedReadContext? retained = null;
            await native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
            {
                retained = context;
                Assert.Same(connection, context.OriginalConnection);
                Assert.Same(transaction, context.OriginalTransaction);
                Assert.Equal(CurrentSchemaProviderKind.PostgreSql, context.Database.Provider);
                Assert.EndsWith("/" + database, context.Database.DatabaseId, StringComparison.Ordinal);
                Assert.Equal(await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(connection, transaction, token), context.Database);
                InvalidOperationException nested = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    native.WithOwnedReadScopeAsync(transaction, (_, _) => Task.CompletedTask, token));
                Assert.Equal("offline_apply_owned_read_scope_active", nested.Message);
                await context.RequireBoundaryAsync(token);
            }, creator.Token);
            var actualContext = Assert.IsType<OfflineMigrationApplyNativeSession.OwnedReadContext>(retained);
            InvalidOperationException expired = Assert.Throws<InvalidOperationException>(() => actualContext.CreateReadScope(default));
            Assert.Equal("offline_apply_owned_read_scope_expired", expired.Message);
            await transaction.RollbackAsync(cleanup.Token);
        }
        finally
        {
            Assert.True(await native.ReleaseAsync(cleanup.Token));
        }
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Fact]
    public async Task Committing_the_original_transaction_inside_a_callback_does_not_leave_a_valid_read_context()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        try
        {
            await using DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token);
            bool actualBoundaryReached = false;
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
                {
                    await context.RequireBoundaryAsync(token);
                    actualBoundaryReached = true;
                    await transaction.CommitAsync(token);
                }, creator.Token));
            Assert.True(actualBoundaryReached);
            Assert.Equal("offline_apply_original_transaction_required", failure.Message);
        }
        finally
        {
            Assert.True(await native.ReleaseAsync(cleanup.Token));
        }
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Callback_cancellation_reaches_fresh_scope_and_independent_cleanup_still_releases_original_lock(bool cancelCreator)
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var borrower = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        try
        {
            await using DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token);
            bool callbackReached = false;
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => native.WithOwnedReadScopeAsync(transaction, (context, _) =>
            {
                callbackReached = true;
                using CancellationTokenSource fresh = context.CreateReadScope(default);
                if (cancelCreator)
                    creator.Cancel();
                else
                    borrower.Cancel();
                Assert.True(fresh.IsCancellationRequested);
                return Task.CompletedTask;
            }, borrower.Token));
            Assert.True(callbackReached);
            await transaction.RollbackAsync(cleanup.Token);
        }
        finally
        {
            Assert.True(await native.ReleaseAsync(cleanup.Token));
        }
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Fact]
    public async Task Reopened_driver_object_does_not_release_a_replacement_sessions_caller_lock()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        int originalProcessId = connection.ProcessID;
        await using (DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token))
        {
            await native.WithOwnedReadScopeAsync(transaction, (_, _) => Task.CompletedTask, creator.Token);
            await transaction.RollbackAsync(cleanup.Token);
        }
        // The original fixture is non-pooled. Closing the borrowed object ends
        // that backend; reopening it does not transfer original lock custody.
        await connection.CloseAsync();
        await connection.OpenAsync(creator.Token);
        Assert.NotEqual(originalProcessId, connection.ProcessID);
        await using DbCommand replacementLock = OfflineMigrationStateStore.NativeCommand(connection, null,
            "SELECT pg_try_advisory_lock(hashtext(@name))");
        OfflineMigrationStateStore.Parameter(replacementLock, "@name", OfflineMigrationHost.StateLockConstant);
        Assert.Equal(true, await replacementLock.ExecuteScalarAsync(creator.Token));
        try
        {
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => native.ReleaseAsync(cleanup.Token));
            Assert.Equal("offline_apply_original_session_required", failure.Message);
            Assert.True(native.CleanupRequired);
            Assert.Equal(ConnectionState.Open, connection.State);
        }
        finally
        {
            await using DbCommand callerUnlock = OfflineMigrationStateStore.NativeCommand(connection, null,
                "SELECT pg_advisory_unlock(hashtext(@name))");
            OfflineMigrationStateStore.Parameter(callerUnlock, "@name", OfflineMigrationHost.StateLockConstant);
            // True proves the failed original release did not decrement this
            // replacement session's independently acquired caller lock.
            Assert.Equal(true, await callerUnlock.ExecuteScalarAsync(cleanup.Token));
        }
    }

    [Fact]
    public async Task Multiple_boundary_calls_use_one_native_connection_without_overlapping_driver_commands()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        try
        {
            await using DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token);
            await native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
            {
                Assert.Same(connection, context.OriginalConnection);
                Assert.Same(transaction, context.OriginalTransaction);
                Task first = context.RequireBoundaryAsync(token);
                Task second = context.RequireBoundaryAsync(token);
                await Task.WhenAll(first, second);
            }, creator.Token);
            await transaction.RollbackAsync(cleanup.Token);
        }
        finally
        {
            Assert.True(await native.ReleaseAsync(cleanup.Token));
        }
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Fact]
    public async Task Callback_first_failure_is_preserved_while_an_entered_boundary_is_terminally_joined()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        using var creator = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await connection.OpenAsync(creator.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            creator.Token, () => cleanup.Token);
        Assert.True(await native.AcquireAsync(creator.Token));
        var firstFailure = new InvalidOperationException("owned_fixture_callback_failed");
        try
        {
            await using DbTransaction transaction = await native.BeginOwnedReadAsync(creator.Token);
            Task? enteredBoundary = null;
            OfflineMigrationApplyNativeSession.OwnedReadContext? retained = null;
            InvalidOperationException reported = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                native.WithOwnedReadScopeAsync(transaction, (context, token) =>
                {
                    retained = context;
                    enteredBoundary = context.RequireBoundaryAsync(token);
                    throw firstFailure;
                }, creator.Token));
            Assert.Same(firstFailure, reported);
            // This explicitly observes the boundary task too; no arbitrary raw
            // callback IO is declared owned or drained by the production port.
            Task actualBoundary = Assert.IsAssignableFrom<Task>(enteredBoundary);
            Assert.True(actualBoundary.IsCompleted);
            try
            {
                await actualBoundary;
            }
            catch (OperationCanceledException)
            {
            }
            catch (InvalidOperationException failure) when (failure.Message == "offline_apply_owned_read_scope_expired")
            {
            }
            var closed = Assert.IsType<OfflineMigrationApplyNativeSession.OwnedReadContext>(retained);
            InvalidOperationException expired = Assert.Throws<InvalidOperationException>(() => closed.CreateReadScope(default));
            Assert.Equal("offline_apply_owned_read_scope_expired", expired.Message);
            await transaction.RollbackAsync(cleanup.Token);
        }
        finally
        {
            Assert.True(await native.ReleaseAsync(cleanup.Token));
        }
        Assert.Equal(ConnectionState.Open, connection.State);
    }
}

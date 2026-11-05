using System.Data;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class AdminRequestSqlFenceIntegrationTests(PostgresSchemaMigrationFixture postgres)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OwnedPublication_HoldsActualSessionAndPrincipalLocksThroughCallback(bool principalRevoke)
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        await using var revoker = new NpgsqlConnection(fixture.Connection);
        await revoker.OpenAsync();
        Task<int>? revoke = null;
        bool published = false;
        await lifetime.PublishReadAsync(connection,
            (_, transaction, _) =>
            {
                Assert.Same(connection, transaction.Connection);
                return Task.FromResult("bounded-private-result");
            },
            async (value, _) =>
            {
                Assert.Equal("bounded-private-result", value);
                revoke = UpdateAsync(revoker, principalRevoke
                    ? "UPDATE admin_principal SET status = 'disabled', validationversion = 2 WHERE id = 1"
                    : "UPDATE admin_session SET revokedatutc = clock_timestamp() AT TIME ZONE 'UTC', validationversion = 2 WHERE sessionid = 'first'");
                await WaitForLockAsync(fixture.Connection, revoker.ProcessID);
                Assert.False(revoke.IsCompleted);
                published = true;
            });
        Assert.True(published);
        Assert.Equal(1, await revoke!.WaitAsync(TimeSpan.FromSeconds(10)));
        // SQL has committed remotely, but no received local update has arrived yet.
        Assert.True(lifetime.IsCurrent);
        bool secondPublication = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lifetime.PublishReadAsync(connection,
            (_, _, _) => Task.FromResult(1), (_, _) => { secondPublication = true; return Task.CompletedTask; }));
        Assert.False(secondPublication);
        Assert.True(lifetime.IsCurrent);
        fixture.Projection.MarkNotReady("received-later");
        Assert.False(lifetime.IsCurrent);
    }

    [Theory]
    [InlineData("revoke")]
    [InlineData("hash")]
    [InlineData("session-version")]
    [InlineData("principal-version")]
    [InlineData("principal-status")]
    [InlineData("expiry")]
    public async Task DelayedLocalInvalidation_RealAuthorityChangesRejectFinalFence(string mutation)
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        string sql = mutation switch
        {
            "revoke" => "UPDATE admin_session SET revokedatutc = clock_timestamp() AT TIME ZONE 'UTC'",
            "hash" => "UPDATE admin_session SET accesstokenhash = repeat('0', 64)",
            "session-version" => "UPDATE admin_session SET validationversion = 2",
            "principal-version" => "UPDATE admin_principal SET validationversion = 2",
            "principal-status" => "UPDATE admin_principal SET status = 'disabled'",
            _ => "UPDATE admin_session SET idleexpiresatutc = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'"
        };
        await UpdateAsync(connection, sql);
        Assert.True(lifetime.IsCurrent);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lifetime.VerifyAndFenceAsync(connection, transaction));
        await transaction.RollbackAsync();
    }

    [Fact]
    public async Task CallerTransaction_FenceUsesOriginalTransaction_AndLocksSurviveUntilCommit()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await using (var write = new NpgsqlCommand("UPDATE admin_session SET lastseenatutc = clock_timestamp() AT TIME ZONE 'UTC' WHERE sessionid = 'first'", connection, transaction))
        {
            Assert.Equal(1, await write.ExecuteNonQueryAsync());
        }
        await lifetime.VerifyAndFenceAsync(connection, transaction);
        await using var revoker = new NpgsqlConnection(fixture.Connection);
        await revoker.OpenAsync();
        Task<int> revoke = UpdateAsync(revoker, "UPDATE admin_principal SET status = 'disabled', validationversion = 2 WHERE id = 1");
        await WaitForLockAsync(fixture.Connection, revoker.ProcessID);
        Assert.False(revoke.IsCompleted);
        await transaction.CommitAsync();
        Assert.Equal(1, await revoke.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task WaitingFence_ObservesConcurrentCommittedRevokeBeforeReturning()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var revoker = new NpgsqlConnection(fixture.Connection);
        await revoker.OpenAsync();
        await using var revokeTransaction = await revoker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("UPDATE admin_session SET revokedatutc = clock_timestamp() AT TIME ZONE 'UTC', validationversion = 2", revoker, revokeTransaction))
        {
            await command.ExecuteNonQueryAsync();
        }
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        Task fence = lifetime.VerifyAndFenceAsync(connection, transaction);
        await WaitForLockAsync(fixture.Connection, connection.ProcessID);
        Assert.False(fence.IsCompleted);
        await revokeTransaction.CommitAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fence);
        Assert.True(lifetime.IsCurrent);
        await transaction.RollbackAsync();
    }

    [Fact]
    public async Task FailuresAndCancellation_RollBackOwnedTransaction_AndReleaseLocks()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => lifetime.PublishReadAsync<int>(connection,
            async (db, transaction, ct) =>
            {
                await using var command = new NpgsqlCommand("UPDATE admin_session SET lastseenatutc = clock_timestamp() AT TIME ZONE 'UTC'", (NpgsqlConnection)db, (NpgsqlTransaction)transaction);
                await command.ExecuteNonQueryAsync(ct);
                return 1;
            }, (_, _) => throw new InvalidOperationException("publication failed")));
        await using (var verify = new NpgsqlCommand("SELECT lastseenatutc IS NULL FROM admin_session", connection))
        {
            Assert.True((bool)(await verify.ExecuteScalarAsync())!);
        }
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lifetime.PublishReadAsync(connection,
            (_, _, _) => Task.FromResult(1), (_, _) => Task.CompletedTask, canceled.Token));
        await using var other = new NpgsqlConnection(fixture.Connection);
        await other.OpenAsync();
        Assert.Equal(1, await UpdateAsync(other, "UPDATE admin_session SET validationversion = 2").WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task WrongConnectionIsolationAndDisposedLifetime_FailClosed()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var first = new NpgsqlConnection(fixture.Connection);
        await using var other = new NpgsqlConnection(fixture.Connection);
        await first.OpenAsync();
        await other.OpenAsync();
        await using (var transaction = await first.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => lifetime.VerifyAndFenceAsync(other, transaction));
            await transaction.RollbackAsync();
        }
        await using (var snapshot = await first.BeginTransactionAsync(IsolationLevel.RepeatableRead))
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => lifetime.VerifyAndFenceAsync(first, snapshot));
            await snapshot.RollbackAsync();
        }
        lifetime.Dispose();
        await using var disposed = await first.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lifetime.VerifyAndFenceAsync(first, disposed));
    }

    [Fact]
    public async Task DisposeDuringAuthorityLockWait_CancelsCommandAndReleasesTransaction()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var blocker = new NpgsqlConnection(fixture.Connection);
        await blocker.OpenAsync();
        await using var blockingTransaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT id FROM admin_principal WHERE id = 1 FOR UPDATE", blocker, blockingTransaction))
        {
            await command.ExecuteScalarAsync();
        }
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        Task fence = lifetime.VerifyAndFenceAsync(connection, transaction);
        await WaitForLockAsync(fixture.Connection, connection.ProcessID);
        lifetime.Dispose();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fence.WaitAsync(TimeSpan.FromSeconds(5)));
        await transaction.RollbackAsync();
        await blockingTransaction.RollbackAsync();
        Assert.Equal(0, fixture.Projection.ActiveRequestLifetimeCount);
        Assert.Equal(1, await UpdateAsync(blocker, "UPDATE admin_session SET validationversion = 2"));
    }

    [Fact]
    public async Task ReadinessWithdrawalDuringRead_PreventsPublication()
    {
        var fixture = await CreateAsync();
        using AdminAuthenticatedRequestLifetime lifetime = fixture.Lifetime;
        await using var connection = new NpgsqlConnection(fixture.Connection);
        await connection.OpenAsync();
        bool published = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => lifetime.PublishReadAsync(connection,
            (_, _, _) =>
            {
                fixture.Projection.MarkNotReady("received-withdrawal");
                return Task.FromResult(1);
            },
            (_, _) => { published = true; return Task.CompletedTask; }));
        Assert.False(published);
        Assert.Equal(0, fixture.Projection.ActiveRequestLifetimeCount);
    }

    private async Task<(string Connection, AdminSessionProjection Projection, AdminAuthenticatedRequestLifetime Lifetime)> CreateAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        // Authority expiry uses PostgreSQL wall time, so these tests intentionally use live time.
        long ticks = DateTimeOffset.UtcNow.Ticks;
        var temporal = new TestTemporalContext(new DateTimeOffset(ticks - ticks % 10, TimeSpan.Zero));
        DateTime now = temporal.BusinessEpochUtc.UtcDateTime;
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection))
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
            long id = await db.Insertable(new AdminPrincipal { Handle = "fence-admin", CreatedAtUtc = now }).ExecuteReturnBigIdentityAsync();
            Assert.Equal(1, id);
            await db.Insertable(new AdminSession
            {
                SessionId = "first",
                AdminPrincipalId = id,
                AccessTokenHash = Convert.ToHexString(AdminAuthenticatedRequestLifetimeTests.Hash("token")),
                CreatedAtUtc = now,
                IdleExpiresAtUtc = now.AddMinutes(10),
                AbsoluteExpiresAtUtc = now.AddHours(1)
            }).ExecuteCommandAsync();
        }
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024), temporal.BusinessClock);
        // Project actual received SQL facts, including database timestamp precision.
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection))
        {
            var authority = new AdminSessionProjectionAuthorityReader(db, projection,
                AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build()), temporal.BusinessClock);
            AdminSessionProjectionSessionUpdate? session = await authority.ReadSessionAsync("first");
            Assert.NotNull(session);
            Assert.True(projection.Apply(session.Value).Accepted);
        }
        Assert.True(projection.MarkReady(1));
        Assert.True(projection.ValidateForRequest("first", 1, AdminAuthenticatedRequestLifetimeTests.Hash("token"), out var lifetime).IsValid);
        return (connection, projection, lifetime!);
    }

    private static async Task<int> UpdateAsync(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection) { CommandTimeout = 10 };
        return await command.ExecuteNonQueryAsync();
    }

    private static async Task WaitForLockAsync(string connectionString, int pid)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await using var monitor = new NpgsqlConnection(connectionString);
        await monitor.OpenAsync(timeout.Token);
        await using var query = new NpgsqlCommand("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = @pid AND wait_event_type = 'Lock')", monitor);
        query.Parameters.AddWithValue("pid", pid);
        while (!(bool)(await query.ExecuteScalarAsync(timeout.Token))!)
        {
            await Task.Delay(10, timeout.Token);
        }
    }
}

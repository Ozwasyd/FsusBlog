using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Npgsql;
using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ActiveReleaseFencedCommitIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Release41 = "20260715080000-generation-41";
    private const string Release42 = "20260715090000-generation-42";
    private const string Digest41 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Digest42 = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTimeOffset Now = new(2026, 7, 15, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task EnlistedTransaction_BlocksRevokeUntilBusinessCommit()
    {
        string connectionString = await CreateDatabaseAsync(Release41, "blue", 41, Digest41);
        using SqlSugarClient workerDb = PostgresSqlSugarTestClient.Create(connectionString);
        var guard = CreateGuard();
        var enlisted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowCommit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ActiveReleaseExecutionTicket ticket = Ticket(Release41, "blue", 41, Digest41, "worker-41");

        Task<DbResult<bool>> workerTransaction = workerDb.Ado.UseTranAsync(async () =>
        {
            await workerDb.Ado.ExecuteCommandAsync(
                "INSERT INTO fenced_commit_probe(id, owner) VALUES (41, 'generation-41');");
            await guard.EnlistAsync(workerDb, ticket, "integration-probe", "probe-41");
            enlisted.SetResult();
            await allowCommit.Task;
            return true;
        });
        await enlisted.Task.WaitAsync(TimeSpan.FromSeconds(10));

        var revokeStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task revoke = RevokeAsync(connectionString, Release41, 41, revokeStarted);
        await revokeStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            await WaitForBlockedAdvisoryLockAsync(connectionString);
            Assert.False(revoke.IsCompleted);
        }
        finally
        {
            allowCommit.TrySetResult();
        }
        DbResult<bool> committed = await workerTransaction.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(committed.IsSuccess, committed.ErrorMessage);
        await revoke.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(1, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT COUNT(*) FROM fenced_commit_probe WHERE id = 41;"));
        Assert.Equal(1, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT COUNT(*) FROM sys_fenced_commit WHERE generation = 41;"));
        Assert.Equal("revoked", await fixture.QueryScalarAsync<string>(
            connectionString,
            "SELECT status FROM sys_deployment_fence WHERE id = 1;"));
    }

    [Fact]
    public async Task GcPausedOldGeneration_AfterDurableSwitch_RollsBackSplitBrainMutationAndToken()
    {
        string connectionString = await CreateDatabaseAsync(Release41, "blue", 41, Digest41);
        using SqlSugarClient oldWorkerDb = PostgresSqlSugarTestClient.Create(connectionString);
        var executionContext = new ActiveReleaseExecutionContextAccessor();
        var guard = new ActiveReleaseTransactionalCommitGuard(
            executionContext,
            new ConfigurationBuilder().AddInMemoryCollection().Build());
        var mutationWritten = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resumeAfterPause = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ActiveReleaseExecutionTicket oldTicket = Ticket(Release41, "blue", 41, Digest41, "paused-worker-41");

        Task oldWorker = Task.Run(async () =>
        {
            using IDisposable scope = executionContext.Push(oldTicket);
            await Assert.ThrowsAsync<ActiveReleaseFenceLostException>(() =>
                ActiveReleaseFencedTransaction.ExecuteAsync(
                    oldWorkerDb,
                    guard,
                    "gc-pause-probe",
                    "probe-41-after-switch",
                    async _ =>
                    {
                        int inserted = await oldWorkerDb.Ado.ExecuteCommandAsync(
                            "INSERT INTO fenced_commit_probe(id, owner) VALUES (41, 'stale-generation-41');");
                        mutationWritten.SetResult();
                        await resumeAfterPause.Task;
                        return inserted;
                    }));
        });
        await mutationWritten.Task.WaitAsync(TimeSpan.FromSeconds(10));

        try
        {
            await SwitchFenceAsync(connectionString, Release42, "green", 42, Digest42);
        }
        finally
        {
            resumeAfterPause.TrySetResult();
        }
        await oldWorker.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(0, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT COUNT(*) FROM fenced_commit_probe WHERE id = 41;"));
        Assert.Equal(0, await fixture.QueryScalarAsync<int>(
            connectionString,
            "SELECT COUNT(*) FROM sys_fenced_commit WHERE generation = 41;"));
        Assert.Equal(42L, await fixture.QueryScalarAsync<long>(
            connectionString,
            "SELECT generation FROM sys_deployment_fence WHERE id = 1;"));
    }

    [Fact]
    public async Task AuditQuery_ExecutesAgainstDeploymentAndCommitTablesWithoutAmbiguousColumns()
    {
        string connectionString = await CreateDatabaseAsync(Release41, "blue", 41, Digest41);
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(ActiveReleaseFencedCommitSql.Audit, connection);
        command.Parameters.AddWithValue("CutoffUtc", Now.AddMinutes(-1).UtcDateTime);
        command.Parameters.AddWithValue("BatchSize", 100);

        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();

        Assert.False(await reader.ReadAsync());
        Assert.Equal("commit_token", reader.GetName(0));
        Assert.Equal("release_id", reader.GetName(3));
    }

    private async Task<string> CreateDatabaseAsync(
        string releaseId,
        string slot,
        long generation,
        string digest)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        await fixture.ExecuteAsync(
            connectionString,
            """
            CREATE TABLE sys_deployment_fence (
                id smallint PRIMARY KEY,
                release_id varchar(96) NOT NULL,
                slot varchar(24) NOT NULL,
                generation bigint NOT NULL,
                image_digest varchar(160) NOT NULL,
                status varchar(24) NOT NULL,
                activated_at_utc timestamp NULL,
                revoked_at_utc timestamp NULL,
                updated_at_utc timestamp NOT NULL
            );
            CREATE TABLE sys_fenced_commit (
                commit_token varchar(32) PRIMARY KEY,
                operation_scope varchar(96) NOT NULL,
                mutation_key varchar(192) NOT NULL,
                release_id varchar(96) NOT NULL,
                slot varchar(24) NOT NULL,
                generation bigint NOT NULL,
                image_digest varchar(160) NOT NULL,
                process_instance_id varchar(192) NOT NULL,
                enlisted_at_utc timestamp NOT NULL
            );
            CREATE TABLE fenced_commit_probe (
                id integer PRIMARY KEY,
                owner varchar(96) NOT NULL
            );
            """);
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(
            """
            INSERT INTO sys_deployment_fence(
                id, release_id, slot, generation, image_digest, status,
                activated_at_utc, revoked_at_utc, updated_at_utc)
            VALUES (1, @releaseId, @slot, @generation, @digest, 'active', @now, NULL, @now);
            """,
            connection);
        command.Parameters.AddWithValue("releaseId", releaseId);
        command.Parameters.AddWithValue("slot", slot);
        command.Parameters.AddWithValue("generation", generation);
        command.Parameters.AddWithValue("digest", digest);
        command.Parameters.AddWithValue("now", Now.UtcDateTime);
        Assert.Equal(1, await command.ExecuteNonQueryAsync());
        return connectionString;
    }

    private static async Task RevokeAsync(
        string connectionString,
        string releaseId,
        long generation,
        TaskCompletionSource started)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        started.SetResult();
        await using var command = new NpgsqlCommand(
            """
            SELECT pg_advisory_xact_lock(1179862354);
            UPDATE sys_deployment_fence
            SET status = 'revoked', revoked_at_utc = @now, updated_at_utc = @now
            WHERE id = 1 AND release_id = @releaseId AND generation = @generation;
            """,
            connection,
            transaction);
        command.Parameters.AddWithValue("now", Now.UtcDateTime.AddMinutes(1));
        command.Parameters.AddWithValue("releaseId", releaseId);
        command.Parameters.AddWithValue("generation", generation);
        await command.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    private static async Task SwitchFenceAsync(
        string connectionString,
        string releaseId,
        string slot,
        long generation,
        string digest)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        await using var command = new NpgsqlCommand(
            """
            SELECT pg_advisory_xact_lock(1179862354);
            UPDATE sys_deployment_fence
            SET release_id = @releaseId,
                slot = @slot,
                generation = @generation,
                image_digest = @digest,
                status = 'active',
                activated_at_utc = @now,
                revoked_at_utc = NULL,
                updated_at_utc = @now
            WHERE id = 1;
            """,
            connection,
            transaction);
        command.Parameters.AddWithValue("releaseId", releaseId);
        command.Parameters.AddWithValue("slot", slot);
        command.Parameters.AddWithValue("generation", generation);
        command.Parameters.AddWithValue("digest", digest);
        command.Parameters.AddWithValue("now", Now.UtcDateTime.AddMinutes(1));
        await command.ExecuteNonQueryAsync();
        await transaction.CommitAsync();
    }

    private async Task WaitForBlockedAdvisoryLockAsync(string connectionString)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            int blocked = await fixture.QueryScalarAsync<int>(
                connectionString,
                "SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory' AND granted = false;");
            if (blocked > 0)
            {
                return;
            }
            await Task.Delay(TimeSpan.FromMilliseconds(25));
        }
        throw new TimeoutException("The revoke transaction did not block on the fenced commit advisory lock.");
    }

    private static ActiveReleaseTransactionalCommitGuard CreateGuard()
        => new(
            new ActiveReleaseExecutionContextAccessor(),
            new ConfigurationBuilder().AddInMemoryCollection().Build());

    private static ActiveReleaseExecutionTicket Ticket(
        string releaseId,
        string slot,
        long generation,
        string digest,
        string processInstanceId)
        => new(releaseId, slot, generation, digest, processInstanceId);
}

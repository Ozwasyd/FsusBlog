using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Npgsql;

using SqlSugar;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AdminAuditDurableReplayIssue2040IntegrationTests(
    PostgresSchemaMigrationFixture fixture, ITestOutputHelper output)
{
    [Fact]
    public async Task RealCommitBeforeAcknowledgementLoss_RetryKeepsOneExactEvent()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("commit-before-ack-loss");
        await owner.Channel.EnqueueAsync(expected);
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        var store = new AdminAuditLogStore(db);
        await Assert.ThrowsAsync<IOException>(async () =>
        {
            await store.WriteBatchAsync([delivery], CancellationToken.None);
            throw new IOException("Acknowledgement lost after the real PostgreSQL commit.");
        });
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync()));
        await store.WriteBatchAsync([delivery], CancellationToken.None);
        AdminAuditLog row = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
        AdminAuditIssue2040Owner.AssertFullPayload(expected, row);
        Assert.True(row.Id > 0);
    }

    [Fact]
    public async Task SameAcceptedIdentityWithAlteredPayload_IsRejectedWithoutAnotherSideEffect()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("altered-duplicate");
        await owner.Channel.EnqueueAsync(expected);
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        var store = new AdminAuditLogStore(db);
        await store.WriteBatchAsync([delivery], CancellationToken.None);
        expected = AdminAuditIssue2040Owner.Copy(expected);
        delivery.MetadataJson = "{\"forged\":true}";
        await Assert.ThrowsAsync<InvalidDataException>(() => store.WriteBatchAsync([delivery], CancellationToken.None));
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync()));
    }

    [Fact]
    public async Task TwoLegitimateIdenticalPayloads_RemainTwoIndependentEventsInOrder()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("legitimate-identical");
        await owner.Channel.EnqueueAsync(expected);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Copy(expected));
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? first));
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? second));
        await new AdminAuditLogStore(db).WriteBatchAsync([first, second], CancellationToken.None);
        AdminAuditLog[] rows = (await db.Queryable<AdminAuditLog>().OrderBy(row => row.Id).ToListAsync()).ToArray();
        Assert.Equal(2, rows.Length);
        Assert.True(rows[0].Id < rows[1].Id);
        Assert.All(rows, row => AdminAuditIssue2040Owner.AssertFullPayload(expected, row));
    }

    [Fact]
    public async Task FreshOwnerAfterRealCommitWithoutJournalAcknowledgement_ReusesDurableReservation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("cold-ack-loss");
        await owner.Channel.EnqueueAsync(expected);
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        await new AdminAuditLogStore(db).WriteBatchAsync([delivery], CancellationToken.None);
        long committedId = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync()).Id;
        using var restarted = Owner(db, owner.Root, deleteRoot: false);
        await restarted.Channel.ReplayAsync(CancellationToken.None);
        AdminAuditLog row = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
        Assert.Equal(committedId, row.Id);
        AdminAuditIssue2040Owner.AssertFullPayload(expected, row);
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task ConcurrentScopes_ReplayOneAcceptedIdentityWithoutDuplicateCommit()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("concurrent-duplicate");
        await owner.Channel.EnqueueAsync(expected);
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        await Task.WhenAll(
            new AdminAuditLogStore(db).WriteBatchAsync([delivery], CancellationToken.None),
            new AdminAuditLogStore(other).WriteBatchAsync([delivery], CancellationToken.None));
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync()));
        await owner.Channel.ReplayAsync(CancellationToken.None);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
        Assert.Equal(1, await db.Queryable<AdminAuditLog>().CountAsync());
    }

    [Theory]
    [InlineData("full")]
    [InlineData("closed")]
    [InlineData("cancelled")]
    public async Task RealCapacityOneRejectedAdmission_PreservesExactDurableCommit(string mode)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AdminAuditIssue2040Owner(
            database: () => PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString), capacity: 1);
        using var cancellation = new CancellationTokenSource();
        if (mode == "full")
        {
            await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("older"));
        }
        else if (mode == "closed")
        {
            owner.Channel.Complete();
        }
        else
        {
            cancellation.Cancel();
        }
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("rejected-required");
        await owner.Channel.EnqueueAsync(expected, cancellation.Token);
        AdminAuditLog[] rows = (await db.Queryable<AdminAuditLog>().OrderBy(row => row.Id).ToListAsync()).ToArray();
        Assert.Equal(mode == "full" ? 2 : 1, rows.Length);
        AdminAuditIssue2040Owner.AssertFullPayload(expected, rows[^1]);
        if (mode == "full")
        {
            Assert.Equal("older", rows[0].Action);
            Assert.True(rows[0].Id < rows[1].Id);
        }
        Assert.Equal(1, owner.Channel.Snapshot().RejectedCount);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Theory]
    [InlineData("adminprincipalid")]
    [InlineData("adminsessionid")]
    [InlineData("action")]
    [InlineData("outcome")]
    [InlineData("targettype")]
    [InlineData("targetid")]
    [InlineData("iphash")]
    [InlineData("useragenthash")]
    [InlineData("ishighimpact")]
    [InlineData("metadatajson")]
    [InlineData("occurredatutc")]
    public async Task EveryStoredPayloadColumn_IsPartOfExactCommitPostcondition(string column)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        await owner.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("stored-payload-mutation"));
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        await new AdminAuditLogStore(db).WriteBatchAsync([delivery], CancellationToken.None);
        string value = column switch
        {
            "adminprincipalid" => "7",
            "ishighimpact" => "false",
            "occurredatutc" => "occurredatutc + interval '1 second'",
            _ => "'altered'"
        };
        // The theory's fixed column allowlist is the only identifier input.
        await db.Ado.ExecuteCommandAsync($"UPDATE admin_audit_log SET {column} = {value};");
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Channel.ReplayAsync(CancellationToken.None));
        Assert.Equal(1, await db.Queryable<AdminAuditLog>().CountAsync());
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
    }

    [Fact]
    public async Task RealPostgresReplayFailure_RetainsDeliveryAndRecoversAfterStoreRepair()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("real-store-failure");
        await owner.Channel.EnqueueAsync(expected);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE admin_audit_log RENAME COLUMN metadatajson TO unavailablemetadata;");
        await Assert.ThrowsAnyAsync<Exception>(() => owner.Channel.ReplayAsync(CancellationToken.None));
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
        Assert.NotNull(owner.Channel.Snapshot().LastFailureReason);
        var failedHealth = AdminAuditDurableAdmissionIssue2040Tests.ObserveAdmin(owner);
        Assert.False(failedHealth.Complete);
        Assert.Equal("failed", failedHealth.HealthStatus);
        Assert.Equal("failed", failedHealth.ReadinessStatus);
        Assert.Equal("failed", failedHealth.QualificationStatus);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE admin_audit_log RENAME COLUMN unavailablemetadata TO metadatajson;");
        await owner.Channel.ReplayAsync(CancellationToken.None);
        AdminAuditIssue2040Owner.AssertFullPayload(expected, Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync()));
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
        Assert.True(AdminAuditDurableAdmissionIssue2040Tests.ObserveAdmin(owner).Complete);
    }

    [Fact]
    public async Task WriterCancelledDuringRealAdvisoryWait_RollsBackAndReplaysSameReservedIdentity()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = Owner(db);
        AdminAuditLog expected = AdminAuditIssue2040Owner.Record("real-lock-cancel");
        await owner.Channel.EnqueueAsync(expected);
        Assert.True(owner.Channel.TryRead(out AdminAuditLog? delivery));
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using var transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand(
            "SELECT pg_advisory_xact_lock(hashtextextended('admin-audit-commit:1', 2040));", blocker, transaction))
        {
            await command.ExecuteNonQueryAsync();
        }
        using var cancellation = new CancellationTokenSource();
        Task write = owner.Channel.ReplayAsync(cancellation.Token);
        Assert.True(await ObserveRealLockWaitAsync(db, blocker.ProcessID, write),
            "The actual admin writer must reach the canonical PostgreSQL advisory wait.");
        Assert.Equal(1, await ReadSequenceValueAsync(db));
        Assert.Equal(0, owner.Channel.Snapshot().QueuedCount);
        Assert.Equal(1, owner.Channel.Snapshot().InFlightCount);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => write);
        Assert.Equal(0, await db.Queryable<AdminAuditLog>().CountAsync());
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(0, owner.Channel.Snapshot().InFlightCount);
        Assert.Equal(0, owner.Channel.Snapshot().TerminalFailureCount);
        await transaction.RollbackAsync();
        await owner.Channel.ReplayAsync(CancellationToken.None);
        AdminAuditLog row = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
        Assert.Equal(1, row.Id);
        Assert.Equal(1, await ReadSequenceValueAsync(db));
        AdminAuditIssue2040Owner.AssertFullPayload(expected, row);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    [Trait("Category", "Process")]
    public async Task KillAfterRealCommitBeforeJournalAck_RestartVerifiesOneExactDatabaseIdentity()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var initial = Owner(db);
        await using var child = await StartOwnedChildAsync(db, initial.Root, "commit-before-ack");
        await child.AssertCommitMarkerAsync();
        AdminAuditLog before = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
        await child.KillAsync();
        using var restarted = Owner(db, initial.Root, deleteRoot: false);
        await restarted.Channel.ReplayAsync(CancellationToken.None);
        AdminAuditLog row = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
        Assert.Equal(before.Id, row.Id);
        AdminAuditIssue2040Owner.AssertFullPayload(AdminAuditIssue2040Owner.Record("accepted-before-kill"), row);
        Assert.Equal(1, await ReadSequenceValueAsync(db));
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    [Trait("Category", "Process")]
    public async Task KillAfterDurableIdReservationWhileRealWriterBlocked_RestartReusesIdentityInOrder()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var initial = Owner(db);
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using var transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand(
            "SELECT pg_advisory_xact_lock(hashtextextended('admin-audit-commit:1', 2040));", blocker, transaction))
        {
            await command.ExecuteNonQueryAsync();
        }
        await using var child = await StartOwnedChildAsync(db, initial.Root, "in-flight");
        Assert.True(await ObserveRealLockWaitAsync(db, blocker.ProcessID, child.Process.WaitForExitAsync()),
            "The live owned process must block after publishing its primary-key reservation.");
        Assert.Equal(1, await ReadSequenceValueAsync(db));
        Assert.False(child.Process.HasExited);
        Assert.Equal(0, await db.Queryable<AdminAuditLog>().CountAsync());
        await child.KillAsync();
        await transaction.RollbackAsync();
        using var restarted = Owner(db, initial.Root, deleteRoot: false);
        await restarted.Channel.EnqueueAsync(AdminAuditIssue2040Owner.Record("next-event"));
        await restarted.Channel.ReplayAsync(CancellationToken.None);
        AdminAuditLog[] rows = (await db.Queryable<AdminAuditLog>().OrderBy(row => row.Id).ToListAsync()).ToArray();
        Assert.Equal(2, rows.Length);
        Assert.Equal(1, rows[0].Id);
        Assert.Equal(2, rows[1].Id);
        AdminAuditIssue2040Owner.AssertFullPayload(AdminAuditIssue2040Owner.Record("accepted-before-kill"), rows[0]);
        AdminAuditIssue2040Owner.AssertFullPayload(AdminAuditIssue2040Owner.Record("next-event"), rows[1]);
        Assert.Equal(2, await ReadSequenceValueAsync(db));
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    [Trait("Category", "Process")]
    public async Task RealReturnedAdmissionThenKillWithoutDrain_RestartRecoversExactEventIntoPostgres()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var initial = Owner(db);
        string invocation = Guid.NewGuid().ToString("N");
        string assembly = typeof(AdminAuditDurableReplayIssue2040IntegrationTests).Assembly.Location;
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add(AdminAuditAdmissionProcessIssue2040Worker.Command);
        start.ArgumentList.Add(initial.Root);
        start.ArgumentList.Add(invocation);
        start.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        start.Environment["FSUSBLOG_ADMIN_AUDIT_PROCESS_DATABASE"] = db.CurrentConnectionConfig.ConnectionString;
        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        Task<string> errors = process.StandardError.ReadToEndAsync();
        try
        {
            string? marker = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"admin-audit-admitted {invocation} {process.Id} {digest}", marker);
            Assert.False(process.HasExited);
            Assert.Equal(0, await db.Queryable<AdminAuditLog>().CountAsync());
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Equal(string.Empty, await errors);
            using var restarted = Owner(db, initial.Root, deleteRoot: false);
            await restarted.Worker.StartAsync(CancellationToken.None);
            try
            {
                var watch = Stopwatch.StartNew();
                while (watch.Elapsed < TimeSpan.FromSeconds(5)
                    && (await db.Queryable<AdminAuditLog>().CountAsync() == 0
                        || restarted.Channel.Snapshot().OutstandingCount != 0))
                {
                    await Task.Delay(25);
                }
                AdminAuditLog row = Assert.Single(await db.Queryable<AdminAuditLog>().ToListAsync());
                AdminAuditIssue2040Owner.AssertFullPayload(AdminAuditIssue2040Owner.Record("accepted-before-kill"), row);
                Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
            }
            finally
            {
                await restarted.Worker.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminAuditLog));
        return db;
    }

    private static AdminAuditIssue2040Owner Owner(SqlSugarClient db, string? root = null, bool deleteRoot = true)
        => new(root, () => PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString), deleteRoot);

    private static async Task<long> ReadSequenceValueAsync(SqlSugarClient db)
    {
        object value = await db.Ado.GetScalarAsync("SELECT last_value FROM admin_audit_log_id_seq;");
        return Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    private async Task<bool> ObserveRealLockWaitAsync(SqlSugarClient db, int blockerPid, Task writer)
    {
        // Never query pg_stat_activity inside the blocker transaction: PostgreSQL
        // may reuse its statistics snapshot. This is an independent read-only observer.
        await using var observer = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await observer.OpenAsync(deadline.Token);
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed < TimeSpan.FromSeconds(5))
        {
            if (writer.IsCompleted)
            {
                output.WriteLine($"writer-terminal-before-lock-observation:{writer.Status}");
                return false;
            }
            await using (var command = new NpgsqlCommand("""
                SELECT pid, datname, state, wait_event_type, wait_event, query
                FROM pg_stat_activity
                WHERE datname = current_database()
                    AND pid <> @BlockerPid
                    AND wait_event_type = 'Lock'
                    AND wait_event = 'advisory'
                    AND pg_blocking_pids(pid) @> ARRAY[@BlockerPid]
                    AND query LIKE '%pg_advisory_xact_lock%';
                """, observer))
            {
                command.Parameters.AddWithValue("BlockerPid", blockerPid);
                await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(deadline.Token);
                if (await reader.ReadAsync(deadline.Token))
                {
                    output.WriteLine($"writer-live:{!writer.IsCompleted}; blockerPid:{blockerPid}; "
                        + $"writerBackendPid:{reader.GetInt32(0)}; database:{reader.GetString(1)}; "
                        + $"state:{reader.GetString(2)}; waitType:{reader.GetString(3)}; "
                        + $"waitEvent:{reader.GetString(4)}; query:{reader.GetString(5)}");
                    return !writer.IsCompleted;
                }
            }
            await Task.Delay(25, deadline.Token);
        }
        return false;
    }

    private static async Task<OwnedAdminProcess> StartOwnedChildAsync(SqlSugarClient db, string root, string mode)
    {
        string invocation = Guid.NewGuid().ToString("N");
        string assembly = typeof(AdminAuditDurableReplayIssue2040IntegrationTests).Assembly.Location;
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add(AdminAuditAdmissionProcessIssue2040Worker.Command);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add(invocation);
        start.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        start.ArgumentList.Add(mode);
        start.Environment["FSUSBLOG_ADMIN_AUDIT_PROCESS_DATABASE"] = db.CurrentConnectionConfig.ConnectionString;
        var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        var child = new OwnedAdminProcess(process, invocation, digest);
        try
        {
            string? marker = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"admin-audit-admitted {invocation} {process.Id} {digest}", marker);
            Assert.False(process.HasExited);
            return child;
        }
        catch
        {
            await child.DisposeAsync();
            throw;
        }
    }

    private sealed class OwnedAdminProcess(Process process, string invocation, string assemblyDigest) : IAsyncDisposable
    {
        private readonly Task<string> _errors = process.StandardError.ReadToEndAsync();
        internal Process Process => process;

        internal async Task AssertCommitMarkerAsync()
        {
            string? marker = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"admin-audit-committed {invocation} {process.Id} {assemblyDigest}", marker);
            Assert.False(process.HasExited);
        }

        internal async Task KillAsync()
        {
            Assert.False(process.HasExited);
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Equal(string.Empty, await _errors);
        }

        public async ValueTask DisposeAsync()
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            process.Dispose();
        }
    }
}

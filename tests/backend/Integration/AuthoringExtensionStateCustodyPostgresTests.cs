using System.Diagnostics;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionStateCustodyPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly VerifiedAuthoringPackage s_old = AuthoringStateProcessWorker.Package("1.0.0", 1);
    private static readonly VerifiedAuthoringPackage s_new = AuthoringStateProcessWorker.Package("2.0.0", 2);
    private static readonly AuthoringStateScope s_from = AuthoringStateProcessWorker.Scope(s_old);
    private static readonly AuthoringStateScope s_to = AuthoringStateProcessWorker.Scope(s_new);

    [Fact]
    public async Task InitialObservationHoldsActualBothScopesOnOwnedConnectionThroughDelayedTerminalCas()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        AuthoringStateSnapshot initial = await store.ReadAsync(s_old, s_from, default);
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, plan, default);
        Assert.Equal(initial.ContentSha256, held.State.From.Snapshot.ContentSha256);
        Assert.Empty(held.State.To!.Snapshot.Entries);
        Assert.Null(held.State.Phase);
        Assert.Equal(new[] { ScopeId(s_from), ScopeId(s_to) }.Order(StringComparer.Ordinal), held.AcquiredScopeIds);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Task writer = new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_new, s_to, 0, new("late", [5]), default).AsTask();
        await WaitForBlockedAsync(db);
        // Simulates the approval owner's delayed terminal CAS while custody remains live.
        await held.VerifyCurrentAsync(default);
        await held.VerifyCurrentAsync(default);
        Assert.False(writer.IsCompleted);
        // The original client is not the held client and can run unrelated SQL.
        Assert.Equal(1, Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT 1;")));
        await held.DisposeAsync();
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => held.VerifyCurrentAsync(default).AsTask());
    }

    [Fact]
    public async Task ReversedScopeOrderAcquiresIdenticalOrderedKeysAndCancelsWithoutLeakingFirstKey()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        // Both empty scopes admit valid opposite-direction initial plans.
        await store.WriteAsync(s_old, s_from, 1, new("old", []), default);
        AuthoringStateScope otherFrom = s_from with
        {
            DocumentId = "empty"
        };
        AuthoringStateScope otherTo = s_to with
        {
            DocumentId = "empty"
        };
        await store.InitializeAsync(s_old, otherFrom, default);
        await store.InitializeAsync(s_new, otherTo, default);
        AuthoringFencedStateMigration forward = AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_old, otherFrom, default), otherTo, []);
        AuthoringFencedStateMigration reverse = AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_new, otherTo, default), otherFrom, []) with
        {
            PlanId = "reverse"
        };
        reverse = reverse with
        {
            ContentSha256 = ComputeContentSha256(reverse)
        };
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, forward, default);
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
        Exception? error = await Record.ExceptionAsync(() => store.ObserveInitialAsync(s_new, s_old, reverse, cancelled.Token).AsTask());
        Assert.NotNull(error);
        await held.VerifyCurrentAsync(default);
        await held.DisposeAsync();
        await using IAuthoringExtensionStateObservation reversed = await store.ObserveInitialAsync(s_new, s_old, reverse, default);
        Assert.Equal(held.AcquiredScopeIds.ToArray(), reversed.AcquiredScopeIds.ToArray());
        Assert.Equal(otherTo, reversed.State.From.Snapshot.Scope);
        Assert.Equal(otherFrom, reversed.State.To!.Snapshot.Scope);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FencedAndSettledObservationsPreserveActualApplyAndBackupRevisions(bool rollback)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        AuthoringStateSnapshot original = await store.ReadAsync(s_old, s_from, default);
        await store.BackupAsync(s_old, s_new, plan, default);
        await using (IAuthoringExtensionStateObservation backed = await store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.BackedUp, default))
        {
            Assert.Equal(plan.ContentSha256, backed.State.From.Fence);
            Assert.Equal(plan.ContentSha256, backed.State.To!.Fence);
            Assert.Equal(2, backed.State.From.Measurement.Records);
            await backed.VerifyCurrentAsync(default);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Completed, default).AsTask());
        }
        AuthoringStateSnapshot applied = await store.ApplyAsync(s_old, s_new, plan, default);
        await using (IAuthoringExtensionStateObservation fenced = await store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Applied, default))
        {
            Assert.Equal(applied.ContentSha256, fenced.State.To!.Snapshot.ContentSha256);
            Assert.Equal(AuthoringStateMigrationPhase.Applied, fenced.State.Phase);
        }
        await using IAuthoringExtensionStateObservation terminal = rollback
            ? await store.RollbackAndObserveAsync(s_old, s_new, plan, default)
            : await store.CompleteAndObserveAsync(s_old, s_new, plan, default);
        Assert.Equal(rollback ? AuthoringStateMigrationPhase.RolledBack : AuthoringStateMigrationPhase.Completed, terminal.State.Phase);
        Assert.Null(terminal.State.From.Fence);
        Assert.Null(terminal.State.To!.Fence);
        Assert.Equal(original.Revision + 2, terminal.State.From.Snapshot.Revision);
        Assert.Equal(applied.Revision + 1, terminal.State.To.Snapshot.Revision);
        Assert.Equal(2, terminal.State.From.Measurement.Records);
        Assert.Equal(4, terminal.State.From.Measurement.Bytes);
        Assert.Equal(rollback ? "old" : "new", Assert.Single(rollback ? terminal.State.From.Snapshot.Entries : terminal.State.To.Snapshot.Entries).Key);
        if (rollback)
        {
            Assert.Empty(terminal.State.To.Snapshot.Entries);
        }
        await terminal.VerifyCurrentAsync(default);
        await terminal.DisposeAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.CompleteAndObserveAsync(s_old, s_new, plan, default).AsTask());
        // Preserve original settled retry behavior without creating historical observation output.
        if (rollback)
        {
            await store.RollbackAsync(s_old, s_new, plan, default);
        }
        else
        {
            await store.CompleteAsync(s_old, s_new, plan, default);
        }
    }

    [Fact]
    public async Task DeletionObservationIncludesRetainedBackupsAndPostDeleteActualTombstone()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        await store.ApplyAsync(s_old, s_new, plan, default);
        await store.CompleteAsync(s_old, s_new, plan, default);
        AuthoringStateMeasurement expected = await store.MeasureAsync(s_old, s_from, default);
        await using (IAuthoringExtensionStateObservation before = await store.ObserveDeletionAsync(s_old, expected, default))
        {
            Assert.Equal(expected, before.State.From.Measurement);
            Assert.Equal(2, expected.Records);
            Assert.Equal(4, expected.Bytes);
            await before.VerifyCurrentAsync(default);
        }
        await using IAuthoringExtensionStateObservation after = await store.DeleteAndObserveAsync(s_old, new(expected, "separate-approved-deletion"), default);
        Assert.Empty(after.State.From.Snapshot.Entries);
        Assert.Equal(expected.Revision + 1, after.State.From.Snapshot.Revision);
        Assert.Equal(0, after.State.From.Measurement.Records);
        Assert.Equal(0, after.State.From.Measurement.Bytes);
        Assert.Null(after.State.To);
        await after.VerifyCurrentAsync(default);
        await after.DisposeAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.DeleteAndObserveAsync(s_old, new(expected, "stale"), default).AsTask());
        Assert.Single((await store.ReadAsync(s_new, s_to, default)).Entries);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SameSizeCurrentOrBackupByteDriftIsRejectedAndReleasesCustody(bool backup)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        await store.RollbackAsync(s_old, s_new, plan, default);
        AuthoringStateMeasurement expected = await store.MeasureAsync(s_old, s_from, default);
        await using IAuthoringExtensionStateObservation held = await store.ObserveDeletionAsync(s_old, expected, default);
        await ChangeBytesAsync(db, backup);
        AuthoringExtensionContractException error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => held.VerifyCurrentAsync(default).AsTask());
        Assert.Equal("state_observation_drift_requires_recovery", error.Message);
        AuthoringStateMeasurement changed = await store.MeasureAsync(s_old, s_from, default);
        Assert.Equal(expected.Bytes, changed.Bytes);
        Assert.Equal(expected.Records, changed.Records);
        Assert.Equal(expected.Revision, changed.Revision);
        Assert.NotEqual(expected.ContentSha256, changed.ContentSha256);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveDeletionAsync(s_old, expected, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.DeleteAsync(s_old, new(expected, "stale"), default).AsTask());
    }

    [Theory]
    [InlineData("cancel-lifetime")]
    [InlineData("cancel-verify")]
    [InlineData("statement-failure")]
    [InlineData("connection-loss")]
    public async Task CustodyFailureReleasesLocksAndCannotBeReused(string failure)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        if (failure == "statement-failure")
        {
            await db.Ado.ExecuteCommandAsync("""
                CREATE TABLE observation_fault(enabled boolean NOT NULL);
                INSERT INTO observation_fault VALUES (false);
                CREATE FUNCTION observation_sql_guard() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
                BEGIN
                    IF (SELECT enabled FROM observation_fault) THEN
                        RAISE EXCEPTION 'synthetic observation SQL failure';
                    END IF;
                    RETURN true;
                END; $$;
                ALTER TABLE authoring_extension_state_scope RENAME TO original_state_scope;
                CREATE VIEW authoring_extension_state_scope AS SELECT * FROM original_state_scope WHERE observation_sql_guard();
                """);
        }
        using var lifetime = new CancellationTokenSource();
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, plan, lifetime.Token);
        if (failure == "cancel-lifetime")
        {
            lifetime.Cancel();
        }
        else if (failure == "statement-failure")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE observation_fault SET enabled = true;");
        }
        else if (failure == "connection-loss")
        {
            await db.Ado.GetScalarAsync("""
                SELECT pg_terminate_backend(pid) FROM pg_locks
                WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND pid <> pg_backend_pid();
                """);
        }
        using var verify = new CancellationTokenSource();
        if (failure == "cancel-verify")
        {
            verify.Cancel();
        }
        Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(verify.Token).AsTask()));
        if (failure == "statement-failure")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE observation_fault SET enabled = false;");
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await store.WriteAsync(s_old, s_from, 1, new("after-release", [8]), deadline.Token);
        Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(default).AsTask()));
        await held.DisposeAsync();
        await held.DisposeAsync();
    }

    [Fact]
    public async Task CancellationDuringPartialAcquisitionReleasesAlreadyAcquiredKey()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        string[] ids = new[] { ScopeId(s_from), ScopeId(s_to) }.Order(StringComparer.Ordinal).ToArray();
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction tx = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@id, 2143));", blocker, tx))
        {
            command.Parameters.AddWithValue("id", $"authoring-extension-state:{ids[1]}");
            await command.ExecuteScalarAsync();
        }
        using var cancel = new CancellationTokenSource();
        Task acquisition = store.ObserveInitialAsync(s_old, s_new, plan, cancel.Token).AsTask();
        await WaitForBlockedAsync(db);
        cancel.Cancel();
        Assert.NotNull(await Record.ExceptionAsync(() => acquisition));
        await using var probe = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await probe.OpenAsync();
        await using var probeTx = await probe.BeginTransactionAsync();
        await using var attempt = new NpgsqlCommand("SELECT pg_try_advisory_xact_lock(hashtextextended(@id, 2143));", probe, probeTx);
        attempt.Parameters.AddWithValue("id", $"authoring-extension-state:{ids[0]}");
        Assert.Equal(true, await attempt.ExecuteScalarAsync());
    }

    [Fact]
    public async Task WriterWinsCommitToObservationGapRefusesWithoutRepeatingCompletion()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        await store.ApplyAsync(s_old, s_new, plan, default);
        using var phaseUpdated = new ManualResetEventSlim();
        using var continueCommit = new ManualResetEventSlim();
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("UPDATE authoring_extension_state_migration SET phase", StringComparison.Ordinal))
            {
                phaseUpdated.Set();
                Assert.True(continueCommit.Wait(TimeSpan.FromSeconds(10)));
            }
        };
        Task<IAuthoringExtensionStateObservation> completing = Task.Run(async () => await store.CompleteAndObserveAsync(s_old, s_new, plan, default));
        try
        {
            Assert.True(phaseUpdated.Wait(TimeSpan.FromSeconds(10)));
            await using var rival = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
            await rival.OpenAsync();
            await using NpgsqlTransaction tx = await rival.BeginTransactionAsync();
            await using var lockCommand = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@id, 2143));", rival, tx);
            lockCommand.Parameters.AddWithValue("id", $"authoring-extension-state:{ScopeId(s_from)}");
            Task<object?> queued = lockCommand.ExecuteScalarAsync();
            using SqlSugarClient probe = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            await WaitForBlockedAsync(probe);
            continueCommit.Set();
            await queued.WaitAsync(TimeSpan.FromSeconds(5));
            // The queued independent writer owns the key before the observer can acquire it.
            await using var read = new NpgsqlCommand("SELECT payload FROM authoring_extension_state_scope WHERE scope_id = @id;", rival, tx);
            read.Parameters.AddWithValue("id", ScopeId(s_from));
            AuthoringStateSnapshot current = DecodeSnapshot((byte[])(await read.ExecuteScalarAsync())!);
            AuthoringStateSnapshot changed = Snapshot(s_from, s_old.PackageIdentity, current.Revision + 1, [new("old", [8, 9])]);
            await using var write = new NpgsqlCommand("UPDATE authoring_extension_state_scope SET revision = @revision, payload = @payload WHERE scope_id = @id;", rival, tx);
            write.Parameters.AddWithValue("id", ScopeId(s_from));
            write.Parameters.AddWithValue("revision", changed.Revision);
            write.Parameters.AddWithValue("payload", Encode(changed));
            await write.ExecuteNonQueryAsync();
            await tx.CommitAsync();
            AuthoringExtensionContractException error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => completing);
            Assert.Equal("state_observation_drift_requires_recovery", error.Message);
        }
        finally
        {
            continueCommit.Set();
            db.Aop.OnLogExecuted = null;
        }
        Assert.Equal(3, Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT phase FROM authoring_extension_state_migration;")));
        AuthoringStateSnapshot after = await store.ReadAsync(s_old, s_from, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.CompleteAndObserveAsync(s_old, s_new, plan, default).AsTask());
        await store.CompleteAsync(s_old, s_new, plan, default);
        Assert.Equal(after.ContentSha256, (await store.ReadAsync(s_old, s_from, default)).ContentSha256);
    }

    [Fact]
    public async Task SettledCustodySurvivesActualTerminalRowCasDelayAndBlocksStateWriter()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        await store.ApplyAsync(s_old, s_new, plan, default);
        await db.Ado.ExecuteCommandAsync("CREATE TABLE synthetic_terminal_cas(id int PRIMARY KEY, status int); INSERT INTO synthetic_terminal_cas VALUES (1, 0);");
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction blockedRow = await blocker.BeginTransactionAsync();
        await using (var row = new NpgsqlCommand("SELECT id FROM synthetic_terminal_cas WHERE id = 1 FOR UPDATE;", blocker, blockedRow))
        {
            await row.ExecuteScalarAsync();
        }
        await using IAuthoringExtensionStateObservation terminal = await store.CompleteAndObserveAsync(s_old, s_new, plan, default);
        await using var cas = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await cas.OpenAsync();
        await using var update = new NpgsqlCommand("UPDATE synthetic_terminal_cas SET status = 1 WHERE id = 1 AND status = 0;", cas);
        Task<int> finalCas = update.ExecuteNonQueryAsync();
        var timer = Stopwatch.StartNew();
        while (Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT COUNT(*) FROM pg_stat_activity WHERE pid = @pid AND wait_event_type = 'Lock';", new SugarParameter("@pid", cas.ProcessID))) == 0)
        {
            Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5));
            await Task.Delay(20);
        }
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Task writer = new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_old, s_from, terminal.State.From.Snapshot.Revision, new("late", [7]), default).AsTask();
        try
        {
            await WaitForBlockedAsync(db);
            await terminal.VerifyCurrentAsync(default);
            Assert.False(finalCas.IsCompleted);
            Assert.False(writer.IsCompleted);
            await blockedRow.CommitAsync();
            Assert.Equal(1, await finalCas.WaitAsync(TimeSpan.FromSeconds(5)));
            await terminal.VerifyCurrentAsync(default);
            Assert.False(writer.IsCompleted);
        }
        finally
        {
            await terminal.DisposeAsync();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task IdleLifetimeCancellationReleasesCustodyWithoutVerifyOrDispose()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        using var lifetime = new CancellationTokenSource();
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, plan, lifetime.Token);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Task writer = new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_old, s_from, 1, new("late", [7]), default).AsTask();
        try
        {
            await WaitForBlockedAsync(db);
            lifetime.Cancel();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(default).AsTask()));
        }
        finally
        {
            await held.DisposeAsync();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task InitialAndFencedRefusalsPreserveOriginalFencesAndPackageOwnership()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveInitialAsync(s_new, s_old, plan, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Applied, default).AsTask());
        await store.BackupAsync(s_old, s_new, plan, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveInitialAsync(s_old, s_new, plan, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Applied, default).AsTask());
        await store.RollbackAsync(s_old, s_new, plan, default);
        await store.WriteAsync(s_old, s_from, 3, new("old", [3, 4]), default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveInitialAsync(s_old, s_new, plan, default).AsTask());
        Assert.Equal(new byte[] { 3, 4 }, Assert.Single((await store.ReadAsync(s_old, s_from, default)).Entries).Value.ToArray());
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        return db;
    }

    private static async Task<AuthoringFencedStateMigration> SeedAsync(PostgresAuthoringExtensionStateStore store)
    {
        await store.InitializeAsync(s_old, s_from, default);
        await store.InitializeAsync(s_new, s_to, default);
        await store.WriteAsync(s_old, s_from, 0, new("old", [1, 2]), default);
        return AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_old, s_from, default), s_to);
    }

    private static async Task WaitForBlockedAsync(SqlSugarClient db)
    {
        var timer = Stopwatch.StartNew();
        while (timer.Elapsed < TimeSpan.FromSeconds(5))
        {
            object value = await db.Ado.GetScalarAsync("""
                SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                    AND database = (SELECT oid FROM pg_database WHERE datname = current_database());
                """);
            if (Convert.ToInt32(value) > 0)
            {
                return;
            }
            await Task.Delay(20);
        }
        Assert.Fail("Expected an independent PostgreSQL connection waiting for an advisory key.");
    }

    private static async Task ChangeBytesAsync(SqlSugarClient db, bool backup)
    {
        string table = backup ? "authoring_extension_state_backup" : "authoring_extension_state_scope";
        // Bypass the cooperative lock protocol to prove byte-level verification, preserving revision/size.
        byte[] payload = (byte[])await db.Ado.GetScalarAsync($"SELECT payload FROM {table} WHERE scope_id = @id;", new SugarParameter("@id", ScopeId(s_from)));
        AuthoringStateSnapshot original = DecodeSnapshot(payload);
        AuthoringStateSnapshot changed = Snapshot(original.Scope, original.PackageIdentity, original.Revision, [new("old", [9, 8])]);
        await db.Ado.ExecuteCommandAsync($"UPDATE {table} SET payload = @payload WHERE scope_id = @id;",
            new SugarParameter("@payload", Encode(changed)), new SugarParameter("@id", ScopeId(s_from)));
    }
}

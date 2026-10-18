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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StateAccessAfterReleaseRefusesBeforeAndAfterIndependentWriter(bool cancelLifetime)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        using var lifetime = new CancellationTokenSource();
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, plan, lifetime.Token);
        AuthoringStateObservation copied = held.State;
        Assert.Equal(1, copied.From.Snapshot.Revision);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Task writer = new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_old, s_from, 1, new("old", [8, 9]), default).AsTask();
        try
        {
            await WaitForBlockedAsync(db);
            if (cancelLifetime)
            {
                lifetime.Cancel();
            }
            else
            {
                await held.DisposeAsync();
            }
            // No failed verification or second disposal is needed to invalidate the getter.
            AssertStateUnavailable(held);
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
            AssertStateUnavailable(held);
            AuthoringStateSnapshot current = await store.ReadAsync(s_old, s_from, default);
            Assert.Equal(2, current.Revision);
            Assert.Equal(new byte[] { 8, 9 }, Assert.Single(current.Entries).Value.ToArray());
            // An earlier immutable copy survives as data, not proof of current custody.
            Assert.Equal(1, copied.From.Snapshot.Revision);
            Assert.NotEqual(copied.From.Snapshot.ContentSha256, current.ContentSha256);
            Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(default).AsTask()));
            AssertStateUnavailable(held);
        }
        finally
        {
            await held.DisposeAsync();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Theory]
    [InlineData("dispose")]
    [InlineData("cancel-lifetime")]
    [InlineData("cancel-running-verify")]
    [InlineData("statement-failure")]
    [InlineData("connection-loss")]
    [InlineData("byte-drift")]
    public async Task RacingStateReadsFailClosedWhenRunningVerificationIsInvalidated(string failure)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE observation_read_guard(enabled boolean NOT NULL, fail boolean NOT NULL);
            INSERT INTO observation_read_guard VALUES (false, false);
            CREATE FUNCTION guard_observation_read() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
            BEGIN
                IF (SELECT enabled FROM observation_read_guard) THEN
                    PERFORM pg_advisory_xact_lock(2143, 4639);
                END IF;
                IF (SELECT fail FROM observation_read_guard) THEN
                    RAISE EXCEPTION 'synthetic observation SELECT failure';
                END IF;
                RETURN true;
            END; $$;
            ALTER TABLE authoring_extension_state_scope RENAME TO original_state_scope;
            CREATE VIEW authoring_extension_state_scope AS SELECT * FROM original_state_scope WHERE guard_observation_read();
            """);
        using var lifetime = new CancellationTokenSource();
        using var verification = new CancellationTokenSource();
        await using IAuthoringExtensionStateObservation held = await store.ObserveInitialAsync(s_old, s_new, plan, lifetime.Token);
        string digest = held.State.From.Snapshot.ContentSha256;
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction blockedRead = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(2143, 4639);", blocker, blockedRead))
        {
            await command.ExecuteScalarAsync();
        }
        if (failure == "byte-drift")
        {
            byte[] payload = (byte[])await db.Ado.GetScalarAsync("SELECT payload FROM original_state_scope WHERE scope_id = @id;", new SugarParameter("@id", ScopeId(s_from)));
            AuthoringStateSnapshot before = DecodeSnapshot(payload);
            AuthoringStateSnapshot changed = Snapshot(s_from, s_old.PackageIdentity, before.Revision, [new("old", [9, 8])]);
            await db.Ado.ExecuteCommandAsync("UPDATE original_state_scope SET payload = @payload WHERE scope_id = @id;",
                new SugarParameter("@payload", Encode(changed)), new SugarParameter("@id", ScopeId(s_from)));
        }
        await db.Ado.ExecuteCommandAsync("UPDATE observation_read_guard SET enabled = true;");
        Task verifying = held.VerifyCurrentAsync(verification.Token).AsTask();
        Task? disposing = null;
        Task? cancelling = null;
        Task[] readers = [];
        var invalidationComplete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var readersStarted = new CountdownEvent(4);
        try
        {
            await WaitForBlockedAsync(db);
            // The synchronous getter must not wait on the async verification gate or SQL.
            AuthoringStateObservation duringRead = await Task.Run(() => held.State).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal(digest, duringRead.From.Snapshot.ContentSha256);
            readers = Enumerable.Range(0, 4).Select(_ => Task.Run(async () =>
            {
                readersStarted.Signal();
                while (!invalidationComplete.Task.IsCompleted)
                {
                    try
                    {
                        Assert.Equal(digest, held.State.From.Snapshot.ContentSha256);
                    }
                    catch (AuthoringExtensionContractException error)
                    {
                        Assert.Equal("state_observation_custody_lost", error.Message);
                    }
                    await Task.Yield();
                }
                // These accesses start after invalidation has completed, not just concurrently.
                for (int attempt = 0; attempt < 100; attempt++)
                {
                    AssertStateUnavailable(held);
                }
            })).ToArray();
            Assert.True(readersStarted.Wait(TimeSpan.FromSeconds(5)));
            if (failure == "dispose")
            {
                disposing = held.DisposeAsync().AsTask();
                Assert.False(disposing.IsCompleted);
                AssertStateUnavailable(held);
            }
            else if (failure == "cancel-lifetime")
            {
                cancelling = Task.Run(lifetime.Cancel);
                var timer = Stopwatch.StartNew();
                while (!lifetime.IsCancellationRequested)
                {
                    Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5));
                    await Task.Yield();
                }
                AssertStateUnavailable(held);
            }
            else if (failure == "cancel-running-verify")
            {
                verification.Cancel();
                AssertStateUnavailable(held);
            }
            else if (failure == "connection-loss")
            {
                Assert.True(Convert.ToBoolean(await db.Ado.GetScalarAsync("""
                    SELECT pg_terminate_backend(pid) FROM pg_locks
                    WHERE locktype = 'advisory' AND classid = 2143 AND objid = 4639 AND NOT granted
                        AND database = (SELECT oid FROM pg_database WHERE datname = current_database());
                    """)));
            }
            else if (failure == "statement-failure")
            {
                await db.Ado.ExecuteCommandAsync("UPDATE observation_read_guard SET fail = true;");
            }
            await blockedRead.RollbackAsync();
            Exception? error = await Record.ExceptionAsync(() => verifying.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.NotNull(error);
            Assert.IsNotType<TimeoutException>(error);
            if (disposing is not null)
            {
                await disposing.WaitAsync(TimeSpan.FromSeconds(5));
            }
            if (cancelling is not null)
            {
                await cancelling.WaitAsync(TimeSpan.FromSeconds(5));
            }
            AssertStateUnavailable(held);
            invalidationComplete.SetResult();
            await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(5));
            await db.Ado.ExecuteCommandAsync("UPDATE observation_read_guard SET enabled = false, fail = false;");
            using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_old, s_from, 1, new("after-release", [7]), deadline.Token);
            AssertStateUnavailable(held);
            Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(default).AsTask()));
        }
        finally
        {
            verification.Cancel();
            await blocker.CloseAsync();
            await held.DisposeAsync();
            invalidationComplete.TrySetResult();
            await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(5));
            await Record.ExceptionAsync(() => verifying.WaitAsync(TimeSpan.FromSeconds(5)));
        }
    }

    private static void AssertStateUnavailable(IAuthoringExtensionStateObservation held)
    {
        AuthoringExtensionContractException error = Assert.Throws<AuthoringExtensionContractException>(() => held.State);
        Assert.Equal("state_observation_custody_lost", error.Message);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task SettledRecoveryReacquiresAfterProcessExitWithoutRepeatingEffects(bool rollback, bool apply)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var original = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(original);
        await original.BackupAsync(s_old, s_new, plan, default);
        if (apply)
        {
            _ = await original.ApplyAsync(s_old, s_new, plan, default);
        }
        // This independent process commits and exits without returning a terminal observation.
        await RunSettlementProcessAsync(db.CurrentConnectionConfig.ConnectionString, rollback ? "rollback" : "complete", plan);
        AuthoringStateSnapshot actualFrom = await original.ReadAsync(s_old, s_from, default);
        AuthoringStateSnapshot actualTo = await original.ReadAsync(s_new, s_to, default);
        string before = await PersistentStateDigestAsync(db);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION refuse_recovery_effects() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'read-only recovery attempted a state effect'; END; $$;
            CREATE TRIGGER refuse_scope_effects BEFORE INSERT OR UPDATE OR DELETE ON authoring_extension_state_scope
                FOR EACH ROW EXECUTE FUNCTION refuse_recovery_effects();
            CREATE TRIGGER refuse_migration_effects BEFORE INSERT OR UPDATE OR DELETE ON authoring_extension_state_migration
                FOR EACH ROW EXECUTE FUNCTION refuse_recovery_effects();
            CREATE TRIGGER refuse_backup_effects BEFORE INSERT OR UPDATE OR DELETE ON authoring_extension_state_backup
                FOR EACH ROW EXECUTE FUNCTION refuse_recovery_effects();
            CREATE TRIGGER refuse_settlement_effects BEFORE INSERT OR UPDATE OR DELETE ON authoring_extension_state_settlement
                FOR EACH ROW EXECUTE FUNCTION refuse_recovery_effects();
            """);
        AuthoringStateMigrationPhase phase = rollback ? AuthoringStateMigrationPhase.RolledBack : AuthoringStateMigrationPhase.Completed;
        for (int restart = 0; restart < 2; restart++)
        {
            using SqlSugarClient restartedDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            var restarted = new PostgresAuthoringExtensionStateStore(restartedDb);
            await using IAuthoringExtensionStateObservation held = await restarted.ObserveSettledMigrationAsync(s_old, s_new, plan, phase, default);
            Assert.Equal(actualFrom.ContentSha256, held.State.From.Snapshot.ContentSha256);
            Assert.Equal(actualTo.ContentSha256, held.State.To!.Snapshot.ContentSha256);
            Assert.Equal(actualFrom.Revision, held.State.From.Snapshot.Revision);
            Assert.Equal(actualTo.Revision, held.State.To.Snapshot.Revision);
            Assert.Equal(phase, held.State.Phase);
            Assert.Null(held.State.From.Fence);
            Assert.Null(held.State.To.Fence);
            Assert.Equal(new[] { ScopeId(s_from), ScopeId(s_to) }.Order(StringComparer.Ordinal), held.AcquiredScopeIds);
            await held.VerifyCurrentAsync(default);
            Assert.Equal(Digest(held.State), Convert.ToString(await db.Ado.GetScalarAsync(
                "SELECT observation_sha256 FROM authoring_extension_state_settlement WHERE plan_id = @id;", new SugarParameter("@id", PlanId(plan)))));
        }
        Assert.Equal(before, await PersistentStateDigestAsync(db));
    }

    [Theory]
    [InlineData("source")]
    [InlineData("destination")]
    [InlineData("backup")]
    [InlineData("revision")]
    [InlineData("backup-purge")]
    [InlineData("binding")]
    [InlineData("fence")]
    public async Task SettledRecoveryRefusesDriftWithoutRepairingOrRepeatingEffects(string drift)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        _ = await store.ApplyAsync(s_old, s_new, plan, default);
        await store.CompleteAsync(s_old, s_new, plan, default);
        if (drift is "source" or "backup")
        {
            await ChangeBytesAsync(db, backup: drift == "backup");
        }
        else if (drift is "destination" or "revision")
        {
            AuthoringStateSnapshot current = await store.ReadAsync(s_new, s_to, default);
            if (drift == "revision")
            {
                await store.WriteAsync(s_new, s_to, current.Revision, Assert.Single(current.Entries), default);
            }
            else
            {
                AuthoringStateSnapshot changed = Snapshot(s_to, s_new.PackageIdentity, current.Revision, [new("new", [8, 9])]);
                await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_scope SET payload = @payload WHERE scope_id = @id;",
                    new SugarParameter("@payload", Encode(changed)), new SugarParameter("@id", ScopeId(s_to)));
            }
        }
        else if (drift == "backup-purge")
        {
            await db.Ado.ExecuteCommandAsync("DELETE FROM authoring_extension_state_backup WHERE scope_id = @id;", new SugarParameter("@id", ScopeId(s_from)));
        }
        else if (drift == "binding")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_settlement SET observation_sha256 = @digest;", new SugarParameter("@digest", new string('c', 64)));
        }
        else
        {
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_scope SET fence = @fence WHERE scope_id = @id;",
                new SugarParameter("@fence", plan.ContentSha256), new SugarParameter("@id", ScopeId(s_to)));
        }
        string drifted = await PersistentStateDigestAsync(db);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveSettledMigrationAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Completed, default).AsTask());
        Assert.Equal(drifted, await PersistentStateDigestAsync(db));
        // Original settled retry remains a no-op; it cannot reset the journal binding to this drift.
        await store.CompleteAsync(s_old, s_new, plan, default);
        Assert.Equal(drifted, await PersistentStateDigestAsync(db));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("journal-digest")]
    [InlineData("journal-scopes")]
    [InlineData("package")]
    [InlineData("missing-binding")]
    [InlineData("nonterminal")]
    public async Task SettledRecoveryRequiresExactOriginalPlanJournalAndRecordedObservation(string mismatch)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        _ = await store.ApplyAsync(s_old, s_new, plan, default);
        await store.CompleteAsync(s_old, s_new, plan, default);
        VerifiedAuthoringPackage owner = s_old;
        AuthoringStateMigrationPhase phase = AuthoringStateMigrationPhase.Completed;
        if (mismatch == "plan")
        {
            plan = plan with
            {
                MaximumRecords = plan.MaximumRecords - 1
            };
            plan = plan with
            {
                ContentSha256 = ComputeContentSha256(plan)
            };
        }
        else if (mismatch == "journal-digest")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_migration SET plan_sha256 = @digest;", new SugarParameter("@digest", new string('c', 64)));
        }
        else if (mismatch == "journal-scopes")
        {
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_migration SET from_scope_id = to_scope_id, to_scope_id = from_scope_id;");
        }
        else if (mismatch == "package")
        {
            owner = s_old with
            {
                PackageIdentity = new string('c', 64)
            };
        }
        else if (mismatch == "missing-binding")
        {
            await db.Ado.ExecuteCommandAsync("DELETE FROM authoring_extension_state_settlement;");
            // Simulates a pre-binding settled operation. Retrying completion must never backfill it.
            await store.CompleteAsync(s_old, s_new, plan, default);
        }
        else
        {
            phase = AuthoringStateMigrationPhase.Applied;
        }
        string before = await PersistentStateDigestAsync(db);
        AuthoringExtensionContractException error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveSettledMigrationAsync(owner, s_new, plan, phase, default).AsTask());
        if (mismatch == "missing-binding")
        {
            Assert.Equal("state_settled_observation_not_recorded", error.Message);
        }
        Assert.Equal(before, await PersistentStateDigestAsync(db));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SettledRecoveryRefusesOppositeRollbackOutcome(bool rollback)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        _ = await store.ApplyAsync(s_old, s_new, plan, default);
        if (rollback)
        {
            await store.RollbackAsync(s_old, s_new, plan, default);
        }
        else
        {
            await store.CompleteAsync(s_old, s_new, plan, default);
        }
        string before = await PersistentStateDigestAsync(db);
        AuthoringStateMigrationPhase opposite = rollback ? AuthoringStateMigrationPhase.Completed : AuthoringStateMigrationPhase.RolledBack;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveSettledMigrationAsync(s_old, s_new, plan, opposite, default).AsTask());
        Assert.Equal(before, await PersistentStateDigestAsync(db));
    }

    [Fact]
    public async Task RecordingActualSettlementFailureRollsBackOriginalEffectsAndRetainsAppliedFence()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        AuthoringStateSnapshot applied = await store.ApplyAsync(s_old, s_new, plan, default);
        string before = await PersistentStateDigestAsync(db);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION reject_settlement_record() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic settlement-record fault'; END; $$;
            CREATE TRIGGER reject_settlement_record BEFORE INSERT ON authoring_extension_state_settlement
                FOR EACH ROW EXECUTE FUNCTION reject_settlement_record();
            """);
        await Assert.ThrowsAsync<PostgresException>(() => store.CompleteAsync(s_old, s_new, plan, default).AsTask());
        Assert.Equal(before, await PersistentStateDigestAsync(db));
        await using (IAuthoringExtensionStateObservation held = await store.ObserveFencedAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Applied, default))
        {
            Assert.Equal(applied.ContentSha256, held.State.To!.Snapshot.ContentSha256);
            await held.VerifyCurrentAsync(default);
        }
        await db.Ado.ExecuteCommandAsync("DROP TRIGGER reject_settlement_record ON authoring_extension_state_settlement;");
        await store.CompleteAsync(s_old, s_new, plan, default);
        await using IAuthoringExtensionStateObservation recovered = await store.ObserveSettledMigrationAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Completed, default);
        await recovered.VerifyCurrentAsync(default);
    }

    [Fact]
    public async Task ReacquiredCustodyUsesReadOnlyTransactionAndBlocksOriginalWriterUntilInvalidation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_old, s_new, plan, default);
        _ = await store.ApplyAsync(s_old, s_new, plan, default);
        await store.CompleteAsync(s_old, s_new, plan, default);
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION require_read_only_recovery() RETURNS boolean LANGUAGE plpgsql AS $$
            BEGIN
                IF current_setting('transaction_read_only') <> 'on' THEN
                    RAISE EXCEPTION 'recovery observation must use a read-only transaction';
                END IF;
                RETURN true;
            END; $$;
            ALTER TABLE authoring_extension_state_settlement RENAME TO original_state_settlement;
            CREATE VIEW authoring_extension_state_settlement AS SELECT * FROM original_state_settlement WHERE require_read_only_recovery();
            """);
        await Assert.ThrowsAsync<PostgresException>(() => db.Ado.GetScalarAsync("SELECT observation_sha256 FROM authoring_extension_state_settlement;"));
        using var lifetime = new CancellationTokenSource();
        await using IAuthoringExtensionStateObservation held = await store.ObserveSettledMigrationAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Completed, lifetime.Token);
        await held.VerifyCurrentAsync(default);
        using SqlSugarClient writerDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Task writer = new PostgresAuthoringExtensionStateStore(writerDb).WriteAsync(s_old, s_from, held.State.From.Snapshot.Revision, new("after-recovery", [7]), default).AsTask();
        try
        {
            await WaitForBlockedAsync(db);
            await held.VerifyCurrentAsync(default);
            Assert.False(writer.IsCompleted);
            lifetime.Cancel();
            AssertStateUnavailable(held);
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(await Record.ExceptionAsync(() => held.VerifyCurrentAsync(default).AsTask()));
        }
        finally
        {
            await held.DisposeAsync();
            await writer.WaitAsync(TimeSpan.FromSeconds(5));
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ObserveSettledMigrationAsync(s_old, s_new, plan, AuthoringStateMigrationPhase.Completed, default).AsTask());
    }

    private static async Task RunSettlementProcessAsync(string connection, string operation, AuthoringFencedStateMigration plan)
    {
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        info.ArgumentList.Add(typeof(AuthoringExtensionStateCustodyPostgresTests).Assembly.Location);
        info.ArgumentList.Add(AuthoringStateProcessWorker.Command);
        using Process process = Process.Start(info) ?? throw new InvalidOperationException("state_recovery_worker_start_failed");
        await process.StandardInput.WriteAsync(System.Text.Json.JsonSerializer.Serialize(
            new AuthoringStateProcessWorker.Request(connection, operation, plan), AuthoringStateProcessWorker.s_jsonOptions));
        process.StandardInput.Close();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await process.WaitForExitAsync(deadline.Token);
            Assert.Equal(0, process.ExitCode);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    private static async Task<string> PersistentStateDigestAsync(SqlSugarClient db) =>
        Convert.ToString(await db.Ado.GetScalarAsync("""
            SELECT md5(string_agg(record, E'\n' ORDER BY record COLLATE "C")) FROM (
                SELECT 'scope:' || scope_id || ':' || revision || ':' || COALESCE(fence, '') || ':' || encode(payload, 'hex') AS record
                    FROM authoring_extension_state_scope
                UNION ALL
                SELECT 'migration:' || plan_id || ':' || plan_sha256 || ':' || from_scope_id || ':' || to_scope_id || ':' || phase
                    FROM authoring_extension_state_migration
                UNION ALL
                SELECT 'backup:' || plan_id || ':' || scope_id || ':' || encode(payload, 'hex') FROM authoring_extension_state_backup
                UNION ALL
                SELECT 'settlement:' || plan_id || ':' || observation_sha256 FROM authoring_extension_state_settlement
            ) records;
            """))!;

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

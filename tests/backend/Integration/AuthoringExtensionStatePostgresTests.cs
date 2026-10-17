using System.Collections.Immutable;
using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionStatePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly VerifiedAuthoringPackage s_oldPackage = AuthoringStateProcessWorker.Package("1.0.0", 1);
    private static readonly VerifiedAuthoringPackage s_newPackage = AuthoringStateProcessWorker.Package("2.0.0", 2);
    private static readonly AuthoringStateScope s_from = AuthoringStateProcessWorker.Scope(s_oldPackage);
    private static readonly AuthoringStateScope s_to = AuthoringStateProcessWorker.Scope(s_newPackage);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DefaultValueDeletion_LeavesNoJournalCopyAndSettledRestartCannotResurrectIt(bool rollback)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_oldPackage, s_from, default), s_to,
            [new(AuthoringStateTransformKind.SetDefault, "unique-default-to-purge", null, [91, 92, 93])]);
        await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
        await store.ApplyAsync(s_oldPackage, s_newPackage, plan, default);
        if (rollback)
        {
            await store.RollbackAsync(s_oldPackage, s_newPackage, plan, default);
        }
        else
        {
            await store.CompleteAsync(s_oldPackage, s_newPackage, plan, default);
        }
        AuthoringStateMeasurement measurement = await store.MeasureAsync(s_newPackage, s_to, default);
        await store.DeleteAsync(s_newPackage, new(measurement, "explicit-default-and-backup-purge"), default);
        Assert.Empty((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        Assert.Equal(0L, Convert.ToInt64(await db.Ado.GetScalarAsync(
            "SELECT COUNT(*) FROM authoring_extension_state_backup WHERE scope_id = @Id;",
            new SugarParameter("@Id", AuthoringExtensionStateContract.ScopeId(s_to)))));
        Assert.Equal(0L, Convert.ToInt64(await db.Ado.GetScalarAsync("""
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'authoring_extension_state_migration'
                AND column_name NOT IN ('plan_id', 'plan_sha256', 'from_scope_id', 'to_scope_id', 'phase');
            """)));
        Assert.Equal(0, await RunWorkerAsync(db.CurrentConnectionConfig.ConnectionString, rollback ? "rollback" : "complete", plan));
        Assert.Empty((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        Assert.Equal(0, (await store.MeasureAsync(s_newPackage, s_to, default)).Bytes);
    }

    [Fact]
    public async Task RetainedBackups_StopAtBoundAndRequireExactApprovedPurge()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        for (int index = 0; index <= AuthoringExtensionStateContract.MaximumBackups; index++)
        {
            AuthoringStateSnapshot source = await store.ReadAsync(s_oldPackage, s_from, default);
            AuthoringStateSnapshot target = await store.ReadAsync(s_newPackage, s_to, default);
            AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(source, s_to) with
            {
                PlanId = $"retention-{index}",
                ExpectedToRevision = target.Revision
            };
            plan = plan with
            {
                ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
            };
            if (index == AuthoringExtensionStateContract.MaximumBackups)
            {
                await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.BackupAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
                Assert.Equal(source.Revision, (await store.ReadAsync(s_oldPackage, s_from, default)).Revision);
            }
            else
            {
                await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
                await store.RollbackAsync(s_oldPackage, s_newPackage, plan, default);
            }
        }
        AuthoringStateMeasurement measurement = await store.MeasureAsync(s_oldPackage, s_from, default);
        Assert.Equal(AuthoringExtensionStateContract.MaximumBackups + 1, measurement.Records);
        await store.DeleteAsync(s_oldPackage, new(measurement, "retention-purge"), default);
        Assert.Equal(0, (await store.MeasureAsync(s_oldPackage, s_from, default)).Bytes);
        Assert.Equal(AuthoringExtensionStateContract.MaximumBackups,
            Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT COUNT(*) FROM authoring_extension_state_backup;")));
    }

    [Fact]
    public async Task OrderedTransforms_CopyRenameDefaultAndDeleteWithoutChangingSource()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_oldPackage, s_from, default), s_to,
        [
            new(AuthoringStateTransformKind.RenameKey, "old", "new", []),
            new(AuthoringStateTransformKind.SetDefault, "default", null, [7, 8]),
            new(AuthoringStateTransformKind.DeleteExtensionKey, "new", null, [])
        ]);
        await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
        AuthoringStateSnapshot applied = await store.ApplyAsync(s_oldPackage, s_newPackage, plan, default);
        Assert.Equal("default", Assert.Single(applied.Entries).Key);
        Assert.Equal(applied.ContentSha256, (await store.ApplyAsync(s_oldPackage, s_newPackage, plan, default)).ContentSha256);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ReadAsync(s_newPackage, s_to, default).AsTask());
        await store.CompleteAsync(s_oldPackage, s_newPackage, plan, default);
        AuthoringStateEntry target = Assert.Single((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        Assert.Equal("default", target.Key);
        Assert.Equal(new byte[] { 7, 8 }, target.Value.ToArray());
        Assert.Equal("old", Assert.Single((await store.ReadAsync(s_oldPackage, s_from, default)).Entries).Key);
    }

    [Fact]
    public async Task CompetingPlans_OnlyOneDurableFenceCanCommit()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var first = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(first);
        AuthoringFencedStateMigration competing = plan with
        {
            PlanId = "competing-plan"
        };
        competing = competing with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(competing)
        };
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var second = new PostgresAuthoringExtensionStateStore(secondDb);
        Exception?[] results = await Task.WhenAll(
            Record.ExceptionAsync(() => first.BackupAsync(s_oldPackage, s_newPackage, plan, default).AsTask()),
            Record.ExceptionAsync(() => second.BackupAsync(s_oldPackage, s_newPackage, competing, default).AsTask()));
        Assert.Single(results, static result => result is null);
        Assert.IsType<AuthoringExtensionContractException>(Assert.Single(results, static result => result is not null));
        Assert.Equal(1L, Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT COUNT(*) FROM authoring_extension_state_migration;")));
        Assert.Equal(2L, Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT COUNT(*) FROM authoring_extension_state_backup;")));
        await first.RollbackAsync(s_oldPackage, s_newPackage, results[0] is null ? plan : competing, default);
    }

    [Fact]
    public async Task CancellationWhileWaitingForDatabaseFence_AbortsWithoutMutation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var first = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(first);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var second = new PostgresAuthoringExtensionStateStore(secondDb);
        await db.Ado.BeginTranAsync();
        try
        {
            _ = await db.Ado.GetScalarAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2143));",
                new SugarParameter("@Identity", $"authoring-extension-state:{AuthoringExtensionStateContract.ScopeId(s_from)}"));
            using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
            Exception? failure = await Record.ExceptionAsync(() => second.WriteAsync(s_oldPackage, s_from, 1, new("late", [9]), deadline.Token).AsTask());
            Assert.True(failure is OperationCanceledException or PostgresException { SqlState: "57014" }, failure?.GetType().FullName);
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
        AuthoringStateSnapshot unchanged = await first.ReadAsync(s_oldPackage, s_from, default);
        Assert.Equal(1, unchanged.Revision);
        Assert.Equal("old", Assert.Single(unchanged.Entries).Key);
    }

    [Fact]
    public async Task Migration_SurvivesKilledHostAndRestoresExactBackupInNewProcess()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        string connection = db.CurrentConnectionConfig.ConnectionString;
        using (Process child = StartWorker(connection, "backup-and-wait", plan))
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try
            {
                Assert.Equal("state-backup-durable", await child.StandardOutput.ReadLineAsync(deadline.Token));
            }
            finally
            {
                if (!child.HasExited)
                {
                    child.Kill(entireProcessTree: true);
                }
                await child.WaitForExitAsync();
            }
            Assert.NotEqual(0, child.ExitCode);
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.WriteAsync(s_oldPackage, s_from, 2, new("late", [9]), default).AsTask());
        Assert.Equal(0, await RunWorkerAsync(connection, "apply", plan));
        Assert.Equal(0, await RunWorkerAsync(connection, "apply", plan));
        Assert.Equal(0, await RunWorkerAsync(connection, "rollback", plan));
        AuthoringStateSnapshot restored = await store.ReadAsync(s_oldPackage, s_from, default);
        Assert.Equal(3, restored.Revision);
        AuthoringStateEntry entry = Assert.Single(restored.Entries);
        Assert.Equal("old", entry.Key);
        Assert.Equal(new byte[] { 1, 2 }, entry.Value.ToArray());
        Assert.Empty((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        await store.WriteAsync(s_oldPackage, s_from, restored.Revision, new("after", [3]), default);
        Assert.Equal(0, await RunWorkerAsync(connection, "rollback", plan));
        Assert.Equal(2, (await store.ReadAsync(s_oldPackage, s_from, default)).Entries.Length);
        Assert.Equal(65, await RunWorkerAsync(connection, "apply", plan));
    }

    [Fact]
    public async Task Complete_ReleasesDurableFenceAndDeletionPurgesOnlyApprovedScopeAndBackups()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        AuthoringStateScope other = s_from with
        {
            DocumentId = "other-document"
        };
        await store.InitializeAsync(s_oldPackage, other, default);
        await store.WriteAsync(s_oldPackage, other, 0, new("core-looking-key", [99]), default);
        await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
        await store.ApplyAsync(s_oldPackage, s_newPackage, plan, default);
        await store.CompleteAsync(s_oldPackage, s_newPackage, plan, default);
        await store.CompleteAsync(s_oldPackage, s_newPackage, plan, default);
        Assert.Equal("new", Assert.Single((await store.ReadAsync(s_newPackage, s_to, default)).Entries).Key);
        AuthoringStateMeasurement measure = await store.MeasureAsync(s_oldPackage, s_from, default);
        Assert.Equal(2, measure.Records); // Current value and retained source backup.
        Assert.Equal(4, measure.Bytes);
        await store.DeleteAsync(s_oldPackage, new(measure, "separate-host-approval"), default);
        Assert.Empty((await store.ReadAsync(s_oldPackage, s_from, default)).Entries);
        Assert.Equal(0, (await store.MeasureAsync(s_oldPackage, s_from, default)).Records);
        Assert.Single((await store.ReadAsync(s_oldPackage, other, default)).Entries);
        Assert.Single((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.DeleteAsync(s_oldPackage, new(measure, "stale"), default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.RollbackAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
    }

    [Fact]
    public async Task IndependentConnections_OnlyOneSameRevisionWriterCommitsAndSameSizeDeletionIsStale()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var first = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(first);
        AuthoringStateMeasurement approval = await first.MeasureAsync(s_oldPackage, s_from, default);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        var second = new PostgresAuthoringExtensionStateStore(secondDb);
        Exception?[] outcomes = await Task.WhenAll(
            Record.ExceptionAsync(() => first.WriteAsync(s_oldPackage, s_from, 1, new("old", [3, 4]), default).AsTask()),
            Record.ExceptionAsync(() => second.WriteAsync(s_oldPackage, s_from, 1, new("old", [5, 6]), default).AsTask()));
        Assert.Single(outcomes, static error => error is null);
        Assert.IsType<AuthoringExtensionContractException>(Assert.Single(outcomes, static error => error is not null));
        AuthoringStateMeasurement changed = await first.MeasureAsync(s_oldPackage, s_from, default);
        Assert.Equal(approval.Records, changed.Records);
        Assert.Equal(approval.Bytes, changed.Bytes);
        Assert.NotEqual(approval.ContentSha256, changed.ContentSha256);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => second.DeleteAsync(s_oldPackage, new(approval, "stale-same-size"), default).AsTask());
        Assert.Single((await first.ReadAsync(s_oldPackage, s_from, default)).Entries);
    }

    [Theory]
    [InlineData(AuthoringStateTransformKind.RenameKey, "missing", "new")]
    [InlineData(AuthoringStateTransformKind.RenameKey, "old", "existing")]
    [InlineData(AuthoringStateTransformKind.DeleteExtensionKey, "missing", null)]
    [InlineData(AuthoringStateTransformKind.SetDefault, "old", null)]
    public async Task InvalidTransform_RejectsEntireBackupWithoutPersistentFence(AuthoringStateTransformKind kind, string source, string? destination)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        await store.WriteAsync(s_oldPackage, s_from, 1, new("existing", [3]), default);
        AuthoringStateSnapshot snapshot = await store.ReadAsync(s_oldPackage, s_from, default);
        AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(snapshot, s_to,
            [new(kind, source, destination, kind == AuthoringStateTransformKind.SetDefault ? [9] : [])]);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.BackupAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
        Assert.Equal(snapshot.ContentSha256, (await store.ReadAsync(s_oldPackage, s_from, default)).ContentSha256);
        Assert.Empty((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        Assert.Equal(0L, Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT COUNT(*) FROM authoring_extension_state_migration;")));
    }

    [Fact]
    public async Task UnknownCrossScopePackageMismatchAndUnfencedCalls_FailClosed()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        _ = await SeedAsync(store);
        AuthoringStateScope[] unknown =
        [
            s_from with { ExtensionId = "other.plugin" }, s_from with { ExtensionVersion = "9.0.0" },
            s_from with { SchemaVersion = 99 },
            s_from with { SiteId = "other" }, s_from with { UserId = "other" },
            s_from with { DocumentId = null }, s_from with { DocumentId = "other" }
        ];
        foreach (AuthoringStateScope scope in unknown)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ReadAsync(s_oldPackage, scope, default).AsTask());
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ReadAsync(s_newPackage, s_from, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.ReadAsync(s_oldPackage with { PackageIdentity = new string('c', 64) }, s_from, default).AsTask());
        IAuthoringExtensionStateStore legacy = store;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => legacy.DeleteAsync(s_from, default).AsTask());
        var legacyPlan = new AuthoringStateMigrationPlan("legacy", s_from, s_to, 100, 1024, TimeSpan.FromSeconds(5), [], "backup", "rollback", new string('d', 64));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => legacy.BackupAsync(legacyPlan, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => legacy.ApplyAsync(legacyPlan, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => legacy.RollbackAsync(legacyPlan, default).AsTask());
        Assert.Equal((1L, 2L), await legacy.MeasureAsync(s_from, default));
    }

    [Fact]
    public async Task TamperedBackupAndPlan_AreRejectedByRestartedProcess()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
        string connection = db.CurrentConnectionConfig.ConnectionString;
        Assert.Equal(65, await RunWorkerAsync(connection, "apply", plan with
        {
            MaximumRecords = 99
        }));
        _ = await db.Ado.ExecuteCommandAsync(
            "UPDATE authoring_extension_state_backup SET payload = payload || decode('20', 'hex') WHERE scope_id = @Id;",
            new SugarParameter("@Id", AuthoringExtensionStateContract.ScopeId(s_from)));
        Assert.Equal(65, await RunWorkerAsync(connection, "apply", plan));
        Assert.Equal(65, await RunWorkerAsync(connection, "rollback", plan));
        Assert.Equal(0, Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT phase FROM authoring_extension_state_migration;")));
        Assert.Equal(2L, Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT revision FROM authoring_extension_state_scope WHERE scope_id = @Id;", new SugarParameter("@Id", AuthoringExtensionStateContract.ScopeId(s_from)))));
    }

    [Fact]
    public async Task DatabaseFaultAfterPartialApply_RollsBackAndRetainsRecoveryFence()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        await store.BackupAsync(s_oldPackage, s_newPackage, plan, default);
        _ = await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION reject_state_phase() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic state phase fault'; END; $$;
            CREATE TRIGGER reject_state_phase BEFORE UPDATE ON authoring_extension_state_migration
                FOR EACH ROW EXECUTE FUNCTION reject_state_phase();
            """);
        await Assert.ThrowsAsync<PostgresException>(() => store.ApplyAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
        Assert.Equal(0, Convert.ToInt32(await db.Ado.GetScalarAsync("SELECT phase FROM authoring_extension_state_migration;")));
        _ = await db.Ado.ExecuteCommandAsync("DROP TRIGGER reject_state_phase ON authoring_extension_state_migration;");
        await store.RollbackAsync(s_oldPackage, s_newPackage, plan, default);
        Assert.Empty((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
        Assert.Single((await store.ReadAsync(s_oldPackage, s_from, default)).Entries);
    }

    [Fact]
    public async Task StaleSourceNonemptyTargetCancellationAndBudget_LeaveStateUnchanged()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var store = new PostgresAuthoringExtensionStateStore(db);
        AuthoringFencedStateMigration plan = await SeedAsync(store);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.BackupAsync(s_oldPackage, s_newPackage, plan, cancelled.Token).AsTask());
        AuthoringFencedStateMigration small = plan with
        {
            MaximumBytes = 1
        };
        small = small with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(small)
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.BackupAsync(s_oldPackage, s_newPackage, small, default).AsTask());
        await store.WriteAsync(s_oldPackage, s_from, 1, new("old", [3, 4]), default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.BackupAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
        plan = AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_oldPackage, s_from, default), s_to);
        await store.WriteAsync(s_newPackage, s_to, 0, new("existing", [5]), default);
        plan = plan with
        {
            ExpectedToRevision = 1
        };
        plan = plan with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.BackupAsync(s_oldPackage, s_newPackage, plan, default).AsTask());
        Assert.Single((await store.ReadAsync(s_oldPackage, s_from, default)).Entries);
        Assert.Single((await store.ReadAsync(s_newPackage, s_to, default)).Entries);
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        return db;
    }

    private static async Task<AuthoringFencedStateMigration> SeedAsync(PostgresAuthoringExtensionStateStore store)
    {
        await store.InitializeAsync(s_oldPackage, s_from, default);
        await store.InitializeAsync(s_newPackage, s_to, default);
        await store.WriteAsync(s_oldPackage, s_from, 0, new("old", [1, 2]), default);
        return AuthoringStateProcessWorker.Plan(await store.ReadAsync(s_oldPackage, s_from, default), s_to);
    }

    private static Process StartWorker(string connection, string operation, AuthoringFencedStateMigration plan)
    {
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        info.ArgumentList.Add(typeof(AuthoringExtensionStatePostgresTests).Assembly.Location);
        info.ArgumentList.Add(AuthoringStateProcessWorker.Command);
        Process child = Process.Start(info) ?? throw new InvalidOperationException("state_worker_start_failed");
        child.StandardInput.Write(JsonSerializer.Serialize(new AuthoringStateProcessWorker.Request(connection, operation, plan), AuthoringStateProcessWorker.s_jsonOptions));
        child.StandardInput.Close();
        return child;
    }

    private static async Task<int> RunWorkerAsync(string connection, string operation, AuthoringFencedStateMigration plan)
    {
        using Process child = StartWorker(connection, operation, plan);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await child.WaitForExitAsync(deadline.Token);
            return child.ExitCode;
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync();
            }
        }
    }
}

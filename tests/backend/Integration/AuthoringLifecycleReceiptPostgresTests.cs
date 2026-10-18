using System.Collections.Concurrent;

using Npgsql;
using SqlSugar;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringLifecycleReceiptPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Append_UpdateRollbackAndRetainedDataPreserveExactPackageEvidence()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt receipt = Receipt();
        await store.AppendAsync(receipt, default);
        foreach (AuthoringLifecycleState state in new[]
        {
            AuthoringLifecycleState.Starting, AuthoringLifecycleState.Running,
            AuthoringLifecycleState.Updating, AuthoringLifecycleState.Migrating,
            AuthoringLifecycleState.RollbackRequired, AuthoringLifecycleState.Running,
            AuthoringLifecycleState.Disabled, AuthoringLifecycleState.Uninstalling,
            AuthoringLifecycleState.RetainedData, AuthoringLifecycleState.Removed
        })
        {
            bool restoring = receipt.State == AuthoringLifecycleState.RollbackRequired;
            receipt = Next(receipt, state);
            if (state == AuthoringLifecycleState.Migrating)
            {
                receipt = Sign(receipt with
                {
                    Version = "2.0.0",
                    StateSchemaVersion = 2,
                    DataSchemaVersion = 2,
                    PackageSha256 = new string('c', 64),
                    ScopeDigest = new string('d', 64)
                });
            }
            if (state == AuthoringLifecycleState.RollbackRequired)
            {
                receipt = Sign(receipt with
                {
                    FailureCode = "migration-failed"
                });
            }
            if (restoring)
            {
                AuthoringLifecycleReceipt original = Receipt();
                receipt = Sign(receipt with
                {
                    Version = original.Version,
                    StateSchemaVersion = original.StateSchemaVersion,
                    DataSchemaVersion = original.DataSchemaVersion,
                    PackageSha256 = original.PackageSha256,
                    ScopeDigest = original.ScopeDigest
                });
            }
            await store.AppendAsync(receipt, default);
            Assert.Equal(receipt, await store.GetLatestAsync(receipt.ExtensionId, default));
        }
        Assert.Equal("migration-failed", await db.Ado.GetStringAsync(
            "SELECT failure_code FROM authoring_lifecycle_receipt WHERE state = 6;"));
        Assert.Equal(Receipt().PackageSha256, receipt.PackageSha256);
        Assert.Equal(11, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Fact]
    public async Task Append_RecreatedStoreAndConnectionRecoverExactIndependentChains()
    {
        string connectionString = await CreateDatabaseAsync();
        AuthoringLifecycleReceipt first = Receipt();
        AuthoringLifecycleReceipt second = Next(first, AuthoringLifecycleState.Starting);
        AuthoringLifecycleReceipt other = Receipt("acme.other");
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString))
        {
            var store = new PostgresAuthoringLifecycleReceiptStore(db);
            Assert.Null(await store.GetLatestAsync("acme.tools", default));
            await store.AppendAsync(first, default);
            await store.AppendAsync(other, default);
            await store.AppendAsync(second, default);
        }

        using SqlSugarClient reopened = PostgresSqlSugarTestClient.Create(connectionString);
        var recovered = new PostgresAuthoringLifecycleReceiptStore(reopened);
        Assert.Equal(second, await recovered.GetLatestAsync("acme.tools", default));
        Assert.Equal(other, await recovered.GetLatestAsync("acme.other", default));
        Assert.Null(await recovered.GetLatestAsync("ACME.tools", default));
        Assert.Equal(3, await reopened.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Theory]
    [InlineData(false, "read committed")]
    [InlineData(true, "read committed")]
    [InlineData(false, "repeatable read")]
    [InlineData(true, "repeatable read")]
    public async Task Append_ConcurrentConnectionsAcceptExactlyOneSuccessor(bool existingChain, string defaultIsolation)
    {
        string connectionString = await CreateDatabaseAsync();
        AuthoringLifecycleReceipt candidate = Receipt();
        if (existingChain)
        {
            using SqlSugarClient seed = PostgresSqlSugarTestClient.Create(connectionString);
            await new PostgresAuthoringLifecycleReceiptStore(seed).AppendAsync(candidate, default);
            candidate = Next(candidate, AuthoringLifecycleState.Starting);
        }

        var outcomes = new ConcurrentBag<Exception?>();
        using var barrier = new Barrier(2);
        var configured = new NpgsqlConnectionStringBuilder(connectionString);
        configured.Options += $" -c default_transaction_isolation={defaultIsolation.Replace(" ", "\\ ", StringComparison.Ordinal)}";
        await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Task.Run(async () =>
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(configured.ConnectionString);
            Assert.Equal(defaultIsolation, await db.Ado.GetStringAsync("SHOW default_transaction_isolation;"));
            Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(30)));
            outcomes.Add(await Record.ExceptionAsync(async () =>
                await new PostgresAuthoringLifecycleReceiptStore(db).AppendAsync(candidate, default)));
        })));

        Assert.Single(outcomes, outcome => outcome is null);
        Assert.IsType<AuthoringExtensionContractException>(Assert.Single(outcomes, outcome => outcome is not null));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(connectionString);
        Assert.Equal(candidate, await new PostgresAuthoringLifecycleReceiptStore(observer)
            .GetLatestAsync(candidate.ExtensionId, default));
        Assert.Equal(existingChain ? 2 : 1,
            await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Theory]
    [InlineData("replay")]
    [InlineData("gap")]
    [InlineData("generation")]
    [InlineData("predecessor")]
    [InlineData("state")]
    [InlineData("transition")]
    public async Task Append_StaleOrForgedSuccessorLeavesCommittedHeadUnchanged(string mutation)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt first = Receipt();
        await store.AppendAsync(first, default);
        AuthoringLifecycleReceipt next = Next(first, AuthoringLifecycleState.Starting);
        AuthoringLifecycleReceipt invalid = mutation switch
        {
            "replay" => first,
            "gap" => next with { Sequence = 3, Generation = 3 },
            "generation" => next with { Generation = 3 },
            "predecessor" => next with { PreviousReceiptSha256 = new string('b', 64) },
            "state" => next with { PreviousState = AuthoringLifecycleState.Disabled },
            "transition" => next with { State = AuthoringLifecycleState.Removed },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await store.AppendAsync(Sign(invalid), default));
        Assert.Equal(first, await store.GetLatestAsync(first.ExtensionId, default));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("sequence")]
    [InlineData("extension")]
    [InlineData("version")]
    [InlineData("state-schema")]
    [InlineData("data-schema")]
    [InlineData("previous-state")]
    [InlineData("state")]
    [InlineData("package")]
    [InlineData("scope")]
    [InlineData("failure")]
    [InlineData("previous-hash")]
    [InlineData("hash")]
    public async Task Append_MalformedReceiptNeverPersists(string mutation)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt receipt = Receipt();
        AuthoringLifecycleReceipt invalid = mutation switch
        {
            "schema" => receipt with { SchemaVersion = 2 },
            "sequence" => receipt with { Sequence = 0, Generation = 0 },
            "extension" => receipt with { ExtensionId = "acme.tools\nother" },
            "version" => receipt with { Version = new string('v', 257) },
            "state-schema" => receipt with { StateSchemaVersion = 0 },
            "data-schema" => receipt with { DataSchemaVersion = 0 },
            "previous-state" => receipt with { PreviousState = (AuthoringLifecycleState)999 },
            "state" => receipt with { State = (AuthoringLifecycleState)999 },
            "package" => receipt with { PackageSha256 = new string('A', 64) },
            "scope" => receipt with { ScopeDigest = "plaintext" },
            "failure" => receipt with { FailureCode = "failure\nplaintext" },
            "previous-hash" => receipt with { PreviousReceiptSha256 = "" },
            "hash" => receipt with { ReceiptSha256 = new string('f', 64) },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };
        if (mutation != "hash")
        {
            invalid = Sign(invalid);
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await store.AppendAsync(invalid, default));
        Assert.Null(await store.GetLatestAsync("acme.tools", default));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("missing-first")]
    [InlineData("missing-middle")]
    [InlineData("generation")]
    [InlineData("cross-extension")]
    public async Task ReadAndAppend_RejectCorruptHistoryEvenWhenLatestReceiptIsValid(string mutation)
    {
        string connectionString = await CreateDatabaseAsync();
        AuthoringLifecycleReceipt first = Receipt();
        AuthoringLifecycleReceipt second = Next(first, AuthoringLifecycleState.Starting);
        AuthoringLifecycleReceipt third = Next(second, AuthoringLifecycleState.Running);
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString))
        {
            var store = new PostgresAuthoringLifecycleReceiptStore(db);
            await store.AppendAsync(first, default);
            await store.AppendAsync(second, default);
            await store.AppendAsync(third, default);
            string sql = mutation switch
            {
                "digest" => "UPDATE authoring_lifecycle_receipt SET version = '2.0.0' WHERE sequence = 1;",
                "missing-first" => "DELETE FROM authoring_lifecycle_receipt WHERE sequence = 1;",
                "missing-middle" => "DELETE FROM authoring_lifecycle_receipt WHERE sequence = 2;",
                "generation" => "UPDATE authoring_lifecycle_receipt SET generation = 99 WHERE sequence = 1;",
                "cross-extension" => "UPDATE authoring_lifecycle_receipt SET extension_id = 'acme.other' WHERE sequence = 1;",
                _ => throw new ArgumentOutOfRangeException(nameof(mutation))
            };
            await db.Ado.ExecuteCommandAsync(sql);
        }
        using SqlSugarClient reopened = PostgresSqlSugarTestClient.Create(connectionString);
        var recovered = new PostgresAuthoringLifecycleReceiptStore(reopened);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await recovered.GetLatestAsync(first.ExtensionId, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await recovered.AppendAsync(Next(third, AuthoringLifecycleState.Disabled), default));
    }

    [Fact]
    public async Task Append_DatabaseFailureRollsBackAndAllowsExactRetry()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt first = Receipt();
        AuthoringLifecycleReceipt next = Next(first, AuthoringLifecycleState.Starting);
        await store.AppendAsync(first, default);
        await db.Ado.ExecuteCommandAsync(
            "ALTER TABLE authoring_lifecycle_receipt ADD CONSTRAINT injected_failure CHECK (sequence < 2);");
        Assert.NotNull(await Record.ExceptionAsync(async () => await store.AppendAsync(next, default)));
        Assert.Equal(first, await store.GetLatestAsync(first.ExtensionId, default));
        await db.Ado.ExecuteCommandAsync("ALTER TABLE authoring_lifecycle_receipt DROP CONSTRAINT injected_failure;");
        await store.AppendAsync(next, default);
        Assert.Equal(next, await store.GetLatestAsync(first.ExtensionId, default));
    }

    [Fact]
    public async Task Append_CancellationAfterInsertRollsBackBeforeCommit()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        using var cancellation = new CancellationTokenSource();
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.StartsWith("INSERT INTO authoring_lifecycle_receipt", StringComparison.Ordinal))
            {
                cancellation.Cancel();
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await store.AppendAsync(Receipt(), cancellation.Token));
        Assert.Null(await store.GetLatestAsync("acme.tools", default));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
        db.Aop.OnLogExecuted = null;
        await store.AppendAsync(Receipt(), default);
        Assert.Equal(Receipt(), await store.GetLatestAsync("acme.tools", default));
    }

    [Fact]
    public async Task Operations_RejectAmbientTransactionAndPreserveItsOwnership()
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        await db.Ado.BeginTranAsync();
        try
        {
            object ambient = db.Ado.Transaction;
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await store.AppendAsync(Receipt(), default));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await store.GetLatestAsync("acme.tools", default));
            Assert.Same(ambient, db.Ado.Transaction);
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
        Assert.Null(await store.GetLatestAsync("acme.tools", default));
    }

    [Theory]
    [InlineData(false, "advisory", false)]
    [InlineData(true, "advisory", false)]
    [InlineData(false, "reader", false)]
    [InlineData(true, "reader", false)]
    [InlineData(true, "insert", false)]
    [InlineData(false, "advisory", true)]
    [InlineData(true, "advisory", true)]
    [InlineData(false, "reader", true)]
    [InlineData(true, "reader", true)]
    [InlineData(true, "insert", true)]
    public async Task Operations_CancelBlockedSqlAndAwaitCleanupBeforeReturning(
        bool append, string stage, bool autoClose)
    {
        string connectionString = await CreateDatabaseAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        db.CurrentConnectionConfig.IsAutoCloseConnection = autoClose;
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt first = Receipt();
        AuthoringLifecycleReceipt next = Next(first, AuthoringLifecycleState.Starting);
        await store.AppendAsync(first, default);
        await db.Ado.OpenAsync();
        int waiterPid = ((NpgsqlConnection)db.Ado.Connection).ProcessID;
        int commandTimeout = db.Ado.CommandTimeOut;
        using var priorCancellation = new CancellationTokenSource();
        db.Ado.CancellationToken = priorCancellation.Token;
        using var cancellation = new CancellationTokenSource();
        using var watchdog = new CancellationTokenSource();
        await using var holder = new NpgsqlConnection(connectionString);
        await holder.OpenAsync();
        await using NpgsqlTransaction held = await holder.BeginTransactionAsync();
        await using var blocker = holder.CreateCommand();
        blocker.CommandText = stage switch
        {
            "advisory" => "SELECT pg_advisory_xact_lock(hashtextextended('authoring-lifecycle-receipt:acme.tools', 0));",
            "reader" => "LOCK TABLE authoring_lifecycle_receipt IN ACCESS EXCLUSIVE MODE;",
            "insert" => "LOCK TABLE authoring_lifecycle_receipt IN SHARE MODE;",
            _ => throw new ArgumentOutOfRangeException(nameof(stage))
        };
        await blocker.ExecuteNonQueryAsync();
        Task operation = append
            ? store.AppendAsync(next, cancellation.Token).AsTask()
            : store.GetLatestAsync(first.ExtensionId, cancellation.Token).AsTask();
        try
        {
            string queryPrefix = stage switch
            {
                "advisory" => "SELECT pg_advisory_xact_lock",
                "reader" => "SELECT schema_version",
                "insert" => "INSERT INTO authoring_lifecycle_receipt",
                _ => throw new ArgumentOutOfRangeException(nameof(stage))
            };
            await AssertBlockedAsync(holder, waiterPid, queryPrefix);
            cancellation.Cancel();
            // This watchdog only bounds the assertion. Failure releases the blocker and
            // still awaits the original operation in finally; it never detaches SQL work.
            Task deadline = Task.Delay(TimeSpan.FromSeconds(15), watchdog.Token);
            Assert.Same(operation, await Task.WhenAny(operation, deadline));
            OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(
                async () => await operation);
            Assert.Equal(cancellation.Token, error.CancellationToken);
            PostgresException driverError = Assert.IsType<PostgresException>(error.InnerException);
            Assert.Equal(PostgresErrorCodes.QueryCanceled, driverError.SqlState);
            Assert.Null(db.Ado.Transaction);
            Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
            Assert.Equal(commandTimeout, db.Ado.CommandTimeOut);
            Assert.Equal(autoClose, db.CurrentConnectionConfig.IsAutoCloseConnection);
            await ClearActivitySnapshotAsync(holder);
            await using var cleanup = holder.CreateCommand();
            cleanup.CommandText = """
                SELECT NOT EXISTS (
                    SELECT FROM pg_stat_activity WHERE pid = @Waiter
                    AND (state <> 'idle' OR xact_start IS NOT NULL)
                ) AND NOT EXISTS (SELECT FROM pg_locks WHERE pid = @Waiter);
                """;
            cleanup.Parameters.AddWithValue("Waiter", waiterPid);
            Assert.True((bool)(await cleanup.ExecuteScalarAsync())!);
            Assert.Equal(holder, held.Connection);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            watchdog.Cancel();
            cancellation.Cancel();
            await held.RollbackAsync();
            _ = await Record.ExceptionAsync(async () => await operation);
        }

        Assert.Equal(first, await store.GetLatestAsync(first.ExtensionId, default));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
        await store.AppendAsync(next, default);
        Assert.Equal(next, await store.GetLatestAsync(first.ExtensionId, default));
        Assert.Equal(2, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
        Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Operations_RestorePriorAdoTokenOnSuccessAndFailure(bool cancelPrior)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        using var priorCancellation = new CancellationTokenSource();
        if (cancelPrior)
        {
            priorCancellation.Cancel();
        }
        db.Ado.CancellationToken = priorCancellation.Token;
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        await store.AppendAsync(Receipt(), default);
        Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
        Assert.Equal(Receipt(), await store.GetLatestAsync("acme.tools", default));
        Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await store.AppendAsync(Receipt(), default));
        Assert.Null(db.Ado.Transaction);
        Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
        await db.Ado.BeginTranAsync();
        try
        {
            var ambient = Assert.IsAssignableFrom<System.Data.IDbTransaction>(db.Ado.Transaction);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await store.GetLatestAsync("acme.tools", default));
            Assert.Same(ambient, db.Ado.Transaction);
            Assert.Equal(priorCancellation.Token, db.Ado.CancellationToken);
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Operations_PreCancelledCallerDoesNotStartSql(bool append)
    {
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(await CreateDatabaseAsync());
        var store = new PostgresAuthoringLifecycleReceiptStore(db);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        int commands = 0;
        db.Aop.OnLogExecuting = (_, _) => commands++;
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            {
                if (append)
                {
                    await store.AppendAsync(Receipt(), cancellation.Token);
                }
                else
                {
                    await store.GetLatestAsync("acme.tools", cancellation.Token);
                }
            });
            Assert.Equal(0, commands);
            Assert.Null(db.Ado.Transaction);
            Assert.Null(db.Ado.CancellationToken);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
        await store.AppendAsync(Receipt(), default);
        Assert.Equal(Receipt(), await store.GetLatestAsync("acme.tools", default));
    }

    private static async Task AssertBlockedAsync(NpgsqlConnection holder, int waiterPid, string queryPrefix)
    {
        await using var observer = holder.CreateCommand();
        observer.CommandText = """
            SELECT EXISTS (
                SELECT FROM pg_stat_activity WHERE pid = @Waiter AND state = 'active'
                AND wait_event_type = 'Lock' AND query LIKE @Query || '%'
                AND @Holder = ANY(pg_blocking_pids(pid))
            );
            """;
        observer.Parameters.AddWithValue("Waiter", waiterPid);
        observer.Parameters.AddWithValue("Query", queryPrefix);
        observer.Parameters.AddWithValue("Holder", holder.ProcessID);
        long started = System.Diagnostics.Stopwatch.GetTimestamp();
        while (System.Diagnostics.Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(15))
        {
            await ClearActivitySnapshotAsync(holder);
            if ((bool)(await observer.ExecuteScalarAsync())!)
            {
                return;
            }
            await Task.Delay(25);
        }
        Assert.Fail($"PostgreSQL did not observe the receipt command blocked at {queryPrefix}.");
    }

    private static async Task ClearActivitySnapshotAsync(NpgsqlConnection connection)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT pg_stat_clear_snapshot();";
        await command.ExecuteNonQueryAsync();
    }

    private async Task<string> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        // Test-only materialization. Production migration/registration is deliberately owned by host composition.
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE authoring_lifecycle_receipt (
                schema_version INTEGER NOT NULL,
                sequence BIGINT NOT NULL,
                extension_id VARCHAR(256) COLLATE "C" NOT NULL,
                package_sha256 VARCHAR(64) NOT NULL,
                version VARCHAR(256) NOT NULL,
                state_schema_version INTEGER NOT NULL,
                data_schema_version INTEGER NOT NULL,
                previous_state INTEGER NOT NULL,
                state INTEGER NOT NULL,
                generation BIGINT NOT NULL,
                scope_digest VARCHAR(64) NOT NULL,
                failure_code VARCHAR(128),
                previous_receipt_sha256 VARCHAR(64) NOT NULL,
                receipt_sha256 VARCHAR(64) NOT NULL,
                PRIMARY KEY (extension_id, sequence)
            );
            """);
        return connectionString;
    }

    private static AuthoringLifecycleReceipt Receipt(string extensionId = "acme.tools") => Sign(new(
        1, 1, extensionId, new string('a', 64), "1.0.0", 1, 1,
        AuthoringLifecycleState.Installed, AuthoringLifecycleState.Enabled, 1,
        new string('b', 64), null, new string('0', 64), ""));

    private static AuthoringLifecycleReceipt Next(AuthoringLifecycleReceipt previous, AuthoringLifecycleState state) =>
        Sign(previous with
        {
            Sequence = previous.Sequence + 1,
            Generation = previous.Generation + 1,
            PreviousState = previous.State,
            State = state,
            FailureCode = null,
            PreviousReceiptSha256 = previous.ReceiptSha256
        });

    private static AuthoringLifecycleReceipt Sign(AuthoringLifecycleReceipt receipt) => receipt with
    {
        ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
    };
}

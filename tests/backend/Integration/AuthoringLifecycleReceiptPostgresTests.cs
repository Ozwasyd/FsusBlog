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

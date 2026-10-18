using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AccountSubjectHashOfflineMigrationIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Backfill_UsesCanonicalHasherAndIsIdempotent()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        var handler = new AccountSubjectHashOnlineBackfillHandler(db);

        OnlineSchemaBackfillBatchResult batch = await handler.ExecuteBatchAsync(null, 2, CancellationToken.None);
        Assert.Equal(2, batch.RowsProcessed);
        Assert.Equal("2", batch.ResumeToken);
        Assert.False(batch.Complete);
        Assert.False(await handler.VerifyAsync(CancellationToken.None));
        while (!batch.Complete)
        {
            batch = await handler.ExecuteBatchAsync(batch.ResumeToken, 256, CancellationToken.None);
        }

        Assert.Equal("300", batch.ResumeToken);
        Assert.True(await handler.VerifyAsync(CancellationToken.None));
        await AssertCanonicalProjectionAsync(connectionString);
        string beforeReplay = await CaptureAccountsAsync(connectionString);
        OnlineSchemaBackfillBatchResult replay = await handler.ExecuteBatchAsync(null, 256, CancellationToken.None);
        Assert.True(replay.Complete);
        Assert.Equal(0, replay.RowsProcessed);
        Assert.True(await handler.VerifyAsync(CancellationToken.None));
        Assert.Equal(beforeReplay, await CaptureAccountsAsync(connectionString));
        Assert.Equal(1, await fixture.QueryScalarAsync<int>(connectionString,
            "SELECT COUNT(*) FROM pg_constraint WHERE conrelid = 'sys_user'::regclass AND conname = 'ck_sys_user_account_subject_hash_format' AND convalidated;"));

        await fixture.ExecuteAsync(connectionString,
            "INSERT INTO sys_user(id, account_subject_hash) VALUES (302, NULL);");
        PostgresException malformed = await Assert.ThrowsAsync<PostgresException>(() => fixture.ExecuteAsync(
            connectionString, "INSERT INTO sys_user(id, account_subject_hash) VALUES (303, 'malformed');"));
        Assert.Equal(PostgresErrorCodes.CheckViolation, malformed.SqlState);
        Assert.Equal("ck_sys_user_account_subject_hash_format", malformed.ConstraintName);
        Assert.False(await handler.VerifyAsync(CancellationToken.None));
        Assert.True((await handler.ExecuteBatchAsync(null, 256, CancellationToken.None)).Complete);
        Assert.True(await handler.VerifyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task OnlineBackfillHandler_ResumesFromDurableKeysetTokenAndFinalizesValidation()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        // The second production batch fails in PostgreSQL after the first batch's
        // checkpoint commits. No test code writes the progress table or a token.
        await fixture.ExecuteAsync(connectionString, """
            CREATE FUNCTION reject_second_account_batch() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.id = 257 THEN
                    RAISE EXCEPTION 'synthetic_second_batch_failure';
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER reject_second_account_batch BEFORE UPDATE ON sys_user
            FOR EACH ROW EXECUTE FUNCTION reject_second_account_batch();
            """);
        OfflineMigrationCommandOptions command = OfflineMigrationCommandLine.Parse([
            "migrate", "--phase", "backfill-resume", "--id",
            AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId,
            "--release-manifest", "synthetic-release.json", "--env-file", "synthetic.env"
        ]);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationExecutor.RunAsync(command, connectionString, "synthetic-release", CancellationToken.None));
        Assert.Equal($"schema_offline_backfill_failed:{AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId}", failure.Message);
        Assert.Contains("synthetic_second_batch_failure", failure.InnerException!.Message);

        Assert.Equal("failed|256|256|1|false", await CaptureProgressAsync(connectionString));
        Assert.Equal(44, await CountInvalidAsync(connectionString));
        string committedFirstBatch = await fixture.QueryScalarAsync<string>(connectionString,
            "SELECT string_agg(id::text || ':' || account_subject_hash || ':' || xmin::text, ',' ORDER BY id) FROM sys_user WHERE id <= 256;");
        await fixture.ExecuteAsync(connectionString, "DROP TRIGGER reject_second_account_batch ON sys_user;");

        // RunAsync creates and disposes its own client on each invocation; this
        // second invocation can recover progress only from the durable database.
        OfflineMigrationExecutionResult resumed = await OfflineMigrationExecutor.RunAsync(
            command, connectionString, "synthetic-release", CancellationToken.None);
        Assert.Equal("ok", resumed.Status);
        Assert.Equal(OfflineMigrationPhase.Backfill, resumed.Phase);
        Assert.Equal([AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId], resumed.MigrationIds);
        Assert.Empty(resumed.Codes);
        Assert.Equal("completed|300|300|1|true", await CaptureProgressAsync(connectionString));
        Assert.Equal(committedFirstBatch, await fixture.QueryScalarAsync<string>(connectionString,
            "SELECT string_agg(id::text || ':' || account_subject_hash || ':' || xmin::text, ',' ORDER BY id) FROM sys_user WHERE id <= 256;"));
        await AssertCanonicalProjectionAsync(connectionString);
        string beforeReplay = await CaptureAccountsAsync(connectionString);
        OfflineMigrationExecutionResult replay = await OfflineMigrationExecutor.RunAsync(
            command, connectionString, "synthetic-release", CancellationToken.None);
        Assert.Equal("ok", replay.Status);
        Assert.Empty(replay.Codes);
        Assert.Equal("completed|300|300|1|true", await CaptureProgressAsync(connectionString));
        Assert.Equal(beforeReplay, await CaptureAccountsAsync(connectionString));
        Assert.Equal(1, await fixture.QueryScalarAsync<int>(connectionString,
            "SELECT COUNT(*) FROM pg_constraint WHERE conrelid = 'sys_user'::regclass AND conname = 'ck_sys_user_account_subject_hash_format' AND convalidated;"));
    }

    [Fact]
    public async Task StartupGate_RechecksProjectionAfterMigrationHistoryCouldAlreadyExist()
    {
        string connectionString = await CreateLegacyAccountTableAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(connectionString);
        var handler = new AccountSubjectHashOnlineBackfillHandler(writer);
        OnlineSchemaBackfillBatchResult batch = await handler.ExecuteBatchAsync(null, 1000, CancellationToken.None);
        Assert.True(batch.Complete);
        await OfflineMigrationStateStore.EnsureControlTablesAsync(writer, CancellationToken.None);
        await OfflineMigrationStateStore.MarkAppliedAsync(writer,
            AccountSubjectHashOnlineBackfillHandler.BackfillMigrationId, "synthetic-checksum", "synthetic-release",
            succeeded: true, CancellationToken.None);

        var readOnly = new NpgsqlConnectionStringBuilder(connectionString);
        readOnly.Options = $"{readOnly.Options} -c default_transaction_read_only=on".Trim();
        using SqlSugarClient reader = PostgresSqlSugarTestClient.Create(readOnly.ConnectionString);
        Assert.Equal("on", await reader.Ado.GetStringAsync("SHOW default_transaction_read_only;"));
        var gate = new AccountSubjectHashInvariantGate(reader);
        string validAccounts = await CaptureAccountsAsync(connectionString);
        IReadOnlyList<string> schema = await fixture.CaptureSchemaSnapshotAsync(connectionString);
        await gate.EnsureAsync();
        Assert.Equal(validAccounts, await CaptureAccountsAsync(connectionString));
        Assert.Equal(schema, await fixture.CaptureSchemaSnapshotAsync(connectionString));

        foreach (string? invalid in new string?[] { null, "", "   ", "INVALID", new('A', 64) })
        {
            await writer.Ado.ExecuteCommandAsync("UPDATE sys_user SET account_subject_hash = @hash WHERE id = 1;",
                new SugarParameter("@hash", invalid ?? (object)DBNull.Value));
            string beforeGate = await CaptureAccountsAsync(connectionString);
            InvalidOperationException rejection = await Assert.ThrowsAsync<InvalidOperationException>(() => gate.EnsureAsync());
            Assert.Contains("incomplete for 1 account(s)", rejection.Message);
            Assert.Equal(beforeGate, await CaptureAccountsAsync(connectionString));
            Assert.Equal(schema, await fixture.CaptureSchemaSnapshotAsync(connectionString));
            Assert.Equal(1, await fixture.QueryScalarAsync<int>(connectionString,
                "SELECT COUNT(*) FROM __fsus_schema_migration_history WHERE migration_id = '20260711-post-account-subject-hash-backfill' AND succeeded;"));
        }

        Assert.True((await handler.ExecuteBatchAsync(null, 256, CancellationToken.None)).Complete);
        Assert.True(await handler.VerifyAsync(CancellationToken.None));
        await gate.EnsureAsync();
        await AssertCanonicalProjectionAsync(connectionString);
    }

    private async Task<string> CreateLegacyAccountTableAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE sys_user (
                id integer PRIMARY KEY,
                identity_kind varchar(32) NULL,
                passkey_user_handle varchar(128) NULL,
                public_handle varchar(64) NULL,
                account_subject_hash varchar(64) NULL
            );
            INSERT INTO sys_user(id, identity_kind, passkey_user_handle, public_handle, account_subject_hash)
            VALUES
                (1, 'anonymous_account', NULL, ' QuietReader ', NULL),
                (2, 'anonymous_account', ' QWJjZA ', 'ignored-handle', ''),
                (3, NULL, NULL, NULL, 'INVALID');
            INSERT INTO sys_user(id, identity_kind, public_handle, account_subject_hash)
            SELECT id, 'anonymous_account', 'reader-' || id::text, NULL
            FROM generate_series(4, 300) AS series(id);
            INSERT INTO sys_user(id, identity_kind, public_handle, account_subject_hash)
            VALUES (301, 'anonymous_account', 'already-valid', repeat('a', 64));
            """);
        return connectionString;
    }

    private async Task AssertCanonicalProjectionAsync(string connectionString)
    {
        foreach ((int id, string expected) in new[]
        {
            (1, AccountSubjectHasher.Create("anonymous_account", "QuietReader")),
            (2, AccountSubjectHasher.Create("anonymous_account", "QWJjZA")),
            (3, AccountSubjectHasher.Create("anonymous_account", "anonymous-account:3")),
            (300, AccountSubjectHasher.Create("anonymous_account", "reader-300")),
            (301, new string('a', 64))
        })
        {
            Assert.Equal(expected, await fixture.QueryScalarAsync<string>(connectionString,
                $"SELECT account_subject_hash FROM sys_user WHERE id = {id};"));
        }
        Assert.Equal(0, await CountInvalidAsync(connectionString));
    }

    private Task<string> CaptureAccountsAsync(string connectionString)
        => fixture.QueryScalarAsync<string>(connectionString,
            "SELECT jsonb_agg(to_jsonb(account) || jsonb_build_object('row_version', xmin::text) ORDER BY id)::text FROM sys_user AS account;");

    private Task<string> CaptureProgressAsync(string connectionString)
        => fixture.QueryScalarAsync<string>(connectionString, """
            SELECT status || '|' || resume_token || '|' || rows_processed::text || '|' || failure_count::text
                || '|' || (verified_at_utc IS NOT NULL)::text
            FROM __fsus_schema_backfill_progress
            WHERE migration_id = '20260711-post-account-subject-hash-backfill';
            """);

    private Task<int> CountInvalidAsync(string connectionString)
        => fixture.QueryScalarAsync<int>(connectionString, """
            SELECT COUNT(*) FROM sys_user
            WHERE account_subject_hash IS NULL OR btrim(account_subject_hash) = ''
                OR account_subject_hash !~ '^[0-9a-f]{64}$';
            """);
}

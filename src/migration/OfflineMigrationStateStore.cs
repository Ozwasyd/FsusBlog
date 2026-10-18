using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;

using Microsoft.Data.Sqlite;

using MySqlConnector;

using SqlSugar;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Migration;

/// <summary>
/// Session-scoped state for the offline migration host. Table layout mirrors
/// the historical PostgresOnlineSchemaMigrationStateStore so an offline host
/// run and an online-served deployment share one migration ledger.
/// </summary>
internal static class OfflineMigrationStateStore
{
    internal const string HistoryTableName = "__fsus_schema_migration_history";
    internal const string StateTableName = "__fsus_schema_online_state";
    internal const string BackfillTableName = "__fsus_schema_backfill_progress";
    internal const string ApplyJournalTableName = CurrentSchemaControlShape.ApplyJournalTableName;
    internal const string JournalCleanupFailuresKey = "FsusBlog.Migration.JournalCleanupFailures";

    // One sole current control shape. Native provider transactions and locks do not
    // grant missing compiled business operations or reinterpret sealed execution modes.
    internal static async Task EnsureApplyJournalAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        CurrentSchemaProviderKind provider = NativeProvider(connection, transaction);
        if (provider != CurrentSchemaProviderKind.PostgreSql)
        {
            if (!await OfflineMigrationApplyJournalDialect.ExistsAsync(provider, connection, transaction, cancellationToken).ConfigureAwait(false))
            {
                // MySQL CREATE TABLE would silently commit this admission transaction.
                // Its owned bootstrap must provide the sole control first; do not execute
                // implicit DDL or pretend that the sealed unit remains all-or-nothing.
                if (provider == CurrentSchemaProviderKind.MySql)
                    throw new InvalidOperationException("offline_apply_mysql_control_bootstrap_required");
                await OfflineMigrationApplyJournalDialect.CreateSqliteAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            }
            await OfflineMigrationApplyJournalDialect.ValidateAsync(provider, connection, transaction, cancellationToken).ConfigureAwait(false);
            return;
        }
        await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    internal static async Task ReadApplyJournalAsync(
        DbConnection connection, DbTransaction transaction,
        string planContentDigest, CurrentSchemaDatabaseIdentity database,
        OfflineMigrationApplyRequest request, OfflineMigrationApplyJournalVerifier verifier,
        CancellationToken cancellationToken)
    {
        CurrentSchemaProviderKind provider = NativeProvider(connection, transaction);
        if (database.Provider != provider)
            throw new InvalidOperationException("offline_apply_native_database_provider_mismatch");
        if (!await OfflineMigrationApplyJournalDialect.ExistsAsync(provider, connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            if (request.Checkpoint is not null)
            {
                throw new InvalidOperationException("offline_apply_checkpoint_missing");
            }
            return;
        }

        await ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await ReadApplyJournalRowsAsync(provider, connection, transaction, planContentDigest,
            database, request, verifier, cancellationToken).ConfigureAwait(false);
    }

    // Only the original native read creator can supply this overload. Snapshot
    // is never accepted by the raw transaction selector or any writing method.
    internal static async Task ReadApplyJournalAsync(
        OfflineMigrationMySqlNativeSession.OwnedReadContext context,
        string planContentDigest, CurrentSchemaDatabaseIdentity database,
        OfflineMigrationApplyRequest request, OfflineMigrationApplyJournalVerifier verifier,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(context);
        using CancellationTokenSource scope = context.CreateReadScope(cancellationToken);
        cancellationToken = scope.Token;
        await context.RequireBoundaryAsync(cancellationToken).ConfigureAwait(false);
        if (database.Provider != CurrentSchemaProviderKind.MySql)
            throw new InvalidOperationException("offline_apply_native_database_provider_mismatch");
        if (!await OfflineMigrationApplyJournalDialect.ExistsAsync(CurrentSchemaProviderKind.MySql,
            context.OriginalConnection, context.OriginalTransaction, cancellationToken).ConfigureAwait(false))
        {
            if (request.Checkpoint is not null)
                throw new InvalidOperationException("offline_apply_checkpoint_missing");
        }
        else
        {
            await ValidateApplyJournalAsync(context, cancellationToken).ConfigureAwait(false);
            await ReadApplyJournalRowsAsync(CurrentSchemaProviderKind.MySql,
                context.OriginalConnection, context.OriginalTransaction, planContentDigest,
                database, request, verifier, cancellationToken).ConfigureAwait(false);
        }
        await context.RequireBoundaryAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
    }

    // The same original whole-chain SQL and verifier body serves both read paths.
    // This private implementation is not a raw caller-owned admission surface.
    private static async Task ReadApplyJournalRowsAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        string planContentDigest, CurrentSchemaDatabaseIdentity database,
        OfflineMigrationApplyRequest request, OfflineMigrationApplyJournalVerifier verifier,
        CancellationToken cancellationToken)
    {
        string databaseDigest = OfflineMigrationPlanValidation.Digest(database);
        await using DbCommand command = NativeCommand(connection, transaction, $"""
            SELECT invocation_id, sequence, entry_digest, parent_digest,
                CASE WHEN {PayloadByteLength(provider)} <= 1048576 THEN entry_payload ELSE NULL END
            FROM {OfflineMigrationApplyJournalDialect.Table(provider)}
            WHERE plan_digest = @plan AND database_digest = @database
            ORDER BY invocation_id, sequence
            """);
        Parameter(command, "@plan", planContentDigest);
        Parameter(command, "@database", databaseDigest);
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (request.Checkpoint is null || reader.GetString(0) != request.InvocationId)
            {
                throw new InvalidOperationException("offline_apply_explicit_checkpoint_required");
            }

            if (reader.IsDBNull(4))
            {
                throw new InvalidOperationException("offline_apply_journal_entry_oversized");
            }

            string payload = reader.GetString(4);
            OfflineMigrationApplyJournalEntry entry = JsonSerializer.Deserialize<OfflineMigrationApplyJournalEntry>(payload)
                ?? throw new InvalidOperationException("offline_apply_journal_entry_invalid");
            if (entry.Sequence != reader.GetInt64(1) || entry.ContentDigest != reader.GetString(2)
                || entry.PreviousDigest != reader.GetString(3))
            {
                throw new InvalidOperationException("offline_apply_journal_columns_changed");
            }

            verifier.Accept(entry);
        }

        if (request.Checkpoint is not null)
        {
            // Read the entire exact run, not WHERE sequence <= requested: a stale head is
            // rejected instead of hiding later committed effects or selecting latest.
            verifier.Complete(request.Checkpoint);
        }
    }

    internal static async Task AppendApplyJournalAsync(
        DbConnection connection, DbTransaction transaction,
        OfflineMigrationApplyJournalEntry entry, CancellationToken cancellationToken)
    {
        string payload = JsonSerializer.Serialize(entry);
        if (Encoding.UTF8.GetByteCount(payload) > 1_048_576)
        {
            throw new InvalidOperationException("offline_apply_journal_entry_oversized");
        }

        CurrentSchemaProviderKind provider = NativeProvider(connection, transaction);
        if (entry.Database.Provider != provider)
            throw new InvalidOperationException("offline_apply_native_database_provider_mismatch");

        DbCommand command = NativeCommand(connection, transaction, $"""
            INSERT INTO {OfflineMigrationApplyJournalDialect.Table(provider)}
                (plan_digest, database_digest, invocation_id, sequence, entry_digest, parent_digest, entry_payload)
            VALUES (@plan, @database, @invocation, @sequence, @entry, @parent, @payload)
            """);
        Exception? first = null;
        try
        {
            Parameter(command, "@plan", entry.PlanContentDigest);
            Parameter(command, "@database", OfflineMigrationPlanValidation.Digest(entry.Database));
            Parameter(command, "@invocation", entry.InvocationId);
            Parameter(command, "@sequence", entry.Sequence);
            Parameter(command, "@entry", entry.ContentDigest);
            Parameter(command, "@parent", entry.PreviousDigest);
            Parameter(command, "@payload", payload);
            if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
                throw new InvalidOperationException("offline_apply_journal_append_failed");
        }
        catch (Exception failure) { first = failure; }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            first ??= cleanup;
            first.Data[JournalCleanupFailuresKey] = "offline_apply_journal_command_disposal_failed";
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
    }

    internal static DbCommand NativeCommand(DbConnection connection, DbTransaction? transaction, string sql)
    {
        DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        return command;
    }

    internal static async Task ValidateApplyJournalAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        CurrentSchemaProviderKind provider = NativeProvider(connection, transaction);
        if (provider != CurrentSchemaProviderKind.PostgreSql)
        {
            await OfflineMigrationApplyJournalDialect.ValidateAsync(provider, connection, transaction, cancellationToken).ConfigureAwait(false);
            return;
        }
        await PgCurrentSchemaControlShape.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    internal static async Task ValidateApplyJournalAsync(
        OfflineMigrationMySqlNativeSession.OwnedReadContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(context);
        using CancellationTokenSource scope = context.CreateReadScope(cancellationToken);
        cancellationToken = scope.Token;
        await context.RequireBoundaryAsync(cancellationToken).ConfigureAwait(false);
        await OfflineMigrationApplyJournalDialect.ValidateAsync(CurrentSchemaProviderKind.MySql,
            context.OriginalConnection, context.OriginalTransaction, cancellationToken).ConfigureAwait(false);
        await context.RequireBoundaryAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
    }

    internal static void Parameter(DbCommand command, string name, object value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }

    internal static CurrentSchemaProviderKind NativeProvider(DbConnection connection, DbTransaction transaction)
        => connection switch
        {
            MySqlConnection when transaction is MySqlTransaction && transaction.Connection == connection
                && transaction.IsolationLevel == IsolationLevel.RepeatableRead => CurrentSchemaProviderKind.MySql,
            SqliteConnection when transaction is SqliteTransaction && transaction.Connection == connection
                && transaction.IsolationLevel == IsolationLevel.Serializable => CurrentSchemaProviderKind.Sqlite,
            MySqlConnection or SqliteConnection => throw new InvalidOperationException("offline_apply_original_native_transaction_required"),
            _ => CurrentSchemaProviderKind.PostgreSql // Original PostgreSQL and its existing command-boundary fixtures.
        };

    private static string PayloadByteLength(CurrentSchemaProviderKind provider)
        => provider == CurrentSchemaProviderKind.Sqlite ? "length(CAST(entry_payload AS BLOB))" : "octet_length(entry_payload)";

    internal sealed record BackfillSnapshot(
        string MigrationId,
        string Status,
        string? ResumeToken,
        long RowsProcessed,
        long FailureCount,
        DateTimeOffset UpdatedAt,
        DateTimeOffset? VerifiedAt = null);

    public static async Task EnsureControlTablesAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync($"""
            CREATE TABLE IF NOT EXISTS {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)} (
                migration_id varchar(160) PRIMARY KEY,
                checksum varchar(128) NOT NULL,
                applied_at_utc timestamp NOT NULL,
                app_version varchar(128) NOT NULL,
                succeeded boolean NOT NULL
            );

            CREATE TABLE IF NOT EXISTS {SchemaMigrationSql.QuoteIdentifier(StateTableName)} (
                singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
                schema_release varchar(128) NOT NULL,
                updated_at_utc timestamp NOT NULL
            );

            CREATE TABLE IF NOT EXISTS {SchemaMigrationSql.QuoteIdentifier(BackfillTableName)} (
                migration_id varchar(160) PRIMARY KEY,
                status varchar(32) NOT NULL,
                resume_token varchar(512) NULL,
                rows_processed bigint NOT NULL,
                failure_count bigint NOT NULL,
                updated_at_utc timestamp NOT NULL,
                verified_at_utc timestamp NULL,
                rows_per_second double precision NULL,
                remaining_rows_estimate bigint NULL
            );
            """).ConfigureAwait(false);
    }

    public static async Task<IReadOnlySet<string>> ReadAppliedMigrationIdsAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool available = await TableExistsAsync(db, HistoryTableName, cancellationToken).ConfigureAwait(false);
        if (!available)
        {
            return new HashSet<string>(StringComparer.Ordinal);
        }

        var applied = new HashSet<string>(StringComparer.Ordinal);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"SELECT migration_id FROM {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)} WHERE succeeded = true",
            Array.Empty<SugarParameter>()).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            applied.Add(reader.GetString(0));
        }

        return applied;
    }

    public static async Task MarkAppliedAsync(
        ISqlSugarClient db,
        string migrationId,
        string checksum,
        string releaseId,
        bool succeeded,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {SchemaMigrationSql.QuoteIdentifier(HistoryTableName)}
                (migration_id, checksum, applied_at_utc, app_version, succeeded)
            VALUES (@migrationId, @checksum, @appliedAt, @appVersion, @succeeded)
            ON CONFLICT (migration_id) DO UPDATE SET
                checksum = EXCLUDED.checksum,
                applied_at_utc = EXCLUDED.applied_at_utc,
                app_version = EXCLUDED.app_version,
                succeeded = EXCLUDED.succeeded
            """,
            new SugarParameter[]
            {
                new SugarParameter("@migrationId", migrationId),
                new SugarParameter("@checksum", checksum),
                new SugarParameter("@appliedAt", DateTimeOffset.UtcNow.UtcDateTime),
                new SugarParameter("@appVersion", releaseId),
                new SugarParameter("@succeeded", succeeded)
            }).ConfigureAwait(false);
    }

    public static async Task<BackfillSnapshot?> ReadBackfillAsync(
        ISqlSugarClient db,
        string migrationId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool available = await TableExistsAsync(db, BackfillTableName, cancellationToken).ConfigureAwait(false);
        if (!available)
        {
            return null;
        }

        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT migration_id, status, resume_token, rows_processed, failure_count,
                   updated_at_utc, verified_at_utc
            FROM {SchemaMigrationSql.QuoteIdentifier(BackfillTableName)}
            WHERE migration_id = @migrationId
            """,
            new SugarParameter[] { new SugarParameter("@migrationId", migrationId) }).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new BackfillSnapshot(
            reader.GetString(0),
            reader.GetString(1),
            reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetInt64(3),
            reader.GetInt64(4),
            new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(5), DateTimeKind.Utc), TimeSpan.Zero),
            reader.IsDBNull(6)
                ? null
                : new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(6), DateTimeKind.Utc), TimeSpan.Zero));
    }

    public static async Task SaveBackfillAsync(
        ISqlSugarClient db,
        BackfillSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {SchemaMigrationSql.QuoteIdentifier(BackfillTableName)}
                (migration_id, status, resume_token, rows_processed, failure_count,
                 updated_at_utc, verified_at_utc)
            VALUES (@migrationId, @status, @resumeToken, @rowsProcessed, @failureCount,
                    @updatedAt, @verifiedAt)
            ON CONFLICT (migration_id) DO UPDATE SET
                status = EXCLUDED.status,
                resume_token = EXCLUDED.resume_token,
                rows_processed = EXCLUDED.rows_processed,
                failure_count = EXCLUDED.failure_count,
                updated_at_utc = EXCLUDED.updated_at_utc,
                verified_at_utc = EXCLUDED.verified_at_utc
            """,
            new SugarParameter[]
            {
                new SugarParameter("@migrationId", snapshot.MigrationId),
                new SugarParameter("@status", snapshot.Status),
                new SugarParameter("@resumeToken", snapshot.ResumeToken),
                new SugarParameter("@rowsProcessed", snapshot.RowsProcessed),
                new SugarParameter("@failureCount", snapshot.FailureCount),
                new SugarParameter("@updatedAt", snapshot.UpdatedAt.UtcDateTime),
                new SugarParameter("@verifiedAt", snapshot.VerifiedAt?.UtcDateTime ?? (object?)DBNull.Value, System.Data.DbType.DateTime)
            }).ConfigureAwait(false);
    }

    private static async Task<bool> TableExistsAsync(
        ISqlSugarClient db,
        string tableName,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT EXISTS (
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname = @tableName AND n.nspname = 'public' AND c.relkind = 'r')
            """,
            new SugarParameter[] { new SugarParameter("@tableName", tableName) }).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return false;
        }

        return reader.GetBoolean(0);
    }
}

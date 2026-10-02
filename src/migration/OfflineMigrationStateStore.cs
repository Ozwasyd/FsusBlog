using System.Data;
using System.Data.Common;
using System.Text.Json;

using SqlSugar;

using FsusBlog.Contracts.Migration;

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
    internal const string ApplyJournalTableName = "__fsus_schema_offline_apply_journal";

    // The sealed route currently admits only PostgreSQL's transactional native session.
    // Provider-specific journal/lock/DDL guarantees must be implemented before another
    // provider is admitted; the legacy three-dialect DDL emitter is not that guarantee.
    internal static async Task EnsureApplyJournalAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using DbCommand command = NativeCommand(connection, transaction, $"""
            CREATE TABLE IF NOT EXISTS public.{ApplyJournalTableName} (
                plan_digest varchar(64) NOT NULL,
                database_digest varchar(64) NOT NULL,
                invocation_id varchar(160) NOT NULL,
                sequence bigint NOT NULL CHECK (sequence > 0),
                entry_digest varchar(64) NOT NULL,
                parent_digest varchar(64) NOT NULL,
                entry_payload text NOT NULL,
                PRIMARY KEY (plan_digest, database_digest, invocation_id, sequence),
                UNIQUE (plan_digest, database_digest, invocation_id, parent_digest),
                UNIQUE (entry_digest)
            )
            """);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        await ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    internal static async Task ReadApplyJournalAsync(
        DbConnection connection, DbTransaction transaction,
        string planContentDigest, CurrentSchemaDatabaseIdentity database,
        OfflineMigrationApplyRequest request, OfflineMigrationApplyJournalVerifier verifier,
        CancellationToken cancellationToken)
    {
        await using (DbCommand available = NativeCommand(connection, transaction,
            "SELECT to_regclass('public.__fsus_schema_offline_apply_journal') IS NOT NULL"))
        {
            if (!Convert.ToBoolean(await available.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false)))
            {
                if (request.Checkpoint is not null)
                {
                    throw new InvalidOperationException("offline_apply_checkpoint_missing");
                }

                return;
            }
        }

        await ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        string databaseDigest = OfflineMigrationPlanValidation.Digest(database);
        await using DbCommand command = NativeCommand(connection, transaction, $"""
            SELECT invocation_id, sequence, entry_digest, parent_digest,
                CASE WHEN octet_length(entry_payload) <= 1048576 THEN entry_payload ELSE NULL END
            FROM public.{ApplyJournalTableName}
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
        if (payload.Length > 1_048_576)
        {
            throw new InvalidOperationException("offline_apply_journal_entry_oversized");
        }

        await using DbCommand command = NativeCommand(connection, transaction, $"""
            INSERT INTO public.{ApplyJournalTableName}
                (plan_digest, database_digest, invocation_id, sequence, entry_digest, parent_digest, entry_payload)
            VALUES (@plan, @database, @invocation, @sequence, @entry, @parent, @payload)
            """);
        Parameter(command, "@plan", entry.PlanContentDigest);
        Parameter(command, "@database", OfflineMigrationPlanValidation.Digest(entry.Database));
        Parameter(command, "@invocation", entry.InvocationId);
        Parameter(command, "@sequence", entry.Sequence);
        Parameter(command, "@entry", entry.ContentDigest);
        Parameter(command, "@parent", entry.PreviousDigest);
        Parameter(command, "@payload", payload);
        if (await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new InvalidOperationException("offline_apply_journal_append_failed");
        }
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
        // IF NOT EXISTS is not evidence that an existing control table has the required
        // append-only keys. Validate the physical owner shape before reading or appending.
        await using DbCommand command = NativeCommand(connection, transaction, """
            WITH actual_columns AS (
                SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS required
                FROM pg_attribute
                WHERE attrelid = to_regclass('public.__fsus_schema_offline_apply_journal')
                    AND attnum > 0 AND NOT attisdropped
            ), expected_columns(name, type, required) AS (
                VALUES ('plan_digest', 'character varying(64)', true),
                    ('database_digest', 'character varying(64)', true),
                    ('invocation_id', 'character varying(160)', true),
                    ('sequence', 'bigint', true), ('entry_digest', 'character varying(64)', true),
                    ('parent_digest', 'character varying(64)', true), ('entry_payload', 'text', true)
            ), actual_constraints AS (
                SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
                WHERE conrelid = to_regclass('public.__fsus_schema_offline_apply_journal')
            ), expected_constraints(definition) AS (
                VALUES ('PRIMARY KEY (plan_digest, database_digest, invocation_id, sequence)'),
                    ('UNIQUE (plan_digest, database_digest, invocation_id, parent_digest)'),
                    ('UNIQUE (entry_digest)'), ('CHECK ((sequence > 0))')
            )
            SELECT NOT EXISTS (
                (SELECT * FROM actual_columns EXCEPT SELECT * FROM expected_columns)
                UNION ALL (SELECT * FROM expected_columns EXCEPT SELECT * FROM actual_columns)
            ) AND NOT EXISTS (
                (SELECT * FROM actual_constraints EXCEPT SELECT * FROM expected_constraints)
                UNION ALL (SELECT * FROM expected_constraints EXCEPT SELECT * FROM actual_constraints)
            )
            """);
        if (!Convert.ToBoolean(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false)))
        {
            throw new InvalidOperationException("offline_apply_journal_physical_shape_changed");
        }
    }

    internal static void Parameter(DbCommand command, string name, object value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }

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

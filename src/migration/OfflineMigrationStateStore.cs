using System.Data;
using System.Data.Common;

using SqlSugar;

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

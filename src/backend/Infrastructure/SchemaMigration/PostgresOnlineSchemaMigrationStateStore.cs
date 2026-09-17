using System.Data;

using FsusBlog.Server.Infrastructure.Operations;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface IOnlineSchemaMigrationStateStore
{
    Task<OnlineSchemaDatabaseSnapshot> ReadAsync(CancellationToken cancellationToken);

    Task EnsureControlTablesAsync(CancellationToken cancellationToken);

    Task SaveBackfillAsync(OnlineSchemaBackfillSnapshot snapshot, CancellationToken cancellationToken);

    Task MarkMigrationAppliedAsync(
        string migrationId,
        string checksum,
        ReleaseId releaseId,
        CancellationToken cancellationToken);

    Task MarkSchemaCompatibilityCoordinateAsync(
        SchemaCompatibilityCoordinate coordinate,
        CancellationToken cancellationToken);
}

public sealed class PostgresOnlineSchemaMigrationStateStore(ISqlSugarClient db)
    : IOnlineSchemaMigrationStateStore
{
    internal const string HistoryTableName = "__fsus_schema_migration_history";
    internal const string StateTableName = "__fsus_schema_online_state";
    internal const string BackfillTableName = "__fsus_schema_backfill_progress";

    public async Task<OnlineSchemaDatabaseSnapshot> ReadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool historyAvailable = await TableExistsAsync(HistoryTableName, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<OnlineSchemaMigrationHistorySnapshot> history = historyAvailable
            ? await ReadHistoryAsync(cancellationToken).ConfigureAwait(false)
            : [];
        string? persistedCoordinate = await ReadSchemaCompatibilityCoordinateAsync(cancellationToken).ConfigureAwait(false);
        SchemaCompatibilityCoordinate? schemaCoordinate = persistedCoordinate is null
            ? null
            : SchemaCompatibilityCoordinate.ParsePersisted(persistedCoordinate);
        IReadOnlyDictionary<string, OnlineSchemaBackfillSnapshot> backfills =
            await ReadBackfillsAsync(cancellationToken).ConfigureAwait(false);

        return new OnlineSchemaDatabaseSnapshot(historyAvailable, schemaCoordinate, history, backfills);
    }

    public async Task EnsureControlTablesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync($"""
            CREATE TABLE IF NOT EXISTS {QuoteIdentifier(HistoryTableName)} (
                migration_id varchar(160) PRIMARY KEY,
                checksum varchar(128) NOT NULL,
                applied_at_utc timestamp NOT NULL,
                app_version varchar(128) NOT NULL,
                succeeded boolean NOT NULL
            );

            CREATE TABLE IF NOT EXISTS {QuoteIdentifier(StateTableName)} (
                singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
                schema_release varchar(128) NOT NULL,
                updated_at_utc timestamp NOT NULL
            );

            CREATE TABLE IF NOT EXISTS {QuoteIdentifier(BackfillTableName)} (
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

            ALTER TABLE {QuoteIdentifier(BackfillTableName)}
                ADD COLUMN IF NOT EXISTS rows_per_second double precision NULL;
            ALTER TABLE {QuoteIdentifier(BackfillTableName)}
                ADD COLUMN IF NOT EXISTS remaining_rows_estimate bigint NULL;
            """).ConfigureAwait(false);
    }

    public async Task SaveBackfillAsync(
        OnlineSchemaBackfillSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {QuoteIdentifier(BackfillTableName)}(
                migration_id,
                status,
                resume_token,
                rows_processed,
                failure_count,
                updated_at_utc,
                verified_at_utc,
                rows_per_second,
                remaining_rows_estimate
            )
            VALUES (
                @migration_id,
                @status,
                @resume_token,
                @rows_processed,
                @failure_count,
                @updated_at_utc,
                @verified_at_utc,
                @rows_per_second,
                @remaining_rows_estimate
            )
            ON CONFLICT (migration_id) DO UPDATE
            SET status = EXCLUDED.status,
                resume_token = EXCLUDED.resume_token,
                rows_processed = EXCLUDED.rows_processed,
                failure_count = EXCLUDED.failure_count,
                updated_at_utc = EXCLUDED.updated_at_utc,
                verified_at_utc = EXCLUDED.verified_at_utc,
                rows_per_second = EXCLUDED.rows_per_second,
                remaining_rows_estimate = EXCLUDED.remaining_rows_estimate;
            """,
            new SugarParameter("@migration_id", snapshot.MigrationId),
            new SugarParameter("@status", snapshot.Status),
            new SugarParameter("@resume_token", (object?)snapshot.ResumeToken ?? DBNull.Value),
            new SugarParameter("@rows_processed", snapshot.RowsProcessed),
            new SugarParameter("@failure_count", snapshot.FailureCount),
            new SugarParameter("@updated_at_utc", snapshot.UpdatedAtUtc.UtcDateTime),
            new SugarParameter("@verified_at_utc", (object?)snapshot.VerifiedAtUtc?.UtcDateTime ?? DBNull.Value),
            new SugarParameter("@rows_per_second", (object?)snapshot.RowsPerSecond ?? DBNull.Value),
            new SugarParameter("@remaining_rows_estimate", (object?)snapshot.RemainingRowsEstimate ?? DBNull.Value)).ConfigureAwait(false);
    }

    public async Task MarkMigrationAppliedAsync(
        string migrationId,
        string checksum,
        ReleaseId releaseId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {QuoteIdentifier(HistoryTableName)}(
                migration_id,
                checksum,
                applied_at_utc,
                app_version,
                succeeded
            )
            VALUES (@migration_id, @checksum, @applied_at_utc, @app_version, TRUE)
            ON CONFLICT (migration_id) DO UPDATE
            SET checksum = EXCLUDED.checksum,
                applied_at_utc = EXCLUDED.applied_at_utc,
                app_version = EXCLUDED.app_version,
                succeeded = TRUE;
            """,
            new SugarParameter("@migration_id", migrationId),
            new SugarParameter("@checksum", checksum),
            new SugarParameter("@applied_at_utc", DateTime.UtcNow),
            new SugarParameter("@app_version", releaseId.Value)).ConfigureAwait(false);
    }

    public async Task MarkSchemaCompatibilityCoordinateAsync(
        SchemaCompatibilityCoordinate coordinate,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {QuoteIdentifier(StateTableName)}(
                singleton_id,
                schema_release,
                updated_at_utc
            )
            VALUES (1, @schema_release, @updated_at_utc)
            ON CONFLICT (singleton_id) DO UPDATE
            SET schema_release = EXCLUDED.schema_release,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@schema_release", coordinate.Value),
            new SugarParameter("@updated_at_utc", DateTime.UtcNow)).ConfigureAwait(false);
    }

    private async Task<bool> TableExistsAsync(string tableName, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync(
            "SELECT to_regclass(@qualified_name) IS NOT NULL AS table_exists;",
            new SugarParameter("@qualified_name", $"public.{tableName}")).ConfigureAwait(false);
        return table.Rows.Count == 1 && Convert.ToBoolean(table.Rows[0]["table_exists"]);
    }

    private async Task<IReadOnlyList<OnlineSchemaMigrationHistorySnapshot>> ReadHistoryAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DataTable table = await db.Ado.GetDataTableAsync($"""
            SELECT migration_id, checksum, applied_at_utc, app_version, succeeded
            FROM {QuoteIdentifier(HistoryTableName)}
            ORDER BY migration_id;
            """).ConfigureAwait(false);

        var history = new List<OnlineSchemaMigrationHistorySnapshot>(table.Rows.Count);
        foreach (DataRow row in table.Rows)
        {
            history.Add(new OnlineSchemaMigrationHistorySnapshot(
                Convert.ToString(row["migration_id"]) ?? string.Empty,
                Convert.ToString(row["checksum"]) ?? string.Empty,
                AsUtc(row["applied_at_utc"]),
                Convert.ToString(row["app_version"]) ?? string.Empty,
                Convert.ToBoolean(row["succeeded"])));
        }

        return history;
    }

    private async Task<string?> ReadSchemaCompatibilityCoordinateAsync(CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(StateTableName, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        DataTable table = await db.Ado.GetDataTableAsync($"""
            SELECT schema_release
            FROM {QuoteIdentifier(StateTableName)}
            WHERE singleton_id = 1;
            """).ConfigureAwait(false);
        return table.Rows.Count == 0
            ? null
            : Convert.ToString(table.Rows[0]["schema_release"]);
    }

    private async Task<IReadOnlyDictionary<string, OnlineSchemaBackfillSnapshot>> ReadBackfillsAsync(
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(BackfillTableName, cancellationToken).ConfigureAwait(false))
        {
            return new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal);
        }

        DataTable table = await db.Ado.GetDataTableAsync($"""
            SELECT migration_id,
                   status,
                   resume_token,
                   rows_processed,
                   failure_count,
                   updated_at_utc,
                   verified_at_utc,
                   rows_per_second,
                   remaining_rows_estimate
            FROM {QuoteIdentifier(BackfillTableName)}
            ORDER BY migration_id;
            """).ConfigureAwait(false);
        var backfills = new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal);
        foreach (DataRow row in table.Rows)
        {
            string migrationId = Convert.ToString(row["migration_id"]) ?? string.Empty;
            backfills[migrationId] = new OnlineSchemaBackfillSnapshot(
                migrationId,
                Convert.ToString(row["status"]) ?? "unknown",
                row["resume_token"] is DBNull ? null : Convert.ToString(row["resume_token"]),
                Convert.ToInt64(row["rows_processed"]),
                Convert.ToInt64(row["failure_count"]),
                AsUtc(row["updated_at_utc"]),
                row["verified_at_utc"] is DBNull ? null : AsUtc(row["verified_at_utc"]),
                row["rows_per_second"] is DBNull ? null : Convert.ToDouble(row["rows_per_second"]),
                row["remaining_rows_estimate"] is DBNull ? null : Convert.ToInt64(row["remaining_rows_estimate"]));
        }

        return backfills;
    }

    private static DateTimeOffset AsUtc(object value)
    {
        DateTime dateTime = Convert.ToDateTime(value);
        return new DateTimeOffset(DateTime.SpecifyKind(dateTime, DateTimeKind.Utc));
    }

    private static string QuoteIdentifier(string name)
        => $"\"{name.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
}

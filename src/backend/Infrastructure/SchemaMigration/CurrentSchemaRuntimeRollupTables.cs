using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

internal sealed record CurrentSchemaRuntimeRollupTable(string TableName, string CreateSql);

// PostCodeFirst visit-log and author-analytics rollup tables that production
// already has from EnsureTable steps. The Server cannot reference the migration
// assembly, so this catalog owns the same CREATE TABLE SQL and the verifier
// requires the tables instead of leaving them on the optional extra allowlist.
internal static class CurrentSchemaRuntimeRollupTables
{
    internal static IReadOnlyList<CurrentSchemaRuntimeRollupTable> Tables
    {
        get;
    } =
    [
        new(
            "daily_read_stats",
            """
            CREATE TABLE IF NOT EXISTS daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL DEFAULT 0,
                human_verified_reads bigint NOT NULL DEFAULT 0,
                unique_viewer_estimate bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "region_read_stats",
            """
            CREATE TABLE IF NOT EXISTS region_read_stats (
                region varchar(128) PRIMARY KEY,
                read_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "event_type_read_stats",
            """
            CREATE TABLE IF NOT EXISTS event_type_read_stats (
                event_type varchar(32) PRIMARY KEY,
                read_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_daily_read_stats",
            """
            CREATE TABLE IF NOT EXISTS author_daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL DEFAULT 0,
                article_reads bigint NOT NULL DEFAULT 0,
                completed_article_reads bigint NOT NULL DEFAULT 0,
                dwell_ms_total bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_route_stats",
            """
            CREATE TABLE IF NOT EXISTS author_route_stats (
                metric_kind varchar(32) NOT NULL,
                label varchar(128) NOT NULL,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                PRIMARY KEY (metric_kind, label)
            );
            """),
        new(
            "author_rum_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_stats (
                name varchar(64) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                p75 double precision NOT NULL DEFAULT 0,
                average double precision NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_rum_page_type_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_page_type_stats (
                page_type varchar(32) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_rum_aot_source_stats",
            """
            CREATE TABLE IF NOT EXISTS author_rum_aot_source_stats (
                aot_source varchar(32) PRIMARY KEY,
                event_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """),
        new(
            "author_aot_stats",
            """
            CREATE TABLE IF NOT EXISTS author_aot_stats (
                metric_kind varchar(32) PRIMARY KEY,
                event_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
            );
            """)
    ];

    internal static IReadOnlyList<string> TableNames
    {
        get;
    } =
        Tables.Select(static table => table.TableName).ToArray();

    internal static async Task ApplyEnsureTableStepsAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        foreach (CurrentSchemaRuntimeRollupTable table in Tables)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(table.CreateSql).ConfigureAwait(false);
        }
    }
}

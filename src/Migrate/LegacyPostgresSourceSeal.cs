using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private const string PostgresClusterProvenance = "cluster-and-catalog";
    private const string PostgresEndpointProvenance = "catalog-and-endpoint";
    private const int PostgresSourceSealVersion = 1;
    private const int PostgresSourceCatalogLimit = 50_000;

    private sealed record LegacyPostgresSourceSeal(int Version, string Provenance, string DatabaseSha256, string CatalogSha256)
    {
        internal bool IsValid() => Version == PostgresSourceSealVersion &&
            Provenance is PostgresClusterProvenance or PostgresEndpointProvenance &&
            IsSha256(DatabaseSha256) && IsSha256(CatalogSha256);
    }

    private static async Task<LegacyPostgresSourceSeal> SealLegacyPostgresSourceAsync(LegacySource source,
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        long database, schema;
        string databaseName;
        bool mayReadCluster;
        await using (var command = new NpgsqlCommand("""
            SELECT d.oid::bigint,d.datname::text,n.oid::bigint,
                pg_catalog.has_function_privilege('pg_catalog.pg_control_system()', 'EXECUTE')
            FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n
            WHERE d.datname=pg_catalog.current_database() AND n.nspname=$1
            """, connection, transaction) { CommandTimeout = LegacyCommandTimeout })
        {
            command.Parameters.AddWithValue(source.Schema);
            await using var row = await command.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct)) throw new InvalidOperationException("The legacy PostgreSQL database and schema identity are unavailable.");
            (database, databaseName, schema, mayReadCluster) = (row.GetInt64(0), row.GetString(1), row.GetInt64(2), row.GetBoolean(3));
        }

        var provenance = mayReadCluster ? PostgresClusterProvenance : PostgresEndpointProvenance;
        using var identity = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(identity, "fsusblog.v2.legacy-postgres-source.1");
        AppendLegacyValue(identity, provenance);
        AppendLegacyValue(identity, databaseName);
        AppendLegacyValue(identity, database);
        AppendLegacyValue(identity, source.Schema);
        AppendLegacyValue(identity, schema);
        if (mayReadCluster)
            AppendLegacyValue(identity, await ReadLegacyPostgresClusterAsync(connection, transaction, ct));
        else
        {
            AppendLegacyValue(identity, connection.Host);
            AppendLegacyValue(identity, connection.Port);
        }

        return new(PostgresSourceSealVersion, provenance, FinishSourceSeal(identity),
            await DigestLegacyPostgresCatalogAsync(source.Schema, transaction, ct));
    }

    private static async Task<string> DigestLegacyPostgresCatalogAsync(string schema, NpgsqlTransaction transaction, CancellationToken ct)
    {
        // The read transaction uses pg_catalog as its search path, so deparsed names are stable and qualified.
        await using var command = new NpgsqlCommand($"""
            WITH selected AS MATERIALIZED (
                SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')
            ), facts AS (
                SELECT s.relname::text AS relation, 0 AS kind, ''::text AS member, 0 AS ordinal,
                    jsonb_build_array(s.relkind::text,s.relpersistence::text,s.relrowsecurity,s.relforcerowsecurity,s.relispartition,
                        CASE WHEN s.relkind='p' THEN pg_catalog.pg_get_partkeydef(s.oid) END,
                        CASE WHEN s.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(s.oid,false) END)::text AS shape
                FROM selected s
                UNION ALL
                SELECT s.relname::text, 1, '', a.attnum::int,
                    jsonb_build_array(a.attname::text,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
                        a.attidentity::text,a.attgenerated::text,n.nspname::text,c.collname::text,
                        pg_catalog.pg_get_expr(d.adbin,d.adrelid,false))::text
                FROM selected s JOIN pg_catalog.pg_attribute a ON a.attrelid=s.oid
                LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=s.oid AND d.adnum=a.attnum
                LEFT JOIN pg_catalog.pg_collation c ON c.oid=a.attcollation
                LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace
                WHERE a.attnum>0 AND NOT a.attisdropped
                UNION ALL
                SELECT s.relname::text, 2, k.conname::text, 0,
                    jsonb_build_array(k.contype::text,k.convalidated,k.condeferrable,k.condeferred,
                        pg_catalog.pg_get_constraintdef(k.oid,false))::text
                FROM selected s JOIN pg_catalog.pg_constraint k ON k.conrelid=s.oid
                UNION ALL
                SELECT s.relname::text, 3, c.relname::text, 0,
                    jsonb_build_array(i.indisvalid,i.indisready,i.indislive,pg_catalog.pg_get_indexdef(c.oid))::text
                FROM selected s JOIN pg_catalog.pg_index i ON i.indrelid=s.oid
                JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
                UNION ALL
                SELECT s.relname::text, 4, p.relname::text, i.inhseqno,
                    jsonb_build_array(n.nspname::text,pg_catalog.pg_get_expr(s.relpartbound,s.oid,false))::text
                FROM selected s JOIN pg_catalog.pg_inherits i ON i.inhrelid=s.oid
                JOIN pg_catalog.pg_class p ON p.oid=i.inhparent
                JOIN pg_catalog.pg_namespace n ON n.oid=p.relnamespace
                UNION ALL
                SELECT s.relname::text, 5, child.relname::text, i.inhseqno,
                    jsonb_build_array(n.nspname::text,pg_catalog.pg_get_expr(child.relpartbound,child.oid,false))::text
                FROM selected s JOIN pg_catalog.pg_inherits i ON i.inhparent=s.oid
                JOIN pg_catalog.pg_class child ON child.oid=i.inhrelid AND child.relnamespace<>s.relnamespace
                JOIN pg_catalog.pg_namespace n ON n.oid=child.relnamespace
            )
            SELECT relation,kind,member,ordinal,CASE WHEN octet_length(shape)<={MaxLegacyTextBytes} THEN shape END
            FROM facts ORDER BY relation COLLATE "C",kind,member COLLATE "C",ordinal,shape COLLATE "C"
            LIMIT {PostgresSourceCatalogLimit + 1}
            """, transaction.Connection, transaction) { CommandTimeout = LegacyCommandTimeout };
        command.Parameters.AddWithValue(schema);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, "fsusblog.v2.legacy-postgres-catalog.1");
        AppendLegacyValue(digest, schema);
        await using var rows = await command.ExecuteReaderAsync(ct);
        var count = 0;
        while (await rows.ReadAsync(ct))
        {
            if (++count > PostgresSourceCatalogLimit || rows.IsDBNull(4))
                throw new InvalidOperationException("The legacy PostgreSQL catalog exceeds the source seal budget.");
            for (var column = 0; column < rows.FieldCount; column++) AppendLegacyValue(digest, rows.GetValue(column));
        }
        return FinishSourceSeal(digest);
    }

    private static string FinishSourceSeal(IncrementalHash digest) => Convert.ToHexStringLower(digest.GetHashAndReset());
}

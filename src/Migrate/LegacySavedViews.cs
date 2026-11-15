using System.Data.Common;
using System.Globalization;
using Npgsql;

internal static partial class Migration
{
    private const string LegacySavedViewPrefix = "author_saved_view";

    private sealed record SavedViewColumn(string Name, string Type, bool Required);
    private sealed record SavedViewRelation(string Name, CandidateTable Target, SavedViewColumn[] Columns, string[] ForeignKeys);
    private sealed record SavedViewRows(SavedViewRelation Relation, LegacyProjection Projection, object?[][] Values);
    private sealed record LegacySavedViewRead(SavedViewRows[] Relations, ImportFinding? Finding = null)
    {
        internal bool Covers(string name) => Relations.Any(row => row.Relation.Name == name);
    }

    // Fixed v1 20260904-post-author-saved-view. UUID and microsecond UTC coordinates use lossless text
    // in the non-serving staging schema; integer and Boolean values use the shadow's signed integer representation.
    private static readonly SavedViewRelation[] LegacySavedViewRelations =
    [
        SavedView("_collection", "owner_admin_principal_id, site_scope COLLATE BINARY", """
            owner_admin_principal_id:i8 site_scope:v128 revision:i8 default_view_id:u? active_view_count:i4
            last_command_digest:v64 content_digest:v64
            """, ["owner_admin_principal_id:admin_principal:id:c:false:false", "default_view_id:author_saved_view:id:r:true:true"]),
        SavedView("", "id", """
            id:u owner_admin_principal_id:i8 site_scope:v128 schema_version:i4 revision:i8 name:v128 name_key:v256
            query_digest:v64 dependency_digest:v64 sort_field_kind:i2 sort_field_identity:v128 sort_direction:i2
            sort_null_placement:i2 sort_collation:v32 sort_timezone_id:v64? stable_tie_breaker:v128 page_size:i4
            pinned:b order_key:i8 lifecycle_state:i2 created_at_utc:t updated_at_utc:t content_digest:v64
            """, ["owner_admin_principal_id,site_scope:author_saved_view_collection:owner_admin_principal_id,site_scope:c:false:false"]),
        SavedView("_condition", "view_id, condition_index", """
            view_id:u condition_index:i2 field_kind:i2 field_identity:v128 operator_id:v128 timezone_id:v64?
            """, ["view_id:author_saved_view:id:c:false:false"]),
        SavedView("_condition_value", "view_id, condition_index, value_index", """
            view_id:u condition_index:i2 value_index:i2 value:v512
            """, ["view_id,condition_index:author_saved_view_condition:view_id,condition_index:c:false:false"]),
        SavedView("_projection", "view_id, projection_index", """
            view_id:u projection_index:i2 field_kind:i2 field_identity:v128
            """, ["view_id:author_saved_view:id:c:false:false"]),
        SavedView("_receipt", "receipt_id", """
            receipt_id:u request_id:u owner_admin_principal_id:i8 site_scope:v128 view_id:u command_kind:v32 command_digest:v64
            view_revision:i8 previous_collection_revision:i8 collection_revision:i8 query_digest:v64 dependency_digest:v64
            pinned:b previous_default_view_id:u? default_view_id:u? previous_active_view_count:i4 active_view_count:i4
            order_key:i8 lifecycle_state:i2 default_transition:i2 change_count:i4 changes_digest:v64 reason_code:v64
            content_digest:v64 occurred_at_utc:t
            """, []),
        SavedView("_receipt_change", "receipt_id, change_index", """
            receipt_id:u change_index:i4 view_id:u change_kind:i2 before_revision:i8? before_name:v128?
            before_query_digest:v64? before_dependency_digest:v64? before_pinned:b? before_order_key:i8?
            before_lifecycle_state:i2? before_content_digest:v64? after_revision:i8 after_name:v128 after_query_digest:v64
            after_dependency_digest:v64 after_pinned:b after_order_key:i8 after_lifecycle_state:i2 after_content_digest:v64 content_digest:v64
            """, ["receipt_id:author_saved_view_receipt:receipt_id:r:false:false"]),
        SavedView("_idempotency", "owner_admin_principal_id, site_scope COLLATE BINARY, request_id", """
            owner_admin_principal_id:i8 site_scope:v128 request_id:u receipt_id:u command_digest:v64 created_at_utc:t
            """, ["receipt_id:author_saved_view_receipt:receipt_id:r:false:false"]),
    ];

    private static SavedViewRelation SavedView(string suffix, string key, string shape, string[] foreignKeys)
    {
        var name = LegacySavedViewPrefix + suffix;
        var columns = shape.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Select(entry =>
        {
            var pair = entry.Split(':');
            return new SavedViewColumn(pair[0], pair[1].TrimEnd('?'), !pair[1].EndsWith('?'));
        }).ToArray();
        var target = new CandidateTable("shadow_" + name, 3, key, columns.Select(column => new CandidateColumn(column.Name,
            column.Type is "i8" or "i4" or "i2" or "b" ? "INTEGER" : "TEXT")).ToArray(),
            NonNull: columns.Where(column => column.Required).Select(column => column.Name).ToArray());
        return new(name, target, columns, foreignKeys);
    }

    private static string SavedViewPostgresType(string code) => code switch
    {
        "i8" => "bigint", "i4" => "integer", "i2" => "smallint", "b" => "boolean",
        "u" => "uuid", "t" => "timestamp without time zone", _ => $"character varying({code[1..]})",
    };

    private static async Task<LegacySavedViewRead> ReadLegacySavedViewsAsync(LegacySource source, DbTransaction tx,
        LegacyTable[] catalog, LegacyTable principal, CancellationToken ct)
    {
        if (tx is not NpgsqlTransaction postgres) return new([]);
        var observed = catalog.Where(table => LegacySavedViewRelations.Any(spec =>
            string.Equals(table.Name, spec.Name, StringComparison.OrdinalIgnoreCase))).ToArray();
        if (observed.Length == 0) return new([]);
        LegacySavedViewRead Refuse(string problem, string relation, long count = 1) => new([], new("legacy-saved-views-" + problem, relation, count));
        if (observed.Length != LegacySavedViewRelations.Length || principal.Name != "admin_principal" || !principal.Columns.Contains(new("id", "bigint")))
            return Refuse("catalog", LegacySavedViewPrefix);

        foreach (var relation in LegacySavedViewRelations)
        {
            var table = observed.SingleOrDefault(item => item.Name == relation.Name);
            if (table is null || table.Kind != "r" || !table.Columns.SequenceEqual(relation.Columns.Select(column =>
                    new LegacyField(column.Name, SavedViewPostgresType(column.Type)))) ||
                !await HasSavedViewKeysAsync(postgres, source.Schema, relation.Name, relation.Target, relation.ForeignKeys, ct))
                return Refuse("catalog", relation.Name);
        }

        var results = new List<SavedViewRows>(LegacySavedViewRelations.Length);
        long textBytes = 0;
        foreach (var relation in LegacySavedViewRelations)
        {
            var fields = string.Join(',', relation.Columns.Select(column => column.Type == "t"
                ? $"CASE WHEN {column.Name} BETWEEN TIMESTAMP '0001-01-01' AND TIMESTAMP '9999-12-31 23:59:59.999999' THEN {column.Name} END"
                : source.Quote(column.Name)));
            await using var command = CreateLegacyCommand(tx,
                $"SELECT {fields} FROM {source.Quote(source.Schema)}.{relation.Name} ORDER BY {KeyForPostgres(relation.Target)} LIMIT {RehearsalLimit + 1}");
            await using var read = await command.ExecuteReaderAsync(ct);
            using var digest = LegacyShadowDigest(relation.Name, relation.Columns.Select(column => column.Name));
            var values = new List<object?[]>();
            while (await read.ReadAsync(ct))
            {
                if (values.Count == RehearsalLimit) return Refuse("budget", relation.Name, RehearsalLimit + 1);
                var row = new object?[relation.Columns.Length];
                for (var index = 0; index < row.Length; index++)
                {
                    var column = relation.Columns[index];
                    if (read.IsDBNull(index) && column.Required) return Refuse("values", relation.Name);
                    row[index] = read.IsDBNull(index) ? null : column.Type switch
                    {
                        "u" => read.GetGuid(index).ToString("D"),
                        "t" => DateTime.SpecifyKind(read.GetDateTime(index), DateTimeKind.Unspecified).ToString("O", CultureInfo.InvariantCulture),
                        "b" => read.GetBoolean(index) ? 1L : 0L,
                        "i8" or "i4" or "i2" => Convert.ToInt64(read.GetValue(index), CultureInfo.InvariantCulture),
                        _ => read.GetString(index),
                    };
                    if (row[index] is string text) textBytes += StrictUtf8.GetByteCount(text);
                    if (textBytes > RehearsalTextBytes) return Refuse("budget", relation.Name, values.Count + 1);
                    AppendLegacyValue(digest, row[index]);
                }
                values.Add(row);
            }
            results.Add(new(relation, new(relation.Name, values.Count, FinishSourceSeal(digest)), values.ToArray()));
        }
        if (results.All(table => table.Values.Length == 0)) return new([]);
        if (!await VerifySavedViewGraphAsync(source, postgres, principal, ct)) return Refuse("graph", LegacySavedViewPrefix);
        var canonical = VerifyLegacySavedViewDigests(results.ToDictionary(table => table.Relation.Name, table => table.Values, StringComparer.Ordinal));
        if (canonical.Finding is { } finding) return new([], finding);
        return new(results.ToArray());
    }

    private static async Task<bool> HasSavedViewKeysAsync(NpgsqlTransaction tx, string schema, string name, CandidateTable table,
        string[] foreignKeys, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relispartition
                AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
                AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C")
                    FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull)=$3
                AND EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p'
                    AND k.convalidated AND NOT k.condeferrable AND ARRAY(SELECT a.attname::text
                    FROM unnest(k.conkey) WITH ORDINALITY v(attnum,position) JOIN pg_catalog.pg_attribute a
                    ON a.attrelid=k.conrelid AND a.attnum=v.attnum ORDER BY v.position)=$4)
                AND NOT EXISTS (SELECT FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f'
                    AND (NOT k.convalidated OR k.confmatchtype<>'s' OR k.confupdtype<>'a' OR NOT EXISTS (SELECT
                    FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace rn ON rn.oid=r.relnamespace
                    WHERE r.oid=k.confrelid AND rn.nspname=$1 AND (
                        (SELECT string_agg(a.attname::text,',' ORDER BY v.position)
                         FROM unnest(k.conkey) WITH ORDINALITY v(attnum,position) JOIN pg_catalog.pg_attribute a
                         ON a.attrelid=k.conrelid AND a.attnum=v.attnum) || ':' || r.relname::text || ':' ||
                        (SELECT string_agg(a.attname::text,',' ORDER BY v.position)
                         FROM unnest(k.confkey) WITH ORDINALITY v(attnum,position) JOIN pg_catalog.pg_attribute a
                         ON a.attrelid=k.confrelid AND a.attnum=v.attnum) || ':' || k.confdeltype::text || ':' ||
                         k.condeferrable::text || ':' || k.condeferred::text)=ANY($5))))
                AND (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f')=cardinality($5)
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r'
            """, tx.Connection, tx) { CommandTimeout = LegacyCommandTimeout };
        command.Parameters.AddWithValue(schema);
        command.Parameters.AddWithValue(name);
        command.Parameters.AddWithValue(table.NonNull!.Order(StringComparer.Ordinal).ToArray());
        command.Parameters.AddWithValue(table.Key.Replace(" COLLATE BINARY", "", StringComparison.Ordinal).Split(", ", StringSplitOptions.None));
        command.Parameters.AddWithValue(foreignKeys);
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static async Task<bool> VerifySavedViewGraphAsync(LegacySource source, NpgsqlTransaction tx, LegacyTable principal, CancellationToken ct)
    {
        var schema = source.Quote(source.Schema);
        await using var command = CreateLegacyCommand(tx, $"""
            WITH collections AS (SELECT * FROM {schema}.author_saved_view_collection),
                 views AS (SELECT * FROM {schema}.author_saved_view),
                 receipts AS (SELECT * FROM {schema}.author_saved_view_receipt),
                 changes AS (SELECT * FROM {schema}.author_saved_view_receipt_change),
                 ids AS (SELECT * FROM {schema}.author_saved_view_idempotency)
            SELECT NOT EXISTS (SELECT FROM collections c WHERE c.owner_admin_principal_id<=0 OR c.site_scope='' OR c.revision<0
                OR c.active_view_count<>(SELECT count(*) FROM views v WHERE (v.owner_admin_principal_id,v.site_scope)=(c.owner_admin_principal_id,c.site_scope)
                    AND v.lifecycle_state=0)
                OR (c.default_view_id IS NOT NULL AND NOT EXISTS (SELECT FROM views v WHERE v.id=c.default_view_id
                    AND (v.owner_admin_principal_id,v.site_scope)=(c.owner_admin_principal_id,c.site_scope) AND v.lifecycle_state=0))
                OR c.revision<>(SELECT count(*) FROM receipts r WHERE (r.owner_admin_principal_id,r.site_scope)=(c.owner_admin_principal_id,c.site_scope)))
            AND NOT EXISTS (SELECT FROM views WHERE schema_version<>1 OR lifecycle_state NOT IN (0,1) OR revision<=0
                OR (pinned AND (order_key<=0 OR lifecycle_state<>0)) OR (NOT pinned AND order_key<>0))
            AND NOT EXISTS (SELECT FROM receipts r WHERE r.owner_admin_principal_id<=0 OR r.collection_revision<=0
                OR r.previous_collection_revision<>r.collection_revision-1
                OR NOT EXISTS (SELECT FROM collections c WHERE (c.owner_admin_principal_id,c.site_scope)=(r.owner_admin_principal_id,r.site_scope)
                    AND r.collection_revision<=c.revision)
                OR NOT EXISTS (SELECT FROM {source.Table(principal)} p WHERE p.{source.Field(principal, "id")}=r.owner_admin_principal_id)
                OR r.change_count<>(SELECT count(*) FROM changes ch WHERE ch.receipt_id=r.receipt_id)
                OR NOT EXISTS (SELECT FROM ids i WHERE (i.owner_admin_principal_id,i.site_scope,i.request_id,i.receipt_id,i.command_digest)
                    =(r.owner_admin_principal_id,r.site_scope,r.request_id,r.receipt_id,r.command_digest)))
            AND NOT EXISTS (SELECT 1 FROM receipts GROUP BY owner_admin_principal_id,site_scope,collection_revision HAVING count(*)<>1)
            AND NOT EXISTS (SELECT FROM ids i JOIN receipts r ON r.receipt_id=i.receipt_id
                WHERE (i.owner_admin_principal_id,i.site_scope,i.request_id,i.command_digest)
                    IS DISTINCT FROM (r.owner_admin_principal_id,r.site_scope,r.request_id,r.command_digest))
            """);
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static CandidateTable[] LegacySavedViewDefinitions(ImportPlan plan)
    {
        if (plan.SourceProjections is null || plan.ExpectedTables is null)
            throw new InvalidOperationException("The legacy import plan does not define its custody projections.");
        var knownSources = LegacySavedViewRelations.Select(relation => relation.Name).ToHashSet(StringComparer.Ordinal);
        var knownTargets = LegacySavedViewRelations.Select(relation => relation.Target.Name).ToHashSet(StringComparer.Ordinal);
        var sources = plan.SourceProjections.Where(projection => knownSources.Contains(projection.Table)).ToArray();
        var targets = plan.ExpectedTables.Where(table => knownTargets.Contains(table.Table)).ToArray();
        if (sources.Length == 0 && targets.Length == 0) return [];
        if (plan.Provider != "postgres" || plan.SourceSeal is null || sources.Length != knownSources.Count || targets.Length != knownTargets.Count ||
            sources.Select(row => row.Table).ToHashSet().Count != knownSources.Count || targets.Select(row => row.Table).ToHashSet().Count != knownTargets.Count ||
            !sources.Any(row => row.Rows > 0) || sources.Any(row => row.Rows is < 0 or > RehearsalLimit || !IsSha256(row.Sha256) ||
                !targets.Any(target => target.Table == "shadow_" + row.Table && target.Rows == row.Rows && IsSha256(target.Sha256))))
            throw new InvalidOperationException("The legacy saved-view custody plan is incomplete.");
        return LegacySavedViewRelations.Select(relation => relation.Target).ToArray();
    }

    private static async Task WriteLegacySavedViewsAsync(DbTransaction tx, SavedViewRows[] relations, CancellationToken ct)
    {
        foreach (var source in relations)
        {
            var table = source.Relation.Target;
            await WriteLegacyShadowRowsAsync(tx, table,
                $"CREATE TABLE {table.Name} ({LegacyShadowColumns(table)}, PRIMARY KEY ({table.Key})) STRICT", source.Values, ct);
        }
    }

    private static async Task<ShadowCount[]> VerifyLegacySavedViewsAsync(DbTransaction tx, SavedViewRows[] relations, CancellationToken ct)
    {
        var observed = new List<ShadowCount>();
        foreach (var source in relations)
        {
            var table = source.Relation.Target;
            var names = table.Columns.Select(column => column.Name);
            using var digest = LegacyShadowDigest(table.Name, names);
            using var original = LegacyShadowDigest(source.Relation.Name, names);
            var count = await ReadLegacyShadowDigestAsync(tx, table, digest, ct, original);
            if (count != source.Projection.Rows || FinishSourceSeal(original) != source.Projection.Sha256)
                throw new InvalidOperationException("The saved-view shadow rows differ from the measured source.");
            observed.Add(new(table.Name, count, FinishSourceSeal(digest)));
        }
        return observed.ToArray();
    }
}

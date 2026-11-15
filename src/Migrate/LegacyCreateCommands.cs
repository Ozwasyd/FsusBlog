using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

internal static partial class Migration
{
    private const string LegacyCreateCommandSource = "article_mutation_command";
    private static readonly CandidateTable LegacyCreateCommandShadow = Candidate("shadow_article_mutation_command", 3, "id", """
        id admin_principal_id client_mutation_id:text request_hash:text article_id revision_id revision_no
        release_id release_no status rights_snapshot_id rights_revision_no created_at_utc:text
        """);

    private static readonly string[] LegacyCreateCommandPostgresTypes =
    [
        "bigint", "bigint", "character varying(36)", "character varying(64)", "integer", "bigint", "integer",
        "bigint", "integer", "integer", "bigint", "integer", "timestamp without time zone"
    ];

    private sealed record LegacyCreateCommand(long Id, long AdminId, string ClientId, string RequestHash, int ArticleId,
        long RevisionId, int Revision, long ReleaseId, int Release, int Status, long RightsId, int RightsRevision, string Created);
    private sealed record LegacyCreateCommandRead(LegacyTable? Relation = null, LegacyProjection? Projection = null,
        LegacyCreateCommand[]? Rows = null, ImportFinding? Finding = null);

    private static async Task<LegacyCreateCommandRead> ReadLegacyCreateCommandsAsync(LegacySource source, DbTransaction tx,
        LegacyTable[] catalog, Dictionary<string, LegacyTable> tables, LegacyTable admins, CancellationToken ct)
    {
        if (source.Provider != "postgres" || catalog.Where(table => table.Name.Equals(LegacyCreateCommandSource,
                StringComparison.OrdinalIgnoreCase)).ToArray() is not [var relation] ||
            relation.Kind != "r" || relation.Name != LegacyCreateCommandSource)
            return new LegacyCreateCommandRead(); // The standard intake reports missing provider authority or unsupported non-empty shapes.

        var columns = LegacyCreateCommandShadow.Columns;
        var expected = columns.Zip(LegacyCreateCommandPostgresTypes, (column, type) => new LegacyField(column.Name, type));
        var supported = relation.Columns.ToHashSet().SetEquals(expected);
        if (!supported || !await HasLegacyCreateCommandCatalogAsync(tx, source.Schema, relation.Name, ct))
            return new LegacyCreateCommandRead();

        string C(string name) => "c." + source.Field(relation, name);
        string Field(string table, string alias, string name) => alias + "." + source.Field(tables[table], name);
        string actualFields = string.Join(',', columns.Select(column => C(column.Name)));
        await using var read = CreateLegacyCommand(tx, $"""
            SELECT {actualFields}, (
                {C("created_at_utc")} BETWEEN TIMESTAMP '0001-01-01 00:00:00' AND TIMESTAMP '9999-12-31 23:59:59.999999'
                AND p.{source.Field(admins, "id")} IS NOT NULL
                AND {Field(Article, "a", "createtime")}={C("created_at_utc")}
                AND {Field(Revision, "r", "created_at")}={C("created_at_utc")}
                AND {Field(Revision, "r", "created_by_admin_principal_id")}={C("admin_principal_id")}
                AND {Field(RightsSnapshot, "s", "created_at")}={C("created_at_utc")}
                AND CASE WHEN {C("status")}=2 THEN {Field(Publication, "released", "id")} IS NOT NULL
                    AND {Field(Publication, "released", "transition_kind")}='immediate-publish'
                    AND {Field(Publication, "released", "created_at")}={C("created_at_utc")}
                    AND {Field(Publication, "released", "published_at")}={C("created_at_utc")}
                    ELSE true END
                ) AS exact_create_coordinates
            FROM {source.Table(relation)} c
            LEFT JOIN {source.Table(admins)} p ON p.{source.Field(admins, "id")}={C("admin_principal_id")}
            LEFT JOIN {source.Table(tables[Article])} a ON {Field(Article, "a", "id")}={C("article_id")}
            LEFT JOIN {source.Table(tables[Revision])} r ON {Field(Revision, "r", "id")}={C("revision_id")}
                AND {Field(Revision, "r", "article_id")}={C("article_id")} AND {Field(Revision, "r", "revision_no")}={C("revision_no")}
            LEFT JOIN {source.Table(tables[RightsSnapshot])} s ON {Field(RightsSnapshot, "s", "id")}={C("rights_snapshot_id")}
                AND {Field(RightsSnapshot, "s", "article_id")}={C("article_id")}
                AND {Field(RightsSnapshot, "s", "article_revision_id")}={C("revision_id")}
                AND {Field(RightsSnapshot, "s", "revision_no")}={C("rights_revision_no")}
            LEFT JOIN {source.Table(tables[Publication])} released ON {Field(Publication, "released", "id")}={C("release_id")}
                AND {Field(Publication, "released", "article_id")}={C("article_id")}
                AND {Field(Publication, "released", "article_revision_id")}={C("revision_id")}
                AND {Field(Publication, "released", "revision_no")}={C("revision_no")}
                AND {Field(Publication, "released", "publication_no")}={C("release_no")}
                AND {Field(Publication, "released", "rights_snapshot_id")}={C("rights_snapshot_id")}
            ORDER BY {C("id")} LIMIT {RehearsalLimit + 1}
            """);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(hash, LegacyCreateCommandSource);
        foreach (var column in columns) AppendLegacyValue(hash, column.Name);
        await using var reader = await read.ExecuteReaderAsync(ct);
        var rows = new List<LegacyCreateCommand>();
        var ids = new HashSet<long>();
        var requests = new HashSet<(long, string)>();
        int invalid = 0;
        int observed = 0;
        while (await reader.ReadAsync(ct))
        {
            if (++observed > RehearsalLimit)
                throw new InvalidOperationException($"The legacy create command projection exceeds its {RehearsalLimit}-row limit.");
            if (Enumerable.Range(0, columns.Length + 1).Any(reader.IsDBNull) || !reader.GetBoolean(columns.Length))
            {
                invalid++;
                continue;
            }
            var created = DateTime.SpecifyKind(reader.GetDateTime(12), DateTimeKind.Unspecified);
            var row = new LegacyCreateCommand(reader.GetInt64(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3),
                reader.GetInt32(4), reader.GetInt64(5), reader.GetInt32(6), reader.GetInt64(7), reader.GetInt32(8),
                reader.GetInt32(9), reader.GetInt64(10), reader.GetInt32(11), created.ToString("O", CultureInfo.InvariantCulture));
            if (!ValidLegacyCreateCommand(row) || !ids.Add(row.Id) || !requests.Add((row.AdminId, row.ClientId)))
            {
                invalid++;
                continue;
            }
            foreach (var value in LegacyCreateCommandValues(row)) AppendLegacyValue(hash, value);
            rows.Add(row);
        }
        if (invalid > 0)
            return new LegacyCreateCommandRead(relation, Finding: new ImportFinding("legacy-create-command", relation.Name, invalid));
        if (rows.Count == 0) return new LegacyCreateCommandRead(relation);
        var projection = new LegacyProjection(relation.Name, rows.Count, Convert.ToHexStringLower(hash.GetHashAndReset()));
        return new LegacyCreateCommandRead(relation, projection, rows.ToArray());
    }

    private static bool ValidLegacyCreateCommand(LegacyCreateCommand row) => row.Id > 0 && row.AdminId > 0 && row.ArticleId > 0 &&
        row.RevisionId > 0 && row.RightsId > 0 && row.Revision == 1 && row.RightsRevision == 1 &&
        (row.Status switch { 2 => row.ReleaseId > 0 && row.Release == 1, 0 or 1 or 3 => row.ReleaseId == 0 && row.Release == 0, _ => false }) &&
        Guid.TryParseExact(row.ClientId, "D", out var requested) && requested.ToString("D") == row.ClientId &&
        row.RequestHash.Length == 64 && row.RequestHash.All(char.IsAsciiHexDigitUpper);

    private static bool HasCompleteLegacyCommandPlan(ImportPlan plan) =>
        plan.SourceProjections?.Where(row => row.Table == LegacyCreateCommandSource).ToArray() is [var source] &&
        plan.ExpectedTables?.Where(row => row.Table == LegacyCreateCommandShadow.Name).ToArray() is [var target] &&
        source.Rows is >= 1 and <= RehearsalLimit && source.Rows == target.Rows && IsSha256(source.Sha256) && IsSha256(target.Sha256);

    private static async Task<bool> HasLegacyCreateCommandCatalogAsync(DbTransaction tx, string schema, string table, CancellationToken ct)
    {
        await using var query = CreateLegacyCommand(tx, """
            SELECT (SELECT count(*)=13 AND bool_and(a.attnotnull) FROM pg_catalog.pg_attribute a
                WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
                AND (SELECT count(DISTINCT indexed.signature)=2 FROM (
                    SELECT i.indisprimary, array_agg(a.attname::text ORDER BY k.ordinality) AS signature
                    FROM pg_catalog.pg_index i
                    CROSS JOIN LATERAL pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality)
                    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
                    WHERE i.indrelid=c.oid AND i.indisvalid AND i.indisunique AND i.indimmediate
                        AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=i.indnatts
                    GROUP BY i.indexrelid,i.indisprimary
                    ) indexed WHERE (indexed.indisprimary AND indexed.signature=ARRAY['id'])
                        OR (NOT indexed.indisprimary AND indexed.signature=ARRAY['admin_principal_id','client_mutation_id']))
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=@schema AND c.relname=@table AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity
            """);
        foreach (var (name, value) in new[] { ("schema", schema), ("table", table) })
        {
            var parameter = query.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            query.Parameters.Add(parameter);
        }
        return await query.ExecuteScalarAsync(ct) is true;
    }

    private static object[] LegacyCreateCommandValues(LegacyCreateCommand row) =>
    [
        row.Id, row.AdminId, row.ClientId, row.RequestHash, row.ArticleId, row.RevisionId, row.Revision,
        row.ReleaseId, row.Release, row.Status, row.RightsId, row.RightsRevision, row.Created
    ];

    private static async Task WriteLegacyCreateCommandShadowAsync(DbTransaction tx, LegacyCreateCommand[] rows, CancellationToken ct)
    {
        var table = LegacyCreateCommandShadow;
        var fields = string.Join(',', table.Columns.Select(column => $"{column.Name} {column.Kind} NOT NULL"));
        await using (var create = CreateLegacyCommand(tx, $"""
            CREATE TABLE {table.Name} ({fields}, PRIMARY KEY (id), UNIQUE (admin_principal_id,client_mutation_id)) STRICT
            """)) await create.ExecuteNonQueryAsync(ct);
        var parameters = table.Columns.Select(column => "@" + column.Name).ToArray();
        await using var insert = CreateLegacyCommand(tx, $"INSERT INTO {table.Name} VALUES ({string.Join(',', parameters)})");
        foreach (var name in parameters)
        {
            var parameter = insert.CreateParameter();
            parameter.ParameterName = name;
            insert.Parameters.Add(parameter);
        }
        foreach (var row in rows)
        {
            var values = LegacyCreateCommandValues(row);
            for (int field = 0; field < values.Length; field++) insert.Parameters[field].Value = values[field];
            await insert.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task<ShadowCount> VerifyLegacyCreateCommandShadowAsync(DbTransaction tx, LegacyCreateCommand[] rows,
        CancellationToken ct)
    {
        var table = LegacyCreateCommandShadow;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(hash, table.Name);
        foreach (var field in table.Columns) AppendLegacyValue(hash, field.Name);
        await using var read = CreateLegacyCommand(tx, $"SELECT * FROM {table.Name} ORDER BY id");
        await using var reader = await read.ExecuteReaderAsync(ct);
        foreach (var row in rows)
        {
            if (!await reader.ReadAsync(ct)) throw new InvalidOperationException("Legacy create command shadow rows are missing.");
            var values = LegacyCreateCommandValues(row);
            for (int field = 0; field < values.Length; field++)
            {
                object observed = reader.GetValue(field);
                object wanted = values[field] is int narrow ? (long)narrow : values[field];
                if (!observed.Equals(wanted)) throw new InvalidOperationException("A legacy create command shadow value changed.");
                AppendLegacyValue(hash, observed);
            }
        }
        if (await reader.ReadAsync(ct)) throw new InvalidOperationException("Legacy create command shadow has additional rows.");
        return new ShadowCount(table.Name, rows.Length, Convert.ToHexStringLower(hash.GetHashAndReset()));
    }
}

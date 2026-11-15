using System.Data.Common;
using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyCategoryCounts = "category_public_article_count";
    private const string LegacyTagCounts = "tag_public_article_count";
    private const string LegacyArticleTaxonomy = "article_public_taxonomy_projection";

    private sealed record TaxonomySourceRelation(string Name, string Key, LegacyField[] Fields);
    private sealed record LegacyTaxonomyEvidence(string Status, LegacyProjection[] Projections, ImportFinding[] Findings)
    {
        internal bool Covers(string name) => Projections.Any(row => row.Table == name);
    }

    private static readonly TaxonomySourceRelation[] LegacyTaxonomyRelations =
    [
        new(LegacyCategoryCounts, "category_id", [new("category_id", "integer"), new("article_count", "bigint"), new("updated_at_utc", "timestamp without time zone")]),
        new(LegacyTagCounts, "tag_id", [new("tag_id", "integer"), new("article_count", "bigint"), new("updated_at_utc", "timestamp without time zone")]),
        new(LegacyArticleTaxonomy, "article_id", [new("article_id", "integer"), new("category_id", "integer"), new("tag_ids", "text"), new("updated_at_utc", "timestamp without time zone")]),
    ];

    private static bool IsLegacyTaxonomyRelation(string name) => LegacyTaxonomyRelations.Any(row => row.Name == name);

    private static async Task<LegacyTaxonomyEvidence> VerifyLegacyTaxonomyAsync(LegacySource source, DbTransaction transaction,
        LegacyTable[] catalog, IReadOnlyDictionary<string, LegacyTable> articles, LegacyAudit audit, CancellationToken ct)
    {
        if (source.Provider != "postgres") return new("not-applicable", [], []);
        var present = LegacyTaxonomyRelations.Select(definition => catalog.Where(table =>
            table.Name.Equals(definition.Name, StringComparison.OrdinalIgnoreCase)).ToArray()).ToArray();
        if (present.All(matches => matches.Length == 0)) return new("absent", [], []);

        var verified = new Dictionary<string, LegacyTable>(StringComparer.Ordinal);
        var findings = new List<ImportFinding>();
        for (var index = 0; index < LegacyTaxonomyRelations.Length; index++)
        {
            var definition = LegacyTaxonomyRelations[index];
            if (present[index] is not [var table] || table.Name != definition.Name || table.Kind != "r" ||
                !table.Columns.ToHashSet().SetEquals(definition.Fields) ||
                !await HasLegacyTaxonomyCatalogAsync((NpgsqlTransaction)transaction, source.Schema, definition, ct))
            {
                findings.Add(new("legacy-taxonomy-catalog", definition.Name, 1));
                continue;
            }
            verified.Add(definition.Name, table);
        }
        if (findings.Count != 0) return new("invalid", [], findings.ToArray());
        var oversized = audit.Projections.Where(row => row.Rows > RehearsalLimit && row.Table is (Article or ArticleTag or Category or Tag))
            .Select(row => new ImportFinding("legacy-taxonomy-budget", row.Table, row.Rows)).ToArray();
        if (oversized.Length != 0) return new("invalid", [], oversized);

        var projections = new List<LegacyProjection>();
        foreach (var shape in LegacyTaxonomyRelations)
        {
            var (projection, finding) = await MeasureLegacyTaxonomyAsync(source, transaction, verified[shape.Name], shape, ct);
            if (finding is not null) findings.Add(finding);
            else projections.Add(projection!);
        }
        if (findings.Count != 0) return new("invalid", [], findings.ToArray());

        findings.AddRange(await CompareLegacyTaxonomyAsync(source, transaction, articles, verified, ct));
        return findings.Count != 0 ? new("invalid", [], findings.ToArray()) :
            new(projections.All(row => row.Rows == 0) ? "verified-empty" : "verified", projections.ToArray(), []);
    }

    private static async Task<bool> HasLegacyTaxonomyCatalogAsync(NpgsqlTransaction tx, string schema, TaxonomySourceRelation definition,
        CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT c.relpersistence='p' AND NOT c.relispartition
               AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
               AND EXISTS (
                   SELECT FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=$3
                   WHERE k.conrelid=c.oid AND k.contype='p' AND k.convalidated AND k.conkey=ARRAY[a.attnum])
               AND ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
                         ORDER BY a.attname::text COLLATE "C")=$4
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relname=$2
            """, tx.Connection, tx);
        command.Parameters.AddWithValue(schema);
        command.Parameters.AddWithValue(definition.Name);
        command.Parameters.AddWithValue(definition.Key);
        command.Parameters.AddWithValue(definition.Fields.Select(field => field.Name)
            .Where(name => definition.Name != LegacyArticleTaxonomy || name != "category_id").Order(StringComparer.Ordinal).ToArray());
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static async Task<(LegacyProjection? Projection, ImportFinding? Finding)> MeasureLegacyTaxonomyAsync(
        LegacySource source, DbTransaction tx, LegacyTable table, TaxonomySourceRelation shape, CancellationToken ct)
    {
        var columns = shape.Fields.Select(field => field.Name == "tag_ids"
            ? $"CASE WHEN octet_length(tag_ids)<={MaxLegacyTextBytes} THEN tag_ids END"
            : source.Field(table, field.Name));
        var time = source.Field(table, "updated_at_utc");
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {string.Join(',', columns)},
                   {time} BETWEEN TIMESTAMP '0001-01-01 00:00:00' AND TIMESTAMP '9999-12-31 23:59:59.999999'
            FROM {source.Table(table)} ORDER BY {source.Field(table, shape.Key)} LIMIT {RehearsalLimit + 1}
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, "fsusblog.v2.legacy-taxonomy.1");
        AppendLegacyValue(digest, shape.Name);
        foreach (var field in shape.Fields)
        {
            AppendLegacyValue(digest, field.Name);
            AppendLegacyValue(digest, field.Type);
        }
        long count = 0;
        while (await rows.ReadAsync(ct))
        {
            if (++count > RehearsalLimit) return (null, new("legacy-taxonomy-budget", shape.Name, count));
            if (!rows.GetBoolean(shape.Fields.Length)) return (null, new("legacy-taxonomy-timestamp", shape.Name, 1));
            if (shape.Name == LegacyArticleTaxonomy && rows.IsDBNull(2))
                return (null, new("legacy-taxonomy-budget", shape.Name, 1));
            for (var index = 0; index < shape.Fields.Length; index++)
                AppendLegacyValue(digest, rows.IsDBNull(index) ? null : rows.GetValue(index));
        }
        return (new(shape.Name, count, Convert.ToHexStringLower(digest.GetHashAndReset())), null);
    }

    private static async Task<ImportFinding[]> CompareLegacyTaxonomyAsync(LegacySource source, DbTransaction tx,
        IReadOnlyDictionary<string, LegacyTable> articles, IReadOnlyDictionary<string, LegacyTable> observed, CancellationToken ct)
    {
        string Table(string key) => source.Table(articles[key]);
        string Column(string key, string field) => source.Field(articles[key], field);
        string Derived(string name) => source.Table(observed[name]);
        await using var query = CreateLegacyCommand(tx, $"""
            WITH visible AS (
                SELECT a.{Column(Article, "id")} AS article_id,a.{Column(Article, "categoryid")} AS category_id
                FROM {Table(Article)} a
                WHERE a.{Column(Article, "status")}=2 AND NOT a.{Column(Article, "isdeleted")}
                  AND (a.{Column(Article, "published_at")} IS NULL OR a.{Column(Article, "published_at")}<=(transaction_timestamp() AT TIME ZONE 'UTC'))
                  AND (a.{Column(Article, "scheduled_publish_at")} IS NULL OR a.{Column(Article, "scheduled_publish_at")}<=(transaction_timestamp() AT TIME ZONE 'UTC'))
            ), memberships AS (
                SELECT v.article_id,t.{Column(ArticleTag, "tagid")} AS tag_id
                FROM visible v JOIN {Table(ArticleTag)} t ON t.{Column(ArticleTag, "articleid")}=v.article_id
            ), expected_articles AS (
                SELECT v.article_id,v.category_id,COALESCE(string_agg(m.tag_id::text,',' ORDER BY m.tag_id),'') AS tag_ids
                FROM visible v LEFT JOIN memberships m USING (article_id) GROUP BY v.article_id,v.category_id
            ), expected_categories AS (
                SELECT category_id,count(*) AS article_count FROM visible WHERE category_id>0 GROUP BY category_id
            ), expected_tags AS (
                SELECT tag_id,count(*) AS article_count FROM memberships GROUP BY tag_id
            )
            SELECT
                (SELECT count(*) FROM visible WHERE category_id IS NULL OR category_id<=0),
                (SELECT count(*) FROM expected_articles e FULL JOIN {Derived(LegacyArticleTaxonomy)} a USING (article_id)
                 WHERE e.article_id IS NULL OR a.article_id IS NULL OR (e.category_id,e.tag_ids) IS DISTINCT FROM (a.category_id,a.tag_ids)),
                (SELECT count(*) FROM expected_categories e FULL JOIN {Derived(LegacyCategoryCounts)} a USING (category_id)
                 WHERE a.category_id IS NULL OR a.article_count IS DISTINCT FROM COALESCE(e.article_count,0)
                    OR NOT EXISTS (SELECT FROM {Table(Category)} c WHERE c.{Column(Category, "id")}=a.category_id)),
                (SELECT count(*) FROM expected_tags e FULL JOIN {Derived(LegacyTagCounts)} a USING (tag_id)
                 WHERE a.tag_id IS NULL OR a.article_count IS DISTINCT FROM COALESCE(e.article_count,0)
                    OR NOT EXISTS (SELECT FROM {Table(Tag)} t WHERE t.{Column(Tag, "id")}=a.tag_id))
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        if (!await rows.ReadAsync(ct)) throw new InvalidOperationException("The native legacy taxonomy comparison did not produce a result.");
        (string Category, string Table)[] comparisons =
        [
            ("legacy-taxonomy-category-domain", Article), ("legacy-taxonomy-projection", LegacyArticleTaxonomy),
            ("legacy-taxonomy-count", LegacyCategoryCounts), ("legacy-taxonomy-count", LegacyTagCounts),
        ];
        var findings = new List<ImportFinding>();
        for (var index = 0; index < comparisons.Length; index++)
        {
            var (category, table) = comparisons[index];
            var count = rows.GetInt64(index);
            if (count != 0) findings.Add(new(category, table, count));
        }
        return findings.ToArray();
    }
}

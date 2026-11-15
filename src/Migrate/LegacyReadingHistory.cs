using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyArticleViews = "article.views";
    private const string LegacyViewSeed = "article_view_seed";
    private static readonly CandidateTable LegacyReadingHistoryShadow = Candidate(
        "shadow_article_view_history", 1, "article_id", "article_id views legacy_views seeded_at_utc:text",
        nonNull: ["article_id", "views"]);

    private sealed record LegacyReadingHistoryRow(int ArticleId, int Views, int? SeedViews, string? SeededAt);
    private sealed record LegacyReadingHistoryRead(bool HandlesViews, bool HandlesSeed, LegacyProjection[] Projections,
        LegacyReadingHistoryRow[]? Rows, ImportFinding? Finding = null);

    private static async Task<LegacyReadingHistoryRead> ReadLegacyReadingHistoryAsync(LegacySource source,
        DbTransaction tx, LegacyTable article, LegacyTable[] catalog, CancellationToken ct)
    {
        if (source.Provider != "postgres") return new(false, false, [], null);
        var views = article.Columns.Where(column => column.Name.Equals("views", StringComparison.OrdinalIgnoreCase)).ToArray();
        var seeds = catalog.Where(table => table.Name.Equals(LegacyViewSeed, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (views.Length == 0 && seeds.Length == 0) return new(false, false, [], null);
        if (views is not [{ Name: "views", Type: "integer" }] || article.Kind != "r" ||
            !article.Columns.Contains(new LegacyField("id", "integer")))
            return new(views.Length != 0, seeds.Length != 0, [], null, new("legacy-reading-history-catalog", LegacyArticleViews, 1));
        LegacyTable? seed = null;
        if (seeds.Length != 0)
        {
            LegacyField[] fields = [new("article_id", "integer"), new("legacy_views", "integer"),
                new("seeded_at_utc", "timestamp without time zone")];
            if (seeds is not [var relation] || relation.Name != LegacyViewSeed || relation.Kind != "r" ||
                !relation.Columns.ToHashSet().SetEquals(fields) ||
                !await HasLegacyReadingHistoryKeyAsync((NpgsqlTransaction)tx, source.Schema, relation.Name,
                    ["article_id", "legacy_views", "seeded_at_utc"], ct))
                return new(true, true, [], null, new("legacy-reading-history-catalog", LegacyViewSeed, 1));
            seed = relation;
        }

        var articleId = "a." + source.Field(article, "id");
        var articleViews = "a." + source.Field(article, "views");
        var seedFields = seed is null ? "NULL::integer, NULL::timestamp, false" : """
            s.legacy_views,
            CASE WHEN s.seeded_at_utc BETWEEN TIMESTAMP '0001-01-01 00:00:00' AND TIMESTAMP '9999-12-31 23:59:59.999999'
                 THEN s.seeded_at_utc END,
            s.article_id IS NOT NULL
            """;
        var join = seed is null ? "" : $"FULL JOIN {source.Table(seed)} s ON s.article_id={articleId}";
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {articleId},{articleViews},{seedFields} FROM {source.Table(article)} a {join}
            ORDER BY {articleId} LIMIT {RehearsalLimit + 1}
            """);
        await using var reader = await query.ExecuteReaderAsync(ct);
        using var viewDigest = ReadingHistoryDigest(LegacyArticleViews, "id", "views");
        using var seedDigest = ReadingHistoryDigest(LegacyViewSeed, "article_id", "legacy_views", "seeded_at_utc");
        var rows = new List<LegacyReadingHistoryRow>();
        var previousId = 0;
        var observed = 0;
        var seedsRead = 0;
        var invalid = 0;
        while (await reader.ReadAsync(ct))
        {
            if (++observed > RehearsalLimit)
                return new(true, seed is not null, [], null, new("legacy-reading-history-budget", LegacyArticleViews, observed));
            var hasSeed = reader.GetBoolean(4);
            if (reader.IsDBNull(0) || reader.IsDBNull(1) || reader.GetInt32(0) <= previousId || reader.GetInt32(1) < 0 ||
                (hasSeed && (reader.IsDBNull(2) || reader.GetInt32(2) < 0 || reader.IsDBNull(3))))
            {
                invalid++;
                continue;
            }
            var id = reader.GetInt32(0);
            var value = reader.GetInt32(1);
            int? seedViews = null;
            string? seededAt = null;
            if (hasSeed)
            {
                seedViews = reader.GetInt32(2);
                seededAt = DateTime.SpecifyKind(reader.GetDateTime(3), DateTimeKind.Utc).ToString("O", CultureInfo.InvariantCulture);
                AppendLegacyValue(seedDigest, id);
                AppendLegacyValue(seedDigest, seedViews);
                AppendLegacyValue(seedDigest, seededAt);
                seedsRead++;
            }
            AppendLegacyValue(viewDigest, id);
            AppendLegacyValue(viewDigest, value);
            rows.Add(new(id, value, seedViews, seededAt));
            previousId = id;
        }
        if (invalid != 0)
            return new(true, seed is not null, [], null, new("legacy-reading-history-values", LegacyArticleViews, invalid));
        var projections = new List<LegacyProjection> { ReadingHistoryProjection(LegacyArticleViews, rows.Count, viewDigest) };
        if (seed is not null) projections.Add(ReadingHistoryProjection(LegacyViewSeed, seedsRead, seedDigest));
        return new(true, seed is not null, projections.ToArray(), rows.ToArray());
    }

    private static IncrementalHash ReadingHistoryDigest(string name, params string[] fields)
    {
        var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, name);
        foreach (var field in fields) AppendLegacyValue(digest, field);
        return digest;
    }

    private static LegacyProjection ReadingHistoryProjection(string name, int count, IncrementalHash digest)
        => new(name, count, Convert.ToHexStringLower(digest.GetHashAndReset()));

    private static async Task<bool> HasLegacyReadingHistoryKeyAsync(NpgsqlTransaction tx, string schema, string table,
        string[] nonNull, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relispartition
               AND NOT EXISTS (SELECT FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
               AND EXISTS (
                   SELECT FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='article_id'
                   WHERE k.conrelid=c.oid AND k.contype='p' AND k.convalidated AND NOT k.condeferrable
                     AND k.conkey=ARRAY[a.attnum])
               AND ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
                         ORDER BY a.attname::text COLLATE "C")=$3
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relname=$2
            """, tx.Connection, tx);
        command.Parameters.AddWithValue(schema);
        command.Parameters.AddWithValue(table);
        command.Parameters.AddWithValue(nonNull);
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static CandidateTable[] LegacyReadingHistoryDefinitions(ImportPlan plan)
    {
        var views = plan.SourceProjections?.Where(row => row.Table == LegacyArticleViews).ToArray() ?? [];
        var seeds = plan.SourceProjections?.Where(row => row.Table == LegacyViewSeed).ToArray() ?? [];
        var retained = plan.ExpectedTables?.Where(row => row.Table == LegacyReadingHistoryShadow.Name).ToArray() ?? [];
        if (views.Length == 0 && seeds.Length == 0 && retained.Length == 0) return [];
        if (plan.Provider != "postgres" || views is not [var source] || retained is not [var target] ||
            source.Rows is < 0 or > RehearsalLimit || source.Rows != target.Rows ||
            plan.SourceProjections!.Where(row => row.Table == Article).ToArray() is not [var article] ||
            source.Rows != article.Rows || !IsSha256(source.Sha256) || !IsSha256(target.Sha256) || seeds.Length > 1 ||
            seeds.Any(seed => seed.Rows < 0 || seed.Rows > source.Rows || !IsSha256(seed.Sha256)))
            throw new InvalidOperationException("The legacy import plan has incomplete reading-history custody.");
        return [LegacyReadingHistoryShadow];
    }

    private static async Task WriteLegacyReadingHistoryShadowAsync(DbTransaction tx, LegacyReadingHistoryRow[] rows,
        CancellationToken ct)
    {
        var table = LegacyReadingHistoryShadow.Name;
        await using (var create = CreateLegacyCommand(tx, $"""
            CREATE TABLE {table} (article_id INTEGER PRIMARY KEY, views INTEGER NOT NULL,
                legacy_views INTEGER, seeded_at_utc TEXT) STRICT
            """)) await create.ExecuteNonQueryAsync(ct);
        await using var insert = CreateLegacyCommand(tx, $"INSERT INTO {table} VALUES (@id,@views,@seed,@at)");
        foreach (var name in new[] { "id", "views", "seed", "at" })
        {
            var parameter = insert.CreateParameter();
            parameter.ParameterName = name;
            insert.Parameters.Add(parameter);
        }
        foreach (var row in rows)
        {
            insert.Parameters[0].Value = row.ArticleId;
            insert.Parameters[1].Value = row.Views;
            insert.Parameters[2].Value = (object?)row.SeedViews ?? DBNull.Value;
            insert.Parameters[3].Value = (object?)row.SeededAt ?? DBNull.Value;
            await insert.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task<ShadowCount> VerifyLegacyReadingHistoryShadowAsync(DbTransaction tx,
        LegacyReadingHistoryRow[] rows, CancellationToken ct)
    {
        var table = LegacyReadingHistoryShadow;
        using var digest = ReadingHistoryDigest(table.Name, table.Columns.Select(column => column.Name).ToArray());
        await using var select = CreateLegacyCommand(tx, $"SELECT * FROM {table.Name} ORDER BY article_id");
        await using var read = await select.ExecuteReaderAsync(ct);
        foreach (var expected in rows)
        {
            if (!await read.ReadAsync(ct) || read.GetInt64(0) != expected.ArticleId || read.GetInt64(1) != expected.Views ||
                (read.IsDBNull(2) ? (long?)null : read.GetInt64(2)) != expected.SeedViews ||
                (read.IsDBNull(3) ? null : read.GetString(3)) != expected.SeededAt)
                throw new InvalidOperationException("The legacy reading-history shadow differs from its source.");
            for (var index = 0; index < read.FieldCount; index++)
                AppendLegacyValue(digest, read.IsDBNull(index) ? null : read.GetValue(index));
        }
        if (await read.ReadAsync(ct))
            throw new InvalidOperationException("The legacy reading-history shadow contains unreviewed rows.");
        return new(table.Name, rows.Length, Convert.ToHexStringLower(digest.GetHashAndReset()));
    }
}

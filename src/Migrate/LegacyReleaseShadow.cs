using System.Data.Common;
using FsusBlog.V2.Core.Content;

internal static partial class Migration
{
    private static readonly string[] ReleaseTables =
        [Block, Category, Tag, TagAlias, ArticleTag, RightsPolicy, RightsSnapshot, Responsibility];

    private static async Task<long> BuildShadowReleaseAsync(DbTransaction transaction, CancellationToken token)
    {
        foreach (var source in ReleaseTables)
        {
            var fields = LegacyColumns[source];
            var definitions = fields.Select(field => $"{field} {(IsLegacyText(field) || IsLegacyTimestamp(field) ? "TEXT" : "INTEGER")}");
            var keys = string.Join(", ", LegacyKeyColumns(source));
            await using var copy = CreateLegacyCommand(transaction, $"""
                CREATE TABLE shadow_{source} ({string.Join(", ", definitions)}, PRIMARY KEY ({keys})
                    {ReleaseConstraints(source)}) STRICT;
                INSERT INTO shadow_{source} ({string.Join(", ", fields)})
                    SELECT {string.Join(", ", fields)} FROM source_{source};
                """);
            await copy.ExecuteNonQueryAsync(token);
        }

        await ValidateShadowTagKeysAsync(transaction, token);
        await using (var create = CreateLegacyCommand(transaction, """
            CREATE TABLE shadow_revision_tag (
                source_revision_id INTEGER NOT NULL REFERENCES shadow_revision (source_revision_id),
                tag_id INTEGER NOT NULL REFERENCES shadow_tag (id),
                PRIMARY KEY (source_revision_id, tag_id)
            ) STRICT
            """))
            await create.ExecuteNonQueryAsync(token);

        var links = await ReadShadowRevisionTagsAsync(transaction, token);
        await using var insert = CreateLegacyCommand(transaction,
            "INSERT INTO shadow_revision_tag VALUES (@revision, @tag)");
        var revision = insert.CreateParameter();
        revision.ParameterName = "revision";
        insert.Parameters.Add(revision);
        var tag = insert.CreateParameter();
        tag.ParameterName = "tag";
        insert.Parameters.Add(tag);
        foreach (var link in links)
        {
            token.ThrowIfCancellationRequested();
            revision.Value = link.Revision;
            tag.Value = link.Tag;
            await insert.ExecuteNonQueryAsync(token);
        }
        return links.Count;
    }

    private static string ReleaseConstraints(string source) => source switch
    {
        Block => ", CHECK (id > 0 AND content_hash IS NOT NULL AND markdown_content IS NOT NULL AND byte_length >= 0 AND created_at IS NOT NULL)",
            Category or Tag => ", CHECK (id BETWEEN 1 AND 2147483647 AND name IS NOT NULL AND length(name) > 0)",
        TagAlias => """
            , CHECK (normalized_name IS NOT NULL AND original_name IS NOT NULL AND tag_id IS NOT NULL)
            , FOREIGN KEY (tag_id) REFERENCES shadow_tag (id)
            """,
        ArticleTag => """
            , FOREIGN KEY (articleid) REFERENCES shadow_article (id)
            , FOREIGN KEY (tagid) REFERENCES shadow_tag (id)
            """,
        RightsPolicy => """
            , UNIQUE (article_id), UNIQUE (id, article_id)
            , CHECK (article_id IS NOT NULL AND enabled IN (0, 1) AND enabled IS NOT NULL)
            , FOREIGN KEY (article_id) REFERENCES shadow_article (id)
            """,
        RightsSnapshot => """
            , UNIQUE (article_id, article_revision_id), UNIQUE (id, article_revision_id, article_id, revision_no)
            , CHECK (article_id IS NOT NULL AND article_revision_id IS NOT NULL AND revision_no IS NOT NULL)
            , FOREIGN KEY (article_rights_policy_id, article_id) REFERENCES shadow_article_rights_policy (id, article_id)
            , FOREIGN KEY (article_revision_id, article_id, revision_no)
                REFERENCES shadow_revision (source_revision_id, article_id, revision)
            """,
        Responsibility => """
            , UNIQUE (article_revision_id, responsibility_version), UNIQUE (id, article_revision_id, article_id, revision_no)
            , CHECK (article_id IS NOT NULL AND article_revision_id IS NOT NULL AND revision_no IS NOT NULL
                AND responsibility_version IS NOT NULL AND responsibility_version > 0)
            , FOREIGN KEY (previous_snapshot_id) REFERENCES shadow_article_responsibility_snapshot (id)
                DEFERRABLE INITIALLY DEFERRED
            , FOREIGN KEY (article_revision_id, article_id, revision_no)
                REFERENCES shadow_revision (source_revision_id, article_id, revision)
            """,
        _ => throw new InvalidOperationException("An unsupported release projection was requested.")
    };

    private static async Task ValidateShadowTagKeysAsync(DbTransaction transaction, CancellationToken token)
    {
        var keys = new Dictionary<string, long>(StringComparer.Ordinal);
        await using (var tags = CreateLegacyCommand(transaction, "SELECT id, name FROM shadow_tag ORDER BY id"))
        await using (var rows = await tags.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token))
            {
                var key = TaxonomyNames.TagLookupKey(rows.GetString(1));
                if (key is null || !keys.TryAdd(key, rows.GetInt64(0)))
                    throw new InvalidOperationException("The legacy canonical tag URL identities require a collision mapping.");
            }
        }
        await using (var validate = CreateLegacyCommand(transaction, """
            SELECT 1 FROM (
                SELECT name, description FROM shadow_tag
                UNION ALL SELECT name, description FROM shadow_category
            ) WHERE length(name) NOT BETWEEN 1 AND 128 OR length(description) NOT BETWEEN 1 AND 500 LIMIT 1
            """))
        {
            if (await validate.ExecuteScalarAsync(token) is not null)
                throw new InvalidOperationException("Legacy taxonomy display fields exceed the v2 bounds and require a mapping.");
        }

        await using var aliases = CreateLegacyCommand(transaction, """
            SELECT normalized_name, original_name, tag_id FROM shadow_tag_url_alias ORDER BY normalized_name COLLATE BINARY
            """);
        await using var reader = await aliases.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
        {
            var key = reader.GetString(0);
            var id = reader.GetInt64(2);
            if (!IsExpectedTagKey(key, reader.GetString(1)) ||
                (keys.TryGetValue(key, out var canonical) && canonical != id))
                throw new InvalidOperationException("The legacy tag URL alias requires an explicit canonical resolution.");
        }
    }

    private static async Task<List<(long Revision, int Tag)>> ReadShadowRevisionTagsAsync(
        DbTransaction transaction, CancellationToken token)
    {
        const int maxPerRevision = 128;
        var result = new List<(long, int)>();
        var known = new HashSet<long>();
        await using (var ids = CreateLegacyCommand(transaction, "SELECT id FROM shadow_tag"))
        await using (var rows = await ids.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token)) known.Add(rows.GetInt64(0));
        }
        await using var query = CreateLegacyCommand(transaction, "SELECT id, tag_ids FROM source_article_revision ORDER BY id");
        await using var reader = await query.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
        {
            token.ThrowIfCancellationRequested();
            var id = reader.GetInt64(0);
            if (await reader.IsDBNullAsync(1, token))
                throw new InvalidOperationException("A source revision lacks its tag identity list.");
            var csv = reader.GetString(1);
            if (csv.Length == 0) continue;
            if (csv.Length > maxPerRevision * 16)
                throw new InvalidOperationException("A source revision exceeds the rehearsal tag limit.");
            var tags = new HashSet<int>();
            foreach (var value in csv.Split(','))
            {
                var tag = ParseRevisionTag(value);
                if (!tags.Add(tag) || !known.Contains(tag))
                    throw new InvalidOperationException("A source revision has a duplicate or unmapped tag identity.");
                if (tags.Count > maxPerRevision)
                    throw new InvalidOperationException("A source revision exceeds the rehearsal tag limit.");
            }
            foreach (var tag in tags.Order()) result.Add((id, tag));
        }
        return result;
    }

    private static async Task VerifyShadowReleaseReadbackAsync(DbTransaction transaction, CancellationToken token)
    {
        foreach (var source in ReleaseTables)
        {
            var fields = string.Join(", ", LegacyColumns[source]);
            var check = $"""
                FROM (SELECT {fields} FROM source_{source}
                    EXCEPT SELECT {fields} FROM shadow_{source}) changed
                """;
            if (await CountAsync(check, transaction, token) != 0)
                throw new InvalidOperationException($"The shadow rehearsal changed release values in {source}.");
        }

        var expected = await ReadShadowRevisionTagsAsync(transaction, token);
        await using var links = CreateLegacyCommand(transaction, "SELECT source_revision_id, tag_id FROM shadow_revision_tag ORDER BY source_revision_id, tag_id");
        await using var reader = await links.ExecuteReaderAsync(token);
        foreach (var link in expected)
        {
            if (!await reader.ReadAsync(token) || reader.GetInt64(0) != link.Revision || reader.GetInt64(1) != link.Tag)
                throw new InvalidOperationException("The shadow rehearsal changed historical revision tag identities.");
        }
        if (await reader.ReadAsync(token))
            throw new InvalidOperationException("The shadow rehearsal gained historical revision tag identities.");
    }
}

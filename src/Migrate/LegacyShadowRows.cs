using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

internal static partial class Migration
{
    private static async Task<long> CopyRehearsalProjectionAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, LegacyProjection projection, DbTransaction shadow, CancellationToken token)
    {
        var fields = LegacyColumns[projection.Table];
        var projected = fields.Select(field => source.Field(table, field)).ToArray();
        var staging = "source_" + projection.Table;
        await using (var ddl = CreateLegacyCommand(shadow,
            $"CREATE TABLE {staging} ({string.Join(", ", fields.Select(field => field + " ANY"))}) STRICT"))
            await ddl.ExecuteNonQueryAsync(token);

        var names = fields.Select((_, i) => "@p" + i).ToArray();
        await using var insert = CreateLegacyCommand(shadow,
            $"INSERT INTO {staging} VALUES ({string.Join(", ", names)})");
        foreach (var name in names)
        {
            var parameter = insert.CreateParameter();
            parameter.ParameterName = name;
            insert.Parameters.Add(parameter);
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(hash, projection.Table);
        foreach (var field in fields) AppendLegacyValue(hash, field);
        await using var query = CreateLegacyCommand(transaction,
            $"SELECT {string.Join(", ", projected)} FROM {source.Table(table)} ORDER BY {LegacySort(source, table, projection.Table)}");
        await using var read = await query.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token);
        long rows = 0, textBytes = 0;
        while (await read.ReadAsync(token))
        {
            token.ThrowIfCancellationRequested();
            for (var i = 0; i < fields.Length; i++)
            {
                var value = await read.IsDBNullAsync(i, token) ? null : read.GetValue(i);
                AppendLegacyValue(hash, value);
                if (value is string text)
                    textBytes = checked(textBytes + StrictUtf8.GetByteCount(text));
                if (textBytes > RehearsalTextBytes)
                    throw new InvalidOperationException("The source projection exceeds the rehearsal text limit.");
                insert.Parameters[i].Value = value switch
                {
                    null => DBNull.Value,
                    bool flag => flag ? 1 : 0,
                    DateTime stamp => stamp.ToString("O", CultureInfo.InvariantCulture),
                    DateTimeOffset stamp => stamp.ToString("O", CultureInfo.InvariantCulture),
                    _ => value
                };
            }
            await insert.ExecuteNonQueryAsync(token);
            rows++;
        }

        if (rows != projection.Rows || !string.Equals(Convert.ToHexStringLower(hash.GetHashAndReset()),
            projection.Sha256, StringComparison.Ordinal))
            throw new InvalidOperationException("The rehearsal source projection differs from its audited fingerprint.");
        return textBytes;
    }

    private static async Task BuildShadowRowsAsync(DbTransaction transaction, Dictionary<int, ArticleOwner> owners,
        CancellationToken token)
    {
        await using (var insert = CreateLegacyCommand(transaction, "INSERT INTO owner_map VALUES (@article, @admin, @user)"))
        {
            foreach (var name in new[] { "article", "admin", "user" })
            {
                var parameter = insert.CreateParameter();
                parameter.ParameterName = name;
                insert.Parameters.Add(parameter);
            }
            foreach (var (id, owner) in owners)
            {
                token.ThrowIfCancellationRequested();
                insert.Parameters[0].Value = id;
                insert.Parameters[1].Value = owner.LegacyAdminId;
                insert.Parameters[2].Value = owner.V2UserId.ToString("D");
                await insert.ExecuteNonQueryAsync(token);
            }
        }

        await using var transform = CreateLegacyCommand(transaction, """
            CREATE INDEX source_revision_id ON source_article_revision(id);
            CREATE INDEX source_publication_id ON source_article_publication(id);
            CREATE INDEX source_publication_article ON source_article_publication(article_id, publication_no);

            INSERT INTO shadow_article
            SELECT a.id, m.legacy_admin_id, m.v2_user_id, r.id, r.revision_no,
                a.title, body.markdown_content, a.summary, a.coverimageurl, a.status, a.categoryid, a.isdeleted,
                a.scheduled_publish_at,a.pending_publication_at,a.published_at,a.last_published_at,a.public_updated_at,
                a.archived_at,a.deleted_at,p.id,
                CASE WHEN a.status = 2 AND a.isdeleted = 0 THEN p.revision_no END,
                COALESCE((SELECT MAX(history.publication_no) FROM source_article_publication history
                          WHERE history.article_id = a.id), 0),
                a.createtime, MAX(a.metadata_updated_at, body.updated_at), a.metadata_updated_at, body.updated_at
            FROM source_article a
            JOIN owner_map m ON a.id = m.article_id
            JOIN source_article_revision r ON r.id = a.current_revision_id AND r.article_id = a.id
            JOIN source_article_body body ON body.article_id = a.id
            LEFT JOIN source_article_publication p ON p.id = a.current_publication_id AND p.article_id = a.id;

            INSERT INTO shadow_revision
            SELECT r.id, r.article_id, r.revision_no, r.title, x.markdown_content,r.summary,r.cover_image_url,r.categoryid,
                r.tag_ids,x.id,lower(x.content_hash),r.markdown_content,r.diff_summary,
                r.created_by_admin_principal_id,r.rollback_source_revision_id,r.rollback_reason,r.created_at
            FROM source_article_revision r
            JOIN source_article_revision_content_block x ON x.id = r.content_block_id;

            """);
        await transform.ExecuteNonQueryAsync(token);
    }

    private static async Task BuildShadowPublicationsAsync(DbTransaction transaction, CancellationToken token)
    {
        await using var transform = CreateLegacyCommand(transaction, """
            INSERT INTO shadow_publication
            SELECT p.id, p.article_id, p.article_revision_id, p.revision_no, p.publication_no,
                p.rights_snapshot_id, p.responsibility_snapshot_id, p.transition_kind, p.published_at,p.created_at
            FROM source_article_publication p
            """);
        await transform.ExecuteNonQueryAsync(token);
    }

    private static async Task<ShadowCount[]> VerifyShadowRowsAsync(DbTransaction transaction, LegacyAudit audit,
        long revisionTagRows, CancellationToken token)
    {
        var checks = new[]
        {
            ("shadow_article", Article, "id"),
            ("shadow_revision", Revision, "source_revision_id"),
            ("shadow_publication", Publication, "source_publication_id"),
            ("shadow_article_revision_content_block", Block, "id"),
            ("shadow_category", Category, "id"),
            ("shadow_tag", Tag, "id"),
            ("shadow_tag_url_alias", TagAlias, "normalized_name COLLATE BINARY"),
            ("shadow_article_tag", ArticleTag, "articleid, tagid"),
            ("shadow_article_rights_policy", RightsPolicy, "id"),
            ("shadow_article_rights_snapshot", RightsSnapshot, "id"),
            ("shadow_article_responsibility_snapshot", Responsibility, "id"),
            ("shadow_revision_tag", "", "source_revision_id, tag_id")
        };
        var result = new List<ShadowCount>(checks.Length);
        foreach (var (shadow, source, order) in checks)
        {
            var expected = source == "" ? revisionTagRows :
                audit.Projections.Single(projection => projection.Table == source).Rows;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            AppendLegacyValue(hash, shadow);
            await using var readBack = CreateLegacyCommand(transaction, $"SELECT * FROM {shadow} ORDER BY {order}");
            await using var reader = await readBack.ExecuteReaderAsync(token);
            for (var i = 0; i < reader.FieldCount; i++) AppendLegacyValue(hash, reader.GetName(i));
            long rows = 0;
            while (await reader.ReadAsync(token))
            {
                token.ThrowIfCancellationRequested();
                for (var i = 0; i < reader.FieldCount; i++)
                    AppendLegacyValue(hash, await reader.IsDBNullAsync(i, token) ? null : reader.GetValue(i));
                rows++;
            }
            if (rows != expected)
                throw new InvalidOperationException($"Shadow rehearsal changed the {source} row count or its owner map missed a source article.");
            result.Add(new ShadowCount(shadow, rows, Convert.ToHexStringLower(hash.GetHashAndReset())));
        }

        const string brokenLineage = """
            FROM shadow_article a
            JOIN source_article s ON s.id = a.id
            JOIN source_article_body b ON b.article_id = a.id
            JOIN owner_map m ON m.article_id = a.id
            LEFT JOIN shadow_revision r ON r.source_revision_id = a.current_source_revision_id
            LEFT JOIN shadow_publication p ON p.source_publication_id = a.current_publication_id
            WHERE r.article_id IS NOT a.id OR r.revision IS NOT a.current_revision
               OR a.current_source_revision_id IS NOT s.current_revision_id
               OR a.current_publication_id IS NOT s.current_publication_id
               OR a.title IS NOT s.title OR a.body IS NOT b.markdown_content OR a.owner_id IS NOT m.v2_user_id
               OR a.summary IS NOT s.summary OR a.cover_image_url IS NOT s.coverimageurl
               OR a.scheduled_publish_at IS NOT s.scheduled_publish_at OR a.pending_publication_at IS NOT s.pending_publication_at
               OR a.published_at IS NOT s.published_at OR a.last_published_at IS NOT s.last_published_at
               OR a.public_updated_at IS NOT s.public_updated_at OR a.archived_at IS NOT s.archived_at OR a.deleted_at IS NOT s.deleted_at
               OR a.source_metadata_updated_at IS NOT s.metadata_updated_at OR a.source_body_updated_at IS NOT b.updated_at
               OR a.legacy_admin_id IS NOT m.legacy_admin_id OR a.deleted IS NOT s.isdeleted
               OR a.source_status IS NOT s.status OR a.source_category_id IS NOT s.categoryid OR a.created_at IS NOT s.createtime
               OR a.updated_at IS NOT CASE WHEN s.metadata_updated_at > b.updated_at
                                          THEN s.metadata_updated_at ELSE b.updated_at END
               OR a.last_publication_number IS NOT COALESCE((SELECT MAX(h.publication_number)
                   FROM shadow_publication h WHERE h.article_id = a.id), 0)
               OR a.current_publication_id IS NOT NULL AND p.article_id IS NOT a.id
               OR a.current_public_revision_candidate IS NOT CASE WHEN s.status = 2 AND s.isdeleted = 0 THEN p.revision END
            """;
        if (await CountAsync(brokenLineage, transaction, token) != 0)
            throw new InvalidOperationException("Shadow article lineage was not preserved.");

        const string brokenRevision = """
            FROM shadow_revision r
            JOIN source_article_revision s ON r.source_revision_id = s.id
            JOIN source_article_revision_content_block c ON s.content_block_id = c.id
            WHERE r.article_id IS NOT s.article_id OR r.revision IS NOT s.revision_no OR r.title IS NOT s.title
               OR r.source_content_block_id IS NOT s.content_block_id OR r.source_category_id IS NOT s.categoryid
               OR r.summary IS NOT s.summary OR r.cover_image_url IS NOT s.cover_image_url OR r.source_tag_ids IS NOT s.tag_ids
               OR r.source_inline_markdown IS NOT s.markdown_content OR r.source_diff_summary IS NOT s.diff_summary
               OR r.source_rollback_reason IS NOT s.rollback_reason
               OR r.body IS NOT c.markdown_content OR r.source_content_sha256 IS NOT lower(c.content_hash)
               OR r.source_admin_id IS NOT s.created_by_admin_principal_id
               OR r.source_rollback_revision_id IS NOT s.rollback_source_revision_id OR r.happened_at IS NOT s.created_at
            """;
        const string brokenPublication = """
            FROM shadow_publication p
            JOIN source_article_publication s ON p.source_publication_id = s.id
            WHERE p.article_id IS NOT s.article_id OR p.source_revision_id IS NOT s.article_revision_id
               OR p.revision IS NOT s.revision_no OR p.publication_number IS NOT s.publication_no
               OR p.source_rights_snapshot_id IS NOT s.rights_snapshot_id
               OR p.source_responsibility_snapshot_id IS NOT s.responsibility_snapshot_id
               OR p.source_transition IS NOT s.transition_kind OR p.published_at IS NOT s.published_at
               OR p.source_created_at IS NOT s.created_at
            """;
        if (await CountAsync(brokenRevision, transaction, token) != 0 ||
            await CountAsync(brokenPublication, transaction, token) != 0)
            throw new InvalidOperationException("Shadow revision content or publication lineage was not preserved.");

        await VerifyShadowReleaseReadbackAsync(transaction, token);
        return result.ToArray();
    }

    private static string LegacyShadowColumns(CandidateTable table, string separator = ",") =>
        string.Join(separator, table.Columns.Select(column => $"{column.Name} {column.Kind}" +
            (table.NonNull!.Contains(column.Name, StringComparer.Ordinal) ? " NOT NULL" : "")));

    private static IncrementalHash LegacyShadowDigest(string name, IEnumerable<string> columns)
    {
        var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, name);
        foreach (var column in columns) AppendLegacyValue(digest, column);
        return digest;
    }

    private static async Task<int> WriteLegacyShadowRowsAsync(DbTransaction tx, CandidateTable table, string createSql,
        IEnumerable<object?[]> rows, CancellationToken ct, IncrementalHash? digest = null)
    {
        await using (var create = CreateLegacyCommand(tx, createSql)) await create.ExecuteNonQueryAsync(ct);
        var parameters = table.Columns.Select(column => "@" + column.Name).ToArray();
        await using var insert = CreateLegacyCommand(tx, $"INSERT INTO {table.Name} VALUES ({string.Join(',', parameters)})");
        foreach (var name in parameters)
        {
            var parameter = insert.CreateParameter();
            parameter.ParameterName = name;
            insert.Parameters.Add(parameter);
        }
        var count = 0;
        foreach (var values in rows)
        {
            for (var index = 0; index < values.Length; index++)
            {
                if (digest is not null) AppendLegacyValue(digest, values[index]);
                insert.Parameters[index].Value = values[index] ?? DBNull.Value;
            }
            await insert.ExecuteNonQueryAsync(ct);
            count++;
        }
        return count;
    }

    private static async Task<ShadowCount> VerifyLegacyShadowRowsAsync(DbTransaction tx, CandidateTable table,
        IEnumerable<object?[]> expected, string changed, string extra, CancellationToken ct, string? missing = null,
        string? columnMismatch = null, bool widenIntegers = false)
    {
        await using var command = ReadLegacyShadow(tx, table);
        await using var reader = await command.ExecuteReaderAsync(ct);
        if (columnMismatch is not null)
        {
            for (var index = 0; index < table.Columns.Length; index++)
                if (reader.GetName(index) != table.Columns[index].Name)
                    throw new InvalidOperationException(columnMismatch);
        }
        using var digest = LegacyShadowDigest(table.Name, table.Columns.Select(column => column.Name));
        var count = 0;
        foreach (var values in expected)
        {
            if (!await reader.ReadAsync(ct)) throw new InvalidOperationException(missing ?? changed);
            for (var index = 0; index < values.Length; index++)
            {
                var observed = LegacyShadowValue(reader, index);
                var wanted = values[index];
                if (widenIntegers && wanted is int narrow) wanted = (long)narrow;
                if (!Equals(observed, wanted)) throw new InvalidOperationException(changed);
                AppendLegacyValue(digest, observed);
            }
            count++;
        }
        if (await reader.ReadAsync(ct)) throw new InvalidOperationException(extra);
        return new(table.Name, count, FinishSourceSeal(digest));
    }

    private static async Task<int> ReadLegacyShadowDigestAsync(DbTransaction tx, CandidateTable table,
        IncrementalHash digest, CancellationToken ct, IncrementalHash? sourceDigest = null)
    {
        await using var command = ReadLegacyShadow(tx, table);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var count = 0;
        while (await reader.ReadAsync(ct))
        {
            for (var index = 0; index < table.Columns.Length; index++)
            {
                var value = LegacyShadowValue(reader, index);
                AppendLegacyValue(digest, value);
                if (sourceDigest is not null) AppendLegacyValue(sourceDigest, value);
            }
            count++;
        }
        return count;
    }

    private static DbCommand ReadLegacyShadow(DbTransaction tx, CandidateTable table) =>
        CreateLegacyCommand(tx, $"SELECT * FROM {table.Name} ORDER BY {table.Key}");

    private static object? LegacyShadowValue(DbDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : reader.GetValue(index);
}

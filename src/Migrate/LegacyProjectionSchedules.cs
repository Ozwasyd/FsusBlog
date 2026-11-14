using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private const string LegacyInitialScheduleTable = "retained_initial_schedule";
    private sealed record LegacyInitialSchedule(int ArticleId, long Revision, long SourceRevisionId,
        long SourceRightsSnapshotId, long? SourceResponsibilitySnapshotId, int? SourceResponsibilityVersion,
        DateTimeOffset DueAt, DateTimeOffset EvaluatedAt, string ContentSha256, string PolicySha256);

    private static DateTimeOffset ParseLegacyScheduleEvaluation(string value)
    {
        if (!value.Contains('T') || !value.EndsWith('Z'))
            throw new ArgumentException("The schedule evaluation timestamp must use explicit UTC ISO-8601 ending in Z.");
        var evaluatedAt = ParseLegacyProjectionTimestamp(value);
        if (evaluatedAt > DateTimeOffset.UtcNow)
            throw new ArgumentException("The schedule evaluation timestamp cannot be in the future.");
        return evaluatedAt;
    }

    private static async Task<LegacyInitialSchedule[]> ReadInitialLegacySchedulesAsync(NpgsqlConnection target,
        NpgsqlTransaction tx, DateTimeOffset evaluatedAt, CancellationToken ct)
    {
        const string shadow = ImportSchema;
        await using var command = new NpgsqlCommand($"""
            SELECT a.id,r.source_revision_id,r.revision,a.scheduled_publish_at,a.created_at,
                   r.title,r.body,r.summary,r.cover_image_url,r.source_category_id,r.source_tag_ids,
                   s.id,s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,
                   s.attribution_template,s.copy_policy,s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,
                   s.proof_binding_enabled,s.canonical_url,s.content_canonical_hash,s.policy_hash,
                   a.updated_at,a.source_metadata_updated_at,a.source_body_updated_at,r.happened_at,s.created_at,
                   responsibility.id,responsibility.responsibility_version,responsibility.created_at,
                   (a.current_revision=1 AND r.revision=1 AND a.deleted=0 AND a.deleted_at IS NULL AND a.archived_at IS NULL
                   AND a.current_publication_id IS NULL AND a.current_public_revision_candidate IS NULL
                   AND a.last_publication_number=0 AND a.published_at IS NULL AND a.last_published_at IS NULL
                   AND a.public_updated_at IS NULL AND r.source_rollback_revision_id IS NULL AND r.source_rollback_reason IS NULL
                   AND r.source_admin_id=a.legacy_admin_id AND r.source_admin_id>0
                   AND (r.summary,r.cover_image_url) IS NOT DISTINCT FROM (a.summary,a.cover_image_url)
                   AND NOT EXISTS (SELECT FROM {shadow}.shadow_publication p WHERE p.article_id=a.id)
                   AND (responsibility.id IS NULL OR (responsibility.id>0 AND responsibility.responsibility_version=1
                       AND responsibility.previous_snapshot_id IS NULL))) AS exact_initial_schedule
            FROM {shadow}.shadow_article a
            LEFT JOIN {shadow}.shadow_revision r ON r.source_revision_id=a.current_source_revision_id AND r.article_id=a.id
            LEFT JOIN {shadow}.shadow_article_rights_snapshot s ON s.article_id=a.id
                AND s.article_revision_id=r.source_revision_id AND s.revision_no=r.revision
            LEFT JOIN LATERAL (
                SELECT h.id,h.created_at,h.responsibility_version,h.previous_snapshot_id
                FROM {shadow}.shadow_article_responsibility_snapshot h
                WHERE h.article_id=a.id AND h.article_revision_id=r.source_revision_id AND h.revision_no=r.revision
                ORDER BY h.responsibility_version DESC,h.id DESC LIMIT 1
            ) responsibility ON true
            WHERE a.source_status=1
            ORDER BY a.id
            """, target, tx);
        await using var rows = await command.ExecuteReaderAsync(ct);
        var items = new List<LegacyInitialSchedule>();
        while (await rows.ReadAsync(ct))
        {
            if (rows.IsDBNull(34) || !rows.GetBoolean(34) || rows.IsDBNull(11) || rows.GetInt64(11) <= 0 ||
                rows.IsDBNull(10) || rows.IsDBNull(6) || string.IsNullOrWhiteSpace(rows.GetString(6)))
                throw new InvalidOperationException("A legacy schedule is outside the verified original first-release shape.");
            var dueText = LegacyRightsText(rows, 3);
            var due = ParseLegacyProjectionTimestamp(dueText);
            var created = ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 4));
            if (due <= evaluatedAt || created > evaluatedAt ||
                Enumerable.Range(26, 5).Any(field => ParseLegacyProjectionTimestamp(LegacyRightsText(rows, field)) != created) ||
                (!rows.IsDBNull(31) && ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 33)) != created))
                throw new InvalidOperationException("A legacy schedule needs its exact original timestamps and an evaluation before its due time.");
            var content = LegacyRevisionContentHash(rows, status: 1, publishedAt: null, scheduledAt: dueText);
            VerifyLegacyRevisionRightsHashes(rows, content, "schedule");
            items.Add(new LegacyInitialSchedule(LegacyRightsInt(rows, 0), rows.GetInt64(2), rows.GetInt64(1), rows.GetInt64(11),
                rows.IsDBNull(31) ? null : rows.GetInt64(31), rows.IsDBNull(32) ? null : LegacyRightsInt(rows, 32),
                due, evaluatedAt, content, rows.GetString(25)));
        }
        if (items.Count == 0)
            throw new InvalidOperationException("No original first release is pending in the staged source.");
        return items.ToArray();
    }

    private static async Task<string> StageOrVerifyInitialLegacySchedulesAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        bool already, LegacyInitialSchedule[] items, CancellationToken ct)
    {
        var table = $"{ImportSchema}.{LegacyInitialScheduleTable}";
        if (!already)
        {
            await ExecuteAsync(target, tx, $"""
                CREATE TABLE {table} (
                    article_id integer PRIMARY KEY,
                    revision bigint NOT NULL CHECK (revision=1),
                    source_revision_id bigint NOT NULL CHECK (source_revision_id>0),
                    source_rights_snapshot_id bigint NOT NULL CHECK (source_rights_snapshot_id>0),
                    source_responsibility_snapshot_id bigint,
                    source_responsibility_version integer,
                    due_at timestamptz NOT NULL,
                    evaluated_at timestamptz NOT NULL,
                    content_sha256 text NOT NULL CHECK (length(content_sha256)=71 AND content_sha256 ~ '^sha256:[0-9a-f]+$'),
                    policy_sha256 text NOT NULL CHECK (length(policy_sha256)=71 AND policy_sha256 ~ '^sha256:[0-9a-f]+$'),
                    FOREIGN KEY (article_id,revision) REFERENCES public.article_revision(article_id,revision),
                    CHECK (isfinite(due_at) AND isfinite(evaluated_at) AND due_at>evaluated_at),
                    CHECK ((source_responsibility_snapshot_id IS NULL AND source_responsibility_version IS NULL) OR
                        (source_responsibility_snapshot_id IS NOT NULL AND source_responsibility_snapshot_id>0
                            AND source_responsibility_version IS NOT DISTINCT FROM 1))
                )
                """, ct);
            foreach (var item in items)
            {
                await using var insert = new NpgsqlCommand($"""
                    INSERT INTO {table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    """, target, tx);
                insert.Parameters.AddWithValue(item.ArticleId);
                insert.Parameters.AddWithValue(item.Revision);
                insert.Parameters.AddWithValue(item.SourceRevisionId);
                insert.Parameters.AddWithValue(item.SourceRightsSnapshotId);
                insert.Parameters.AddWithValue(NpgsqlDbType.Bigint, (object?)item.SourceResponsibilitySnapshotId ?? DBNull.Value);
                insert.Parameters.AddWithValue(NpgsqlDbType.Integer, (object?)item.SourceResponsibilityVersion ?? DBNull.Value);
                insert.Parameters.AddWithValue(item.DueAt);
                insert.Parameters.AddWithValue(item.EvaluatedAt);
                insert.Parameters.AddWithValue(item.ContentSha256);
                insert.Parameters.AddWithValue(item.PolicySha256);
                await insert.ExecuteNonQueryAsync(ct);
            }
        }

        await using var shape = new NpgsqlCommand($"""
            SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relhasrules
                AND NOT EXISTS (SELECT FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal)
                AND (SELECT array_agg(a.attname||':'||t.typname||':'||a.attnotnull::text ORDER BY a.attnum)
                     FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
                     WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.atttypmod=-1)
                    = ARRAY['article_id:int4:true','revision:int8:true','source_revision_id:int8:true',
                        'source_rights_snapshot_id:int8:true','source_responsibility_snapshot_id:int8:false',
                        'source_responsibility_version:int4:false','due_at:timestamptz:true','evaluated_at:timestamptz:true',
                        'content_sha256:text:true','policy_sha256:text:true'],
                (SELECT array_agg(pg_get_constraintdef(k.oid) ORDER BY k.contype,k.conname COLLATE "C")
                 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.convalidated AND k.contype IN ('c','p','f'))
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='{ImportSchema}' AND c.relname='{LegacyInitialScheduleTable}'
            """, target, tx);
        string[] constraints;
        await using (var catalog = await shape.ExecuteReaderAsync(ct))
        {
            if (!await catalog.ReadAsync(ct) || catalog.IsDBNull(0) || !catalog.GetBoolean(0) || catalog.IsDBNull(1) ||
                (constraints = catalog.GetFieldValue<string[]>(1)).Length != 9)
                throw new InvalidOperationException("The retained legacy schedule table shape differs.");
        }
        await using var query = new NpgsqlCommand($"""
            SELECT s.*,a.published_revision IS NULL AND a.publication_count=0 AND NOT a.deleted AND a.revision=s.revision
                           AND p.article_id IS NULL
            FROM {table} s LEFT JOIN public.article a ON a.id=s.article_id
            LEFT JOIN public.article_publication p ON p.article_id=s.article_id
            ORDER BY s.article_id
            """, target, tx);
        await using var rows = await query.ExecuteReaderAsync(ct);
        foreach (var item in items)
        {
            if (!await rows.ReadAsync(ct) || rows.IsDBNull(10) || !rows.GetBoolean(10) ||
                new LegacyInitialSchedule(rows.GetInt32(0), rows.GetInt64(1), rows.GetInt64(2), rows.GetInt64(3),
                    rows.IsDBNull(4) ? null : rows.GetInt64(4), rows.IsDBNull(5) ? null : rows.GetInt32(5),
                    rows.GetFieldValue<DateTimeOffset>(6), rows.GetFieldValue<DateTimeOffset>(7), rows.GetString(8), rows.GetString(9)) != item)
                throw new InvalidOperationException("The retained legacy schedule or its unpublished article differs.");
        }
        if (await rows.ReadAsync(ct))
            throw new InvalidOperationException("The retained legacy schedule table has additional rows.");
        return DigestMediaDocument(constraints);
    }
}

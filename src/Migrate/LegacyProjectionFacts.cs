using FsusBlog.V2.Contracts;
using Npgsql;

internal static partial class Migration
{
    private static async Task VerifyLegacyProjectionFactsAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        bool retainInitialSchedules, CancellationToken token)
    {
        await using (var timestamps = new NpgsqlCommand($"""
            SELECT created_at,updated_at,source_metadata_updated_at,source_body_updated_at,published_at,last_published_at,
                   public_updated_at,archived_at,deleted_at,scheduled_publish_at,pending_publication_at
            FROM {ImportSchema}.shadow_article
            UNION ALL
            SELECT happened_at,happened_at,happened_at,happened_at,NULL,NULL,NULL,NULL,NULL,NULL,NULL
            FROM {ImportSchema}.shadow_revision
            UNION ALL
            SELECT published_at,source_created_at,published_at,source_created_at,NULL,NULL,NULL,NULL,NULL,NULL,NULL
            FROM {ImportSchema}.shadow_publication
            """, target, tx))
        await using (var rows = await timestamps.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token))
                for (var field = 0; field < rows.FieldCount; field++)
                    if (field < 4 || !rows.IsDBNull(field))
                        _ = ParseLegacyProjectionTimestamp(rows.IsDBNull(field) ? null : rows.GetString(field));
        }

        const string shadow = ImportSchema;
        var supportedLifecycle = retainInitialSchedules ? "0,1,2,3,4" : "0,2,3,4";
        await RequireNoProjectionRowsAsync($"""
            SELECT 1 FROM {shadow}.shadow_article a
            LEFT JOIN {shadow}.shadow_revision r ON r.source_revision_id=a.current_source_revision_id
            LEFT JOIN public.blog_user u ON u.id=a.owner_id::uuid
            WHERE r.article_id IS DISTINCT FROM a.id OR r.revision IS DISTINCT FROM a.current_revision
               OR a.current_revision IS DISTINCT FROM (
                    SELECT max(h.revision) FROM {shadow}.shadow_revision h WHERE h.article_id=a.id)
               OR a.source_category_id IS DISTINCT FROM r.source_category_id
               OR a.title IS DISTINCT FROM r.title OR a.body IS DISTINCT FROM r.body
               OR u.id IS NULL OR NOT u.enabled OR NOT u.can_author
               OR a.created_at::timestamptz > a.updated_at::timestamptz
               OR a.updated_at::timestamptz IS DISTINCT FROM greatest(
                    a.source_metadata_updated_at::timestamptz,a.source_body_updated_at::timestamptz)
               OR a.id NOT BETWEEN 1 AND 2147483646
               OR a.last_publication_number NOT BETWEEN 0 AND 2147483646
            """, "Current legacy article, verified owner or revision coordinates are inconsistent.", target, tx, token);

        await RequireNoProjectionRowsAsync($"""
            SELECT 1 FROM {shadow}.shadow_revision
            WHERE revision NOT BETWEEN 1 AND 2147483647
               OR title IS NULL OR octet_length(title) NOT BETWEEN 1 AND {WireLimits.TitleBytes}
               OR body IS NULL OR octet_length(body) > {WireLimits.BodyBytes}
            UNION ALL
            SELECT 1 FROM {shadow}.shadow_category WHERE id NOT BETWEEN 1 AND 2147483646
            UNION ALL
            SELECT 1 FROM {shadow}.shadow_tag WHERE id NOT BETWEEN 1 AND 2147483646
            """, "Legacy article text or taxonomy identities exceed the current representation.", target, tx, token);

        await RequireNoProjectionRowsAsync($"""
            (SELECT t.articleid,t.tagid FROM {shadow}.shadow_article_tag t
             EXCEPT
             SELECT a.id,r.tag_id FROM {shadow}.shadow_article a JOIN {shadow}.shadow_revision_tag r
               ON r.source_revision_id=a.current_source_revision_id)
            UNION ALL
            (SELECT a.id,r.tag_id FROM {shadow}.shadow_article a JOIN {shadow}.shadow_revision_tag r
               ON r.source_revision_id=a.current_source_revision_id
             EXCEPT
             SELECT t.articleid,t.tagid FROM {shadow}.shadow_article_tag t)
            """, "The current article tags differ from its captured head revision.", target, tx, token);

        await RequireNoProjectionRowsAsync($"""
            WITH ordered AS (
                SELECT p.*,
                       row_number() over w AS expected_no,
                       lag(p.published_at::timestamptz) over w AS previous_at,
                       lag(p.revision) over w AS previous_revision
                FROM {shadow}.shadow_publication p WINDOW w AS (PARTITION BY p.article_id ORDER BY p.publication_number)
            )
            SELECT 1 FROM ordered p JOIN {shadow}.shadow_article a ON a.id=p.article_id
            WHERE p.publication_number<>p.expected_no OR p.source_publication_id NOT BETWEEN 1 AND 9223372036854775806
               OR p.source_rights_snapshot_id NOT BETWEEN 1 AND 9223372036854775806
               OR p.revision>a.current_revision OR p.revision<=p.previous_revision
               OR p.published_at::timestamptz < p.previous_at
               OR p.published_at::timestamptz > statement_timestamp()
               OR p.source_created_at::timestamptz < p.published_at::timestamptz
            """, "Legacy release chronology cannot be represented without guessing.", target, tx, token);

        await RequireNoProjectionRowsAsync($"""
            SELECT 1 FROM {shadow}.shadow_article a
            LEFT JOIN {shadow}.shadow_publication recent ON recent.article_id=a.id AND recent.publication_number=a.last_publication_number
            LEFT JOIN {shadow}.shadow_publication first ON first.article_id=a.id AND first.publication_number=1
            WHERE a.source_status NOT IN ({supportedLifecycle}) OR a.pending_publication_at IS NOT NULL
                OR (a.source_status=1) IS DISTINCT FROM (a.scheduled_publish_at IS NOT NULL)
                OR (a.source_status=4) IS DISTINCT FROM (a.deleted=1)
                OR (a.source_status=4) IS DISTINCT FROM (a.deleted_at IS NOT NULL)
                OR (a.source_status=3 AND a.archived_at IS NULL)
                OR (a.source_status=2 AND (a.archived_at IS NOT NULL OR recent.revision IS NULL
                    OR a.current_public_revision_candidate IS DISTINCT FROM recent.revision
                    OR a.published_at::timestamptz IS DISTINCT FROM first.published_at::timestamptz
                    OR a.last_published_at::timestamptz IS DISTINCT FROM recent.published_at::timestamptz
                    OR a.public_updated_at::timestamptz IS DISTINCT FROM recent.published_at::timestamptz))
                OR (a.source_status<>2 AND a.current_public_revision_candidate IS NOT NULL)
                OR (a.source_status IN (0,3,4) AND a.current_publication_id IS NOT NULL
                    AND a.current_publication_id IS DISTINCT FROM recent.source_publication_id)
                OR (a.source_status=2 AND a.current_publication_id IS DISTINCT FROM recent.source_publication_id)
                OR (a.last_publication_number=0 AND (recent.source_publication_id IS NOT NULL OR a.published_at IS NOT NULL
                    OR a.last_published_at IS NOT NULL OR a.public_updated_at IS NOT NULL))
                OR (a.last_publication_number>0 AND recent.source_publication_id IS NULL)
            """, "An old article publication or lifecycle state requires a separate verified conversion.", target, tx, token);
    }

    private static async Task RequireNoProjectionRowsAsync(string sql, string error, NpgsqlConnection target,
        NpgsqlTransaction tx, CancellationToken token)
    {
        await using var query = new NpgsqlCommand($"SELECT EXISTS ({sql})", target, tx);
        if (await query.ExecuteScalarAsync(token) is not false) throw new InvalidOperationException(error);
    }
}

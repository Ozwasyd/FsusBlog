\set ON_ERROR_STOP on
\set QUIET 1
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout TO '120s';

SELECT current_database() = :'database_name' AND current_database() ~ '^fsusv2_nightly_[0-9a-f]{32}$'
    AND current_setting('data_directory') = :'data_directory'
    AND current_user = 'fsusv2_nightly_qa'
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
    AND current_setting('server_encoding') = 'UTF8' AND current_setting('session_replication_role') = 'origin'
    AND :'profile' = 'nightly'
    AND :'fixture_sha256' ~ '^[0-9a-f]{64}$' AND :'readback_sha256' ~ '^[0-9a-f]{64}$'
    AND (SELECT count(*) = 1 AND bool_and(singleton AND version = 1) FROM public.v2_schema)
    AND (SELECT count(*) = 1 AND bool_and(singleton AND site_id = :'site_id'::uuid)
         FROM public.authoring_recovery_site) AS owned \gset
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment oracle requires the owned full nightly fixture and its sealed inputs'; END $$;
\endif

-- Construct the hot graph from fixture coordinates and compare it with stored rows.
-- The five private leaves and three retained ancestors follow from the seeded shape.
WITH constants AS (
    SELECT 9007199254740993::bigint AS base, to_timestamp(:'due_unix_ms'::bigint / 1000.0) AS due
), replies AS (
    SELECT base + 500000 + n AS id, n, base + CASE
        WHEN n <= 480 THEN 1 WHEN n <= 512 THEN 2 ELSE n - 510 END AS root,
        CASE WHEN n BETWEEN 481 AND 512 THEN n - 480 ELSE 1 END AS depth
    FROM constants CROSS JOIN generate_series(1, 10000) AS seq(n)
), expected AS (
    SELECT base + n AS id, NULL::bigint AS parent, base + n AS root, 0 AS depth,
        CASE WHEN n = 3 THEN 3 ELSE 1 END AS moderation, n = 4 AS deleted, n = 5 AS blocked,
        false AS excluded, n BETWEEN 3 AND 5 AS masked, format('C11 root %s', n) AS author,
        format('C11 nightly root %s', n) AS content
    FROM constants CROSS JOIN generate_series(1, 10000) AS seq(n)
    UNION ALL
    SELECT id, CASE WHEN depth = 1 THEN root ELSE id - 1 END, root, depth,
        CASE n WHEN 517 THEN 0 WHEN 518 THEN 2 WHEN 519 THEN 3 ELSE 1 END,
        n = 520, n = 516, n BETWEEN 516 AND 520, false,
        format('C11 reply %s', n), format('C11 nightly reply %s', n)
    FROM replies
), hot AS MATERIALIZED (
    SELECT e.*, c.id AS stored, c.created_at, c.body, c.display_name,
        c.id IS NOT NULL AND c.parent_id IS NOT DISTINCT FROM e.parent
            AND c.reply_to_id IS NOT DISTINCT FROM e.parent
            AND c.root_id = e.root AND c.depth = e.depth
            AND c.moderation_status = e.moderation AND c.deleted = e.deleted
            AND e.blocked = EXISTS (
                SELECT FROM public.comment_blocked_region b WHERE (b.article_id, b.comment_id) = (1, e.id)
                  AND b.region_code = 'CN')
            AND octet_length(c.body) = char_length(c.body) AND c.body = e.content
            AND c.display_name = e.author AND c.author_mode = 1 AND c.display_language = 'en'
            AND c.scope_label IS NULL AND c.edited_at IS NULL AS matches
    FROM expected e LEFT JOIN public.comment c ON (c.article_id, c.id) = (1, e.id)
), counts AS (
    SELECT count(*) AS rows,
        count(*) FILTER (WHERE parent_id IS NULL) AS roots,
        count(*) FILTER (WHERE article_id = 1) AS hot_rows,
        count(*) FILTER (WHERE article_id = 2) AS empty_rows,
        count(*) FILTER (WHERE article_id = 90001) AS archived_rows,
        count(*) FILTER (WHERE article_id = 95001) AS deleted_rows
    FROM public.comment
), active AS (
    SELECT a.id, p.revision, p.publication_id, p.published_at
    FROM public.article a JOIN public.article_publication p ON (a.id, a.published_revision) = (p.article_id, p.revision)
    WHERE a.id IN (1, 2, 90001, 95001) AND NOT a.deleted
      AND p.published_at <= statement_timestamp()
), seal AS (
    SELECT (SELECT max(id) FROM public.blog_outbox WHERE kind IN ('publish', 'retract', 'delete')) AS watermark,
        (SELECT revision FROM public.taxonomy_epoch WHERE singleton) AS taxonomy_epoch,
        counts.rows, counts.roots,
        counts.rows = 1000000 AND counts.roots = 500000 AND counts.hot_rows = 20000 AND counts.empty_rows = 0
            AND counts.archived_rows = 2 AND counts.deleted_rows = 2
            AND (SELECT count(*) = 20000 AND bool_and(matches) FROM hot)
            AND (SELECT count(*) = 2 FROM public.comment_blocked_region)
            AND (SELECT count(*) = 2 AND bool_and(id IN (1, 2) AND revision = 3 AND publication_id > 0) FROM active)
            AND (SELECT count(*) = 2 AND bool_and(published_revision IS NULL AND deleted = (id = 95001))
                 FROM public.article WHERE id IN (90001, 95001))
            AND due > statement_timestamp()
            AND (SELECT count(*) = 10000 AND bool_and(due_at = due) FROM public.article_schedule) AS verified
    FROM constants CROSS JOIN counts
), output AS (
    SELECT 0::bigint AS position, jsonb_build_object(
        'version', 1, 'profile', :'profile', 'verified', coalesce(verified AND watermark > 0 AND taxonomy_epoch >= 0, false),
        'siteId', :'site_id', 'databaseName', :'database_name',
        'fixtureSha256', :'fixture_sha256', 'readbackSha256', :'readback_sha256',
        'dueUnixMs', :'due_unix_ms', 'watermark', watermark::text, 'taxonomyEpoch', taxonomy_epoch::text,
        'rows', rows, 'roots', roots, 'hotRows', 20000,
        'publication', (SELECT publication_id::text FROM active WHERE id = 1),
        'revision', (SELECT revision::text FROM active WHERE id = 1)) AS value
    FROM seal
    UNION ALL
    SELECT hot.id, jsonb_build_array(hot.id::text, parent::text, root::text, depth, masked,
        floor(extract(epoch FROM created_at) * 1000)::bigint,
        CASE WHEN NOT masked THEN encode(sha256(convert_to(body, 'UTF8')), 'hex') END,
        CASE WHEN NOT masked THEN encode(sha256(convert_to(display_name, 'UTF8')), 'hex') END)
    FROM hot JOIN seal ON seal.verified WHERE NOT excluded
)
SELECT value FROM output ORDER BY position;
ROLLBACK;

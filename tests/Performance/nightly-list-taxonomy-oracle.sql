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
DO $$ BEGIN RAISE EXCEPTION 'List rank oracle requires the owned full nightly fixture and its sealed inputs'; END $$;
\endif

WITH ranked AS MATERIALIZED (
    SELECT row_number() OVER (ORDER BY a.created_at DESC, a.id DESC) AS rank,
        a.id, (extract(epoch FROM a.created_at) * 1000000)::bigint AS created_us,
        p.revision, p.publication_id, p.publication_no, p.published_at,
        category.category_id, tag.tag_id, r.title, left(r.body, 200) AS summary
    FROM public.article AS a
    JOIN public.article_publication AS p ON (p.article_id, p.revision) = (a.id, a.published_revision)
    JOIN public.article_publication_rights AS pr
        ON (pr.article_id, pr.revision, pr.publication_id) = (p.article_id, p.revision, p.publication_id)
    JOIN public.article_revision_rights AS rights ON (rights.article_id, rights.revision) = (pr.article_id, pr.revision)
    JOIN public.article_revision AS r ON (r.article_id, r.revision) = (p.article_id, p.revision)
    JOIN public.article_revision_category AS category ON (category.article_id, category.revision) = (p.article_id, p.revision)
    JOIN public.article_revision_tag AS tag ON (tag.article_id, tag.revision) = (p.article_id, p.revision)
    WHERE NOT a.deleted AND p.published_at <= statement_timestamp()
), category_counts AS (
    SELECT c.id, c.name, coalesce(m.members, 0) AS members
    FROM public.category AS c
    LEFT JOIN (SELECT category_id, count(*) AS members FROM ranked GROUP BY category_id) AS m
        ON m.category_id = c.id
), tag_counts AS (
    SELECT t.id, t.name, coalesce(m.members, 0) AS members
    FROM public.tag AS t
    LEFT JOIN (SELECT tag_id, count(*) AS members FROM ranked GROUP BY tag_id) AS m ON m.tag_id = t.id
), boundary AS (
    SELECT to_timestamp(:'due_unix_ms'::bigint / 1000.0) AS due,
        (SELECT max(id) FROM public.blog_outbox WHERE kind IN ('publish', 'retract', 'delete')) AS watermark
), head AS (
    SELECT coalesce(
        count(*) = 85000 AND count(DISTINCT ranked.id) = 85000
        AND count(*) = (SELECT count(*) FROM public.article_publication)
        AND bool_and(ranked.id BETWEEN 1 AND 80000 OR ranked.id BETWEEN 85001 AND 90000)
        AND bool_and(revision = 3 AND publication_id > 0 AND publication_no = 1 AND created_us > 0)
        AND bool_and(octet_length(summary) = char_length(summary))
        AND boundary.due > statement_timestamp() AND boundary.watermark > 0
        AND (SELECT count(*) = 10000 AND bool_and(due_at = boundary.due) FROM public.article_schedule),
        false) AS verified, boundary.watermark
    FROM ranked CROSS JOIN boundary
    GROUP BY boundary.due, boundary.watermark
), output AS (
    SELECT 0::bigint AS position, jsonb_build_object(
        'version', 1, 'verified', coalesce(head.verified, false), 'total', 85000,
        'siteId', :'site_id', 'fixtureSha256', :'fixture_sha256', 'readbackSha256', :'readback_sha256',
        'dueUnixMs', :'due_unix_ms', 'watermark', head.watermark::text,
        'categories', (SELECT jsonb_agg(jsonb_build_array(id, name, members) ORDER BY id) FROM category_counts),
        'tags', (SELECT jsonb_agg(jsonb_build_array(id, name, members) ORDER BY id) FROM tag_counts)
    ) AS value
    FROM (SELECT 1) AS one LEFT JOIN head ON true
    UNION ALL
    SELECT ranked.rank, jsonb_build_array(
        ranked.id, ranked.created_us::text, ranked.revision::text, ranked.publication_id::text,
        floor(extract(epoch FROM ranked.published_at) * 1000)::bigint, ranked.category_id, ranked.tag_id,
        encode(sha256(convert_to(ranked.title, 'UTF8')), 'hex'),
        encode(sha256(convert_to(ranked.summary, 'UTF8')), 'hex')
    )
    FROM ranked JOIN head ON head.verified
)
SELECT value FROM output ORDER BY position;
ROLLBACK;

\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL lock_timeout TO '2s';

SELECT current_database() = :'database_name'
    AND current_setting('data_directory') = :'data_directory'
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
    AND current_setting('session_replication_role') = 'origin'
    AND :'profile' IN ('pilot', 'nightly')
    AND NOT EXISTS (
        SELECT FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid())
    AND pg_try_advisory_xact_lock(4815262471654073021::bigint)
    AND pg_try_advisory_xact_lock(716729109726707501::bigint)
    AND pg_try_advisory_xact_lock(1179866434, 1) AS owned \gset
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment fixture requires the idle, owned Unix-only PostgreSQL database and a known profile'; END $$;
\endif

LOCK TABLE public.comment, public.comment_blocked_region IN SHARE ROW EXCLUSIVE MODE;
SELECT (SELECT count(*) = 1 AND bool_and(singleton AND version = 1) FROM public.v2_schema)
    AND (SELECT count(*) = 1 AND bool_and(singleton AND site_id = :'site_id'::uuid)
         FROM public.authoring_recovery_site)
    AND NOT EXISTS (SELECT FROM public.comment)
    AND NOT EXISTS (SELECT FROM public.comment_blocked_region)
    AND NOT EXISTS (SELECT FROM public.comment_public_write)
    AND NOT EXISTS (SELECT FROM public.comment_public_handle) AS pristine \gset
\if :pristine
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment fixture site or empty comment authority differs'; END $$;
\endif

CREATE TEMP TABLE c11_comment_plan ON COMMIT DROP AS
SELECT * FROM (VALUES
    ('pilot', 20, 16, 18, 18, 19, 20, 16, 52, 12, 2, 0, 48, 84),
    ('nightly', 100000, 80000, 85001, 90000, 90001, 95001, 10000, 10000, 480, 5, 65008, 500000, 500000)
) p(profile, article_count, published_last, update_first, update_last, archived_id, deleted_id,
    hot_roots, hot_replies, wide_replies, regular_pairs, extra_pair_articles, root_count, reply_count)
WHERE p.profile = :'profile';

SELECT count(a.id) = p.article_count AND min(a.id) = 1 AND max(a.id) = p.article_count
    AND bool_and(CASE WHEN a.id BETWEEN 1 AND p.published_last OR a.id BETWEEN p.update_first AND p.update_last THEN
        release.article_id IS NOT NULL AND release.revision IS NOT DISTINCT FROM a.published_revision
            AND NOT a.deleted AND release.published_at + interval '1 second' <= statement_timestamp()
            AND rights.id IS NOT NULL
        ELSE release.article_id IS NULL AND a.published_revision IS NULL END) AS matches_articles
FROM c11_comment_plan p CROSS JOIN public.article a
LEFT JOIN public.article_publication release ON release.article_id = a.id
LEFT JOIN public.article_publication_rights rights
    ON (rights.article_id, rights.publication_id, rights.revision) = (a.id, release.publication_id, release.revision)
GROUP BY p.article_count \gset
\if :matches_articles
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment fixture article IDs or active release coordinates differ'; END $$;
\endif

-- Open posts use their current publication time. Archived and deleted posts use the
-- last public release confirmed by their distinct terminal events and receipts.
CREATE TEMP TABLE c11_comment_window ON COMMIT DROP AS
WITH closed AS (
    SELECT a.owner_id, a.deleted, h.*
    FROM c11_comment_plan p JOIN public.article a ON a.id IN (p.archived_id, p.deleted_id)
    CROSS JOIN LATERAL (
        SELECT h.* FROM public.article_publication_history h WHERE h.article_id = a.id ORDER BY h.event_no DESC LIMIT 1
    ) h
    WHERE a.published_revision IS NULL AND a.revision = h.revision AND a.publication_count = h.publication_no
        AND h.publication_id IS NULL AND h.happened_at <= statement_timestamp()
        AND NOT EXISTS (SELECT FROM public.article_publication release WHERE release.article_id = a.id)
)
SELECT release.article_id, release.published_at AS opened_at, NULL::timestamptz AS closed_at
FROM public.article_publication release CROSS JOIN c11_comment_plan p
WHERE release.article_id BETWEEN 1 AND p.published_last
   OR release.article_id BETWEEN p.update_first AND p.update_last
UNION ALL
SELECT h.article_id, prior.happened_at, h.happened_at
FROM c11_comment_plan p
JOIN closed h ON h.article_id = p.archived_id
JOIN public.admin_article_rollback archive
    ON (archive.principal_id, archive.command_id) = (h.admin_actor_id, h.admin_command_id)
    AND (archive.article_id, archive.revision, archive.publication_no, archive.published_at)
        = (h.article_id, h.revision, h.publication_no, h.happened_at)
    AND archive.previous_publication_id = h.supersedes_id
JOIN public.article_publication_history prior
    ON (prior.article_id, prior.publication_id, prior.revision)
        = (h.article_id, archive.previous_publication_id, archive.previous_revision)
JOIN public.article_publication_history source
    ON (source.article_id, source.publication_id, source.revision)
        = (h.article_id, archive.source_publication_id, archive.source_revision)
    AND source.publication_id = prior.supersedes_id
WHERE NOT h.deleted AND h.kind = 'retract' AND h.reason = 'administrator-rollback-archived'
    AND (h.event_no, h.revision, h.publication_no) = (3, 6, 3)
    AND h.actor_id IS NULL AND h.command_id IS NULL
    AND archive.principal_id = 'cb7c1f2b-fd4e-4cce-9b22-31e36b475c28'::uuid AND archive.principal_id <> h.owner_id
    AND archive.destination = 3 AND NOT archive.from_archive
    AND (prior.event_no, prior.revision, prior.publication_no) = (2, 5, 2)
    AND prior.kind = 'replace' AND prior.reason = 'author-replaced' AND prior.actor_id = h.owner_id
    AND (source.event_no, source.revision, source.publication_no) = (1, 3, 1)
    AND source.kind = 'publish' AND source.reason = 'author-published' AND source.actor_id = h.owner_id
    AND source.happened_at < prior.happened_at AND prior.happened_at + interval '2 microseconds' < h.happened_at
    AND NOT EXISTS (SELECT FROM public.article_publication release WHERE release.publication_id = archive.publication_id)
    AND NOT EXISTS (SELECT FROM public.article_publication_history visible WHERE visible.publication_id = archive.publication_id)
UNION ALL
SELECT h.article_id, prior.happened_at, h.happened_at
FROM c11_comment_plan p
JOIN closed h ON h.article_id = p.deleted_id
JOIN public.article_command receipt ON (receipt.actor_id, receipt.command_id) = (h.owner_id, h.command_id)
    AND (receipt.article_id, receipt.revision) = (h.article_id, h.revision) AND NOT receipt.published
JOIN public.article_publication_history prior ON (prior.article_id, prior.publication_id) = (h.article_id, h.supersedes_id)
WHERE h.deleted AND h.kind = 'delete' AND h.reason = 'author-deleted'
    AND (h.event_no, h.revision, h.publication_no) = (2, 4, 1)
    AND h.actor_id = h.owner_id AND h.admin_actor_id IS NULL AND h.admin_command_id IS NULL
    AND (prior.event_no, prior.revision, prior.publication_no) = (1, 3, 1)
    AND prior.kind = 'publish' AND prior.reason = 'author-published' AND prior.actor_id = h.owner_id
    AND prior.happened_at + interval '2 microseconds' < h.happened_at;

SELECT count(*) = 2 AS has_closed_windows FROM c11_comment_window WHERE closed_at IS NOT NULL \gset
\if :has_closed_windows
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment fixture requires genuine archive and owner-delete publication windows'; END $$;
\endif

CREATE TEMP TABLE c11_comment_regular ON COMMIT DROP AS
WITH ranked AS (
    SELECT article_id, row_number() OVER (ORDER BY article_id) AS ordinal
    FROM c11_comment_window WHERE closed_at IS NULL AND article_id NOT IN (1, 2)
), allotment AS (
    SELECT article_id, hot_roots, regular_pairs + (ordinal <= extra_pair_articles)::integer AS pairs
    FROM ranked CROSS JOIN c11_comment_plan
)
SELECT article_id, pairs,
    hot_roots + 1 + coalesce(sum(pairs) OVER (ORDER BY article_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        AS first_root
FROM allotment;

WITH roots AS (
    SELECT 1 article_id, r.root_no FROM c11_comment_plan p CROSS JOIN LATERAL generate_series(1::bigint, p.hot_roots) r(root_no)
    UNION ALL
    SELECT a.article_id, r.root_no FROM c11_comment_regular a
    CROSS JOIN LATERAL generate_series(a.first_root, a.first_root + a.pairs - 1) r(root_no)
    UNION ALL
    SELECT archived_id, root_count - 1 FROM c11_comment_plan
    UNION ALL
    SELECT deleted_id, root_count FROM c11_comment_plan
)
INSERT INTO public.comment (article_id, id, root_id, depth, moderation_status, deleted, body, author_mode,
    display_name, display_language, created_at)
SELECT r.article_id, 9007199254740993 + r.root_no, 9007199254740993 + r.root_no, 0,
    CASE WHEN r.root_no = 3 THEN 3 ELSE 1 END, r.root_no = 4,
    format('C11 %s root %s', p.profile, r.root_no), 1, format('C11 root %s', r.root_no), 'en',
    w.opened_at + (CASE WHEN w.closed_at IS NULL THEN r.root_no ELSE 1 END) * interval '1 microsecond'
FROM roots r JOIN c11_comment_window w USING (article_id) CROSS JOIN c11_comment_plan p
ORDER BY r.root_no;

WITH hot AS (
    SELECT u.reply_no,
        CASE WHEN u.reply_no <= p.wide_replies THEN 1
             WHEN u.reply_no <= p.wide_replies + 32 THEN 2
             ELSE u.reply_no - p.wide_replies - 32 + 2 END AS root_no,
        CASE WHEN u.reply_no BETWEEN p.wide_replies + 1 AND p.wide_replies + 32
             THEN (u.reply_no - p.wide_replies)::integer ELSE 1 END AS depth
    FROM c11_comment_plan p CROSS JOIN LATERAL generate_series(1::bigint, p.hot_replies) u(reply_no)
), paired AS (
    SELECT a.article_id, r.root_no FROM c11_comment_regular a
    CROSS JOIN LATERAL generate_series(a.first_root, a.first_root + a.pairs - 1) r(root_no)
    UNION ALL
    SELECT archived_id, root_count - 1 FROM c11_comment_plan
    UNION ALL
    SELECT deleted_id, root_count FROM c11_comment_plan
), replies AS (
    SELECT 1 AS article_id, root_no, reply_no, depth FROM hot
    UNION ALL
    SELECT a.article_id, a.root_no, p.hot_replies + a.root_no - p.hot_roots, 1
    FROM paired a CROSS JOIN c11_comment_plan p
), coordinates AS (
    SELECT r.*, 9007199254740993 + r.root_no AS root_id, 9007199254740993 + p.root_count + r.reply_no AS id
    FROM replies r CROSS JOIN c11_comment_plan p
)
INSERT INTO public.comment (article_id, id, parent_id, root_id, parent_depth, reply_to_id, depth,
    moderation_status, deleted, body, author_mode, display_name, display_language, created_at)
SELECT c.article_id, c.id, parent.id, c.root_id, c.depth - 1, parent.id, c.depth,
    CASE WHEN c.article_id = 1 AND c.depth = 1 AND c.root_no = 7 THEN 0
         WHEN c.article_id = 1 AND c.depth = 1 AND c.root_no = 8 THEN 2
         WHEN c.article_id = 1 AND c.depth = 1 AND c.root_no = 9 THEN 3 ELSE 1 END,
    c.article_id = 1 AND c.depth = 1 AND c.root_no = 10,
    format('C11 %s reply %s', p.profile, c.reply_no), 1, format('C11 reply %s', c.reply_no), 'en',
    w.opened_at + (CASE WHEN w.closed_at IS NULL THEN c.reply_no + p.root_count ELSE c.depth + 1 END) * interval '1 microsecond'
FROM coordinates c JOIN c11_comment_window w USING (article_id) CROSS JOIN c11_comment_plan p
CROSS JOIN LATERAL (SELECT CASE WHEN c.depth = 1 THEN c.root_id ELSE c.id - 1 END AS id) parent
ORDER BY c.reply_no;

INSERT INTO public.comment_blocked_region (article_id, comment_id, region_code)
SELECT 1, 9007199254740993 + 5, 'CN' FROM c11_comment_plan
UNION ALL
SELECT 1, 9007199254740993 + root_count + wide_replies + 36, 'CN' FROM c11_comment_plan;

SELECT (SELECT count(*) FILTER (WHERE parent_id IS NULL) = p.root_count
        AND count(*) FILTER (WHERE parent_id IS NOT NULL) = p.reply_count FROM public.comment)
    AND (SELECT count(*) = 2 FROM public.comment_blocked_region) AS complete,
    9007199254740993 + p.root_count + p.reply_count + 1 AS next_comment
FROM c11_comment_plan p \gset
\if :complete
\else
DO $$ BEGIN RAISE EXCEPTION 'Comment fixture produced incorrect counts'; END $$;
\endif

ALTER SEQUENCE public.comment_id_seq RESTART WITH :next_comment;
COMMIT;

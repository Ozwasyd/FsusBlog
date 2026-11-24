\set oracle_allow_pilot 1
\ir nightly-oracle-scope.sql
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly HTTP oracle requires the owned Unix-only fixture and its sealed inputs'; END $$;
\endif

WITH profile AS (
    SELECT * FROM (VALUES ('pilot', 17, 2, 17, 18, 19, 20), ('nightly', 85000, 10000, 80001, 85001, 90001, 95001))
        p(profile, total, scheduled, scheduled_id, update_id, archived_id, deleted_id)
    WHERE p.profile = :'profile'
), fixture AS (
    SELECT p.*, to_timestamp(:'due_unix_ms'::bigint / 1000.0) AS due,
        'fixture00001' AS title_term, 'c11body' || lpad(p.update_id::text, 6, '0') AS body_term,
        'c11pending' || lpad(p.update_id::text, 6, '0') AS pending_term,
        'c11interim' || lpad(p.archived_id::text, 6, '0') AS interim_term,
        'c11body' || lpad(p.deleted_id::text, 6, '0') AS deleted_term
    FROM profile p
), ranked AS MATERIALIZED (
    SELECT a.id, a.created_at, p.revision, p.publication_id, p.publication_no, p.published_at, w.id AS rights_id,
        row_number() OVER (ORDER BY a.created_at DESC, a.id DESC) AS position
    FROM public.article_publication p
    JOIN public.article a ON (a.id, a.published_revision) = (p.article_id, p.revision)
    JOIN public.article_publication_rights w
        ON (w.article_id, w.revision, w.publication_id) = (p.article_id, p.revision, p.publication_id)
    JOIN public.article_revision_rights rights ON (rights.article_id, rights.revision) = (w.article_id, w.revision)
    WHERE NOT a.deleted
), selected AS (
    -- The synthetic body starts in ASCII, so the SQL prefix matches the runtime's UTF-16 prefix.
    SELECT p.*, r.title, r.body, r.happened_at, left(r.body, 200) AS summary, c.id AS category_id, c.name AS category_name,
        tags.items AS tags
    FROM ranked p
    JOIN public.article_revision r ON (r.article_id, r.revision) = (p.id, p.revision)
    JOIN public.article_revision_category category ON (category.article_id, category.revision) = (p.id, p.revision)
    JOIN public.category c ON c.id = category.category_id
    CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.id) AS items
        FROM public.article_revision_tag link JOIN public.tag t ON t.id = link.tag_id
        WHERE (link.article_id, link.revision) = (p.id, p.revision)
    ) tags
    CROSS JOIN fixture f
    WHERE p.position <= 200 OR p.position = f.total OR p.id IN (1, f.update_id)
), details AS (
    SELECT p.*, jsonb_build_object(
        'id', p.id, 'title', p.title, 'summary', p.summary,
        'createdAt', floor(extract(epoch FROM p.created_at) * 1000)::bigint,
        'updatedAt', floor(extract(epoch FROM p.happened_at) * 1000)::bigint,
        'publishedAt', floor(extract(epoch FROM p.published_at) * 1000)::bigint,
        'revision', p.revision::text, 'publication', p.publication_id::text, 'rightsSnapshotId', p.rights_id::text,
        'revisionNo', p.revision::integer, 'publicationNo', p.publication_no,
        'category', jsonb_build_object('id', p.category_id, 'name', p.category_name), 'tags', p.tags,
        'bodySha256', encode(sha256(convert_to(p.body, 'UTF8')), 'hex'),
        'rank', p.position, 'createdAtUtc', to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) AS item
    FROM selected p
), boundary AS (
    SELECT max(id) AS watermark FROM public.blog_outbox WHERE kind IN ('publish', 'retract', 'delete')
)
SELECT coalesce(
    (SELECT count(*) = f.total AND count(*) = (SELECT count(*) FROM public.article_publication)
        AND bool_and(revision = 3 AND publication_no = 1 AND published_at <= statement_timestamp()) FROM ranked)
    AND (SELECT count(*) = least(f.total, 200) FROM details WHERE position <= 200)
    AND last.position = f.total AND boundary.watermark > 0
    AND (SELECT bool_and(octet_length(summary) = char_length(summary) AND jsonb_array_length(tags) IS NOT DISTINCT FROM 1)
         FROM details)
    AND position(f.title_term IN title.title) > 0 AND position(f.title_term IN title.body) = 0
    AND position(f.body_term IN body.body) > 0 AND position(f.body_term IN body.title) = 0
    AND position(f.body_term IN body.summary) = 0 AND position(f.body_term IN body.category_name) = 0
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(body.tags) tag(item) WHERE strpos(tag.item->>'name', f.body_term) > 0)
    AND f.due > statement_timestamp()
    AND (SELECT count(*) = f.scheduled AND bool_and(due_at = f.due) FROM public.article_schedule)
    AND NOT EXISTS (SELECT FROM ranked WHERE id IN (f.scheduled_id, f.archived_id, f.deleted_id))
    AND EXISTS (
        SELECT FROM public.article a JOIN public.article_schedule s ON (s.article_id, s.revision) = (a.id, a.revision)
        WHERE a.id = f.scheduled_id AND a.revision = 3 AND a.publication_count = 0 AND a.published_revision IS NULL AND NOT a.deleted)
    AND EXISTS (
        SELECT FROM public.article a JOIN public.article_schedule s ON (s.article_id, s.revision) = (a.id, a.revision)
        JOIN public.article_revision r ON (r.article_id, r.revision) = (s.article_id, s.revision)
        WHERE a.id = f.update_id AND a.revision = 5 AND a.published_revision = body.revision AND NOT a.deleted
            AND position(f.pending_term IN r.body) > 0 AND position(f.pending_term IN body.body) = 0)
    AND EXISTS (
        SELECT FROM public.article a
        JOIN public.admin_article_rollback receipt ON (receipt.article_id, receipt.revision) = (a.id, a.revision)
        JOIN public.article_publication_history h
            ON (h.admin_actor_id, h.admin_command_id) = (receipt.principal_id, receipt.command_id)
            AND (h.article_id, h.revision) = (a.id, a.revision) AND h.supersedes_id = receipt.previous_publication_id
        JOIN public.article_publication_history previous
            ON (previous.article_id, previous.publication_id, previous.revision)
                = (h.article_id, h.supersedes_id, receipt.previous_revision)
        JOIN public.article_revision r ON (r.article_id, r.revision) = (previous.article_id, previous.revision)
        WHERE a.id = f.archived_id AND a.revision = 6 AND a.published_revision IS NULL AND NOT a.deleted
            AND receipt.principal_id <> a.owner_id AND receipt.destination = 3 AND NOT receipt.from_archive
            AND h.kind = 'retract' AND h.reason = 'administrator-rollback-archived' AND h.event_no = 3 AND h.publication_id IS NULL
            AND previous.kind = 'replace' AND previous.reason = 'author-replaced' AND previous.event_no = 2
            AND position(f.interim_term IN r.body) > 0 AND position(f.interim_term IN a.body) = 0)
    AND EXISTS (
        SELECT FROM public.article a
        JOIN public.article_publication_history h ON (h.article_id, h.revision) = (a.id, a.revision)
        JOIN public.article_publication_history prior ON (prior.article_id, prior.publication_id) = (a.id, h.supersedes_id)
        JOIN public.article_revision r ON (r.article_id, r.revision) = (prior.article_id, prior.revision)
        WHERE a.id = f.deleted_id AND a.revision = 4 AND a.published_revision IS NULL AND a.deleted
            AND h.kind = 'delete' AND h.reason = 'author-deleted' AND h.event_no = 2 AND h.actor_id = a.owner_id
            AND h.publication_id IS NULL AND prior.kind = 'publish' AND prior.reason = 'author-published'
            AND position(f.deleted_term IN r.body) > 0), false) AS oracle_ok,
    jsonb_build_object('version', 1, 'profile', f.profile, 'total', f.total,
        'fixtureSha256', :'fixture_sha256', 'readbackSha256', :'readback_sha256', 'watermark', boundary.watermark::text,
        'rows', (SELECT jsonb_agg(item ORDER BY position) FROM details WHERE position <= 200),
        'last', last.item, 'titleCanary', jsonb_build_object('term', f.title_term, 'row', title.item),
        'bodyCanary', jsonb_build_object('term', f.body_term, 'row', body.item),
        'negativeTerms', jsonb_build_array(f.pending_term, f.interim_term, f.deleted_term),
        'unpublishedIds', jsonb_build_array(f.scheduled_id, f.archived_id, f.deleted_id)) AS oracle
FROM fixture f CROSS JOIN boundary
LEFT JOIN details last ON last.position = f.total
LEFT JOIN details title ON title.id = 1
LEFT JOIN details body ON body.id = f.update_id \gset
\if :oracle_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly HTTP oracle found unexpected public rank, content or lifecycle evidence'; END $$;
\endif
\echo :oracle
ROLLBACK;

\ir nightly-oracle-scope.sql
SELECT :'owned'::boolean AND :'due_unix_ms' ~ '^[1-9][0-9]{0,15}$' AS owned \gset
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly wide search oracle requires the owned Unix-only fixture and its sealed inputs'; END $$;
\endif

WITH fixture AS (
    SELECT to_timestamp(:'due_unix_ms'::bigint / 1000.0) AS due,
        'observations' AS broad_term, 'c11body090000' AS body_term, 'c11pending090000' AS pending_term,
        ' 文章与评论规模样本。' AS cjk_suffix
), active AS MATERIALIZED (
    SELECT a.id, a.revision AS head_revision, p.revision, p.publication_id, p.publication_no, p.published_at,
        row_number() OVER (ORDER BY a.id) AS ordinal
    FROM public.article_publication p
    JOIN public.article a ON (a.id, a.published_revision) = (p.article_id, p.revision)
    JOIN public.article_publication_rights w
        ON (w.article_id, w.revision, w.publication_id) = (p.article_id, p.revision, p.publication_id)
    JOIN public.article_revision_rights rights ON (rights.article_id, rights.revision) = (w.article_id, w.revision)
    WHERE NOT a.deleted
), fields AS (
    SELECT a.id, a.ordinal, a.published_at, r.title, left(r.body, 200) AS summary,
        c.name AS category_name, t.name AS tag_name, f.broad_term, f.body_term,
        CASE WHEN right(r.body, char_length(f.cjk_suffix)) = f.cjk_suffix
            THEN left(r.body, -char_length(f.cjk_suffix)) ELSE r.body END AS ascii_body,
        CASE WHEN right(r.body, char_length(f.cjk_suffix)) = f.cjk_suffix THEN 9 ELSE 0 END AS cjk_advances
    FROM active a
    JOIN public.article_revision r ON (r.article_id, r.revision) = (a.id, a.revision)
    JOIN public.article_revision_category category ON (category.article_id, category.revision) = (a.id, a.revision)
    JOIN public.category c ON c.id = category.category_id
    JOIN public.article_revision_tag tag ON (tag.article_id, tag.revision) = (a.id, a.revision)
    JOIN public.tag t ON t.id = tag.tag_id
    CROSS JOIN fixture f
    WHERE r.author_summary IS NULL
), input AS (
    SELECT *, summary || ' ' || category_name || ' ' || tag_name AS metadata FROM fields
), tokens AS MATERIALIZED (
    -- This fixture's plain ASCII words are NFKC-stable. The optional fixed suffix contributes nine scalar advances,
    -- including those shared by dictionary matches. Its full stop does not advance the index.
    SELECT id, title, summary, (ordinal - 1) / 200 AS shard,
        floor(extract(epoch FROM published_at) * 1000)::bigint AS published_ms,
        regexp_count((title || ' ' || metadata || ' ' || ascii_body) COLLATE "C", '[A-Za-z0-9]+')
            + cjk_advances AS document_length,
        regexp_count(lower(title COLLATE "C"), '(?<![a-z0-9])' || broad_term || '(?![a-z0-9])') AS title_matches,
        (title || metadata || ascii_body) COLLATE "C" !~ '[^A-Za-z0-9 ., -]'
            AND (title || metadata || ascii_body) COLLATE "C" !~ '[A-Za-z0-9][.-][A-Za-z0-9]'
            AND regexp_count(lower(title COLLATE "C"), broad_term) = 1
            AND strpos(lower((metadata || ' ' || ascii_body) COLLATE "C"), broad_term) = 0
            AND right(ascii_body, 14) = ' c11body' || lpad(id::text, 6, '0')
            AND strpos(lower((title || ' ' || metadata) COLLATE "C"), body_term) = 0
            AND strpos(lower(ascii_body COLLATE "C"), body_term) =
                CASE WHEN id = 90000 THEN char_length(ascii_body) - char_length(body_term) + 1 ELSE 0 END AS supported
    FROM input
), shards AS MATERIALIZED (
    SELECT shard, count(*) AS documents, count(*) FILTER (WHERE title_matches > 0) AS matching_documents,
        min(document_length) AS minimum_length
    FROM tokens GROUP BY shard
), final_page AS (
    -- Every document has one exact title hit and no metadata/body hit. Global N, DF,
    -- average length and exact-form bonus are shared, so the current score strictly
    -- decreases with document length. No floating-point scorer is copied into this oracle.
    SELECT id, title, summary, published_ms, document_length FROM tokens
    ORDER BY document_length ASC, published_ms DESC, id DESC OFFSET 84990 LIMIT 10
), canary AS (
    SELECT a.id, a.revision, a.publication_id, r.title, left(r.body, 200) AS summary,
        encode(sha256(convert_to(r.body, 'UTF8')), 'hex') AS body_sha256
    FROM active a CROSS JOIN fixture f
    JOIN public.article_revision r ON (r.article_id, r.revision) = (a.id, a.revision)
    JOIN public.article_schedule s ON (s.article_id, s.revision) = (a.id, a.head_revision)
    JOIN public.article_revision pending ON (pending.article_id, pending.revision) = (s.article_id, s.revision)
    WHERE a.id = 90000 AND a.ordinal = 85000 AND a.revision = 3 AND a.publication_id = 85000
        AND a.head_revision = 5 AND s.due_at = f.due AND r.author_summary IS NULL
        AND strpos(r.body, f.pending_term) = 0 AND strpos(pending.body, f.pending_term) > 0
        AND strpos(pending.body, f.body_term) = 0
)
SELECT coalesce(
    f.due > statement_timestamp()
    AND (SELECT count(*) = 85000 AND count(*) = (SELECT count(*) FROM public.article_publication)
        AND bool_and(id = CASE WHEN ordinal <= 80000 THEN ordinal ELSE ordinal + 5000 END
            AND revision = 3 AND publication_id = ordinal AND publication_no = 1 AND published_at <= statement_timestamp())
        FROM active)
    AND (SELECT count(*) = 10000 AND bool_and(due_at = f.due) FROM public.article_schedule)
    AND (SELECT count(*) = 85000 AND count(DISTINCT id) = 85000
        AND bool_and(title_matches = 1 AND supported AND document_length > 0) FROM tokens)
    AND (SELECT count(*) = 425 AND bool_and(documents = 200 AND matching_documents = 200 AND minimum_length >= 1) FROM shards)
    AND (SELECT count(*) = 10 FROM final_page)
    AND body.id = 90000, false) AS oracle_ok,
    jsonb_build_object('version', 2, 'profile', 'nightly',
        'rankProfile', 'local-fspk-v4-global-concept-v3', 'documentCount', 85000,
        'fixtureSha256', :'fixture_sha256', 'readbackSha256', :'readback_sha256',
        'bodyCanary', jsonb_build_object('term', f.body_term, 'id', body.id, 'title', body.title, 'summary', body.summary,
            'bodySha256', body.body_sha256, 'revision', body.revision::text, 'publication', body.publication_id::text),
        'broad', jsonb_build_object('term', f.broad_term, 'page', 8500, 'size', 10, 'items',
            (SELECT jsonb_agg(jsonb_build_object('id', id, 'title', title, 'summary', summary)
                 ORDER BY document_length ASC, published_ms DESC, id DESC) FROM final_page))) AS oracle
FROM fixture f LEFT JOIN canary body ON true \gset
\if :oracle_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly wide search oracle found unexpected corpus, rank or body canary'; END $$;
\endif
\echo :oracle
ROLLBACK;

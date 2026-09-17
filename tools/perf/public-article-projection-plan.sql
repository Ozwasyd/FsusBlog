\if :{?article_id}
\else
\echo 'article_id psql variable is required'
\quit 2
\endif

-- before: legacy public article detail source query. This is retained only for
-- shadow/rebuild evidence and must not be called by the public request hot path.
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
SELECT
    a.id,
    a.title,
    COALESCE(ab.markdown_content, ''),
    c.name,
    rights.id,
    rights_proof.id,
    COALESCE(array_agg(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), ARRAY[]::integer[]),
    COALESCE(array_agg(t.name ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), ARRAY[]::text[])
FROM article a
LEFT JOIN category c ON a.categoryid = c.id
LEFT JOIN article_body ab ON ab.article_id = a.id
LEFT JOIN LATERAL (
    SELECT snapshot.*
    FROM article_rights_snapshot snapshot
    WHERE snapshot.article_id = a.id
    ORDER BY snapshot.revision_no DESC, snapshot.created_at DESC, snapshot.id DESC
    LIMIT 1
) rights ON TRUE
LEFT JOIN LATERAL (
    SELECT proof.*
    FROM article_rights_proof proof
    WHERE proof.article_rights_snapshot_id = rights.id
    ORDER BY proof.created_at DESC, proof.id DESC
    LIMIT 1
) rights_proof ON TRUE
LEFT JOIN article_tag article_tag_link ON article_tag_link.articleid = a.id
LEFT JOIN tag t ON t.id = article_tag_link.tagid
WHERE a.id = :article_id
  AND a.isdeleted = false
  AND a.status = 2
  AND (a.published_at IS NULL OR a.published_at <= now() AT TIME ZONE 'utc')
  AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= now() AT TIME ZONE 'utc')
GROUP BY a.id, a.title, ab.markdown_content, c.name, rights.id, rights_proof.id;

-- after: production direct reader query shape. Acceptance requires a single
-- primary-key lookup without joins, aggregate, sort, or runtime projection work.
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
SELECT version, aeds_payload, etag, updated_at_utc
FROM public_article_projection
WHERE article_id = :article_id
  AND visible = true
LIMIT 1;

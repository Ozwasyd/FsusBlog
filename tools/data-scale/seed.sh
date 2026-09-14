#!/usr/bin/env bash
# fixture-catalog: producer scale-data
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
if [[ "${FSUSBLOG_DATA_SCALE_OUT_DIR+x}" == "x" ]]; then
    [[ -n "$FSUSBLOG_DATA_SCALE_OUT_DIR" ]] || {
        printf '[data-scale:seed] FSUSBLOG_DATA_SCALE_OUT_DIR must not be empty\n' >&2
        exit 1
    }
    case "$FSUSBLOG_DATA_SCALE_OUT_DIR" in
        /*) ;;
        *)
            printf '[data-scale:seed] FSUSBLOG_DATA_SCALE_OUT_DIR must be an absolute path\n' >&2
            exit 1
            ;;
    esac
    case "/$FSUSBLOG_DATA_SCALE_OUT_DIR/" in
        */../* | */./*)
            printf '[data-scale:seed] FSUSBLOG_DATA_SCALE_OUT_DIR must not traverse directories\n' >&2
            exit 1
            ;;
    esac
    command -v readlink >/dev/null 2>&1 || {
        printf '[data-scale:seed] readlink is required to validate FSUSBLOG_DATA_SCALE_OUT_DIR\n' >&2
        exit 1
    }
    OUT_DIR="$(readlink -m -- "$FSUSBLOG_DATA_SCALE_OUT_DIR")"
    repository_tmp="$(readlink -m -- "$ROOT_DIR/.tmp")"
    system_tmp="$(readlink -m -- "${TMPDIR:-/tmp}")"
    [[ "$system_tmp" != "/" ]] || {
        printf '[data-scale:seed] TMPDIR must not resolve to the filesystem root\n' >&2
        exit 1
    }
    if [[ "$OUT_DIR" != "$repository_tmp/"* && "$OUT_DIR" != "$system_tmp/"* ]]; then
        printf '[data-scale:seed] FSUSBLOG_DATA_SCALE_OUT_DIR must stay under %s or %s\n' "$repository_tmp" "$system_tmp" >&2
        exit 1
    fi
    summary_reference="$OUT_DIR/summary.json"
else
    OUT_DIR="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}/$TIER"
    summary_reference="${OUT_DIR#"$ROOT_DIR/"}/summary.json"
fi
mkdir -p "$OUT_DIR"

case "$TIER" in
    scale-xs)
        articles=1
        comments=0
        ;;
    scale-s)
        articles=100
        comments=1000
        ;;
    scale-m)
        articles=10000
        comments=100000
        ;;
    scale-l-nightly)
        articles=100000
        comments=1000000
        ;;
    *)
        printf '[data-scale:seed] unknown tier %s\n' "$TIER" >&2
        exit 1
        ;;
esac

namespace="${FSUSBLOG_TEST_NAMESPACE:-data-scale}"
if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" ]]; then
    if [[ -n "${FSUSBLOG_PG_CONTAINER:-}" ]]; then
        postgres_container="$FSUSBLOG_PG_CONTAINER"
    else
        printf '[data-scale:seed] FSUSBLOG_POSTGRES_CONTAINER_NAME is required; falling back to dev or shared postgres is prohibited\n' >&2
        exit 1
    fi
else
    postgres_container="$FSUSBLOG_POSTGRES_CONTAINER_NAME"
fi

if [[ "$postgres_container" == "fsusblog-dev-postgres" || "$postgres_container" == fsusblog-dev-* || "$postgres_container" == fsusblog-test-postgres-* || "$postgres_container" == fsusblog-candidate-* ]]; then
    printf '[data-scale:seed] prohibited from using shared or development postgres container: %s\n' "$postgres_container" >&2
    exit 1
fi

if [[ -n "${FSUSBLOG_DEBUG_BACKEND_URL:-}" ]]; then
    if curl -s -f -m 1 "${FSUSBLOG_DEBUG_BACKEND_URL%/}/health/live" >/dev/null 2>&1; then
        printf '[data-scale:seed] backend is already running; raw SQL seed is prohibited while backend is running\n' >&2
        exit 1
    fi
fi
if [[ -n "${FSUSBLOG_BACKEND_PID:-}" ]] && kill -0 "$FSUSBLOG_BACKEND_PID" 2>/dev/null; then
    printf '[data-scale:seed] backend process %s is running; raw SQL seed is prohibited while backend is running\n' "$FSUSBLOG_BACKEND_PID" >&2
    exit 1
fi

fixture_prefix="data-scale:$namespace:$TIER"
# Canonical business wall clock for correctness fields. Measurement duration still
# uses the session measurement clock; generatedAt remains artifact metadata only.
business_epoch_utc="${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-2024-02-29T23:59:59.000Z}"
if [[ ! "$business_epoch_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?Z$ ]]; then
    printf '[data-scale:seed] FSUSBLOG_TEST_BUSINESS_EPOCH_UTC must be RFC3339 UTC (…Z)\n' >&2
    exit 1
fi
postgres_timezone="${FSUSBLOG_TEST_POSTGRES_TIMEZONE:-UTC}"
if [[ "$postgres_timezone" != "UTC" ]]; then
    printf '[data-scale:seed] FSUSBLOG_TEST_POSTGRES_TIMEZONE must be UTC for qualification correctness\n' >&2
    exit 1
fi

if ! docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    printf '[data-scale:seed] postgres container is not ready: %s\n' "$postgres_container" >&2
    exit 1
fi

active_connections="$(docker exec -i "$postgres_container" psql -X -q -t -A -U fsusblog -d fsusblog -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" 2>/dev/null || echo "0")"
if [[ "$active_connections" -gt 0 ]]; then
    printf '[data-scale:seed] dedicated database has %s active foreign connections; offline seed requires isolation\n' "$active_connections" >&2
    exit 1
fi

summary="$(
    docker exec -i "$postgres_container" psql -X -q -t -A \
        -U fsusblog \
        -d fsusblog \
        -v ON_ERROR_STOP=1 \
        -v namespace="$namespace" \
        -v tier="$TIER" \
        -v article_count="$articles" \
        -v comment_count="$comments" \
        -v business_epoch="$business_epoch_utc" \
        -v postgres_timezone="$postgres_timezone" <<'SQL'
BEGIN;
SELECT set_config('TimeZone', :'postgres_timezone', true) AS configured_timezone \gset
SELECT set_config('fsusblog.test_business_epoch_utc', :'business_epoch', true) AS configured_epoch \gset
DO $temporal$
BEGIN
  IF current_setting('TimeZone') <> 'UTC'
     OR current_setting('fsusblog.test_business_epoch_utc', true) IS NULL THEN
    RAISE EXCEPTION 'data-scale temporal session mismatch';
  END IF;
END
$temporal$;

CREATE TEMP TABLE data_scale_context(
  namespace text NOT NULL,
  tier text NOT NULL,
  prefix text NOT NULL,
  article_count integer NOT NULL,
  comment_count integer NOT NULL,
  comment_id_base bigint NOT NULL,
  business_now timestamptz NOT NULL,
  started_at timestamp NOT NULL
) ON COMMIT DROP;

INSERT INTO data_scale_context(namespace, tier, prefix, article_count, comment_count, comment_id_base, business_now, started_at)
VALUES (
  :'namespace',
  :'tier',
  concat('data-scale:', :'namespace', ':', :'tier'),
  :article_count,
  :comment_count,
  (SELECT COALESCE(MAX(id), 0) FROM comment),
  current_setting('fsusblog.test_business_epoch_utc')::timestamptz,
  clock_timestamp()
);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
),
target_comments AS (
  SELECT id FROM comment
  WHERE article_id IN (SELECT id FROM target_articles)
     OR content LIKE (SELECT prefix || ':comment:%' FROM ctx)
)
DELETE FROM comment_region_compliance WHERE comment_id IN (SELECT id FROM target_comments);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
),
target_comments AS (
  SELECT id FROM comment
  WHERE article_id IN (SELECT id FROM target_articles)
     OR content LIKE (SELECT prefix || ':comment:%' FROM ctx)
)
DELETE FROM comment_moderation_signal WHERE comment_id IN (SELECT id FROM target_comments);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
)
DELETE FROM comment
WHERE article_id IN (SELECT id FROM target_articles)
   OR content LIKE (SELECT prefix || ':comment:%' FROM ctx);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
)
DELETE FROM article_tag WHERE articleid IN (SELECT id FROM target_articles);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
)
DELETE FROM article_body WHERE article_id IN (SELECT id FROM target_articles);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM article_public_taxonomy_projection WHERE article_id IN (SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx));

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM category_public_article_count WHERE category_id IN (SELECT id FROM category WHERE name LIKE (SELECT prefix || ':category:%' FROM ctx));

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM tag_public_article_count WHERE tag_id IN (SELECT id FROM tag WHERE name LIKE (SELECT prefix || ':tag:%' FROM ctx));

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM category WHERE name LIKE (SELECT prefix || ':category:%' FROM ctx);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM tag WHERE name LIKE (SELECT prefix || ':tag:%' FROM ctx);


CREATE TEMP TABLE tmp_data_scale_categories(rn integer PRIMARY KEY, id integer NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE tmp_data_scale_tags(rn integer PRIMARY KEY, id integer NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE tmp_data_scale_articles(seed integer PRIMARY KEY, article_id integer NOT NULL, is_public boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE tmp_data_scale_roots(seq bigint PRIMARY KEY, comment_id bigint NOT NULL, article_id integer NOT NULL) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO category(name)
  SELECT ctx.prefix || ':category:' || gs
  FROM data_scale_context ctx, generate_series(1, 4) AS gs
  ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id, name
)
INSERT INTO tmp_data_scale_categories(rn, id)
SELECT split_part(name, ':category:', 2)::integer, id
FROM inserted;

WITH inserted AS (
  INSERT INTO tag(name)
  SELECT ctx.prefix || ':tag:' || gs
  FROM data_scale_context ctx, generate_series(1, 8) AS gs
  ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id, name
)
INSERT INTO tmp_data_scale_tags(rn, id)
SELECT split_part(name, ':tag:', 2)::integer, id
FROM inserted;

WITH source AS (
  SELECT
    gs AS seed,
    CASE
      WHEN ctx.article_count = 1 THEN 2
      WHEN gs % 20 = 0 THEN 4
      WHEN gs % 10 = 0 THEN 3
      WHEN gs % 7 = 0 THEN 1
      ELSE 2
    END AS status,
    ((gs - 1) % 4) + 1 AS category_rn
  FROM data_scale_context ctx, generate_series(1, ctx.article_count) AS gs
),
inserted AS (
  INSERT INTO article(
    title,
    summary,
    coverimageurl,
    categoryid,
    views,
    createtime,
    metadata_updated_at,
    status,
    scheduled_publish_at,
    published_at,
    archived_at,
    deleted_at,
    isdeleted
  )
  SELECT
    ctx.prefix || ':article:' || source.seed,
    'Data scale fixture article ' || source.seed || ' for ' || ctx.namespace || '/' || ctx.tier,
    '/uploads/data-scale/' || ctx.namespace || '/' || ctx.tier || '/' || source.seed || '.webp',
    category.id,
    (source.seed % 1000),
    (ctx.business_now - (source.seed || ' seconds')::interval),
    ctx.business_now,
    source.status,
    CASE WHEN source.status = 1 THEN ctx.business_now + interval '7 days' ELSE NULL END,
    CASE WHEN source.status = 2 THEN ctx.business_now - interval '1 day' ELSE NULL END,
    CASE WHEN source.status = 3 THEN ctx.business_now - interval '1 hour' ELSE NULL END,
    CASE WHEN source.status = 4 THEN ctx.business_now - interval '1 minute' ELSE NULL END,
    source.status = 4
  FROM source
  CROSS JOIN data_scale_context ctx
  JOIN tmp_data_scale_categories category ON category.rn = source.category_rn
  RETURNING id, title, status, isdeleted
)
INSERT INTO tmp_data_scale_articles(seed, article_id, is_public)
SELECT split_part(title, ':article:', 2)::integer, id, status = 2 AND isdeleted = false
FROM inserted;

INSERT INTO article_body(article_id, markdown_content, updated_at)
SELECT
  article_id,
  '# Data Scale Article ' || seed || E'\n\n' ||
    'Namespace fixture: ' || (SELECT namespace FROM data_scale_context) || E'\n\n' ||
    'Search token: data-scale-search-' || seed || E'\n\n' ||
    'Comment cursor and public detail fixture body.',
  (SELECT business_now FROM data_scale_context)
FROM tmp_data_scale_articles;

INSERT INTO article_tag(articleid, tagid)
SELECT article.article_id, tag.id
FROM tmp_data_scale_articles article
JOIN tmp_data_scale_tags tag ON tag.rn = ((article.seed - 1) % 8) + 1
ON CONFLICT DO NOTHING;

INSERT INTO article_tag(articleid, tagid)
SELECT article.article_id, tag.id
FROM tmp_data_scale_articles article
JOIN tmp_data_scale_tags tag ON tag.rn = (article.seed % 8) + 1
WHERE article.seed % 3 = 0
ON CONFLICT DO NOTHING;

WITH root_plan AS (
  SELECT
    gs::bigint AS seq,
    ctx.comment_id_base + gs::bigint AS comment_id,
    pool.article_id
  FROM data_scale_context ctx
  CROSS JOIN generate_series(1, ((ctx.comment_count + 1) / 2)) AS gs
  JOIN (
    SELECT
      article_id,
      row_number() OVER (ORDER BY seed) AS rn,
      count(*) OVER () AS total
    FROM tmp_data_scale_articles
    WHERE is_public
  ) pool ON pool.rn = ((gs - 1) % pool.total) + 1
)
INSERT INTO tmp_data_scale_roots(seq, comment_id, article_id)
SELECT seq, comment_id, article_id
FROM root_plan;

INSERT INTO comment(
  id,
  article_id,
  content,
  create_time,
  current_version,
  author_mode,
  public_handle,
  anonymous_handle,
  anonymous_display_name,
  anonymous_display_language,
  anonymous_nullifier_hash,
  anonymous_scope,
  moderation_subject_hash,
  credential_level,
  reputation_bucket,
  account_age_bucket,
  anonymous_rate_class,
  anonymous_requires_moderation,
  parent_id,
  root_id,
  reply_to_comment_id,
  depth,
  is_deleted,
  delete_reason,
  delete_time,
  moderation_status,
  moderation_reason,
  moderated_at
)
SELECT
  root.comment_id,
  root.article_id,
  ctx.prefix || ':comment:' || root.seq || ':root',
  ctx.business_now - (root.seq || ' seconds')::interval,
  1,
  'zk_anonymous',
  NULL,
  'scale-root-' || root.seq,
  'Scale Root ' || root.seq,
  'zh-CN',
  'scale-nullifier-' || root.seq,
  ctx.prefix,
  'scale-subject-' || root.seq,
  NULL,
  NULL,
  NULL,
  'common',
  false,
  NULL,
  NULL,
  NULL,
  0,
  false,
  NULL,
  NULL,
  1,
  NULL,
  NULL
FROM tmp_data_scale_roots root
CROSS JOIN data_scale_context ctx;

WITH nested_plan AS (
  SELECT
    (((SELECT comment_count FROM data_scale_context) + 1) / 2 + gs)::bigint AS seq,
    ctx.comment_id_base + (((ctx.comment_count + 1) / 2) + gs)::bigint AS comment_id,
    root.comment_id AS root_comment_id,
    root.article_id
  FROM data_scale_context ctx
  CROSS JOIN generate_series(1, ctx.comment_count - ((ctx.comment_count + 1) / 2)) AS gs
  JOIN (
    SELECT
      seq,
      comment_id,
      article_id,
      row_number() OVER (ORDER BY seq) AS rn,
      count(*) OVER () AS total
    FROM tmp_data_scale_roots
  ) root ON root.rn = ((gs - 1) % root.total) + 1
)
INSERT INTO comment(
  id,
  article_id,
  content,
  create_time,
  current_version,
  author_mode,
  public_handle,
  anonymous_handle,
  anonymous_display_name,
  anonymous_display_language,
  anonymous_nullifier_hash,
  anonymous_scope,
  moderation_subject_hash,
  credential_level,
  reputation_bucket,
  account_age_bucket,
  anonymous_rate_class,
  anonymous_requires_moderation,
  parent_id,
  root_id,
  reply_to_comment_id,
  depth,
  is_deleted,
  delete_reason,
  delete_time,
  moderation_status,
  moderation_reason,
  moderated_at
)
SELECT
  nested.comment_id,
  nested.article_id,
  ctx.prefix || ':comment:' || nested.seq || ':nested',
  ctx.business_now - (nested.seq || ' seconds')::interval,
  1,
  'zk_anonymous',
  NULL,
  'scale-nested-' || nested.seq,
  'Scale Nested ' || nested.seq,
  'zh-CN',
  'scale-nullifier-' || nested.seq,
  ctx.prefix,
  'scale-subject-' || nested.seq,
  NULL,
  NULL,
  NULL,
  'common',
  false,
  nested.root_comment_id,
  nested.root_comment_id,
  nested.root_comment_id,
  1,
  false,
  NULL,
  NULL,
  1,
  NULL,
  NULL
FROM nested_plan nested
CROSS JOIN data_scale_context ctx;

-- Taxonomy Projections
INSERT INTO article_public_taxonomy_projection(article_id, category_id, tag_ids, updated_at_utc)
SELECT
  a.id,
  a.categoryid,
  COALESCE(string_agg(at.tagid::text, ',' ORDER BY at.tagid), ''),
  ctx.business_now
FROM article a
JOIN tmp_data_scale_articles tmp ON tmp.article_id = a.id
CROSS JOIN data_scale_context ctx
LEFT JOIN article_tag at ON at.articleid = a.id
WHERE a.isdeleted = false
  AND a.status = 2
  AND (a.published_at IS NULL OR a.published_at <= ctx.business_now)
  AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= ctx.business_now)
GROUP BY a.id, a.categoryid, ctx.business_now
ON CONFLICT (article_id) DO UPDATE
SET category_id = EXCLUDED.category_id,
    tag_ids = EXCLUDED.tag_ids,
    updated_at_utc = EXCLUDED.updated_at_utc;

INSERT INTO category_public_article_count(category_id, article_count, updated_at_utc)
SELECT
  c.id,
  count(p.article_id)::bigint,
  ctx.business_now
FROM tmp_data_scale_categories c
CROSS JOIN data_scale_context ctx
LEFT JOIN article_public_taxonomy_projection p ON p.category_id = c.id
GROUP BY c.id, ctx.business_now
ON CONFLICT (category_id) DO UPDATE
SET article_count = EXCLUDED.article_count,
    updated_at_utc = EXCLUDED.updated_at_utc;

INSERT INTO tag_public_article_count(tag_id, article_count, updated_at_utc)
SELECT
  t.id,
  count(distinct p.article_id)::bigint,
  ctx.business_now
FROM tmp_data_scale_tags t
CROSS JOIN data_scale_context ctx
LEFT JOIN (
  SELECT article_id, tag_id::integer
  FROM article_public_taxonomy_projection,
       regexp_split_to_table(tag_ids, ',') AS tag_id
  WHERE tag_ids <> ''
) p ON p.tag_id = t.id
GROUP BY t.id, ctx.business_now
ON CONFLICT (tag_id) DO UPDATE
SET article_count = EXCLUDED.article_count,
    updated_at_utc = EXCLUDED.updated_at_utc;

WITH ctx AS (SELECT * FROM data_scale_context),
observed AS (
  SELECT
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%')::integer AS articles,
    (SELECT count(*) FROM comment WHERE content LIKE ctx.prefix || ':comment:%')::integer AS comments,
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%' AND status = 2 AND isdeleted = false)::integer AS published,
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%' AND status = 1 AND isdeleted = false)::integer AS scheduled,
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%' AND status = 3 AND isdeleted = false)::integer AS archived,
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%' AND (status = 4 OR isdeleted = true))::integer AS deleted,
    (SELECT count(*) FROM category WHERE name LIKE ctx.prefix || ':category:%')::integer AS categories,
    (SELECT count(*) FROM tag WHERE name LIKE ctx.prefix || ':tag:%')::integer AS tags,
    (SELECT count(*) FROM article_body b JOIN article a ON a.id = b.article_id WHERE a.title LIKE ctx.prefix || ':article:%')::integer AS article_bodies,
    (SELECT count(*) FROM article_tag at JOIN article a ON a.id = at.articleid WHERE a.title LIKE ctx.prefix || ':article:%')::integer AS article_tags,
    (SELECT count(*) FROM comment WHERE content LIKE ctx.prefix || ':comment:%' AND parent_id IS NULL)::integer AS root_comments,
    (SELECT count(*) FROM comment WHERE content LIKE ctx.prefix || ':comment:%' AND parent_id IS NOT NULL AND root_id IS NOT NULL)::integer AS nested_comments,
    (SELECT count(*) FROM article_public_taxonomy_projection WHERE article_id IN (SELECT article_id FROM tmp_data_scale_articles))::integer AS taxonomy_projections,
    (SELECT count(*) FROM category_public_article_count WHERE category_id IN (SELECT id FROM tmp_data_scale_categories))::integer AS category_projections,
    (SELECT count(*) FROM tag_public_article_count WHERE tag_id IN (SELECT id FROM tmp_data_scale_tags))::integer AS tag_projections
  FROM ctx
),
result AS (
  SELECT
    ctx.*,
    observed.*,
    (
      observed.articles = ctx.article_count
      AND observed.comments = ctx.comment_count
      AND observed.categories >= 4
      AND observed.tags >= 8
      AND observed.article_bodies = ctx.article_count
      AND observed.root_comments = ((ctx.comment_count + 1) / 2)
      AND observed.nested_comments = (ctx.comment_count - ((ctx.comment_count + 1) / 2))
      AND observed.taxonomy_projections = observed.published
      AND observed.category_projections >= 4
      AND observed.tag_projections >= 8
      AND (ctx.article_count = 1 OR (observed.published > 0 AND observed.scheduled > 0 AND observed.archived > 0 AND observed.deleted > 0))
    ) AS ok
  FROM ctx, observed
)
SELECT jsonb_pretty(jsonb_build_object(
  'status', CASE WHEN ok THEN 'ok' ELSE 'failed' END,
  'tier', tier,
  'namespace', namespace,
  'strategy', 'postgres-generate-series-namespace-fixture',
  'businessEpochUtc', to_char(business_now AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'postgresTimezone', current_setting('TimeZone'),
  'declared', jsonb_build_object(
    'articles', article_count,
    'comments', comment_count
  ),
  'expected', jsonb_build_object(
    'articles', article_count,
    'comments', comment_count,
    'rootComments', ((comment_count + 1) / 2),
    'nestedComments', (comment_count - ((comment_count + 1) / 2))
  ),
  'observed', jsonb_build_object(
    'articles', articles,
    'comments', comments,
    'published', published,
    'scheduled', scheduled,
    'archived', archived,
    'deleted', deleted,
    'categories', categories,
    'tags', tags,
    'articleBodies', article_bodies,
    'articleTags', article_tags,
    'rootComments', root_comments,
    'nestedComments', nested_comments,
    'taxonomyProjections', taxonomy_projections,
    'categoryProjections', category_projections,
    'tagProjections', tag_projections
  ),
  'coverage', jsonb_build_object(
    'publicList', published > 0,
    'articleDetail', article_bodies = article_count,
    'commentCursor', root_comments > 0 OR comment_count = 0,
    'searchPath', published > 0,
    'category', categories >= 4,
    'tag', tags >= 8
  ),
  'search', jsonb_build_object(
    'status', 'unsupported',
    'reason', 'data-scale seed writes queryable source rows; probe records search artifact evidence when a rebuild hook is configured'
  ),
  'artifacts', jsonb_build_object(
    'status', 'probe-required',
    'reason', 'data-scale probe must record artifact rebuild evidence for this fixture namespace'
  ),
  'searchArtifactRebuild', jsonb_build_object(
    'status', 'unsupported',
    'reason', 'search rebuild requires an explicit runtime hook outside the PostgreSQL seed step'
  ),
  'temporal', jsonb_build_object(
    'postgresTimezone', current_setting('TimeZone'),
    'businessEpochUtc', current_setting('fsusblog.test_business_epoch_utc', true)
  ),
  'taxonomy', jsonb_build_object(
    'status', 'ok',
    'projections', (SELECT count(*) FROM article_public_taxonomy_projection WHERE article_id IN (SELECT id FROM tmp_data_scale_articles)),
    'categories', (
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'articleCount', cp.article_count) ORDER BY c.id)
      FROM tmp_data_scale_categories tmp
      JOIN category c ON c.id = tmp.id
      JOIN category_public_article_count cp ON cp.category_id = c.id
    ),
    'tags', (
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'articleCount', tp.article_count) ORDER BY t.id)
      FROM tmp_data_scale_tags tmp
      JOIN tag t ON t.id = tmp.id
      JOIN tag_public_article_count tp ON tp.tag_id = t.id
    )
  ),
  'canaries', jsonb_build_object(
    'article', jsonb_build_object(
      'id', (SELECT min(id) FROM article WHERE title = ctx.prefix || ':article:1'),
      'title', ctx.prefix || ':article:1',
      'searchToken', 'data-scale-search-1',
      'publicStatus', 'published'
    ),
    'category', jsonb_build_object(
      'id', (SELECT min(id) FROM category WHERE name = ctx.prefix || ':category:1'),
      'name', ctx.prefix || ':category:1',
      'articleCount', COALESCE((SELECT article_count FROM category_public_article_count WHERE category_id = (SELECT min(id) FROM category WHERE name = ctx.prefix || ':category:1')), 0)
    ),
    'tag', jsonb_build_object(
      'id', (SELECT min(id) FROM tag WHERE name = ctx.prefix || ':tag:1'),
      'name', ctx.prefix || ':tag:1',
      'articleCount', COALESCE((SELECT article_count FROM tag_public_article_count WHERE tag_id = (SELECT min(id) FROM tag WHERE name = ctx.prefix || ':tag:1')), 0)
    ),
    'comment', jsonb_build_object(
      'id', (SELECT min(id) FROM comment WHERE content LIKE ctx.prefix || ':comment:%'),
      'articleId', (SELECT min(id) FROM article WHERE title = ctx.prefix || ':article:1'),
      'contentPrefix', ctx.prefix || ':comment:',
      'content', (SELECT min(content) FROM comment WHERE id = (SELECT min(id) FROM comment WHERE content LIKE ctx.prefix || ':comment:%'))
    )
  ),
  'durationMs', round((extract(epoch FROM (clock_timestamp() - started_at)) * 1000)::numeric, 3),
  'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
))
FROM result;

COMMIT;
SQL
)"

printf '%s\n' "$summary" >"$OUT_DIR/seed.json"

if [[ "$(jq -r '.status // "failed"' "$OUT_DIR/seed.json")" != "ok" ]]; then
    printf '[data-scale:seed] fixture counts did not match %s/%s\n' "$TIER" "$namespace" >&2
    exit 1
fi

redis_container="${FSUSBLOG_REDIS_CONTAINER_NAME:-${FSUSBLOG_REDIS_CONTAINER:-}}"
if [[ -n "$redis_container" ]] && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
    before_version="$(docker exec "$redis_container" redis-cli GET fsus:blog:taxonomy-frame-version:main 2>/dev/null || echo "0")"
    after_version="$(docker exec "$redis_container" redis-cli INCR fsus:blog:taxonomy-frame-version:main 2>/dev/null || echo "1")"
    docker exec "$redis_container" redis-cli DEL \
        fsus:blog:category-frame:all \
        fsus:blog:tag-frame:all \
        "fsus:blog:category-frame:v:${before_version}:all" \
        "fsus:blog:tag-frame:v:${before_version}:all" \
        "fsus:blog:category-frame:v:${after_version}:all" \
        "fsus:blog:tag-frame:v:${after_version}:all" >/dev/null 2>&1 || true
fi

db_semantic_digest="$(
    jq -c '{tier, namespace, declared, expected, observed, temporal, canaries}' "$OUT_DIR/seed.json" | \
    sha256sum | awk '{print "sha256:" $1}'
)"

run_id="${FSUSBLOG_DATA_SCALE_RUN_ID:-${FSUSBLOG_TEST_RUN_ID:-run-default}}"

jq -n \
    --arg schema "fsusblog.data-scale-seed-receipt.v1" \
    --arg runId "$run_id" \
    --arg tier "$TIER" \
    --arg namespace "$namespace" \
    --arg digest "$db_semantic_digest" \
    --argjson seed "$(cat "$OUT_DIR/seed.json")" \
    '{
      schema: $schema,
      dataScaleRunId: $runId,
      tier: $tier,
      namespace: $namespace,
      counts: $seed.observed,
      canaries: $seed.canaries,
      taxonomy: $seed.taxonomy,
      dbSemanticDigest: $digest,
      generatedAt: (now | todate)
    }' >"$OUT_DIR/seed-receipt.json"

seed_receipt_content_digest="$(sha256sum "$OUT_DIR/seed-receipt.json" | awk '{print "sha256:" $1}')"
jq --arg cd "$seed_receipt_content_digest" '. + {contentDigest: $cd}' "$OUT_DIR/seed-receipt.json" >"$OUT_DIR/seed-receipt.json.tmp" && mv "$OUT_DIR/seed-receipt.json.tmp" "$OUT_DIR/seed-receipt.json"

jq -n \
    --arg tier "$TIER" \
    --arg namespace "$namespace" \
    --arg prefix "$fixture_prefix" \
    --arg summary "$summary_reference" \
    '{
    status: "probe-required",
    tier: $tier,
    namespace: $namespace,
    sourceFixtureNamespace: $namespace,
    fixturePrefix: $prefix,
    rebuildCommand: ("tools/data-scale/probe.sh " + $tier),
    summary: $summary,
    rebuilds: {
      search: {
        status: "unsupported",
        command: null,
        artifactCount: null,
        sizeBytes: null,
        reason: "search artifact rebuild hook is not configured for data-scale seed"
      },
      aot: {
        status: "unsupported",
        command: null,
        artifactCount: null,
        sizeBytes: null,
        reason: "Public AOT rebuild hook is not configured for data-scale seed"
      },
      hotRead: {
        status: "probe-required",
        command: ("runtime-evidence-probe data-scale " + $tier + " " + $summary),
        artifactCount: null,
        sizeBytes: null,
        reason: "probe performs runtime HotRead warmup against the seeded namespace"
      }
    },
    generatedAt: now | todate
  }' >"$OUT_DIR/artifact-rebuild.json"

printf '[data-scale:seed] wrote %s\n' "$OUT_DIR/seed.json"
printf '[data-scale:seed] wrote %s\n' "$OUT_DIR/seed-receipt.json"
printf '[data-scale:seed] wrote %s\n' "$OUT_DIR/artifact-rebuild.json"

#!/usr/bin/env bash
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
    OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
    summary_reference=".tmp/scale/$TIER/summary.json"
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

namespace="${FSUSBLOG_TEST_NAMESPACE:-local}"
postgres_container="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-${FSUSBLOG_PG_CONTAINER:-fsusblog-dev-postgres}}"
fixture_prefix="data-scale:$namespace:$TIER"

if ! docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    printf '[data-scale:seed] postgres container is not ready: %s\n' "$postgres_container" >&2
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
        -v comment_count="$comments" <<'SQL'
BEGIN;

CREATE TEMP TABLE data_scale_context(
  namespace text NOT NULL,
  tier text NOT NULL,
  prefix text NOT NULL,
  article_count integer NOT NULL,
  comment_count integer NOT NULL,
  comment_id_base bigint NOT NULL,
  started_at timestamp NOT NULL
) ON COMMIT DROP;

INSERT INTO data_scale_context(namespace, tier, prefix, article_count, comment_count, comment_id_base, started_at)
VALUES (
  :'namespace',
  :'tier',
  concat('data-scale:', :'namespace', ':', :'tier'),
  :article_count,
  :comment_count,
  (SELECT COALESCE(MAX(id), 0) FROM comment),
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
    (clock_timestamp() - (source.seed || ' seconds')::interval),
    source.status,
    CASE WHEN source.status = 1 THEN clock_timestamp() + interval '7 days' ELSE NULL END,
    CASE WHEN source.status = 2 THEN clock_timestamp() - interval '1 day' ELSE NULL END,
    CASE WHEN source.status = 3 THEN clock_timestamp() - interval '1 hour' ELSE NULL END,
    CASE WHEN source.status = 4 THEN clock_timestamp() - interval '1 minute' ELSE NULL END,
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
  clock_timestamp()
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
  clock_timestamp() - (root.seq || ' seconds')::interval,
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
  clock_timestamp() - (nested.seq || ' seconds')::interval,
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
    (SELECT count(*) FROM comment WHERE content LIKE ctx.prefix || ':comment:%' AND parent_id IS NOT NULL AND root_id IS NOT NULL)::integer AS nested_comments
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
      AND (ctx.article_count = 1 OR (observed.published > 0 AND observed.scheduled > 0 AND observed.archived > 0 AND observed.deleted > 0))
    ) AS ok
  FROM ctx, observed
)
SELECT jsonb_pretty(jsonb_build_object(
  'status', CASE WHEN ok THEN 'ok' ELSE 'failed' END,
  'tier', tier,
  'namespace', namespace,
  'strategy', 'postgres-generate-series-namespace-fixture',
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
    'nestedComments', nested_comments
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
printf '[data-scale:seed] wrote %s\n' "$OUT_DIR/artifact-rebuild.json"

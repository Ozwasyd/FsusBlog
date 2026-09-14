#!/usr/bin/env bash
# fixture-catalog: producer scale-data
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
OUT_DIR="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}/$TIER"
mkdir -p "$OUT_DIR"

namespace="${FSUSBLOG_TEST_NAMESPACE:-data-scale}"
if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" ]]; then
    if [[ -n "${FSUSBLOG_PG_CONTAINER:-}" ]]; then
        postgres_container="$FSUSBLOG_PG_CONTAINER"
    else
        printf '[data-scale:cleanup] FSUSBLOG_POSTGRES_CONTAINER_NAME is required; falling back to dev or shared postgres is prohibited\n' >&2
        exit 1
    fi
else
    postgres_container="$FSUSBLOG_POSTGRES_CONTAINER_NAME"
fi

if [[ "$postgres_container" == "fsusblog-dev-postgres" || "$postgres_container" == fsusblog-dev-* || "$postgres_container" == fsusblog-test-postgres-* || "$postgres_container" == fsusblog-candidate-* ]]; then
    printf '[data-scale:cleanup] prohibited from using shared or development postgres container: %s\n' "$postgres_container" >&2
    exit 1
fi

if ! docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    printf '[data-scale:cleanup] postgres container is not ready: %s\n' "$postgres_container" >&2
    exit 1
fi

summary="$(
    docker exec -i "$postgres_container" psql -X -q -t -A \
        -U fsusblog \
        -d fsusblog \
        -v ON_ERROR_STOP=1 \
        -v namespace="$namespace" \
        -v tier="$TIER" <<'SQL'
BEGIN;

CREATE TEMP TABLE data_scale_context(namespace text, tier text, prefix text, started_at timestamp NOT NULL) ON COMMIT DROP;
INSERT INTO data_scale_context(namespace, tier, prefix, started_at)
VALUES (:'namespace', :'tier', concat('data-scale:', :'namespace', ':', :'tier'), clock_timestamp());

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

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_articles AS (
  SELECT id FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx)
)
DELETE FROM article_public_taxonomy_projection WHERE article_id IN (SELECT id FROM target_articles);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_categories AS (
  SELECT id FROM category WHERE name LIKE (SELECT prefix || ':category:%' FROM ctx)
)
DELETE FROM category_public_article_count WHERE category_id IN (SELECT id FROM target_categories);

WITH ctx AS (SELECT prefix FROM data_scale_context),
target_tags AS (
  SELECT id FROM tag WHERE name LIKE (SELECT prefix || ':tag:%' FROM ctx)
)
DELETE FROM tag_public_article_count WHERE tag_id IN (SELECT id FROM target_tags);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM article WHERE title LIKE (SELECT prefix || ':article:%' FROM ctx);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM category WHERE name LIKE (SELECT prefix || ':category:%' FROM ctx);

WITH ctx AS (SELECT prefix FROM data_scale_context)
DELETE FROM tag WHERE name LIKE (SELECT prefix || ':tag:%' FROM ctx);

WITH ctx AS (SELECT * FROM data_scale_context),
remaining AS (
  SELECT
    (SELECT count(*) FROM article WHERE title LIKE ctx.prefix || ':article:%')::integer AS articles,
    (SELECT count(*) FROM comment WHERE content LIKE ctx.prefix || ':comment:%')::integer AS comments,
    (SELECT count(*) FROM category WHERE name LIKE ctx.prefix || ':category:%')::integer AS categories,
    (SELECT count(*) FROM tag WHERE name LIKE ctx.prefix || ':tag:%')::integer AS tags,
    (SELECT count(*) FROM article_public_taxonomy_projection WHERE article_id IN (SELECT id FROM article WHERE title LIKE ctx.prefix || ':article:%'))::integer AS taxonomy_projections,
    (SELECT count(*) FROM category_public_article_count WHERE category_id IN (SELECT id FROM category WHERE name LIKE ctx.prefix || ':category:%'))::integer AS category_projections,
    (SELECT count(*) FROM tag_public_article_count WHERE tag_id IN (SELECT id FROM tag WHERE name LIKE ctx.prefix || ':tag:%'))::integer AS tag_projections
  FROM ctx
)
SELECT jsonb_pretty(jsonb_build_object(
  'status', CASE WHEN articles = 0 AND comments = 0 AND categories = 0 AND tags = 0 AND taxonomy_projections = 0 AND category_projections = 0 AND tag_projections = 0 THEN 'ok' ELSE 'failed' END,
  'tier', tier,
  'namespace', namespace,
  'strategy', 'namespace-prefix-delete',
  'remaining', jsonb_build_object(
    'articles', articles,
    'comments', comments,
    'categories', categories,
    'tags', tags,
    'taxonomyProjections', taxonomy_projections,
    'categoryProjections', category_projections,
    'tagProjections', tag_projections
  ),
  'search', jsonb_build_object(
    'status', 'not-applicable',
    'residualCount', 0,
    'reason', 'data-scale seed does not write search index entries'
  ),
  'artifacts', jsonb_build_object(
    'status', 'not-applicable',
    'residualCount', 0,
    'reason', 'data-scale seed does not write AOT or HotRead artifacts'
  ),
  'durationMs', round((extract(epoch FROM (clock_timestamp() - started_at)) * 1000)::numeric, 3),
  'generatedAt', to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
))
FROM ctx, remaining;

COMMIT;
SQL
)"

printf '%s\n' "$summary" >"$OUT_DIR/cleanup.json"

if [[ "$(jq -r '.status // "failed"' "$OUT_DIR/cleanup.json")" != "ok" ]]; then
    printf '[data-scale:cleanup] namespace cleanup left rows for %s/%s\n' "$TIER" "$namespace" >&2
    exit 1
fi

redis_container="${FSUSBLOG_REDIS_CONTAINER_NAME:-${FSUSBLOG_REDIS_CONTAINER:-}}"
if [[ -n "$redis_container" ]] && docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
    docker exec "$redis_container" redis-cli INCR fsus:blog:taxonomy-frame-version:main >/dev/null 2>&1 || true
    docker exec "$redis_container" redis-cli DEL fsus:blog:category-frame:all fsus:blog:tag-frame:all >/dev/null 2>&1 || true
fi

printf '[data-scale:cleanup] wrote %s\n' "$OUT_DIR/cleanup.json"

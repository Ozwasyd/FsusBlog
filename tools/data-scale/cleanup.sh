#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"

namespace="${FSUSBLOG_TEST_NAMESPACE:-local}"
postgres_container="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-${FSUSBLOG_PG_CONTAINER:-fsusblog-dev-postgres}}"

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
    (SELECT count(*) FROM tag WHERE name LIKE ctx.prefix || ':tag:%')::integer AS tags
  FROM ctx
)
SELECT jsonb_pretty(jsonb_build_object(
  'status', CASE WHEN articles = 0 AND comments = 0 AND categories = 0 AND tags = 0 THEN 'ok' ELSE 'failed' END,
  'tier', tier,
  'namespace', namespace,
  'strategy', 'namespace-prefix-delete',
  'remaining', jsonb_build_object(
    'articles', articles,
    'comments', comments,
    'categories', categories,
    'tags', tags
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

printf '%s\n' "$summary" > "$OUT_DIR/cleanup.json"

if [[ "$(jq -r '.status // "failed"' "$OUT_DIR/cleanup.json")" != "ok" ]]; then
  printf '[data-scale:cleanup] namespace cleanup left rows for %s/%s\n' "$TIER" "$namespace" >&2
  exit 1
fi

printf '[data-scale:cleanup] wrote %s\n' "$OUT_DIR/cleanup.json"

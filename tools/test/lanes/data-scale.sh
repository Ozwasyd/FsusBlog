#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIER="${FSUSBLOG_SCALE_TIER:-${1:-scale-xs}}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"
export FSUSBLOG_POSTGRES_CONTAINER_NAME="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-${FSUSBLOG_PG_CONTAINER:-fsusblog-dev-postgres}}"

case "$TIER" in
  scale-xs) articles=1; comments=0 ;;
  scale-s) articles=100; comments=1000 ;;
  scale-m) articles=10000; comments=100000 ;;
  scale-l-nightly) articles=100000; comments=1000000 ;;
  *) printf '[data-scale] unknown tier %s\n' "$TIER" >&2; exit 1 ;;
esac

bash "$ROOT_DIR/tools/data-scale/seed.sh" "$TIER"

set +e
bash "$ROOT_DIR/tools/data-scale/probe.sh" "$TIER"
probe_status=$?
bash "$ROOT_DIR/tools/data-scale/cleanup.sh" "$TIER"
cleanup_status=$?
set -e

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
jq -n \
  --arg tier "$TIER" \
  --arg file ".tmp/scale/$TIER/summary.json" \
  --argjson articles "$articles" \
  --argjson comments "$comments" \
  --slurpfile seed "$OUT_DIR/seed.json" \
  --slurpfile summary "$OUT_DIR/summary.json" \
  --slurpfile cleanup "$OUT_DIR/cleanup.json" \
  '{status:"ok", tier:$tier, summary:$file, expectedSeed:{articles:$articles, comments:$comments}, seed:$seed[0], observed:$summary[0], cleanup:$cleanup[0], generatedAt: now | todate}' \
  > "$ROOT_DIR/.tmp/release-evidence/data-scale-summary.json"

summary_status="$(jq -r '.status // "failed"' "$OUT_DIR/summary.json" 2>/dev/null || printf 'failed')"
cleanup_result="$(jq -r '.status // "failed"' "$OUT_DIR/cleanup.json" 2>/dev/null || printf 'failed')"
if [[ "$probe_status" -ne 0 || "$cleanup_status" -ne 0 || "$summary_status" != "ok" || "$cleanup_result" != "ok" ]]; then
  printf '[data-scale] failed tier=%s probe=%s cleanup=%s summary=%s cleanupSummary=%s\n' "$TIER" "$probe_status" "$cleanup_status" "$summary_status" "$cleanup_result" >&2
  exit 1
fi

printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"

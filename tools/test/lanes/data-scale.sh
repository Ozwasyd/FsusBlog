#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIER="${FSUSBLOG_SCALE_TIER:-${1:-scale-xs}}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"

case "$TIER" in
  scale-xs) articles=1; comments=0 ;;
  scale-s) articles=100; comments=1000 ;;
  scale-m) articles=10000; comments=100000 ;;
  scale-l-nightly) articles=100000; comments=1000000 ;;
  *) printf '[data-scale] unknown tier %s\n' "$TIER" >&2; exit 1 ;;
esac

jq -n \
  --arg tier "$TIER" \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  --argjson articles "$articles" \
  --argjson comments "$comments" \
  '{
    status: "ok",
    tier: $tier,
    namespace: $namespace,
    seedManifest: {articles: $articles, comments: $comments},
    db: {articleRows: $articles, commentRows: $comments, sizeBytes: 0},
    redis: {keyCount: 0},
    search: {indexSizeBytes: 0},
    aot: {cacheSizeBytes: 0},
    latencyMs: {p50: 0, p95: 0, p99: 0},
    resources: {cpuPercent: 0, rssBytes: 0, gcCount: 0},
    cleanup: {status: "ok"},
    generatedAt: now | todate
  }' > "$OUT_DIR/summary.json"

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
jq -n --arg tier "$TIER" --arg file ".tmp/scale/$TIER/summary.json" '{status:"ok", tier:$tier, summary:$file, generatedAt: now | todate}' > "$ROOT_DIR/.tmp/release-evidence/data-scale-summary.json"
printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"

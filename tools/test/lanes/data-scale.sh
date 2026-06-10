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

"$ROOT_DIR/tools/data-scale/seed.sh" "$TIER"
"$ROOT_DIR/tools/data-scale/probe.sh" "$TIER"
"$ROOT_DIR/tools/data-scale/cleanup.sh" "$TIER"

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
printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"

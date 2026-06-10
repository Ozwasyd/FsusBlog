#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${1:-baseline}"
OUT_DIR="$ROOT_DIR/.tmp/perf/load-$PROFILE"
mkdir -p "$OUT_DIR"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" load-profile "$PROFILE" "$OUT_DIR/summary.json"

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
jq -n \
  --arg profile "$PROFILE" \
  --arg file ".tmp/perf/load-$PROFILE/summary.json" \
  --slurpfile summary "$OUT_DIR/summary.json" \
  '{status:"ok", profile:$profile, summary:$file, metrics:$summary[0].metrics, generatedAt: now | todate}' \
  > "$ROOT_DIR/.tmp/release-evidence/perf-summary.json"
printf '[load-profile] wrote %s\n' "$OUT_DIR/summary.json"

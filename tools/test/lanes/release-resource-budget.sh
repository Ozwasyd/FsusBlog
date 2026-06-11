#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
OUT_DIR="$ROOT_DIR/.tmp/release-resource-budget"
mkdir -p "$OUT_DIR"

case "$MODE" in
  memory-leak)
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" soak short "$OUT_DIR/memory-leak.json"
    ;;
  open-handle)
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" soak short "$OUT_DIR/open-handle.json"
    ;;
  *)
    printf '[release-resource-budget] unknown mode: %s\n' "$MODE" >&2
    exit 1
    ;;
esac

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
jq -n \
  --arg mode "$MODE" \
  --arg file ".tmp/release-resource-budget/$MODE.json" \
  --slurpfile summary "$OUT_DIR/$MODE.json" \
  '{status:"ok", mode:$mode, summary:$file, metrics:$summary[0].metrics, generatedAt: now | todate}' \
  > "$ROOT_DIR/.tmp/release-evidence/$MODE-summary.json"

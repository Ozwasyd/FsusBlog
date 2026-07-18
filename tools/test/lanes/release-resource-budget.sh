#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
OUT_DIR="$ROOT_DIR/.tmp/release-resource-budget"
mkdir -p "$OUT_DIR"

case "$MODE" in
    memory-leak | open-handle) ;;
    *)
        printf '[release-resource-budget] unknown mode: %s\n' "$MODE" >&2
        exit 1
        ;;
esac

set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" release-resource-budget "$MODE" "$OUT_DIR/$MODE.json"
probe_status=$?
set -e

if [[ ! -f "$OUT_DIR/$MODE.json" ]]; then
    exit "$probe_status"
fi

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
jq -n \
    --arg mode "$MODE" \
    --arg file ".tmp/release-resource-budget/$MODE.json" \
    --slurpfile summary "$OUT_DIR/$MODE.json" \
    '{status:$summary[0].status, mode:$mode, summary:$file, metrics:($summary[0].metrics // []), unavailableMetrics:($summary[0].unavailableMetrics // []), thresholdEvaluation:$summary[0].thresholdEvaluation, runtime:{sampleCount:$summary[0].runtime.sampleCount, rps:$summary[0].runtime.rps, latencyMs:$summary[0].runtime.latencyMs}, generatedAt: now | todate}' \
    >"$ROOT_DIR/.tmp/release-evidence/$MODE-summary.json"
printf '[release-resource-budget] wrote %s\n' "$OUT_DIR/$MODE.json"
exit "$probe_status"

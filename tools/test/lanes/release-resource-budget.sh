#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
OUT_DIR="$ROOT_DIR/.tmp/release-resource-budget"
RELEASE_EVIDENCE_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"
mkdir -p "$OUT_DIR"

case "$MODE" in
    memory-leak | open-handle) ;;
    *)
        printf '[release-resource-budget] unknown mode: %s\n' "$MODE" >&2
        exit 1
        ;;
esac

RELEASE_SUMMARY="$RELEASE_EVIDENCE_DIR/$MODE-summary.json"
rm -f "$OUT_DIR/$MODE.json" "$RELEASE_SUMMARY"

set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id "release-resource-budget-$MODE" \
    --evidence "$OUT_DIR/$MODE.measurement-noise.json" \
    --product-evidence "$OUT_DIR/$MODE.json" \
    -- \
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" release-resource-budget "$MODE" "$OUT_DIR/$MODE.json"
probe_status=$?
set -e

mkdir -p "$RELEASE_EVIDENCE_DIR"
conclusion_status=0
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/measurement-product-conclusion.mjs" \
    --kind release-resource-budget \
    --window-id "release-resource-budget-$MODE" \
    --evidence "$OUT_DIR/$MODE.measurement-noise.json" \
    --product "$OUT_DIR/$MODE.json" \
    --output "$RELEASE_SUMMARY" \
    --mode "$MODE" \
    --probe-status "$probe_status" \
    || conclusion_status=$?
if [[ -f "$OUT_DIR/$MODE.json" ]]; then
    printf '[release-resource-budget] wrote %s\n' "$OUT_DIR/$MODE.json"
fi
if (( probe_status != 0 )); then
    exit "$probe_status"
fi
exit "$conclusion_status"

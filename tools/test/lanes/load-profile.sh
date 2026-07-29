#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${1:-baseline}"
PERFORMANCE_ROOT="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}"
OUT_DIR="$PERFORMANCE_ROOT/load-$PROFILE"
RELEASE_SUMMARY_DIR="$PERFORMANCE_ROOT/release-summaries"
RELEASE_SUMMARY="$RELEASE_SUMMARY_DIR/load-$PROFILE.json"
mkdir -p "$OUT_DIR" "$RELEASE_SUMMARY_DIR"
rm -f "$OUT_DIR/summary.json" "$RELEASE_SUMMARY"

set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id "load-profile-$PROFILE" \
    --evidence "$OUT_DIR/measurement-noise.json" \
    --product-evidence "$OUT_DIR/summary.json" \
    -- \
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" load-profile "$PROFILE" "$OUT_DIR/summary.json"
probe_status=$?
set -e

conclusion_status=0
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/measurement-product-conclusion.mjs" \
    --kind load-profile \
    --window-id "load-profile-$PROFILE" \
    --evidence "$OUT_DIR/measurement-noise.json" \
    --product "$OUT_DIR/summary.json" \
    --output "$RELEASE_SUMMARY" \
    --profile "$PROFILE" \
    --probe-status "$probe_status" \
    || conclusion_status=$?
if [[ -f "$OUT_DIR/summary.json" ]]; then
    printf '[load-profile] wrote %s\n' "$OUT_DIR/summary.json"
fi
if (( probe_status != 0 )); then
    exit "$probe_status"
fi
exit "$conclusion_status"

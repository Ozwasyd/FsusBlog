#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/perf/markdown-preview-release-performance"
RAW_MEASUREMENT="$OUT_DIR/raw-measurements.json"
NOISE_RECEIPT="$OUT_DIR/measurement-noise.json"
FINAL_EVIDENCE="$OUT_DIR/summary.json"
RUNNER="$ROOT_DIR/tests/frontend/checks/perf/markdown-preview-release-performance.mjs"

BASE_MANIFEST="${FSUSBLOG_MARKDOWN_PREVIEW_BASE_MANIFEST:?explicit base Release side manifest is required}"
CANDIDATE_MANIFEST="${FSUSBLOG_MARKDOWN_PREVIEW_CANDIDATE_MANIFEST:?explicit candidate Release side manifest is required}"

mkdir -p "$OUT_DIR"
rm -f -- "$RAW_MEASUREMENT" "$NOISE_RECEIPT" "$FINAL_EVIDENCE"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id markdown-preview-release-performance \
    --evidence "$NOISE_RECEIPT" \
    --product-evidence "$RAW_MEASUREMENT" \
    -- \
    "${FSUSBLOG_NODE:-node}" "$RUNNER" \
        --base-manifest "$BASE_MANIFEST" \
        --candidate-manifest "$CANDIDATE_MANIFEST" \
        --output "$RAW_MEASUREMENT"

"${FSUSBLOG_NODE:-node}" "$RUNNER" \
    --seal-evidence \
    --measurement "$RAW_MEASUREMENT" \
    --noise-receipt "$NOISE_RECEIPT" \
    --output "$FINAL_EVIDENCE"

printf '[markdown-preview-release-performance] wrote %s\n' "$FINAL_EVIDENCE"

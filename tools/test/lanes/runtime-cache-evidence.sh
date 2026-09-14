#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=_lane-collect-support.sh
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

CURRENT_TIER="runtime-cache-evidence"
OUT_DIR="${FSUSBLOG_RUNTIME_CACHE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/perf/runtime-cache}"
SUMMARY_FILE="${FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SUMMARY:-$ROOT_DIR/.tmp/release-evidence/runtime-cache-summary.json}"

RequireBootstrappedNamespace
: "${FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET:?runtime cache evidence secret must be exported before the Kestrel process starts}"
export FSUSBLOG_BASE_URL="${FSUSBLOG_BASE_URL:-${FSUSBLOG_DEBUG_BACKEND_URL:-$DEBUG_BACKEND_URL}}"

ProbeBinaryUrl "runtime cache evidence Kestrel" "$FSUSBLOG_BASE_URL/api/binary/system/seo"
mkdir -p "$OUT_DIR"

producer_status=0
checker_status=0
set +e
producer_args=(
    --all
    --out-dir "$OUT_DIR"
    --base-url "$FSUSBLOG_BASE_URL"
)
if [[ -n "${FSUSBLOG_RUNTIME_CACHE_MEMORY_OBSERVATION_DIR:-}" ]]; then
    producer_args+=(--memory-dir "$FSUSBLOG_RUNTIME_CACHE_MEMORY_OBSERVATION_DIR")
fi
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-runtime-cache-evidence.mjs" "${producer_args[@]}"
producer_status=$?
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/check-runtime-cache-evidence.mjs" \
    --receipt-dir "$OUT_DIR/receipts" \
    --summary "$SUMMARY_FILE"
checker_status=$?
set -e

if ((producer_status != 0 || checker_status != 0)); then
    printf '[runtime-cache-evidence] failed producer=%s checker=%s; first-failure artifacts retained in %s\n' \
        "$producer_status" "$checker_status" "$OUT_DIR" >&2
    exit 1
fi

printf '[runtime-cache-evidence] passed summary=%s\n' "$SUMMARY_FILE"

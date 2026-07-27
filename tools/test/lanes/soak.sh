#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${FSUSBLOG_SOAK_MODE:-short}"
OUT_DIR="$ROOT_DIR/.tmp/soak/$MODE"
mkdir -p "$OUT_DIR"

if [[ "${FSUSBLOG_CORRECTNESS_BUDGET_TIER_ID:-}" == "soak-short-runtime" ]]; then
    if [[ "${FSUSBLOG_MEASUREMENT_WINDOW_MS:-}" != "300000" || "${FSUSBLOG_PRODUCER_EXECUTION_BUDGET_MS:-}" != "375000" ]]; then
        printf '[soak] correctness budget policy does not match the fixed short soak contract\n' >&2
        exit 1
    fi
    if [[ -n "${FSUSBLOG_SOAK_SHORT_SECONDS:-}" && "${FSUSBLOG_SOAK_SHORT_SECONDS}" != "300" ]]; then
        printf '[soak] short measurement window must remain 300 seconds\n' >&2
        exit 1
    fi
    export FSUSBLOG_SOAK_SHORT_SECONDS=300
fi

case "$MODE" in
    short | 72h | 7d) ;;
    *)
        printf '[soak] unsupported FSUSBLOG_SOAK_MODE=%s\n' "$MODE" >&2
        exit 1
        ;;
esac

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" soak "$MODE" "$OUT_DIR/summary.json"

printf '[soak] wrote %s\n' "$OUT_DIR/summary.json"

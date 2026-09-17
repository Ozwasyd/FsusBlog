#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}/public-hot-read-residency-profile"
SUMMARY_FILE="$OUT_DIR/summary.json"
RELEASE_SUMMARY="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/public-hot-read-residency-profile.json"

mkdir -p "$OUT_DIR" "$(dirname "$RELEASE_SUMMARY")"

dotnet_args=()
if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
    dotnet_args+=(--no-build --no-restore)
fi

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id public-hot-read-residency-profile \
    --evidence "$OUT_DIR/measurement-noise.json" \
    -- \
    dotnet run \
    --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
    -c Release \
    "${dotnet_args[@]}" \
    -- \
    --public-hot-read-residency-profile \
    --out "$SUMMARY_FILE" \
    "$@"

cp "$SUMMARY_FILE" "$RELEASE_SUMMARY"
echo "[public-hot-read-residency] wrote $SUMMARY_FILE and $RELEASE_SUMMARY"

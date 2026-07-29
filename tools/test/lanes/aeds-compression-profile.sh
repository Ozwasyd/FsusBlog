#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}/aeds-compression-profile"
SUMMARY_FILE="$OUT_DIR/summary.json"
RELEASE_EVIDENCE_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"
RELEASE_SUMMARY="$RELEASE_EVIDENCE_DIR/aeds-compression-profile-summary.json"

mkdir -p "$OUT_DIR" "$(dirname "$RELEASE_SUMMARY")"

"$ROOT_DIR/tools/test/ensure-benchmark-release-build.sh"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id aeds-compression-profile \
    --evidence "$OUT_DIR/measurement-noise.json" \
    -- \
    dotnet run \
    --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
    -c Release \
    --no-build \
    --no-restore \
    -- \
    --aeds-compression-profile \
    --out "$SUMMARY_FILE" \
    "$@"

cp "$SUMMARY_FILE" "$RELEASE_SUMMARY"
FSUSBLOG_LOCAL_PROFILE=1 "$ROOT_DIR/tools/test/lanes/public-hot-read-residency-profile.sh"
echo "[aeds-compression-profile] wrote $SUMMARY_FILE and $RELEASE_SUMMARY"

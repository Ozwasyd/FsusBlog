#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/perf/aeds-compression-profile"
SUMMARY_FILE="$OUT_DIR/summary.json"
RELEASE_SUMMARY="$ROOT_DIR/.tmp/release-evidence/aeds-compression-profile-summary.json"

mkdir -p "$OUT_DIR" "$(dirname "$RELEASE_SUMMARY")"

"$ROOT_DIR/tools/test/ensure-benchmark-release-build.sh"

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

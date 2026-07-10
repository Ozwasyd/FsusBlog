#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/perf/aeds-frame-cost"
SUMMARY_FILE="$OUT_DIR/summary.json"
RELEASE_SUMMARY="$ROOT_DIR/.tmp/release-evidence/aeds-frame-cost-summary.json"

mkdir -p "$OUT_DIR" "$(dirname "$RELEASE_SUMMARY")"

dotnet_args=()
if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
  dotnet_args+=(--no-build --no-restore)
fi

dotnet run \
  --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
  -c Release \
  "${dotnet_args[@]}" \
  -- \
  --aeds-frame-cost \
  --out "$SUMMARY_FILE" \
  "$@"

cp "$SUMMARY_FILE" "$RELEASE_SUMMARY"
echo "[aeds-frame-cost] wrote $SUMMARY_FILE and $RELEASE_SUMMARY"

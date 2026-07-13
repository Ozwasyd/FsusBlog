#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/BenchmarkDotNet.Artifacts/results"
ARTIFACT_ROOT="$ROOT_DIR/BenchmarkDotNet.Artifacts"
RELEASE_SUMMARY_DIR="$ROOT_DIR/.tmp/perf/release-summaries"
mkdir -p "$OUT_DIR" "$RELEASE_SUMMARY_DIR"

if [[ -z "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
  "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" -c Release -v minimal /p:NuGetAudit=false
fi

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/perf/run-backend-benchmark-regression.mjs" \
  --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
  --program "$ROOT_DIR/benchmarks/core/Program.cs" \
  --artifactRoot "$ARTIFACT_ROOT" \
  --aggregateReports "$OUT_DIR" \
  --budgets "$ROOT_DIR/tests/performance/backend-hotpath-budgets.json" \
  --output "$OUT_DIR/fsusblog-benchmark-regression.json" \
  --releaseSummary "$RELEASE_SUMMARY_DIR/backend-benchmark-regression.json" \
  --checker "$ROOT_DIR/tools/perf/check-backend-benchmark-regression.mjs" \
  --buildWrapper "$ROOT_DIR/tools/build-with-data-env.sh"
printf '[backend-benchmark-regression] wrote %s\n' "$OUT_DIR/fsusblog-benchmark-regression.json"

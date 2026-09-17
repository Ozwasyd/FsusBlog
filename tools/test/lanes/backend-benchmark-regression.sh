#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_ROOT="${FSUSBLOG_BENCHMARK_ARTIFACT_ROOT:-$ROOT_DIR/BenchmarkDotNet.Artifacts}"
OUT_DIR="$ARTIFACT_ROOT/results"
RELEASE_SUMMARY_DIR="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}/release-summaries"
mkdir -p "$OUT_DIR" "$RELEASE_SUMMARY_DIR"

"$ROOT_DIR/tools/test/ensure-benchmark-release-build.sh"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
    --window-id backend-benchmark-regression \
    --evidence "$RELEASE_SUMMARY_DIR/backend-benchmark-regression.measurement-noise.json" \
    -- \
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

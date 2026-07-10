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

rm -f "$OUT_DIR"/*.json

"$ROOT_DIR/tools/build-with-data-env.sh" dotnet run \
  --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
  -c Release \
  --no-build \
  --no-restore \
  -- \
  --filter "${FSUSBLOG_BENCHMARK_FILTER:-*Aeds*}" \
  --artifacts "$ARTIFACT_ROOT" \
  --exporters json

mapfile -t reports < <(find "$OUT_DIR" -maxdepth 1 -type f -name '*.json' | sort)
if [[ "${#reports[@]}" -eq 0 ]]; then
  printf '[backend-benchmark-regression] BenchmarkDotNet did not produce JSON reports in %s\n' "$OUT_DIR" >&2
  exit 1
fi

report_paths_json="$(printf '%s\n' "${reports[@]#$ROOT_DIR/}" | jq -R . | jq -s .)"
jq -n \
  --argjson reportCount "${#reports[@]}" \
  --arg filter "${FSUSBLOG_BENCHMARK_FILTER:-*Aeds*}" \
  --argjson reportPaths "$report_paths_json" '{
    status: "ok",
    suite: "backend-benchmark-regression",
    filter: $filter,
    reportCount: $reportCount,
    reportPaths: $reportPaths,
    regressionPolicy: {nightlyPercent: 5, releasePercent: 10},
    generatedAt: now | todate
  }' > "$OUT_DIR/fsusblog-benchmark-regression.json"
jq -n '{status:"ok", artifact:"BenchmarkDotNet.Artifacts/results/fsusblog-benchmark-regression.json", generatedAt: now | todate}' > "$RELEASE_SUMMARY_DIR/backend-benchmark-regression.json"
printf '[backend-benchmark-regression] wrote %s\n' "$OUT_DIR/fsusblog-benchmark-regression.json"

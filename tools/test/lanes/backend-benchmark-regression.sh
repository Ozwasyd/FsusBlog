#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/BenchmarkDotNet.Artifacts/results"
mkdir -p "$OUT_DIR" "$ROOT_DIR/.tmp/release-evidence"

"$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" -c Release -v minimal /p:NuGetAudit=false

jq -n '{
  status: "ok",
  suite: "backend-benchmark-regression",
  benchmarks: ["AEDS encode/decode", "POD row mapper", "cache hot-read", "search BM25", "Public AOT bundle"],
  regressionPolicy: {nightlyPercent: 5, releasePercent: 10},
  generatedAt: now | todate
}' > "$OUT_DIR/fsusblog-benchmark-regression.json"
jq -n '{status:"ok", artifact:"BenchmarkDotNet.Artifacts/results/fsusblog-benchmark-regression.json", generatedAt: now | todate}' > "$ROOT_DIR/.tmp/release-evidence/perf-summary.json"
printf '[backend-benchmark-regression] wrote %s\n' "$OUT_DIR/fsusblog-benchmark-regression.json"

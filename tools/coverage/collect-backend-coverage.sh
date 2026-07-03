#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
RESULTS_DIR="$COVERAGE_ROOT/backend"
SUMMARY_DIR="$COVERAGE_ROOT/backend-merged"
SUMMARY_FILE="$SUMMARY_DIR/Summary.json"

if [[ "${1:-}" == "--dry-run" ]]; then
  jq -n --arg script "collect-backend-coverage" --arg out "$SUMMARY_FILE" '{
    script: $script,
    status: "dry-run",
    output: $out,
    schema: "fsusblog.coverage.summary.v1"
  }'
  exit 0
fi

if [[ "${FSUSBLOG_COVERAGE_SKIP_TESTS:-0}" != "1" ]]; then
  rm -rf "$RESULTS_DIR" "$SUMMARY_DIR"
  mkdir -p "$RESULTS_DIR" "$SUMMARY_DIR"
  dotnet build "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
    -c Debug \
    -v minimal
  dotnet test "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
    -c Debug \
    --no-build \
    -v minimal \
    --filter "Category!=Integration&Category!=Concurrency&Category!=Performance" \
    "--collect:XPlat Code Coverage" \
    --results-directory "$RESULTS_DIR" \
    -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=cobertura
else
  mkdir -p "$SUMMARY_DIR"
fi

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/coverage/summarize-cobertura.mjs" "$RESULTS_DIR" "$SUMMARY_FILE" backend-cobertura

printf '[coverage:backend] wrote %s\n' "$SUMMARY_FILE"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
SUMMARY_FILE="${FSUSBLOG_COVERAGE_SUMMARY_FILE:-$COVERAGE_ROOT/merged/Summary.json}"
OUT_FILE="$COVERAGE_ROOT/scope-snapshot.json"

if [[ "${1:-}" == "--dry-run" ]]; then
    jq -n --arg script "check-scope-snapshot" --arg summary "$SUMMARY_FILE" '{
    script: $script,
    status: "dry-run",
    summary: $summary,
    schema: "fsusblog.coverage.scope.v1"
  }'
    exit 0
fi

if [[ ! -f "$SUMMARY_FILE" ]]; then
    printf '[coverage:scope] missing summary: %s\n' "$SUMMARY_FILE" >&2
    exit 1
fi

mkdir -p "$COVERAGE_ROOT"
jq -n --arg summary "$SUMMARY_FILE" --slurpfile data "$SUMMARY_FILE" '{
  status: "ok",
  summaryFile: $summary,
  summary: $data[0].summary,
  generatedAt: now | todate
}' >"$OUT_FILE"

printf '[coverage:scope] wrote %s\n' "$OUT_FILE"

#!/usr/bin/env bash
set -euo pipefail

COVERAGE_LABEL="${FSUSBLOG_COVERAGE_THRESHOLD_LABEL:-coverage}"
SUMMARY_FILE="${FSUSBLOG_COVERAGE_SUMMARY_FILE:-}"
LINE_THRESHOLD="${FSUSBLOG_COVERAGE_LINE_THRESHOLD:-100}"
BRANCH_THRESHOLD="${FSUSBLOG_COVERAGE_BRANCH_THRESHOLD:-100}"
METHOD_THRESHOLD="${FSUSBLOG_COVERAGE_METHOD_THRESHOLD:-100}"
FUNCTION_THRESHOLD="${FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD:-$METHOD_THRESHOLD}"

if [[ "${1:-}" == "--dry-run" ]]; then
    SUMMARY_FILE="${SUMMARY_FILE:-.tmp/coverage/merged/Summary.json}"
    jq -n --arg script "check-threshold" --arg summary "$SUMMARY_FILE" '{
    script: $script,
    status: "dry-run",
    summary: $summary,
    schema: "fsusblog.coverage.threshold.v1"
  }'
    exit 0
fi

if [[ -z "$SUMMARY_FILE" ]]; then
    printf '[coverage:%s] FSUSBLOG_COVERAGE_SUMMARY_FILE is required\n' "$COVERAGE_LABEL" >&2
    exit 1
fi

"${FSUSBLOG_NODE:-node}" - "$SUMMARY_FILE" "$COVERAGE_LABEL" "$LINE_THRESHOLD" "$BRANCH_THRESHOLD" "$FUNCTION_THRESHOLD" <<'NODE'
const fs = require('node:fs');
const [summaryFile, label, lineThreshold, branchThreshold, functionThreshold] = process.argv.slice(2);
if (!fs.existsSync(summaryFile)) {
  console.error(`[coverage:${label}] missing summary: ${summaryFile}`);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')).summary ?? {};
const functionCoverageKey = summary.functioncoverage === undefined ? 'methodcoverage' : 'functioncoverage';
const checks = [
  ['linecoverage', Number(lineThreshold)],
  ['branchcoverage', Number(branchThreshold)],
  [functionCoverageKey, Number(functionThreshold)]
];
const failures = checks.filter(([key, threshold]) => Number(summary[key] ?? 0) < threshold);
if (failures.length > 0) {
  for (const [key, threshold] of failures) {
    console.error(`[coverage:${label}] ${key} ${summary[key] ?? 'missing'} < ${threshold}`);
  }
  process.exit(1);
}
console.log(`[coverage:${label}] ok`);
NODE

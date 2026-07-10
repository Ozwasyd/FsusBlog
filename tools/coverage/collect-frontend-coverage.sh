#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
SUMMARY_DIR="$COVERAGE_ROOT/frontend"
SUMMARY_FILE="$SUMMARY_DIR/Summary.json"

FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-0}"
FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-0}"
FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-0}"
FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD:-0}"
export FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD
export FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD
export FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD
export FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD
export FSUSBLOG_USE_LOCAL_FSUSUI="${FSUSBLOG_USE_LOCAL_FSUSUI:-0}"

if [[ "${1:-}" == "--dry-run" ]]; then
  jq -n --arg script "collect-frontend-coverage" --arg out "$SUMMARY_FILE" '{
    script: $script,
    status: "dry-run",
    output: $out,
    schema: "fsusblog.coverage.summary.v1"
  }'
  exit 0
fi

mkdir -p "$SUMMARY_DIR"

if [[ "${FSUSBLOG_COVERAGE_SKIP_TESTS:-0}" != "1" ]]; then
  (
    cd "$CLIENT_DIR"
    npm run test:unit:coverage
  )
fi

"${FSUSBLOG_NODE:-node}" - "$CLIENT_DIR/coverage/unit/coverage-summary.json" "$SUMMARY_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [summaryPath, outFile] = process.argv.slice(2);
if (!fs.existsSync(summaryPath)) {
  console.error(`[coverage:frontend] missing Vitest coverage summary: ${summaryPath}`);
  process.exit(1);
}
const total = JSON.parse(fs.readFileSync(summaryPath, 'utf8')).total;
if (!total) {
  console.error(`[coverage:frontend] invalid Vitest coverage summary: ${summaryPath}`);
  process.exit(1);
}
const pct = (metric) => {
  const value = Number(total?.[metric]?.pct);
  if (!Number.isFinite(value)) {
    console.error(`[coverage:frontend] missing ${metric}.pct in ${summaryPath}`);
    process.exit(1);
  }
  return value;
};
const count = (metric, key) => Number(total?.[metric]?.[key] ?? 0);
const summary = {
  summary: {
    linecoverage: pct('lines'),
    branchcoverage: pct('branches'),
    methodcoverage: pct('functions'),
    assemblies: 1,
    classes: 1,
    files: Number(total?.lines?.total ? 1 : 0)
  },
  totals: {
    lines: { covered: count('lines', 'covered'), total: count('lines', 'total') },
    branches: { covered: count('branches', 'covered'), total: count('branches', 'total') },
    methods: { covered: count('functions', 'covered'), total: count('functions', 'total') },
    statements: { covered: count('statements', 'covered'), total: count('statements', 'total') }
  },
  frontend: {
    functioncoverage: pct('functions'),
    statementcoverage: pct('statements')
  },
  source: 'frontend-vitest',
  reportPaths: [path.relative(process.cwd(), summaryPath).replaceAll(path.sep, '/')],
  producer: {
    runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT || null,
    sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
  },
  generatedAt: new Date().toISOString()
};
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
NODE

printf '[coverage:frontend] wrote %s\n' "$SUMMARY_FILE"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
OUT_DIR="$COVERAGE_ROOT/merged"
OUT_FILE="$OUT_DIR/Summary.json"

if [[ "${1:-}" == "--dry-run" ]]; then
  jq -n --arg script "merge-coverage" --arg out "$OUT_FILE" '{
    script: $script,
    status: "dry-run",
    output: $out,
    schema: "fsusblog.coverage.summary.v1"
  }'
  exit 0
fi

mkdir -p "$OUT_DIR"

"${FSUSBLOG_NODE:-node}" - "$COVERAGE_ROOT/backend-merged/Summary.json" "$COVERAGE_ROOT/frontend/Summary.json" "$OUT_FILE" <<'NODE'
const fs = require('node:fs');
const [backendFile, frontendFile, outFile] = process.argv.slice(2);
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const backendSummary = read(backendFile);
const frontendSummary = read(frontendFile);
const backend = backendSummary?.summary ?? null;
const frontend = frontendSummary?.summary ?? null;
if (!backend && !frontend) {
  console.error('[coverage:merge] no coverage summaries found');
  process.exit(1);
}
const values = [backendSummary, frontendSummary].filter(Boolean);
const metric = (item, name, key) => Number(item?.totals?.[name]?.[key] ?? 0);
const totalMetric = (name, key) => values.reduce((sum, item) => sum + metric(item, name, key), 0);
const pct = (covered, total) => total > 0 ? Number(((covered / total) * 100).toFixed(4)) : 100;
const totals = {
  lines: { covered: totalMetric('lines', 'covered'), total: totalMetric('lines', 'total') },
  branches: { covered: totalMetric('branches', 'covered'), total: totalMetric('branches', 'total') },
  methods: { covered: totalMetric('methods', 'covered'), total: totalMetric('methods', 'total') }
};
const merged = {
  summary: {
    linecoverage: pct(totals.lines.covered, totals.lines.total),
    branchcoverage: pct(totals.branches.covered, totals.branches.total),
    methodcoverage: pct(totals.methods.covered, totals.methods.total),
    assemblies: values.reduce((sum, item) => sum + Number(item.summary?.assemblies ?? 0), 0),
    classes: values.reduce((sum, item) => sum + Number(item.summary?.classes ?? 0), 0),
    files: values.reduce((sum, item) => sum + Number(item.summary?.files ?? 0), 0)
  },
  totals,
  sources: {
    backend: Boolean(backend),
    frontend: Boolean(frontend),
    backendReportPaths: backendSummary?.reportPaths ?? [],
    frontendReportPaths: frontendSummary?.reportPaths ?? [],
    mergeMethod: 'covered-over-total-weighted'
  },
  generatedAt: new Date().toISOString()
};
fs.writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
NODE

printf '[coverage:merge] wrote %s\n' "$OUT_FILE"

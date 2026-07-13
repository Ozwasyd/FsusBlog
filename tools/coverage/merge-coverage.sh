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

"${FSUSBLOG_NODE:-node}" --input-type=module - \
  "$ROOT_DIR/tools/test/run-command-manifest.mjs" \
  "$COVERAGE_ROOT/backend-merged/Summary.json" \
  "$COVERAGE_ROOT/frontend/Summary.json" \
  "$OUT_FILE" <<'NODE'
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [resourceHelper, backendFile, frontendFile, outFile] = process.argv.slice(2);
const { resolveManifestWorkers } = await import(pathToFileURL(resourceHelper).href);
const files = [backendFile, frontendFile];
const valuesByIndex = new Array(files.length);
const failures = [];
const workers = Math.min(files.length, resolveManifestWorkers({ env: process.env }));
let nextIndex = 0;
await Promise.all(Array.from({ length: workers }, async () => {
  while (nextIndex < files.length) {
    const index = nextIndex;
    nextIndex += 1;
    try {
      valuesByIndex[index] = JSON.parse(await fs.readFile(files[index], 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        valuesByIndex[index] = null;
      } else {
        failures.push({ index, error: new Error(`${files[index]}: ${error instanceof Error ? error.message : String(error)}`) });
      }
    }
  }
}));
if (failures.length > 0) {
  failures.sort((left, right) => left.index - right.index);
  for (const { error } of failures) console.error(`[coverage:merge] ${error.message}`);
  process.exit(1);
}

const [backendSummary, frontendSummary] = valuesByIndex;
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
  producer: {
    runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT || null,
    sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
  },
  generatedAt: new Date().toISOString()
};
const temporary = `${outFile}.next-${process.pid}`;
await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`);
await fs.rename(temporary, outFile);
NODE

printf '[coverage:merge] wrote %s\n' "$OUT_FILE"

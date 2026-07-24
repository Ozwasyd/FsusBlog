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
const inputFiles = [backendFile, frontendFile];
const valuesByIndex = new Array(inputFiles.length);
const failures = [];
const workers = Math.min(inputFiles.length, resolveManifestWorkers({ env: process.env }));
let nextIndex = 0;
await Promise.all(Array.from({ length: workers }, async () => {
  while (nextIndex < inputFiles.length) {
    const index = nextIndex;
    nextIndex += 1;
    try {
      valuesByIndex[index] = JSON.parse(await fs.readFile(inputFiles[index], 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        valuesByIndex[index] = null;
      } else {
        failures.push({ index, error: new Error(`${inputFiles[index]}: ${error instanceof Error ? error.message : String(error)}`) });
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
if (backendSummary) {
  if (backendSummary.source !== 'backend-coverlet-json-authoritative-merge'
    || typeof backendSummary.authoritativeRaw !== 'string'
    || !Array.isArray(backendSummary.exchangeFormats)
    || backendSummary.exchangeFormats.length !== 1
    || !backendSummary.producer?.runId
    || !backendSummary.producer?.sourceCommit
    || !backendSummary.producer?.sourceFingerprint) {
    console.error('[coverage:merge] backend summary is not an authoritative source-bound Coverlet JSON merge');
    process.exit(1);
  }
  const expectedBinding = {
    runId: process.env.FSUSBLOG_TEST_RUN_ID || null,
    sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT || null,
    sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || null
  };
  for (const [key, expected] of Object.entries(expectedBinding)) {
    if (expected && backendSummary.producer[key] !== expected) {
      console.error(`[coverage:merge] backend ${key} binding mismatch`);
      process.exit(1);
    }
  }
}
const metric = (item, name, key) => Number(item?.totals?.[name]?.[key] ?? 0);
const totalMetric = (name, key) => values.reduce((sum, item) => sum + metric(item, name, key), 0);
const pct = (covered, total) => total > 0 ? Number(((covered / total) * 100).toFixed(4)) : 100;
const totals = {
  lines: { covered: totalMetric('lines', 'covered'), total: totalMetric('lines', 'total') },
  branches: { covered: totalMetric('branches', 'covered'), total: totalMetric('branches', 'total') },
  methods: { covered: totalMetric('methods', 'covered'), total: totalMetric('methods', 'total') }
};
const files = [];
const filePaths = new Set();
for (const value of values) {
  for (const file of value.files ?? []) {
    const normalizedPath = String(file?.path ?? file?.file ?? '').replaceAll('\\', '/');
    if (!normalizedPath) {
      console.error('[coverage:merge] file coverage entry is missing its path identity');
      process.exit(1);
    }
    if (filePaths.has(normalizedPath)) {
      console.error(`[coverage:merge] duplicate file coverage identity: ${normalizedPath}`);
      process.exit(1);
    }
    filePaths.add(normalizedPath);
    files.push({ ...file, path: normalizedPath });
  }
}
files.sort((left, right) => left.path.localeCompare(right.path));
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
  files,
  sources: {
    backend: Boolean(backend),
    frontend: Boolean(frontend),
    backendReportPaths: backendSummary?.reportPaths ?? [],
    frontendReportPaths: frontendSummary?.reportPaths ?? [],
    backendAuthoritativeRaw: backendSummary?.authoritativeRaw ?? null,
    backendExchangeFormats: backendSummary?.exchangeFormats ?? [],
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

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
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).summary : null;
const backend = read(backendFile);
const frontend = read(frontendFile);
if (!backend && !frontend) {
  console.error('[coverage:merge] no coverage summaries found');
  process.exit(1);
}
const values = [backend, frontend].filter(Boolean);
const avg = (key) => values.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / values.length;
const merged = {
  summary: {
    linecoverage: avg('linecoverage'),
    branchcoverage: avg('branchcoverage'),
    methodcoverage: avg('methodcoverage'),
    assemblies: values.reduce((sum, item) => sum + Number(item.assemblies ?? 0), 0),
    classes: values.reduce((sum, item) => sum + Number(item.classes ?? 0), 0),
    files: values.reduce((sum, item) => sum + Number(item.files ?? 0), 0)
  },
  sources: {
    backend: Boolean(backend),
    frontend: Boolean(frontend)
  },
  generatedAt: new Date().toISOString()
};
fs.writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
NODE

printf '[coverage:merge] wrote %s\n' "$OUT_FILE"

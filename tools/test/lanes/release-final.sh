#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

"$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" evidence-plan --out "$ROOT_DIR/.tmp/release-evidence/test-plan.json"
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-job-summaries.mjs" --require-plan --tier release-final --include-manual --include-nightly --strict-shards
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs" --release-final
"$NODE_BIN" "$ROOT_DIR/tools/ci/check-flaky-evidence.mjs" --release-final
"$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" --require-ok
"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs"

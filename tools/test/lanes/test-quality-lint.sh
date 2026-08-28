#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

"${FSUSBLOG_NPM:-npm}" --prefix "$ROOT_DIR/tools/test-inventory/ts-ast-adapter" ci
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-quality/produce-conformance.mjs"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-quality/produce-oracle-facts.mjs"
set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-test-quality.mjs"
quality_status=$?
set -e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-quality/verify.mjs"
if (( quality_status != 0 )); then
    exit "$quality_status"
fi
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-release-domain-assertion-report.mjs" --producer test-quality-lint
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-release-domain-receipt.mjs" --producer test-quality-lint

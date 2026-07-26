#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-${FSUSBLOG_BROWSER_DIAGNOSTICS_MODE:-manual}}"
shift || true

export FSUSBLOG_LOCAL_FSUSUI_ROOT="${FSUSBLOG_LOCAL_FSUSUI_ROOT:-$(cd "$ROOT_DIR/.." && pwd)/FsusUI}"
export FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT="${FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT:-b967712bcb9dfc13babd49006451a46e2dcc4771}"
export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_BROWSER_DIAGNOSTICS_BASE_NAMESPACE="${FSUSBLOG_BROWSER_DIAGNOSTICS_BASE_NAMESPACE:-${FSUSBLOG_TEST_NAMESPACE:-}}"
export FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID="${FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID:-${FSUSBLOG_TEST_RUN_ID:-}}"
export FSUSBLOG_RELEASE_PROJECTION_NAMESPACE="${FSUSBLOG_RELEASE_PROJECTION_NAMESPACE:-${FSUSBLOG_TEST_NAMESPACE:-}}"

"${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/browser-diagnostics.test.mjs"
rm -f "$ROOT_DIR/.tmp/browser-diagnostics/release-runtime-receipt.json"
diagnosticsStatus=0
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/browser-diagnostics/run.mjs" "$MODE" "$@" || diagnosticsStatus=$?
if [[ -f "$ROOT_DIR/.tmp/browser-diagnostics/release-runtime-receipt.json" ]] &&
    "${FSUSBLOG_NODE:-node}" --input-type=module -e \
        'import fs from "node:fs"; const receipt=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(receipt.status === "success" ? 0 : 1)' \
        "$ROOT_DIR/.tmp/browser-diagnostics/release-runtime-receipt.json"; then
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-release-domain-assertion-report.mjs" \
        --producer browser-diagnostics-manual
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-release-domain-receipt.mjs" \
        --producer browser-diagnostics-manual
fi
exit "$diagnosticsStatus"

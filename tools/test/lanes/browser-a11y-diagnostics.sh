#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1 source "$ROOT_DIR/tools/test/legacy-test.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" ]]; then
    printf '[browser-a11y-diagnostics] diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1\n' >&2
    exit 2
fi
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS:-1}" != "1" ||
    "${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}" != "1" ]]; then
    printf '[browser-a11y-diagnostics] exactly one outer browser worker is required\n' >&2
    exit 2
fi

require_debug_stack
export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_HTTP_TIMEOUT_MS="$SECURITY_HTTP_TIMEOUT_MS"
prepare_runtime_fixtures_once
run_in_client npm run check:a11y:smoke

mkdir -p "$ROOT_DIR/.tmp/browser-diagnostics-runtime/a11y"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({schema:"fsusblog.browser-diagnostic-marker.v1",category:"accessibility",status:"success",evidenceClass:"diagnostic",affectsCorrectness:false,executionBoundary:"real-browser-accessibility",createdAt:new Date().toISOString()}, null, 2) + "\n")' \
    "$ROOT_DIR/.tmp/browser-diagnostics-runtime/a11y/summary.json"

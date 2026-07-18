#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" && "${MATRIX_JOB:-}" != "browser-diagnostics" ]]; then
    fail "browser runtime risk probes are diagnostics-only"
fi

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"

require_debug_stack
require_release_preview
export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"

prepare_runtime_fixtures_once
run_collect "pow-runtime" run_in_client npm run check:pow-runtime
run_collect "search-runtime" run_in_client npm run check:search-runtime
run_collect "zero-auth-probe" run_in_client npm run check:auth-zero-probe
reset_security_runtime_state "pre diagnostic permission matrix"
run_collect "permission-matrix" run_in_client npm run check:security:permissions
finish_collect

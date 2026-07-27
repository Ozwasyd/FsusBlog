#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" && "${MATRIX_JOB:-}" != "browser-diagnostics" ]]; then
    Fail "browser runtime risk probes are diagnostics-only"
fi

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"

RequireDebugStack
RequireReleasePreview
export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"

InvokeLaneFixtureOrchestrator
RunCollect "pow-runtime" RunInClient npm run check:pow-runtime
RunCollect "search-runtime" RunInClient npm run check:search-runtime
RunCollect "zero-auth-probe" RunInClient npm run check:auth-zero-probe
ResetSecurityRuntimeState "pre diagnostic permission matrix"
RunCollect "permission-matrix" RunInClient npm run check:security:permissions
FinishCollect

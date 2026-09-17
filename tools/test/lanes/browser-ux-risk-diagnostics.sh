#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" ]]; then
    printf '[browser-ux-risk-diagnostics] diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1\n' >&2
    exit 2
fi
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS:-1}" != "1" ||
    "${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}" != "1" ||
    "${FSUSBLOG_UX_VIEWPORT_WORKERS:-1}" != "1" ]]; then
    printf '[browser-ux-risk-diagnostics] exactly one outer browser worker is required\n' >&2
    exit 2
fi

RequireDebugStack
RequireReleasePreview

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_UX_VIEWPORT_WORKERS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_CONFIG=playwright.diagnostics.config.ts
export FSUSBLOG_PLAYWRIGHT_RETRIES=0
export FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL"
export FSUSBLOG_RELEASE_PREVIEW_URL="$RELEASE_PREVIEW_URL"
export FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-${FSUSBLOG_BROWSER_DIAGNOSTIC_NAMESPACE:?missing diagnostic namespace}}"

exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/run-local-production-risk.mjs"

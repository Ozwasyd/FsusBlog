#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" ]]; then
    printf '[browser-render-diagnostics] diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1\n' >&2
    exit 2
fi
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS:-1}" != "1" ||
    "${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}" != "1" ]]; then
    printf '[browser-render-diagnostics] exactly one outer browser worker is required\n' >&2
    exit 2
fi

export FSUSBLOG_DOM_BUDGET_STRICT="${FSUSBLOG_DOM_BUDGET_STRICT:-1}"
export FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT="${FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT:-1}"
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
RequireDebugStack
export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"

npm --prefix "$ROOT_DIR/src/frontend" run check:dom-budget
npm --prefix "$ROOT_DIR/src/frontend" run check:route-render-pressure

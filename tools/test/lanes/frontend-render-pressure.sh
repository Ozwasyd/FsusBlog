#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1 source "$ROOT_DIR/tools/test/legacy-test.sh"

export FSUSBLOG_DOM_BUDGET_STRICT="${FSUSBLOG_DOM_BUDGET_STRICT:-1}"
export FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT="${FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT:-1}"

require_debug_stack

export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"

npm --prefix "$ROOT_DIR/src/frontend" run check:dom-depth-static
npm --prefix "$ROOT_DIR/src/frontend" run check:markdown-render-budget
npm --prefix "$ROOT_DIR/src/frontend" run check:dom-budget
npm --prefix "$ROOT_DIR/src/frontend" run check:route-render-pressure

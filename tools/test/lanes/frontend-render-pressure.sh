#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export FSUSBLOG_DOM_BUDGET_STRICT="${FSUSBLOG_DOM_BUDGET_STRICT:-1}"
export FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT="${FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT:-1}"

npm --prefix "$ROOT_DIR/src/frontend" run check:dom-depth-static
npm --prefix "$ROOT_DIR/src/frontend" run check:markdown-render-budget
npm --prefix "$ROOT_DIR/src/frontend" run check:dom-budget
npm --prefix "$ROOT_DIR/src/frontend" run check:route-render-pressure

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-${FSUSBLOG_BROWSER_DIAGNOSTICS_MODE:-manual}}"
shift || true

export FSUSBLOG_LOCAL_FSUSUI_ROOT="${FSUSBLOG_LOCAL_FSUSUI_ROOT:-$(cd "$ROOT_DIR/.." && pwd)/FsusUI}"
export FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT="${FSUSBLOG_LOCAL_FSUSUI_EXPECTED_COMMIT:-b967712bcb9dfc13babd49006451a46e2dcc4771}"

"${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/browser-diagnostics.test.mjs"
exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/browser-diagnostics/run.mjs" "$MODE" "$@"

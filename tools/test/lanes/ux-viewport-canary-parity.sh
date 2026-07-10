#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

FSUSBLOG_TEST_LEGACY_SOURCE_ONLY=1 source "$ROOT_DIR/tools/test/legacy-test.sh"

# Fail before starting services when the tracked 70-case historical authority is absent.
# The checker writes a structured blocked release-evidence artifact on this path.
node "$ROOT_DIR/tools/ux/run-viewport-canary-parity.mjs" --check-authority

require_debug_stack
require_release_preview

export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_UX_VIEWPORT_WORKERS=1

if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
  prepare_session_fixtures_once
  export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
fi

node "$ROOT_DIR/tools/ux/run-viewport-canary-parity.mjs"

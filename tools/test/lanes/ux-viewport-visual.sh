#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

RequireDebugStack
RequireReleasePreview

export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
ConfigurePlaywrightWorkers ux-viewport-visual FSUSBLOG_UX_VIEWPORT_WORKERS

if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
    FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" PrepareSessionFixturesOnce
    export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
fi

npm --prefix "$ROOT_DIR/src/frontend" run check:ux:viewport-visual

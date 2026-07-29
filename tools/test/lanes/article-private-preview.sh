#!/usr/bin/env bash
# fixture-catalog: consumer article-private-preview-lane matrix
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_TEST_SESSION_ISOLATION=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/article-private-preview"
export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"

RequireDebugStack
InvokeLaneFixtureOrchestrator
export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
RunInClient npm run check:article-private-preview

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=tools/test/lanes/_suite-support.sh
source "$ROOT_DIR/tools/test/lanes/_suite-support.sh"

export FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER="${FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER:-$ROOT_DIR/tests/browser-contract/default-fixture-provider.mjs}"
export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/production-xss-fast"
export FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-production-xss-fast-local-$BASHPID}"
export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC="${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-2024-02-29T23:59:59.000Z}"
export FSUSBLOG_TEST_POSTGRES_TIMEZONE="UTC"
export FSUSBLOG_TEST_BACKEND_CULTURE="Invariant"
export FSUSBLOG_TEST_NODE_TIMEZONE="UTC"
export TZ="UTC"
TEMPORAL_CONTEXT_FILE="$ROOT_DIR/.tmp/production-xss/fast-temporal-context.json"
mkdir -p "$(dirname "$TEMPORAL_CONTEXT_FILE")"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-temporal-context.mjs" \
    --producer comment-moderation \
    --output "$TEMPORAL_CONTEXT_FILE" >/dev/null
export FSUSBLOG_TEMPORAL_CONTEXT_FILE="$TEMPORAL_CONTEXT_FILE"
RunInClient npm run check:production-xss:fast

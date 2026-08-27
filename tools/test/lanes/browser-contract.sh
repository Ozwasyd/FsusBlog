#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
CONTRACT_TIMEOUT="${FSUSBLOG_BROWSER_CONTRACT_TIMEOUT:-9m}"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-}"
SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}"

if [[ ! "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ||
    ! "$SOURCE_FINGERPRINT" =~ ^(sha256:)?[a-f0-9]{64}$ ]]; then
    printf '[browser-contract] complete FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT identity is required\n' >&2
    exit 2
fi

export FSUSBLOG_PLAYWRIGHT_SESSION_MODE="browser-contract"
export FSUSBLOG_BROWSER_CONTRACT_SESSIONS="${FSUSBLOG_BROWSER_CONTRACT_SESSIONS:-1}"
export FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY="${FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY:-1}"
export FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER="${FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER:-$ROOT_DIR/tests/browser-contract/default-fixture-provider.mjs}"
if [[ "$FSUSBLOG_BROWSER_CONTRACT_SESSIONS" != "1" || "$FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY" != "1" ]]; then
    printf '[browser-contract] fixture topology is fixed at 1 session / 1 concurrency\n' >&2
    exit 2
fi
if [[ -z "${FSUSBLOG_BROWSER_CONTRACT_RUN_ID:-}" ]]; then
    if [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
        export FSUSBLOG_BROWSER_CONTRACT_RUN_ID="$FSUSBLOG_TEST_RUN_ID"
    elif [[ -n "${GITHUB_RUN_ID:-}" ]]; then
        export FSUSBLOG_BROWSER_CONTRACT_RUN_ID="github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
    else
        FSUSBLOG_BROWSER_CONTRACT_RUN_ID="local-${BASHPID}-$(date -u +%s)"
        export FSUSBLOG_BROWSER_CONTRACT_RUN_ID
    fi
fi
export FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-$FSUSBLOG_BROWSER_CONTRACT_RUN_ID}"
export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC="${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-2024-02-29T23:59:59.000Z}"
export FSUSBLOG_TEST_POSTGRES_TIMEZONE="UTC"
export FSUSBLOG_TEST_BACKEND_CULTURE="Invariant"
export FSUSBLOG_TEST_NODE_TIMEZONE="UTC"
export TZ="UTC"
TEMPORAL_CONTEXT_FILE="${FSUSBLOG_BROWSER_CONTRACT_OUTPUT:-$ROOT_DIR/.tmp/browser-contract}/temporal-context.json"
"$NODE_BIN" "$ROOT_DIR/tools/test/write-temporal-context.mjs" \
    --producer comment-moderation \
    --output "$TEMPORAL_CONTEXT_FILE" >/dev/null
export FSUSBLOG_TEMPORAL_CONTEXT_FILE="$TEMPORAL_CONTEXT_FILE"

if [[ ! "$CONTRACT_TIMEOUT" =~ ^([1-9][0-9]*)(s|m)$ ]]; then
    printf '[browser-contract] FSUSBLOG_BROWSER_CONTRACT_TIMEOUT must be a positive s/m duration\n' >&2
    exit 2
fi

cd "$ROOT_DIR"
"$NODE_BIN" --test "$ROOT_DIR/tests/tools/browser-contract.test.mjs"
"$NODE_BIN" --test "$ROOT_DIR/tests/browser-contract/fixture-lifecycle.test.mjs"

exec timeout --signal=TERM --kill-after=15s "$CONTRACT_TIMEOUT" \
    "$NODE_BIN" "$ROOT_DIR/tests/browser-contract/run.mjs"

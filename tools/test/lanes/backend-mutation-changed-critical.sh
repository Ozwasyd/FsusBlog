#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHANGED_PATHS_FILE="${FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE:-}"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-}"
WORKTREE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:-}"

if [[ -z "$CHANGED_PATHS_FILE" || -z "$SOURCE_COMMIT" || -z "$WORKTREE_FINGERPRINT" || -z "$RUN_ID" ]]; then
    printf '%s\n' \
        "[backend-mutation-changed-critical] FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE, FSUSBLOG_TEST_SOURCE_COMMIT, FSUSBLOG_TEST_SOURCE_FINGERPRINT, and FSUSBLOG_TEST_RUN_ID are required" >&2
    exit 1
fi

node "$ROOT_DIR/tools/test/run-changed-critical-mutation.mjs" \
    --catalog "$ROOT_DIR/config/testing/mutation/changed-critical-domains.v1.json" \
    --changed-paths "$CHANGED_PATHS_FILE" \
    --source-commit "$SOURCE_COMMIT" \
    --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
    --output-root "$ROOT_DIR/.tmp/mutation/changed-critical" \
    --run-id "$RUN_ID"

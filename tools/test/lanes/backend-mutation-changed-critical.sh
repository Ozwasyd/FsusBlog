#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCOPE="${FSUSBLOG_MUTATION_SCOPE:-pr}"
CHANGED_PATHS_FILE="${FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE:-}"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-}"
WORKTREE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:-}"
OWNER_RECEIPT="${FSUSBLOG_BEHAVIOR_OWNER_RECEIPT:-}"
BEHAVIOR_CATALOG="${FSUSBLOG_BEHAVIOR_CATALOG:-$ROOT_DIR/config/contracts/behavior-contracts.json}"
TEST_BINDINGS="${FSUSBLOG_BEHAVIOR_TEST_BINDINGS:-}"
TEST_PLAN="${FSUSBLOG_TEST_PLAN:-}"
BEHAVIOR_TEST_EVIDENCE="${FSUSBLOG_BEHAVIOR_TEST_EVIDENCE:-}"

if [[ -z "$SOURCE_COMMIT" || -z "$WORKTREE_FINGERPRINT" || -z "$RUN_ID" || -z "$OWNER_RECEIPT" || -z "$TEST_BINDINGS" || -z "$TEST_PLAN" || -z "$BEHAVIOR_TEST_EVIDENCE" ]]; then
    printf '%s\n' \
        "[backend-mutation-changed-critical] source identity, run ID, owner receipt, test bindings, test plan, and behavior-test evidence are required" >&2
    printf '%s\n' \
        "[backend-mutation-changed-critical] canonical command: node tools/test-matrix/produce-behavior-mutation-qualification.mjs --scope ${SCOPE} --source-commit <sha> --worktree-fingerprint <fp> --run-id <id> --owner-receipt <path> --test-bindings <path> --test-plan <path> --behavior-test-evidence <path>" >&2
    exit 1
fi

if [[ "$SCOPE" == "pr" ]]; then
    if [[ -z "$CHANGED_PATHS_FILE" ]]; then
        printf '%s\n' "[backend-mutation-changed-critical] scope=pr requires FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE" >&2
        printf '%s\n' "[backend-mutation-changed-critical] canonical command: node tools/test-matrix/produce-behavior-mutation-qualification.mjs --scope pr --changed-paths <file> --source-commit <sha> --worktree-fingerprint <fp> --run-id <id> --owner-receipt <path> --test-bindings <path> --test-plan <path> --behavior-test-evidence <path>" >&2
        exit 1
    fi
    CHANGED_PATHS_ARGS=(--changed-paths "$CHANGED_PATHS_FILE")
elif [[ "$SCOPE" == "release" ]]; then
    CHANGED_PATHS_ARGS=()
else
    printf '%s\n' "[backend-mutation-changed-critical] FSUSBLOG_MUTATION_SCOPE must be pr or release (got $SCOPE)" >&2
    printf '%s\n' "[backend-mutation-changed-critical] canonical command: node tools/test-matrix/produce-behavior-mutation-qualification.mjs --scope pr|release --source-commit <sha> --worktree-fingerprint <fp> --run-id <id> --owner-receipt <path> --test-bindings <path> --test-plan <path> --behavior-test-evidence <path>" >&2
    exit 1
fi

node "$ROOT_DIR/tools/test-matrix/produce-behavior-mutation-qualification.mjs" \
    --scope "$SCOPE" \
    "${CHANGED_PATHS_ARGS[@]}" \
    --catalog "$ROOT_DIR/config/testing/mutation/changed-critical-domains.v1.json" \
    --source-commit "$SOURCE_COMMIT" \
    --worktree-fingerprint "$WORKTREE_FINGERPRINT" \
    --output-root "$ROOT_DIR/.tmp/mutation/changed-critical" \
    --run-id "$RUN_ID" \
    --owner-receipt "$OWNER_RECEIPT" \
    --behavior-catalog "$BEHAVIOR_CATALOG" \
    --test-bindings "$TEST_BINDINGS" \
    --test-plan "$TEST_PLAN" \
    --behavior-test-evidence "$BEHAVIOR_TEST_EVIDENCE"

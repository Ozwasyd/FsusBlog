#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
PRODUCTION_ATTEMPT_ID="${FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID:-}"
TEST_ATTEMPT_ID="${FSUSBLOG_TEST_ATTEMPT_ID:-}"
if [[ -n "$PRODUCTION_ATTEMPT_ID" && -n "$TEST_ATTEMPT_ID" && "$PRODUCTION_ATTEMPT_ID" != "$TEST_ATTEMPT_ID" ]]; then
    printf '[behavior-evidence-post-runtime] attempt authorities disagree\n' >&2
    exit 1
fi
ATTEMPT_ID="${PRODUCTION_ATTEMPT_ID:-$TEST_ATTEMPT_ID}"
[[ "$ATTEMPT_ID" =~ ^attempt-[0-9]{4}$ ]] || { printf '[behavior-evidence-post-runtime] explicit attempt identity is required\n' >&2; exit 1; }
OBSERVATION_DIR="${FSUSBLOG_POST_RUNTIME_OBSERVATION_DIR:-.tmp/post-runtime-observations/$RUN_ID/$ATTEMPT_ID}"
CLAIMS_DIR="${FSUSBLOG_POST_RUNTIME_CLAIMS_DIR:-.tmp/post-runtime-plan/$RUN_ID}"
CONTEXT="${FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:?FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT is required}"
SCHEDULER_EVIDENCE="${FSUSBLOG_SCHEDULER_CHECKPOINT:?FSUSBLOG_SCHEDULER_CHECKPOINT must identify the current tier admission}"
OUTPUT="${FSUSBLOG_BEHAVIOR_POST_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-post-runtime/receipt.json}"

cd "$ROOT_DIR"
ARGS=(
    --pre-runtime "${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/receipt.json}"
    --catalog "$ROOT_DIR/config/contracts/behavior-contracts.json"
    --registry "$ROOT_DIR/config/testing/post-runtime-producer-registry.json"
    --observation-directory "$OBSERVATION_DIR"
    --accepted-claims "$CLAIMS_DIR/accepted-claims.json"
    --execution-context "$CONTEXT"
    --scheduler-evidence "$SCHEDULER_EVIDENCE"
    --verification-mode running
    --scheduler-run-id "$RUN_ID"
    --scheduler-context "${FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT:?FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT is required}"
    --scheduler-context-digest "${FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST:?FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST is required}"
    --scheduler-candidate-digest "${FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST:?FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST is required}"
)

"$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-post-runtime.mjs" "${ARGS[@]}" --out "$OUTPUT"
exec "$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-post-runtime.mjs" "${ARGS[@]}" --verify-receipt "$OUTPUT"

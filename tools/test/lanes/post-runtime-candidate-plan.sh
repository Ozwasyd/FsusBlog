#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
PRODUCTION_ATTEMPT_ID="${FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID:-}"
TEST_ATTEMPT_ID="${FSUSBLOG_TEST_ATTEMPT_ID:-}"
if [[ -n "$PRODUCTION_ATTEMPT_ID" && -n "$TEST_ATTEMPT_ID" && "$PRODUCTION_ATTEMPT_ID" != "$TEST_ATTEMPT_ID" ]]; then
    printf '[post-runtime-candidate-plan] attempt authorities disagree\n' >&2
    exit 1
fi
ATTEMPT_ID="${PRODUCTION_ATTEMPT_ID:-${TEST_ATTEMPT_ID:-attempt-0001}}"
[[ "$ATTEMPT_ID" =~ ^attempt-[0-9]{4}$ ]] || { printf '[post-runtime-candidate-plan] attempt identity is invalid\n' >&2; exit 1; }
export FSUSBLOG_TEST_ATTEMPT_ID="$ATTEMPT_ID"
RELEASE_ID="${FSUSBLOG_RELEASE_ID:?FSUSBLOG_RELEASE_ID is required}"
PRE_RUNTIME="${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/receipt.json}"
TERMINAL_CLAIMS="${FSUSBLOG_DOCS_GLOBAL_CLAIM_EXACTNESS_FINAL_EVIDENCE_PATH:?FSUSBLOG_DOCS_GLOBAL_CLAIM_EXACTNESS_FINAL_EVIDENCE_PATH reference is required}"
BUILD_RECEIPT="${FSUSBLOG_CI_PRODUCTION_BUILD_RECEIPT:-$ROOT_DIR/.tmp/ci-production-build/receipt.json}"
CLAIMS_DIR="${FSUSBLOG_POST_RUNTIME_CLAIMS_DIR:-.tmp/post-runtime-plan/$RUN_ID}"
OUT_DIR="${FSUSBLOG_POST_RUNTIME_PLAN_DIR:-$CLAIMS_DIR/$ATTEMPT_ID}"
RAW_DIR="${FSUSBLOG_POST_RUNTIME_RAW_DIR:-.tmp/post-runtime-raw/$RUN_ID/$ATTEMPT_ID}"

cd "$ROOT_DIR"
mkdir -p "$CLAIMS_DIR" "$OUT_DIR"

if [[ -e "$CLAIMS_DIR/accepted-claims.json" ]]; then
    "$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" verify-accepted-claims \
        --receipt "$CLAIMS_DIR/accepted-claims.json" --run-id "$RUN_ID"
else
    "$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" accepted-claims \
        --terminal "$TERMINAL_CLAIMS" \
        --run-id "$RUN_ID" \
        --out "$CLAIMS_DIR/accepted-claims.json"
fi

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" candidate-context \
    --pre-runtime "$PRE_RUNTIME" \
    --run-id "$RUN_ID" \
    --attempt-id "$ATTEMPT_ID" \
    --release-id "$RELEASE_ID" \
    --out "$OUT_DIR/candidate-context.json"

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" candidate-plan \
    --pre-runtime "$PRE_RUNTIME" \
    --accepted-claims "$CLAIMS_DIR/accepted-claims.json" \
    --build "$BUILD_RECEIPT" \
    --context "$OUT_DIR/candidate-context.json" \
    --observation "aot-spa-hydration=$RAW_DIR/aot-spa-hydration.json" \
    --observation "blue-green-containment=$RAW_DIR/blue-green-containment.json" \
    --observation "browser-behavior-contract=$RAW_DIR/browser-behavior-contract.json" \
    --observation "cache-search-outbox-convergence=$RAW_DIR/cache-search-outbox-convergence.json" \
    --observation "release-identity-readiness=$RAW_DIR/release-identity-readiness.json" \
    --observation "route-response-error=$RAW_DIR/route-response-error.json" \
    --observation "session-cookie-runtime=$RAW_DIR/session-cookie-runtime.json" \
    --out "$OUT_DIR/candidate-plan.json"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
ATTEMPT_ID="${FSUSBLOG_TEST_ATTEMPT_ID:-attempt-1}"
PRE_RUNTIME="${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/receipt.json}"
TERMINAL_CLAIMS="${FSUSBLOG_GLOBAL_CLAIM_EXACTNESS_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/global-claim-exactness.json}"
BUILD_RECEIPT="${FSUSBLOG_CI_PRODUCTION_BUILD_RECEIPT:-$ROOT_DIR/.tmp/ci-production-build/receipt.json}"
OUT_DIR="${FSUSBLOG_POST_RUNTIME_PLAN_DIR:-$ROOT_DIR/.tmp/post-runtime-plan/$RUN_ID}"
RAW_DIR="${FSUSBLOG_POST_RUNTIME_RAW_DIR:-$ROOT_DIR/.tmp/post-runtime-raw/$RUN_ID}"

mkdir -p "$OUT_DIR"

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" accepted-claims \
    --terminal "$TERMINAL_CLAIMS" \
    --out "$OUT_DIR/accepted-claims.json"

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" candidate-context \
    --pre-runtime "$PRE_RUNTIME" \
    --run-id "$RUN_ID" \
    --attempt-id "$ATTEMPT_ID" \
    --out "$OUT_DIR/candidate-context.json"

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" candidate-plan \
    --pre-runtime "$PRE_RUNTIME" \
    --accepted-claims "$OUT_DIR/accepted-claims.json" \
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

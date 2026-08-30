#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
PLAN_DIR="${FSUSBLOG_POST_RUNTIME_PLAN_DIR:-$ROOT_DIR/.tmp/post-runtime-plan/$RUN_ID}"
RAW_DIR="${FSUSBLOG_POST_RUNTIME_RAW_DIR:-$ROOT_DIR/.tmp/post-runtime-raw/$RUN_ID}"
OUT_DIR="${FSUSBLOG_POST_RUNTIME_OBSERVATION_DIR:-$ROOT_DIR/.tmp/post-runtime-observations/$RUN_ID}"

classes=(
    aot-spa-hydration
    blue-green-containment
    browser-behavior-contract
    cache-search-outbox-convergence
    release-identity-readiness
    route-response-error
    session-cookie-runtime
)

mkdir -p "$OUT_DIR/classes"
for class_id in "${classes[@]}"; do
    "$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/current-run.mjs" class-receipt \
        --receipt "$PLAN_DIR/candidate-plan.json" \
        --class "$class_id" \
        --result "$RAW_DIR/$class_id.json" \
        --out "$OUT_DIR/classes/$class_id.json"
done

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/application-runtime.mjs" produce \
    --candidate-plan "$PLAN_DIR/candidate-plan.json" \
    --accepted-claims "$PLAN_DIR/accepted-claims.json" \
    --class-receipt "$OUT_DIR/classes/aot-spa-hydration.json" \
    --class-receipt "$OUT_DIR/classes/browser-behavior-contract.json" \
    --class-receipt "$OUT_DIR/classes/cache-search-outbox-convergence.json" \
    --class-receipt "$OUT_DIR/classes/route-response-error.json" \
    --class-receipt "$OUT_DIR/classes/session-cookie-runtime.json" \
    --out "$OUT_DIR/application-runtime.json"

"$NODE_BIN" "$ROOT_DIR/tools/fact-extractors/post-runtime/release-deployment.mjs" produce \
    --candidate-plan "$PLAN_DIR/candidate-plan.json" \
    --accepted-claims "$PLAN_DIR/accepted-claims.json" \
    --class-receipt "$OUT_DIR/classes/blue-green-containment.json" \
    --class-receipt "$OUT_DIR/classes/release-identity-readiness.json" \
    --out "$OUT_DIR/release-deployment.json"

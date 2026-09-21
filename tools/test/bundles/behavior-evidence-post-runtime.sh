#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:-}"
SCHEDULER_EVIDENCE="${FSUSBLOG_SCHEDULER_CHECKPOINT:-}"

if [[ -z "$RUN_ID" ]]; then
    printf '[behavior-evidence-post-runtime] FSUSBLOG_TEST_RUN_ID is required for scheduler evidence\n' >&2
    exit 2
fi
if [[ -z "$SCHEDULER_EVIDENCE" ]]; then
    printf '[behavior-evidence-post-runtime] FSUSBLOG_SCHEDULER_CHECKPOINT must name the immutable current-tier scheduler admission\n' >&2
    exit 2
fi

PRE_RUNTIME="${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-.tmp/behavior-evidence-pre-runtime/receipt.json}"
CATALOG="config/contracts/behavior-contracts.json"
REGISTRY="config/testing/post-runtime-producer-registry.json"
APPLICATION="${FSUSBLOG_APPLICATION_RUNTIME_OBSERVATION_RECEIPT:-.tmp/fact-observation-receipts/application-runtime-observation-producer.json}"
RELEASE="${FSUSBLOG_RELEASE_DEPLOYMENT_OBSERVATION_RECEIPT:-.tmp/fact-observation-receipts/release-deployment-observation-producer.json}"
OUTPUT="${FSUSBLOG_BEHAVIOR_POST_RUNTIME_RECEIPT:-.tmp/behavior-evidence-post-runtime/receipt.json}"
ARGS=(
    --pre-runtime "$PRE_RUNTIME"
    --catalog "$CATALOG"
    --registry "$REGISTRY"
    --observation "$APPLICATION"
    --observation "$RELEASE"
    --scheduler-evidence "$SCHEDULER_EVIDENCE"
)

"$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-post-runtime.mjs" \
    "${ARGS[@]}" \
    --out "$OUTPUT"

exec "$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-post-runtime.mjs" \
    "${ARGS[@]}" \
    --verify-receipt "$OUTPUT"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RUN_ID="${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}"
PRODUCTION_ATTEMPT_ID="${FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID:-}"
TEST_ATTEMPT_ID="${FSUSBLOG_TEST_ATTEMPT_ID:-}"
if [[ -n "$PRODUCTION_ATTEMPT_ID" && -n "$TEST_ATTEMPT_ID" && "$PRODUCTION_ATTEMPT_ID" != "$TEST_ATTEMPT_ID" ]]; then
    printf '[post-runtime-observation-producers] attempt authorities disagree\n' >&2
    exit 1
fi
ATTEMPT_ID="${PRODUCTION_ATTEMPT_ID:-${TEST_ATTEMPT_ID:-attempt-0001}}"
[[ "$ATTEMPT_ID" =~ ^attempt-[0-9]{4}$ ]] || { printf '[post-runtime-observation-producers] attempt identity is invalid\n' >&2; exit 1; }
export FSUSBLOG_TEST_ATTEMPT_ID="$ATTEMPT_ID"
CLAIMS_DIR="${FSUSBLOG_POST_RUNTIME_CLAIMS_DIR:-.tmp/post-runtime-plan/$RUN_ID}"
PLAN_DIR="${FSUSBLOG_POST_RUNTIME_PLAN_DIR:-$CLAIMS_DIR/$ATTEMPT_ID}"
RAW_DIR="${FSUSBLOG_POST_RUNTIME_RAW_DIR:-.tmp/post-runtime-raw/$RUN_ID/$ATTEMPT_ID}"
OUT_DIR="${FSUSBLOG_POST_RUNTIME_OBSERVATION_DIR:-.tmp/post-runtime-observations/$RUN_ID/$ATTEMPT_ID}"
SOURCE_DIR="${FSUSBLOG_POST_RUNTIME_SOURCE_DIR:-.tmp/post-runtime-sources/$RUN_ID/$ATTEMPT_ID}"
PROBE_DIR="${FSUSBLOG_RUNTIME_OBSERVATION_PROBE_DIR:-.tmp/runtime-observation-probes/$RUN_ID/$ATTEMPT_ID}"

cd "$ROOT_DIR"

relative_path()
{
    local value="$1"
    if [[ "$value" == "$ROOT_DIR/"* ]]; then
        value="${value#"$ROOT_DIR/"}"
    fi
    if [[ "$value" == /* || "$value" == *"../"* || "$value" == ../* ]]; then
        printf '[post-runtime-observation-producers] path must be current-run and repository-relative: %s\n' "$1" >&2
        exit 1
    fi
    printf '%s' "$value"
}

require_file()
{
    local value
    value="$(relative_path "$1")"
    if [[ ! -f "$value" ]]; then
        printf '[post-runtime-observation-producers] required current-run input is missing: %s\n' "$value" >&2
        exit 1
    fi
    printf '%s' "$value"
}

PLAN_DIR="$(relative_path "$PLAN_DIR")"
CLAIMS_DIR="$(relative_path "$CLAIMS_DIR")"
RAW_DIR="$(relative_path "$RAW_DIR")"
OUT_DIR="$(relative_path "$OUT_DIR")"
SOURCE_DIR="$(relative_path "$SOURCE_DIR")"
PROBE_DIR="$(relative_path "$PROBE_DIR")"
PLAN="$(require_file "$PLAN_DIR/candidate-plan.json")"
CLAIMS="$(require_file "$CLAIMS_DIR/accepted-claims.json")"
BROWSER="$(require_file "${FSUSBLOG_BROWSER_CONTRACT_RECEIPT:-.tmp/browser-contract/receipt.json}")"
ROLLOUT_EVIDENCE="$(require_file "${FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE:?FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE is required}")"
RUNTIME_ROLE_ADMISSION="$(require_file "${FSUSBLOG_RUNTIME_ROLE_STATIC_ADMISSION:-.tmp/behavior-doc-static-admission/receipt.json}")"

AOT_MANIFEST="$(require_file "${FSUSBLOG_AOT_MANIFEST_RECEIPT:?FSUSBLOG_AOT_MANIFEST_RECEIPT is required}")"
aot_args=(--manifest "$AOT_MANIFEST" --browser-contract "$BROWSER")

mkdir -p "$RAW_DIR" "$SOURCE_DIR" "$OUT_DIR/classes"

"$NODE_BIN" tools/fact-extractors/post-runtime/current-run.mjs verify-accepted-claims --receipt "$CLAIMS" --run-id "$RUN_ID"
"$NODE_BIN" tools/fact-extractors/post-runtime/current-run.mjs verify-candidate-plan --receipt "$PLAN"

"$NODE_BIN" tools/test-evidence/aot-spa-hydration-raw.mjs bundle --candidate-plan "$PLAN" "${aot_args[@]}" --out "$SOURCE_DIR/aot-spa-hydration.json"
"$NODE_BIN" tools/test-evidence/aot-spa-hydration-raw.mjs project --candidate-plan "$PLAN" --source "$SOURCE_DIR/aot-spa-hydration.json" --out "$RAW_DIR/aot-spa-hydration.json"
"$NODE_BIN" tools/test-evidence/aot-spa-hydration-raw.mjs verify --candidate-plan "$PLAN" --receipt "$RAW_DIR/aot-spa-hydration.json"

"$NODE_BIN" tools/test-evidence/browser-contract-observation-raw.mjs project --candidate-plan "$PLAN" --browser-contract "$BROWSER" --out "$RAW_DIR/browser-behavior-contract.json"
"$NODE_BIN" tools/test-evidence/browser-contract-observation-raw.mjs verify --candidate-plan "$PLAN" --receipt "$RAW_DIR/browser-behavior-contract.json"

for class_id in route-response-error session-cookie-runtime cache-search-outbox-convergence; do
    probe="$(require_file "$PROBE_DIR/$class_id.json")"
    "$NODE_BIN" tools/test-evidence/runtime-observation-raw.mjs project-probe --candidate-plan "$PLAN" --probe "$probe" --out "$RAW_DIR/$class_id.json"
    "$NODE_BIN" tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan "$PLAN" --receipt "$RAW_DIR/$class_id.json"
done

"$NODE_BIN" tools/test-evidence/release-readiness-raw.mjs bundle-authorities --candidate-plan "$PLAN" --rollout-evidence "$ROLLOUT_EVIDENCE" --runtime-role-admission "$RUNTIME_ROLE_ADMISSION" --out "$SOURCE_DIR/release-identity-readiness.json"
"$NODE_BIN" tools/test-evidence/release-readiness-raw.mjs project-authorities --candidate-plan "$PLAN" --source "$SOURCE_DIR/release-identity-readiness.json" --out "$RAW_DIR/release-identity-readiness.json"
"$NODE_BIN" tools/test-evidence/release-readiness-raw.mjs verify --candidate-plan "$PLAN" --receipt "$RAW_DIR/release-identity-readiness.json"

"$NODE_BIN" tools/test-evidence/blue-green-containment-raw.mjs bundle-authorities --candidate-plan "$PLAN" --rollout-evidence "$ROLLOUT_EVIDENCE" --runtime-role-admission "$RUNTIME_ROLE_ADMISSION" --out "$SOURCE_DIR/blue-green-containment.json"
"$NODE_BIN" tools/test-evidence/blue-green-containment-raw.mjs produce-authorities --candidate-plan "$PLAN" --source "$SOURCE_DIR/blue-green-containment.json" --out "$RAW_DIR/blue-green-containment.json"
"$NODE_BIN" tools/test-evidence/blue-green-containment-raw.mjs verify --candidate-plan "$PLAN" --receipt "$RAW_DIR/blue-green-containment.json"

classes=(
    aot-spa-hydration
    blue-green-containment
    browser-behavior-contract
    cache-search-outbox-convergence
    release-identity-readiness
    route-response-error
    session-cookie-runtime
)
for class_id in "${classes[@]}"; do
    "$NODE_BIN" tools/fact-extractors/post-runtime/current-run.mjs class-receipt --receipt "$PLAN" --class "$class_id" --result "$RAW_DIR/$class_id.json" --out "$OUT_DIR/classes/$class_id.json"
    "$NODE_BIN" tools/fact-extractors/post-runtime/current-run.mjs verify-class-receipt --receipt "$OUT_DIR/classes/$class_id.json"
done

application_classes=(aot-spa-hydration browser-behavior-contract cache-search-outbox-convergence route-response-error session-cookie-runtime)
application_args=()
for class_id in "${application_classes[@]}"; do application_args+=(--class-receipt "$OUT_DIR/classes/$class_id.json"); done
"$NODE_BIN" tools/fact-extractors/post-runtime/application-runtime.mjs produce --candidate-plan "$PLAN" --accepted-claims "$CLAIMS" "${application_args[@]}" --out "$OUT_DIR/application-runtime.json"
"$NODE_BIN" tools/fact-extractors/post-runtime/application-runtime.mjs verify --receipt "$OUT_DIR/application-runtime.json"

release_args=(--class-receipt "$OUT_DIR/classes/blue-green-containment.json" --class-receipt "$OUT_DIR/classes/release-identity-readiness.json")
"$NODE_BIN" tools/fact-extractors/post-runtime/release-deployment.mjs produce --candidate-plan "$PLAN" --accepted-claims "$CLAIMS" "${release_args[@]}" --out "$OUT_DIR/release-deployment.json"
"$NODE_BIN" tools/fact-extractors/post-runtime/release-deployment.mjs verify --receipt "$OUT_DIR/release-deployment.json"

printf '[post-runtime-observation-producers] verified run=%s attempt=%s classes=7 scopes=2\n' "$RUN_ID" "$ATTEMPT_ID"

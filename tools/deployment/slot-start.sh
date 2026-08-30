#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

SLOT=""
RELEASE_MANIFEST=""
PRODUCTION_BUILD_RECEIPT=""
PRE_RESERVED_GENERATION=""
ROLLOUT_STATE_FILE="${FSUSBLOG_ROLLOUT_STATE_FILE:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            [[ $# -ge 2 ]] || SlotFail "--slot requires a value"
            SLOT="$2"
            shift 2
            ;;
        --release-manifest)
            [[ $# -ge 2 ]] || SlotFail "--release-manifest requires a path"
            RELEASE_MANIFEST="$2"
            shift 2
            ;;
        --production-build-receipt)
            [[ $# -ge 2 ]] || SlotFail "--production-build-receipt requires a path"
            PRODUCTION_BUILD_RECEIPT="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || SlotFail "--env-file requires a path"
            PRODUCTION_ENV_FILE="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || SlotFail "--state-file requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        --deployment-generation)
            [[ $# -ge 2 ]] || SlotFail "--deployment-generation requires a value"
            PRE_RESERVED_GENERATION="$2"
            shift 2
            ;;
        --rollout-state)
            [[ $# -ge 2 ]] || SlotFail "--rollout-state requires a path"
            ROLLOUT_STATE_FILE="$2"
            shift 2
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

SlotRequire "$SLOT"
[[ -n "$RELEASE_MANIFEST" ]] || SlotFail "--release-manifest is required"
[[ -f "$PRODUCTION_BUILD_RECEIPT" ]] ||
    SlotFail "--production-build-receipt is required and must name the sealed CI receipt"
SlotRequireCommand curl
SlotRequireCommand docker
SlotRequireCommand jq
SlotRequireCommand node
SlotAcquireDeploymentLock
SlotConfigure "$SLOT"
SlotLoadManifest "$RELEASE_MANIFEST" "$SLOT"
release_asset_store="${FSUSBLOG_RELEASE_ASSET_STORE:-}"
[[ -n "$release_asset_store" ]] ||
    SlotFail "FSUSBLOG_RELEASE_ASSET_STORE is required for SPA authority validation"
release_asset_store="$(realpath "$release_asset_store")"
release_asset_root="$release_asset_store/releases"
asset_root="$release_asset_root/$FSUSBLOG_RELEASE_ID"
spa_manifest_descriptor="$asset_root/spa-manifest-descriptor.json"
retained_production_build_receipt="$asset_root/production-build-receipt.json"
PRODUCTION_BUILD_RECEIPT="$(realpath "$PRODUCTION_BUILD_RECEIPT")"
[[ "$PRODUCTION_BUILD_RECEIPT" == "$retained_production_build_receipt" ]] ||
    SlotFail "--production-build-receipt must use the current retained release authority"
node "$ROOT_DIR/tools/storage/create-spa-manifest-descriptor.mjs" verify-retained \
    --release-manifest "$RELEASE_MANIFEST" \
    --build-receipt "$PRODUCTION_BUILD_RECEIPT" \
    --release-asset-root "$release_asset_root" \
    --asset-root "$asset_root" \
    --runtime-asset-root "/app/release-assets/$FSUSBLOG_RELEASE_ID" \
    --descriptor "$spa_manifest_descriptor" ||
    SlotFail "SPA manifest descriptor or production build receipt authority is invalid"
[[ -f "$spa_manifest_descriptor" && ! -L "$spa_manifest_descriptor" ]] ||
    SlotFail "canonical SPA manifest descriptor is missing or symbolic"
[[ -f "$retained_production_build_receipt" && ! -L "$retained_production_build_receipt" ]] ||
    SlotFail "retained production build receipt is missing or symbolic"
deployment_state="$(SlotStateReadCurrent)"
[[ "$(jq -r '.status' <<<"$deployment_state")" == "stable" ]] ||
    SlotFail "gateway state must be stable before starting a candidate"
active_slot="$(jq -r '.activeSlot // ""' <<<"$deployment_state")"
if [[ -n "$active_slot" ]]; then
    previous_rollback_release="$(jq -r --arg slot "$active_slot" '.slots[$slot].releaseId // ""' <<<"$deployment_state")"
else
    previous_rollback_release="${FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE:-}"
fi
node "$ROOT_DIR/tools/release/release-id.mjs" validate "$previous_rollback_release" >/dev/null ||
    SlotFail "unable to derive a valid previous rollback release"
[[ "$previous_rollback_release" != "$FSUSBLOG_RELEASE_ID" ]] ||
    SlotFail "previous rollback release must differ from the candidate release"
export FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE="$previous_rollback_release"
if [[ "${FSUSBLOG_ROLLOUT_ENTRY:-0}" != "1" ]]; then
    [[ "${FSUSBLOG_DEPLOYMENT_BOOTSTRAP:-0}" == "1" &&
        "$(jq -r '.activeSlot == null' <<<"$deployment_state")" == "true" ]] ||
        SlotFail "slot-start is internal; use release-rollout.sh (bootstrap is allowed only with an empty durable state)"
fi
[[ "$(jq -r '.activeSlot // ""' <<<"$deployment_state")" != "$SLOT" ]] ||
    SlotFail "refusing to start or replace persisted active slot $SLOT"
export FSUSBLOG_DEPLOYMENT_MODE="candidate"

RecordFailedStart() {
    local message="$1"
    SlotStateRecordFailure "$SLOT" start "$message" || true
}

before="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
if [[ "$(jq -r '.running and .identityMatchesSlot and .loopbackOnly and .liveness == "ok" and .readiness == "ok"' <<<"$before")" == "true" &&
"$(jq -r '.release.releaseId' <<<"$before")" == "$FSUSBLOG_RELEASE_ID" &&
"$(jq -r '.release.imageRef' <<<"$before")" == "$FSUSBLOG_IMAGE_REF" &&
"$(jq -r '.release.imageDigest' <<<"$before")" == "$FSUSBLOG_IMAGE_DIGEST" &&
"$(jq -r '.release.deploymentMode' <<<"$before")" == "candidate" &&
"$(jq -r '.release.deploymentGeneration' <<<"$before")" == "$(jq -r '.persisted.record.deploymentGeneration // 0' <<<"$before")" &&
(-z "$PRE_RESERVED_GENERATION" || "$(jq -r '.release.deploymentGeneration' <<<"$before")" == "$PRE_RESERVED_GENERATION") ]]; then
    jq -cn --argjson slot "$before" '{status: "already-running", preflight: {status: "not-required", reason: "exact-healthy-release-already-running"}, slot: $slot}'
    exit 0
fi

preflight_args=(
    --slot "$SLOT"
    --release-manifest "$RELEASE_MANIFEST"
    --env-file "$PRODUCTION_ENV_FILE"
    --state-file "$SLOT_STATE_FILE"
)
if ! preflight="$("$ROOT_DIR/tools/deployment/slot-preflight.sh" "${preflight_args[@]}")"; then
    RecordFailedStart "candidate preflight failed"
    SlotFail "candidate preflight failed; active slot was not changed"
fi

if [[ -n "$PRE_RESERVED_GENERATION" ]]; then
    [[ "$PRE_RESERVED_GENERATION" =~ ^[0-9]+$ && "$PRE_RESERVED_GENERATION" -ge 1 ]] ||
        SlotFail "pre-reserved deployment generation is invalid"
    current_generation="$(SlotStateReadCurrent | jq -r '.runtimeGeneration')"
    [[ "$PRE_RESERVED_GENERATION" == "$current_generation" ]] ||
        SlotFail "pre-reserved deployment generation is not the latest durable reservation"
    export FSUSBLOG_DEPLOYMENT_GENERATION="$PRE_RESERVED_GENERATION"
else
    generation_reservation="$(node "$ROOT_DIR/tools/deployment/slot-state.mjs" reserve-generation \
        --state "$SLOT_STATE_FILE" \
        --slot "$SLOT")" ||
        SlotFail "unable to reserve a unique candidate runtime generation"
    FSUSBLOG_DEPLOYMENT_GENERATION="$(jq -r '.generation' <<<"$generation_reservation")"
    export FSUSBLOG_DEPLOYMENT_GENERATION
fi
[[ "$FSUSBLOG_DEPLOYMENT_GENERATION" =~ ^[0-9]+$ && "$FSUSBLOG_DEPLOYMENT_GENERATION" -ge 1 ]] ||
    SlotFail "reserved candidate runtime generation is invalid"

if [[ "$(jq -r '.running' <<<"$before")" == "true" ]]; then
    SlotFail "refusing to replace a running inactive runtime; recover its exact owning rollout first"
fi

cleanup_owned_candidate=0
if [[ -n "$ROLLOUT_STATE_FILE" && -f "$ROLLOUT_STATE_FILE" ]]; then
    if node "$ROOT_DIR/tools/deployment/verify-destructive-operation.mjs" runtime-candidate-cleanup \
        --slot-state "$SLOT_STATE_FILE" --rollout-state "$ROLLOUT_STATE_FILE" \
        --slot "$SLOT" --release "$FSUSBLOG_RELEASE_ID" --digest "$FSUSBLOG_IMAGE_DIGEST" \
        --generation "$FSUSBLOG_DEPLOYMENT_GENERATION" >/dev/null; then
        cleanup_owned_candidate=1
    else
        SlotFail "candidate identity is not owned by the durable current rollout"
    fi
fi

deploy_args=(
    --env-file "$PRODUCTION_ENV_FILE"
    --release-manifest "$RELEASE_MANIFEST"
    --spa-manifest-descriptor "$spa_manifest_descriptor"
    --production-build-receipt "$retained_production_build_receipt"
    --release-id "$FSUSBLOG_RELEASE_ID"
    --image-ref "$FSUSBLOG_IMAGE_REF"
    --slot "$SLOT"
    --project-name "$FSUSBLOG_COMPOSE_PROJECT_NAME"
)
if ! FSUSBLOG_INTERNAL_SLOT_OPERATION=1 "$ROOT_DIR/tools/deploy-production.sh" "${deploy_args[@]}"; then
    if [[ "$cleanup_owned_candidate" == "1" ]]; then
        SlotCompose down --remove-orphans >/dev/null 2>&1 || true
        node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null 2>&1 || true
    fi
    RecordFailedStart "candidate deploy failed"
    SlotFail "candidate deploy failed; active slot was not changed"
fi

health_timeout="${FSUSBLOG_SLOT_HEALTH_TIMEOUT_SECONDS:-120}"
health_interval="${FSUSBLOG_SLOT_HEALTH_INTERVAL_SECONDS:-2}"
[[ "$health_timeout" =~ ^[0-9]+$ && "$health_timeout" -ge 1 ]] || SlotFail "FSUSBLOG_SLOT_HEALTH_TIMEOUT_SECONDS is invalid"
[[ "$health_interval" =~ ^[0-9]+$ && "$health_interval" -ge 1 ]] || SlotFail "FSUSBLOG_SLOT_HEALTH_INTERVAL_SECONDS is invalid"
deadline=$((SECONDS + health_timeout))
healthy=0
while ((SECONDS < deadline)); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$FSUSBLOG_SLOT_PORT/health/live" >/dev/null &&
        curl -fsS --max-time 5 "http://127.0.0.1:$FSUSBLOG_SLOT_PORT/health/ready" >/dev/null; then
        healthy=1
        break
    fi
    sleep "$health_interval"
done

if [[ "$healthy" != "1" ]]; then
    if [[ "$cleanup_owned_candidate" == "1" ]]; then
        SlotCompose down --remove-orphans >/dev/null 2>&1 || true
        node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null 2>&1 || true
    fi
    RecordFailedStart "candidate liveness/readiness timeout"
    SlotFail "candidate health probes timed out; active slot was not changed"
fi

after="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
if [[ "$(jq -r '.running and .identityMatchesSlot and .loopbackOnly' <<<"$after")" != "true" ||
"$(jq -r '.release.releaseId' <<<"$after")" != "$FSUSBLOG_RELEASE_ID" ||
"$(jq -r '.release.imageRef' <<<"$after")" != "$FSUSBLOG_IMAGE_REF" ||
"$(jq -r '.release.imageDigest' <<<"$after")" != "$FSUSBLOG_IMAGE_DIGEST" ]]; then
    RecordFailedStart "candidate runtime identity mismatch"
    SlotFail "candidate runtime identity mismatch; unknown-owned runtime was preserved"
fi

if ! node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-start \
    --state "$SLOT_STATE_FILE" \
    --slot "$SLOT" \
    --release-manifest "$(realpath "$RELEASE_MANIFEST")" \
    --release-id "$FSUSBLOG_RELEASE_ID" \
    --created-at-utc "$FSUSBLOG_RELEASE_CREATED_AT_UTC" \
    --commit-sha "$FSUSBLOG_COMMIT_SHA" \
    --image-ref "$FSUSBLOG_IMAGE_REF" \
    --image-digest "$FSUSBLOG_IMAGE_DIGEST" \
    --deployment-generation "$FSUSBLOG_DEPLOYMENT_GENERATION" \
    --at "$(jq -r '.startedAt' <<<"$after")" >/dev/null; then
    SlotCompose down --remove-orphans >/dev/null 2>&1 || true
    RecordFailedStart "candidate state persistence failed"
    SlotFail "candidate state persistence failed; candidate was stopped and active slot was not changed"
fi

final="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
jq -cn --argjson preflight "$preflight" --argjson slot "$final" '{status: "started", preflight: $preflight, slot: $slot}'

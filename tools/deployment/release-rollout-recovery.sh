#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

ACTION="${1:-}"
[[ -n "$ACTION" ]] || SlotFail "usage: release-rollout-recovery.sh rollback-to-source [options]"
shift

ROLLOUT_STATE_FILE=""
SOURCE_MANIFEST=""
PUBLIC_PROBE_URL="${FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL:-}"
ADMIN_HEADER_FILE="${FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE:-}"
CONTROL_ORIGIN="${FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN:-}"
OUT_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollout-state)
            [[ $# -ge 2 ]] || SlotFail "--rollout-state requires a path"
            ROLLOUT_STATE_FILE="$2"
            shift 2
            ;;
        --slot-state)
            [[ $# -ge 2 ]] || SlotFail "--slot-state requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || SlotFail "--env-file requires a path"
            PRODUCTION_ENV_FILE="$2"
            shift 2
            ;;
        --source-manifest)
            [[ $# -ge 2 ]] || SlotFail "--source-manifest requires a path"
            SOURCE_MANIFEST="$2"
            shift 2
            ;;
        --public-url)
            [[ $# -ge 2 ]] || SlotFail "--public-url requires a URL"
            PUBLIC_PROBE_URL="$2"
            shift 2
            ;;
        --admin-header-file)
            [[ $# -ge 2 ]] || SlotFail "--admin-header-file requires a path"
            ADMIN_HEADER_FILE="$2"
            shift 2
            ;;
        --control-origin)
            [[ $# -ge 2 ]] || SlotFail "--control-origin requires an origin"
            CONTROL_ORIGIN="$2"
            shift 2
            ;;
        --out)
            [[ $# -ge 2 ]] || SlotFail "--out requires a path"
            OUT_FILE="$2"
            shift 2
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

[[ "$ACTION" == "rollback-to-source" ]] || SlotFail "only rollback-to-source is supported"
[[ -f "$ROLLOUT_STATE_FILE" ]] || SlotFail "rollout state is missing"
[[ -f "$SOURCE_MANIFEST" ]] || SlotFail "the exact source release manifest is required for monotonic rollback"
[[ -f "$PRODUCTION_ENV_FILE" ]] || SlotFail "production env file is missing"
[[ -f "$ADMIN_HEADER_FILE" ]] || SlotFail "deployment admin header file is missing"
[[ -n "$OUT_FILE" ]] || SlotFail "--out is required"
[[ "$PUBLIC_PROBE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] ||
    { [[ "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" && "$PUBLIC_PROBE_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/health/ready$ ]] ||
        SlotFail "public URL must be an explicit HTTPS /health/ready URL"; }
[[ -n "$CONTROL_ORIGIN" ]] || CONTROL_ORIGIN="${PUBLIC_PROBE_URL%/health/ready}"
for command in curl jq node stat; do SlotRequireCommand "$command"; done

rollout="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")" ||
    SlotFail "unable to read rollout state"
export FSUSBLOG_ROLLOUT_ENTRY=1
[[ "$(jq -r '.status == "recovery_required" and .recovery.action == "rollback-gateway-to-source"' <<<"$rollout")" == "true" ]] ||
    SlotFail "rollout does not request post-switch source rollback"

source_slot="$(jq -r '.source.slot' <<<"$rollout")"
source_release="$(jq -r '.source.releaseId' <<<"$rollout")"
source_digest="$(jq -r '.source.imageDigest' <<<"$rollout")"
source_original_generation="$(jq -r '.source.runtimeGeneration' <<<"$rollout")"
failed_target_slot="$(jq -r '.target.slot' <<<"$rollout")"
failed_target_release="$(jq -r '.target.releaseId' <<<"$rollout")"
failed_target_generation="$(jq -r '.target.runtimeGeneration' <<<"$rollout")"
SlotRequire "$source_slot"
SlotRequire "$failed_target_slot"

manifest="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
    --manifest "$SOURCE_MANIFEST" --slot "$source_slot" \
    --release-id "$source_release" --image-digest "$source_digest")" ||
    SlotFail "source manifest does not match the immutable rollback source"

SlotAcquireDeploymentLock
export FSUSBLOG_DEPLOYMENT_LOCK_FD="${FSUSBLOG_DEPLOYMENT_LOCK_FD:-9}"

evidence_dir="$(dirname "$OUT_FILE")"
mkdir -p "$evidence_dir"
source_status_file="$evidence_dir/rollback-source-status.json"
gateway_file="$evidence_dir/rollback-gateway.json"
fence_before_file="$evidence_dir/rollback-fence-before.json"
fence_after_file="$evidence_dir/rollback-fence-after.json"
failed_target_restart_file="$evidence_dir/rollback-failed-target-notification-restart.json"
failed_target_drain_file="$evidence_dir/rollback-failed-target-drain.json"
failed_target_drain_gate_file="$evidence_dir/rollback-failed-target-drain-gate.json"

state_before="$(SlotStateReadCurrent)"
active_before="$(jq -r '.activeSlot // ""' <<<"$state_before")"
source_current_generation="$(jq -r --arg slot "$source_slot" '.slots[$slot].deploymentGeneration // 0' <<<"$state_before")"

if [[ "$active_before" != "$source_slot" ]]; then
    source_inspect="$("$ROOT_DIR"/tools/deployment/slot-status.sh --slot "$source_slot" --state-file "$SLOT_STATE_FILE")"
    source_ready_candidate="$(jq -r \
        --arg release "$source_release" --arg digest "$source_digest" '
      .exists and .running and .identityMatchesSlot and .loopbackOnly
      and .liveness == "ok" and .readiness == "ok"
      and .release.releaseId == $release and .release.imageDigest == $digest
      and .release.deploymentMode == "candidate"
      and (.release.deploymentGeneration | type == "number")
    ' <<<"$source_inspect")"
    if [[ "$source_ready_candidate" == "true" && "$source_current_generation" -gt "$source_original_generation" ]]; then
        source_rollback_generation="$source_current_generation"
    else
        "$ROOT_DIR/tools/deployment/slot-stop.sh" \
            --slot "$source_slot" --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" >/dev/null
        reservation="$(node "$ROOT_DIR/tools/deployment/slot-state.mjs" reserve-generation \
            --state "$SLOT_STATE_FILE" --slot "$source_slot")" ||
            SlotFail "unable to reserve a fresh rollback runtime generation"
        source_rollback_generation="$(jq -r '.generation' <<<"$reservation")"
        "$ROOT_DIR/tools/deployment/slot-start.sh" \
            --slot "$source_slot" --release-manifest "$SOURCE_MANIFEST" \
            --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" \
            --deployment-generation "$source_rollback_generation" >/dev/null ||
            SlotFail "unable to restart rollback source as a fresh candidate"
    fi

    "$ROOT_DIR/tools/deployment/gateway-rollback.sh" \
        --state-file "$SLOT_STATE_FILE" --public-url "$PUBLIC_PROBE_URL" \
        --admin-header-file "$ADMIN_HEADER_FILE" --control-origin "$CONTROL_ORIGIN" \
        --defer-source-drain --rollout-state-file "$ROLLOUT_STATE_FILE" \
        >"$gateway_file" ||
        SlotFail "gateway rollback to the fresh source candidate failed"
else
    source_rollback_generation="$(jq -r --arg slot "$source_slot" '.slots[$slot].deploymentGeneration // 0' <<<"$state_before")"
    jq -cn --arg slot "$source_slot" --arg releaseId "$source_release" \
        '{status:"already-rolled-back",source:{slot:$slot,releaseId:$releaseId}}' >"$gateway_file"
fi

[[ "$source_rollback_generation" =~ ^[0-9]+$ && "$source_rollback_generation" -gt "$source_original_generation" ]] ||
    SlotFail "rollback did not allocate a generation newer than the original source token"

source_port="$([[ "$source_slot" == "blue" ]] && printf '%s' "${FSUSBLOG_BLUE_PORT:-8081}" || printf '%s' "${FSUSBLOG_GREEN_PORT:-8082}")"
node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" status \
    --port "$source_port" --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
    --allow-inactive --out "$fence_before_file" >/dev/null ||
    SlotFail "unable to inspect the current active release fence before rollback CAS"
fence_before="$(jq -c '.result.snapshot // .result' "$fence_before_file")"
expected_release="$(jq -r '.releaseId' <<<"$fence_before")"
expected_slot="$(jq -r '.slot' <<<"$fence_before")"
expected_generation="$(jq -r '.generation' <<<"$fence_before")"
[[ -n "$expected_release" && -n "$expected_slot" && "$expected_generation" =~ ^[0-9]+$ && "$expected_generation" -ge 1 ]] ||
    SlotFail "current fence identity is unavailable; rollback requires manual recovery"

node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" acquire \
    --port "$source_port" --release "$source_release" --slot "$source_slot" \
    --generation "$source_rollback_generation" --digest "$source_digest" \
    --expected-release "$expected_release" --expected-slot "$expected_slot" --expected-generation "$expected_generation" \
    --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
    --out "$fence_after_file" >/dev/null ||
    SlotFail "active fence rollback CAS failed"

failed_target_port="$([[ "$failed_target_slot" == "blue" ]] && printf '%s' "${FSUSBLOG_BLUE_PORT:-8081}" || printf '%s' "${FSUSBLOG_GREEN_PORT:-8082}")"
node "$ROOT_DIR/tools/deployment/notification-stream-restart.mjs" restart \
    --port "$failed_target_port" --release "$failed_target_release" --slot "$failed_target_slot" \
    --generation "$failed_target_generation" --reason rollback_drain \
    --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
    --out "$failed_target_restart_file" >/dev/null ||
    SlotFail "failed target notification streams could not be restarted before rollback drain"
"$ROOT_DIR/tools/deployment/deployment-control.sh" drain \
    --slot "$failed_target_slot" --release "$failed_target_release" --generation "$failed_target_generation" \
    --port "$failed_target_port" --timeout-seconds "${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-45}" \
    --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" --wait \
    >"$failed_target_drain_file" ||
    SlotFail "failed target did not drain after source fence restoration"
node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" source-drain \
    --input "$failed_target_drain_file" --notification "$failed_target_restart_file" \
    --out "$failed_target_drain_gate_file" >/dev/null ||
    SlotFail "failed target rollback drain evidence did not pass"

curl -fsS --max-time 15 -D "$source_status_file.headers" -o /dev/null "$PUBLIC_PROBE_URL" ||
    SlotFail "public source probe failed after rollback"
public_release="$(awk 'BEGIN{IGNORECASE=1} /^X-Fsus-Release-Id:/ {gsub(/\r/, "", $2); print $2}' "$source_status_file.headers" | tail -1)"
public_slot="$(awk 'BEGIN{IGNORECASE=1} /^X-Fsus-Release-Slot:/ {gsub(/\r/, "", $2); print $2}' "$source_status_file.headers" | tail -1)"
[[ "$public_release" == "$source_release" && "$public_slot" == "$source_slot" ]] ||
    SlotFail "public gateway identity does not match rollback source"

final_state="$(SlotStateReadCurrent)"
final_fence="$(jq -c '.result.snapshot // .result' "$fence_after_file")"
jq -cn \
    --arg rolloutId "$(jq -r '.rolloutId' <<<"$rollout")" \
    --arg sourceManifest "$(realpath "$SOURCE_MANIFEST")" \
    --arg sourceSlot "$source_slot" --arg sourceRelease "$source_release" --arg sourceDigest "$source_digest" \
    --arg failedTargetSlot "$failed_target_slot" --arg failedTargetRelease "$failed_target_release" \
    --arg publicRelease "$public_release" --arg publicSlot "$public_slot" \
    --arg gatewayEvidence "$gateway_file" --arg fenceBeforeEvidence "$fence_before_file" --arg fenceAfterEvidence "$fence_after_file" \
    --arg failedTargetRestartEvidence "$failed_target_restart_file" --arg failedTargetDrainEvidence "$failed_target_drain_gate_file" \
    --argjson originalGeneration "$source_original_generation" \
    --argjson rollbackGeneration "$source_rollback_generation" \
    --argjson failedTargetGeneration "$failed_target_generation" \
    --argjson finalSlotState "$final_state" --argjson finalFence "$final_fence" '
  {
    schema: "fsusblog.release-rollout-recovery.v1",
    status: "ok",
    action: "rollback-gateway-to-source",
    rolloutId: $rolloutId,
    sourceManifest: $sourceManifest,
    source: {slot:$sourceSlot,releaseId:$sourceRelease,imageDigest:$sourceDigest,originalGeneration:$originalGeneration,rollbackGeneration:$rollbackGeneration},
    failedTarget: {slot:$failedTargetSlot,releaseId:$failedTargetRelease,generation:$failedTargetGeneration},
    checks: {
      freshRollbackRuntime: ($rollbackGeneration > $originalGeneration),
      monotonicFenceToken: ($finalFence.generation == $rollbackGeneration),
      publicSourceRestored: ($publicRelease == $sourceRelease and $publicSlot == $sourceSlot),
      durableGatewayState: ($finalSlotState.activeSlot == $sourceSlot and $finalSlotState.activeReleaseId == $sourceRelease),
      failedTargetDrained: true
    },
    public: {releaseId:$publicRelease,slot:$publicSlot},
    evidence: {gateway:$gatewayEvidence,fenceBefore:$fenceBeforeEvidence,fenceAfter:$fenceAfterEvidence,failedTargetRestart:$failedTargetRestartEvidence,failedTargetDrain:$failedTargetDrainEvidence},
    completedAtUtc: (now | todateiso8601)
  }' >"$OUT_FILE"

jq -e '.status == "ok" and (.checks | to_entries | all(.value == true))' "$OUT_FILE" >/dev/null ||
    SlotFail "rollback recovery evidence did not satisfy every invariant"
printf '%s\n' "$(cat "$OUT_FILE")"

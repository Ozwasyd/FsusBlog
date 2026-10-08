#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

[[ "${FSUSBLOG_ROLLOUT_ENTRY:-0}" == "1" ]] ||
    SlotFail "gateway-switch is internal; use release-rollout.sh or its durable recovery entry"

TARGET_SLOT=""
EXPECTED_RELEASE_ID=""
EXPECTED_IMAGE_DIGEST=""
TRANSITION_KIND="switch"
DRY_RUN=0
ACTIVE_UPSTREAM_FILE="${FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM:-/etc/openresty/fsusblog/active-upstream.conf}"
GATEWAY_CONFIG_FILE="${FSUSBLOG_GATEWAY_CONFIG_FILE:-/etc/openresty/nginx.conf}"
PUBLIC_PROBE_URL="${FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL:-}"
POST_SWITCH_PROBE_URL=""
POST_SWITCH_LOOPBACK_PATH="/health/ready"
OPENRESTY_BIN="${FSUSBLOG_OPENRESTY_BIN:-openresty}"
EVIDENCE_DIR="${FSUSBLOG_GATEWAY_EVIDENCE_DIR:-/var/lib/fsusblog/deployment/evidence}"
DEPLOYMENT_ADMIN_HEADER_FILE="${FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE:-}"
DEPLOYMENT_CONTROL_ORIGIN="${FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN:-}"
DRAIN_TIMEOUT_SECONDS="${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-45}"
DEFER_SOURCE_DRAIN=0
ROLLOUT_STATE_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --to)
            [[ $# -ge 2 ]] || SlotFail "--to requires a slot"
            TARGET_SLOT="$2"
            shift 2
            ;;
        --release)
            [[ $# -ge 2 ]] || SlotFail "--release requires a releaseId"
            EXPECTED_RELEASE_ID="$2"
            shift 2
            ;;
        --image-digest)
            [[ $# -ge 2 ]] || SlotFail "--image-digest requires a digest"
            EXPECTED_IMAGE_DIGEST="$2"
            shift 2
            ;;
        --kind)
            [[ $# -ge 2 ]] || SlotFail "--kind requires switch"
            TRANSITION_KIND="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || SlotFail "--state-file requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        --active-upstream)
            [[ $# -ge 2 ]] || SlotFail "--active-upstream requires a path"
            ACTIVE_UPSTREAM_FILE="$2"
            shift 2
            ;;
        --gateway-config)
            [[ $# -ge 2 ]] || SlotFail "--gateway-config requires a path"
            GATEWAY_CONFIG_FILE="$2"
            shift 2
            ;;
        --public-url)
            [[ $# -ge 2 ]] || SlotFail "--public-url requires a URL"
            PUBLIC_PROBE_URL="$2"
            shift 2
            ;;
        --evidence-dir)
            [[ $# -ge 2 ]] || SlotFail "--evidence-dir requires a path"
            EVIDENCE_DIR="$2"
            shift 2
            ;;
        --admin-header-file)
            [[ $# -ge 2 ]] || SlotFail "--admin-header-file requires a path"
            DEPLOYMENT_ADMIN_HEADER_FILE="$2"
            shift 2
            ;;
        --control-origin)
            [[ $# -ge 2 ]] || SlotFail "--control-origin requires an origin"
            DEPLOYMENT_CONTROL_ORIGIN="$2"
            shift 2
            ;;
        --drain-timeout-seconds)
            [[ $# -ge 2 ]] || SlotFail "--drain-timeout-seconds requires a value"
            DRAIN_TIMEOUT_SECONDS="$2"
            shift 2
            ;;
        --defer-source-drain)
            DEFER_SOURCE_DRAIN=1
            shift
            ;;
        --rollout-state-file)
            [[ $# -ge 2 ]] || SlotFail "--rollout-state-file requires a path"
            ROLLOUT_STATE_FILE="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

[[ "$TRANSITION_KIND" != "rollback" ]] || SlotFail "schema_image_only_rollback_retired"
[[ "$TRANSITION_KIND" == "switch" ]] || SlotFail "--kind must be switch"
SlotRequire "$TARGET_SLOT"
[[ -n "$EXPECTED_RELEASE_ID" ]] || SlotFail "--release is required"
[[ -f "$ACTIVE_UPSTREAM_FILE" ]] || SlotFail "active upstream file is missing: $ACTIVE_UPSTREAM_FILE"
[[ -f "$GATEWAY_CONFIG_FILE" ]] || SlotFail "gateway config is missing: $GATEWAY_CONFIG_FILE"
[[ "$PUBLIC_PROBE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] ||
    { [[ "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" && "$PUBLIC_PROBE_URL" =~ ^http://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] ||
        SlotFail "public probe URL must be an explicit HTTPS /health/ready URL"; }
[[ -n "$DEPLOYMENT_CONTROL_ORIGIN" ]] || DEPLOYMENT_CONTROL_ORIGIN="${PUBLIC_PROBE_URL%/health/ready}"
[[ -f "$DEPLOYMENT_ADMIN_HEADER_FILE" ]] || SlotFail "deployment admin header file is required"
[[ "$DRAIN_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$DRAIN_TIMEOUT_SECONDS" -ge 5 && "$DRAIN_TIMEOUT_SECONDS" -le 300 ]] ||
    SlotFail "drain timeout must be between 5 and 300 seconds"
if [[ "$DEFER_SOURCE_DRAIN" == "1" ]]; then
    [[ -f "$ROLLOUT_STATE_FILE" ]] || SlotFail "--defer-source-drain requires a durable --rollout-state-file"
    rollout_guard="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")" ||
        SlotFail "unable to read rollout state for deferred drain"
    deferred_guard_ok="$(jq -r --arg slot "$TARGET_SLOT" --arg release "$EXPECTED_RELEASE_ID" '
    .status == "running" and .currentStage == "gateway-switch"
    and .target.slot == $slot and .target.releaseId == $release
  ' <<<"$rollout_guard")"
    [[ "$deferred_guard_ok" == "true" ]] ||
        SlotFail "deferred drain is allowed only from the unique rollout gateway stage"
    POST_SWITCH_PROBE_URL="${PUBLIC_PROBE_URL%/health/ready}/health/live"
    POST_SWITCH_LOOPBACK_PATH="/health/live"
else
    POST_SWITCH_PROBE_URL="$PUBLIC_PROBE_URL"
fi
SlotRequireCommand curl
SlotRequireCommand date
SlotRequireCommand flock
SlotRequireCommand jq
SlotRequireCommand node
SlotRequireCommand awk
SlotRequireCommand sleep
SlotRequireCommand "$OPENRESTY_BIN"
SlotAcquireDeploymentLock

started_epoch_ms="$(date -u +%s%3N)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
prepared_file=""
staged_config=""
backup_file=""
installed=0
transition_started=0
planned_generation=0
source_slot=""
source_release=""
source_digest=""
target_digest="$EXPECTED_IMAGE_DIGEST"
upstream_before_sha=""
upstream_after_sha=""
target_identity_ok=false
target_readiness_ok=false
source_public_release_ok=false
staged_config_ok=false
state_begin_ok=false
upstream_install_ok=false
active_config_ok=false
reload_ok=false
public_release_ok=false
target_loopback_after_reload_ok=false
state_commit_ok=false
source_runtime_status_ok=false
target_runtime_status_ok=false
target_activation_ok=false
source_drain_ok=false
source_drain_deferred=false
target_neutralized_on_recovery=false
target_activation_attempted=0
source_port=0
source_generation=0
target_generation=0
source_runtime_before=null
target_runtime_before=null
target_runtime_after=null
source_runtime_after=null

WriteEvidence() {
    local status="$1"
    local failureStage="${2:-}"
    local message="${3:-}"
    local recoveryAction="${4:-none}"
    local completedEpochMs completedAt durationMs generation evidenceFile evidence stateSnapshot
    completedEpochMs="$(date -u +%s%3N)"
    completedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    durationMs=$((completedEpochMs - started_epoch_ms))
    generation="$planned_generation"
    stateSnapshot="$(SlotStateReadCurrent 2>/dev/null || true)"
    if jq -e 'type == "object" and (.switchGeneration | type == "number")' >/dev/null 2>&1 <<<"$stateSnapshot"; then
        generation="$(jq -r 'if .pendingTransition != null then .pendingTransition.generation else .switchGeneration end' <<<"$stateSnapshot")"
    fi
    [[ "$generation" =~ ^[0-9]+$ ]] || generation=0
    mkdir -p "$EVIDENCE_DIR"
    evidenceFile="$EVIDENCE_DIR/$(date -u +%Y%m%d%H%M%S%3N)-${generation}-${TRANSITION_KIND}-$$.json"
    evidence="$(jq -cn \
        --arg kind "$TRANSITION_KIND" \
        --arg status "$status" \
        --arg startedAt "$started_at" \
        --arg completedAt "$completedAt" \
        --arg sourceSlot "$source_slot" \
        --arg sourceReleaseId "$source_release" \
        --arg sourceImageDigest "$source_digest" \
        --arg targetSlot "$TARGET_SLOT" \
        --arg targetReleaseId "$EXPECTED_RELEASE_ID" \
        --arg targetImageDigest "$target_digest" \
        --arg publicProbeUrl "$PUBLIC_PROBE_URL" \
        --arg postSwitchProbeUrl "$POST_SWITCH_PROBE_URL" \
        --arg failureStage "$failureStage" \
        --arg error "$message" \
        --arg recoveryAction "$recoveryAction" \
        --arg upstreamBeforeSha256 "$upstream_before_sha" \
        --arg upstreamAfterSha256 "$upstream_after_sha" \
        --argjson generation "$generation" \
        --argjson durationMs "$durationMs" \
        --argjson targetIdentity "$target_identity_ok" \
        --argjson targetReadiness "$target_readiness_ok" \
        --argjson sourcePublicRelease "$source_public_release_ok" \
        --argjson stagedConfigTest "$staged_config_ok" \
        --argjson stateBegin "$state_begin_ok" \
        --argjson upstreamInstall "$upstream_install_ok" \
        --argjson activeConfigTest "$active_config_ok" \
        --argjson reload "$reload_ok" \
        --argjson publicReleaseProbe "$public_release_ok" \
        --argjson targetLoopbackAfterReload "$target_loopback_after_reload_ok" \
        --argjson stateCommit "$state_commit_ok" \
        --argjson sourceRuntimeStatus "$source_runtime_status_ok" \
        --argjson targetRuntimeStatus "$target_runtime_status_ok" \
        --argjson targetActivation "$target_activation_ok" \
        --argjson sourceDrain "$source_drain_ok" \
        --argjson sourceDrainDeferred "$source_drain_deferred" \
        --argjson targetNeutralizedOnRecovery "$target_neutralized_on_recovery" \
        --argjson sourceRuntimeBefore "$source_runtime_before" \
        --argjson targetRuntimeBefore "$target_runtime_before" \
        --argjson targetRuntimeAfter "$target_runtime_after" \
        --argjson sourceRuntimeAfter "$source_runtime_after" '
    {
      schema: "fsusblog.gateway-transition-evidence.v1",
      kind: $kind,
      status: $status,
      generation: $generation,
      startedAtUtc: $startedAt,
      completedAtUtc: $completedAt,
      durationMs: $durationMs,
      source: {slot: $sourceSlot, releaseId: $sourceReleaseId, imageDigest: $sourceImageDigest},
      target: {slot: $targetSlot, releaseId: $targetReleaseId, imageDigest: $targetImageDigest},
      checks: {
        targetIdentity: $targetIdentity,
        targetReadiness: $targetReadiness,
        sourcePublicRelease: $sourcePublicRelease,
        stagedConfigTest: $stagedConfigTest,
        stateBegin: $stateBegin,
        upstreamInstall: $upstreamInstall,
        activeConfigTest: $activeConfigTest,
        reload: $reload,
        publicReleaseProbe: $publicReleaseProbe,
        targetLoopbackAfterReload: $targetLoopbackAfterReload,
        stateCommit: $stateCommit,
        sourceRuntimeStatus: $sourceRuntimeStatus,
        targetRuntimeStatus: $targetRuntimeStatus,
        targetActivation: $targetActivation,
        sourceDrain: $sourceDrain,
        sourceDrainDeferred: $sourceDrainDeferred,
        targetNeutralizedOnRecovery: $targetNeutralizedOnRecovery
      },
      lifecycle: {
        sourceBefore: $sourceRuntimeBefore,
        targetBefore: $targetRuntimeBefore,
        targetAfterActivation: $targetRuntimeAfter,
        sourceAfterDrain: $sourceRuntimeAfter
      },
      publicProbeUrl: $publicProbeUrl,
      postSwitchProbeUrl: $postSwitchProbeUrl,
      upstreamBeforeSha256: $upstreamBeforeSha256,
      upstreamAfterSha256: $upstreamAfterSha256,
      failureStage: (if $failureStage == "" then null else $failureStage end),
      error: (if $error == "" then null else $error end),
      recoveryAction: $recoveryAction
    }')"
    printf '%s\n' "$evidence" | node "$ROOT_DIR/tools/deployment/gateway-control.mjs" write-evidence --output "$evidenceFile" >/dev/null
    printf '%s\n' "$evidence" | node "$ROOT_DIR/tools/deployment/gateway-control.mjs" write-evidence --output "$EVIDENCE_DIR/latest.json" >/dev/null
    printf '%s\n' "$evidenceFile"
}

GatewayFail() {
    local failureStage="$1"
    local message="$2"
    local recoveryAction="${3:-none}"
    local evidenceFile
    evidenceFile="$(WriteEvidence failed "$failureStage" "$message" "$recoveryAction" 2>/dev/null || true)"
    [[ -n "$evidenceFile" ]] && printf '[gateway-switch] evidence=%s\n' "$evidenceFile" >&2
    printf '[gateway-switch] fatal stage=%s: %s\n' "$failureStage" "$message" >&2
    exit 1
}

ProbeReleaseOnce() {
    local url="$1"
    local expectedRelease="$2"
    local expectedSlot="$3"
    local headers actualRelease actualSlot
    headers="$(curl -fsS --max-time 10 -D - -o /dev/null "$url")" || return 1
    actualRelease="$(awk 'BEGIN { IGNORECASE=1 } /^X-Fsus-Release-Id:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' <<<"$headers")"
    actualSlot="$(awk 'BEGIN { IGNORECASE=1 } /^X-Fsus-Release-Slot:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' <<<"$headers")"
    [[ "$actualRelease" == "$expectedRelease" && "$actualSlot" == "$expectedSlot" ]]
}

ProbeReleaseUntil() {
    local url="$1"
    local expectedRelease="$2"
    local expectedSlot="$3"
    local timeout="${FSUSBLOG_GATEWAY_PROBE_TIMEOUT_SECONDS:-30}"
    local interval="${FSUSBLOG_GATEWAY_PROBE_INTERVAL_SECONDS:-1}"
    [[ "$timeout" =~ ^[0-9]+$ && "$timeout" -ge 1 ]] || return 1
    [[ "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 ]] || return 1
    local deadline=$((SECONDS + timeout))
    while ((SECONDS < deadline)); do
        ProbeReleaseOnce "$url" "$expectedRelease" "$expectedSlot" && return 0
        sleep "$interval"
    done
    return 1
}

DeploymentControl() {
    local action="$1"
    local port="$2"
    shift 2
    "$ROOT_DIR/tools/deployment/deployment-control.sh" "$action" \
        --port "$port" \
        --admin-header-file "$DEPLOYMENT_ADMIN_HEADER_FILE" \
        --origin "$DEPLOYMENT_CONTROL_ORIGIN" \
        "$@"
}

SanitizeRuntimeSnapshot() {
    jq -c '{releaseId, slot, mode, state, generation, canReceiveTraffic, canClaimBackgroundWork, canAcceptNotificationStream, inFlightHttpRequests, notificationStreamConnections, activeBackgroundClaims, drain: {requested: .drain.requested, drained: .drain.drained, timedOut: .drain.timedOut, blockers: .drain.blockers}}'
}

state="$(SlotStateReadCurrent)" || GatewayFail state-read "unable to read durable slot state"
[[ "$(jq -r '.status' <<<"$state")" == "stable" ]] || GatewayFail state-read "gateway state is not stable; run gateway-recover.sh"
planned_generation="$(jq -r '.switchGeneration + 1' <<<"$state")"
source_slot="$(jq -r '.activeSlot // ""' <<<"$state")"
source_release="$(jq -r '.activeReleaseId // ""' <<<"$state")"
source_digest="$(jq -r '.activeImageDigest // ""' <<<"$state")"
[[ -n "$source_slot" && -n "$source_release" && -n "$source_digest" ]] || GatewayFail state-read "active release identity is not initialized"
[[ "$source_slot" != "$TARGET_SLOT" ]] || GatewayFail state-read "target slot is already active"

source="$("$ROOT_DIR"/tools/deployment/slot-inspect.sh --slot "$source_slot" --state-file "$SLOT_STATE_FILE")" ||
    GatewayFail source-inspect "unable to inspect active source slot"
[[ "$(jq -r '.exists and .running and .identityMatchesSlot and .loopbackOnly and .liveness == "ok" and .readiness == "ok"' <<<"$source")" == "true" ]] ||
    GatewayFail source-inspect "persisted source slot is not a healthy loopback runtime"
[[ "$(jq -r '.release.releaseId' <<<"$source")" == "$source_release" &&
"$(jq -r '.release.imageDigest' <<<"$source")" == "$source_digest" ]] ||
    GatewayFail source-inspect "source runtime identity does not match durable gateway state"
[[ "$(jq -r '.release.deploymentGeneration == .persisted.record.deploymentGeneration' <<<"$source")" == "true" ]] ||
    GatewayFail source-inspect "source runtime generation does not match durable slot state"
source_port="$(jq -r '.port' <<<"$source")"
source_generation="$(jq -r '.release.deploymentGeneration' <<<"$source")"
[[ "$source_generation" =~ ^[0-9]+$ && "$source_generation" -ge 1 ]] ||
    GatewayFail source-inspect "source runtime deployment generation is invalid"
source_runtime_raw="$(DeploymentControl status "$source_port")" ||
    GatewayFail source-runtime-status "unable to read active source deployment state"
[[ "$(jq -r --arg release "$source_release" --arg slot "$source_slot" --argjson generation "$source_generation" '.releaseId == $release and .slot == $slot and .generation == $generation and .mode == "active" and .state == "active" and .canReceiveTraffic == true' <<<"$source_runtime_raw")" == "true" ]] ||
    GatewayFail source-runtime-status "source runtime is not the uniquely active deployment identity"
source_runtime_before="$(SanitizeRuntimeSnapshot <<<"$source_runtime_raw")"
source_runtime_status_ok=true

current_upstream="$(node "$ROOT_DIR/tools/deployment/gateway-control.mjs" inspect --file "$ACTIVE_UPSTREAM_FILE")" ||
    GatewayFail upstream-read "active upstream file is invalid"
[[ "$(jq -r '.slot' <<<"$current_upstream")" == "$source_slot" ]] ||
    GatewayFail upstream-read "active upstream does not match persisted active slot"
upstream_before_sha="$(jq -r '.sha256' <<<"$current_upstream")"

target="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$TARGET_SLOT" --state-file "$SLOT_STATE_FILE")" ||
    GatewayFail target-inspect "unable to inspect target slot"
[[ "$(jq -r '.exists and .running and .identityMatchesSlot and .loopbackOnly and .liveness == "ok" and .readiness == "ok"' <<<"$target")" == "true" ]] ||
    GatewayFail target-readiness "target slot is missing, stopped, draining, misbound or not ready"
[[ "$(jq -r '.persisted.record.status // ""' <<<"$target")" == "running" ]] ||
    GatewayFail target-readiness "persisted target slot is not in running state"
[[ "$(jq -r '.release.releaseId' <<<"$target")" == "$EXPECTED_RELEASE_ID" ]] ||
    GatewayFail target-identity "target runtime releaseId does not match request"
target_digest="$(jq -r '.release.imageDigest' <<<"$target")"
[[ -z "$EXPECTED_IMAGE_DIGEST" || "$target_digest" == "$EXPECTED_IMAGE_DIGEST" ]] ||
    GatewayFail target-identity "target runtime image digest does not match request"
[[ "$(jq -r '.persisted.record.imageDigest // ""' <<<"$target")" == "$target_digest" ]] ||
    GatewayFail target-identity "target runtime image digest does not match durable slot state"
[[ "$(jq -r '.release.deploymentGeneration == .persisted.record.deploymentGeneration' <<<"$target")" == "true" ]] ||
    GatewayFail target-identity "target runtime generation does not match durable slot state"
target_identity_ok=true

target_port="$(jq -r '.port' <<<"$target")"
target_generation="$(jq -r '.release.deploymentGeneration' <<<"$target")"
[[ "$target_generation" =~ ^[0-9]+$ && "$target_generation" -ge 1 ]] ||
    GatewayFail target-identity "target runtime deployment generation is invalid"
ProbeReleaseOnce "http://127.0.0.1:$target_port/health/ready" "$EXPECTED_RELEASE_ID" "$TARGET_SLOT" ||
    GatewayFail target-readiness "target loopback release headers/readiness do not match"
target_readiness_ok=true
target_runtime_raw="$(DeploymentControl status "$target_port")" ||
    GatewayFail target-runtime-status "unable to read candidate deployment state"
target_runtime_acceptable="$(jq -r \
    --arg release "$EXPECTED_RELEASE_ID" \
    --arg slot "$TARGET_SLOT" \
    --argjson generation "$target_generation" '
    .releaseId == $release
    and .slot == $slot
    and .generation == $generation
    and .mode == "candidate" and .state == "ready"
    and .canReceiveTraffic == false and .canClaimBackgroundWork == false
  ' <<<"$target_runtime_raw")"
[[ "$target_runtime_acceptable" == "true" ]] ||
    GatewayFail target-runtime-status "target runtime is not an exact ready candidate"
target_runtime_before="$(SanitizeRuntimeSnapshot <<<"$target_runtime_raw")"
target_runtime_status_ok=true
ProbeReleaseOnce "$PUBLIC_PROBE_URL" "$source_release" "$source_slot" ||
    GatewayFail public-source-probe "public gateway does not currently serve persisted active release"
source_public_release_ok=true

prepared="$(node "$ROOT_DIR/tools/deployment/gateway-control.mjs" prepare \
    --slot "$TARGET_SLOT" \
    --active "$ACTIVE_UPSTREAM_FILE" \
    --config "$GATEWAY_CONFIG_FILE")" || GatewayFail prepare-config "unable to create durable staged upstream/config"
prepared_file="$(jq -r '.preparedFile' <<<"$prepared")"
staged_config="$(jq -r '.stagedConfig' <<<"$prepared")"
upstream_after_sha="$(jq -r '.upstreamSha256' <<<"$prepared")"
backup_file="$(dirname "$ACTIVE_UPSTREAM_FILE")/.${TRANSITION_KIND}-backup-$(date -u +%Y%m%d%H%M%S)-$$.conf"

if ! "$OPENRESTY_BIN" -t -c "$staged_config"; then
    rm -f "$prepared_file" "$staged_config"
    GatewayFail staged-config-test "OpenResty rejected staged target upstream"
fi
staged_config_ok=true

if [[ "$DRY_RUN" == "1" ]]; then
    rm -f "$prepared_file" "$staged_config"
    jq -cn \
        --arg kind "$TRANSITION_KIND" \
        --arg fromSlot "$source_slot" \
        --arg fromRelease "$source_release" \
        --arg fromDigest "$source_digest" \
        --arg toSlot "$TARGET_SLOT" \
        --arg toRelease "$EXPECTED_RELEASE_ID" \
        --arg toDigest "$target_digest" \
        --argjson toPort "$target_port" \
        --argjson sourceGeneration "$source_generation" \
        --argjson targetGeneration "$target_generation" \
        --arg activeUpstream "$ACTIVE_UPSTREAM_FILE" \
        --arg gatewayConfig "$GATEWAY_CONFIG_FILE" \
        --arg upstreamBeforeSha256 "$upstream_before_sha" \
        --arg upstreamAfterSha256 "$upstream_after_sha" \
        --argjson deferSourceDrain "$([[ "$DEFER_SOURCE_DRAIN" == "1" ]] && printf true || printf false)" \
        '{status: "dry-run", kind: $kind, source: {slot: $fromSlot, releaseId: $fromRelease, imageDigest: $fromDigest, generation: $sourceGeneration}, target: {slot: $toSlot, releaseId: $toRelease, imageDigest: $toDigest, generation: $targetGeneration, host: "127.0.0.1", port: $toPort}, validated: ["durable-state", "source-runtime-active", "target-runtime-ready-candidate", "target-runtime-identity", "target-readiness", "source-public-release", "staged-openresty-config"], planned: (["persist-switching-state", "atomic-upstream-install", "active-openresty-config-test", "activate-target-runtime", "graceful-reload", "target-public-release", "commit-durable-state"] + (if $deferSourceDrain then ["defer-source-drain-to-rollout-before-active-fence"] else ["drain-source-runtime"] end) + ["write-evidence"]), deferSourceDrain: $deferSourceDrain, activeUpstream: $activeUpstream, gatewayConfig: $gatewayConfig, upstreamBeforeSha256: $upstreamBeforeSha256, upstreamAfterSha256: $upstreamAfterSha256}'
    exit 0
fi

if ! node "$ROOT_DIR/tools/deployment/slot-state.mjs" begin-transition \
    --state "$SLOT_STATE_FILE" \
    --slot "$TARGET_SLOT" \
    --release-id "$EXPECTED_RELEASE_ID" \
    --image-digest "$target_digest" \
    --kind "$TRANSITION_KIND" >/dev/null; then
    rm -f "$prepared_file" "$staged_config"
    GatewayFail state-begin "unable to persist switching state"
fi
transition_started=1
state_begin_ok=true

MarkInterruptedTransition() {
    local signal="$1"
    if [[ "$transition_started" == "1" ]]; then
        node "$ROOT_DIR/tools/deployment/slot-state.mjs" rollback-required \
            --state "$SLOT_STATE_FILE" --message "interrupted by $signal during gateway transition" >/dev/null 2>&1 || true
    fi
    printf '[gateway-switch] interrupted by %s; run gateway-recover.sh\n' "$signal" >&2
    exit 130
}
trap 'MarkInterruptedTransition INT' INT
trap 'MarkInterruptedTransition TERM' TERM
trap 'MarkInterruptedTransition HUP' HUP

RecoverSource() {
    local failureStage="$1"
    local message="$2"
    local recovered=0
    if [[ "$target_activation_attempted" == "1" ]]; then
        node "$ROOT_DIR/tools/deployment/slot-state.mjs" rollback-required \
            --state "$SLOT_STATE_FILE" --message "$failureStage: verified database restore or forward recovery required" >/dev/null 2>&1 || true
        GatewayFail "$failureStage" "$message" "schema-restore-or-forward-required"
    fi
    if [[ "$installed" == "1" && -n "$backup_file" && -f "$backup_file" ]]; then
        if node "$ROOT_DIR/tools/deployment/gateway-control.mjs" restore --active "$ACTIVE_UPSTREAM_FILE" --backup "$backup_file" >/dev/null &&
            "$OPENRESTY_BIN" -t -c "$GATEWAY_CONFIG_FILE" &&
            "$OPENRESTY_BIN" -s reload -c "$GATEWAY_CONFIG_FILE" &&
            ProbeReleaseUntil "$PUBLIC_PROBE_URL" "$source_release" "$source_slot"; then
            recovered=1
        fi
    elif [[ "$installed" == "0" ]]; then
        recovered=1
    fi

    if [[ "$recovered" == "1" ]]; then
        node "$ROOT_DIR/tools/deployment/slot-state.mjs" abort-transition \
            --state "$SLOT_STATE_FILE" --message "$failureStage: $message" >/dev/null ||
            GatewayFail state-abort "source upstream recovered but stable state could not be persisted" "source-restored-state-write-failed"
        rm -f "$prepared_file" "$staged_config" "$backup_file"
        GatewayFail "$failureStage" "$message" "source-upstream-restored"
    fi

    node "$ROOT_DIR/tools/deployment/slot-state.mjs" rollback-required \
        --state "$SLOT_STATE_FILE" --message "$failureStage: $message" >/dev/null 2>&1 || true
    GatewayFail "$failureStage" "$message" "rollback-required-manual-recovery"
}

if ! node "$ROOT_DIR/tools/deployment/gateway-control.mjs" install \
    --active "$ACTIVE_UPSTREAM_FILE" \
    --prepared "$prepared_file" \
    --backup "$backup_file" >/dev/null; then
    RecoverSource install-upstream "atomic upstream install failed"
fi
installed=1
upstream_install_ok=true

if ! "$OPENRESTY_BIN" -t -c "$GATEWAY_CONFIG_FILE"; then
    RecoverSource active-config-test "OpenResty rejected installed target upstream"
fi
active_config_ok=true
target_activation_attempted=1
if ! target_activation_raw="$(DeploymentControl activate "$target_port" \
    --slot "$TARGET_SLOT" \
    --release "$EXPECTED_RELEASE_ID" \
    --generation "$target_generation")"; then
    RecoverSource target-activation "candidate runtime activation failed"
fi
target_activation_ok=true
target_runtime_after="$(jq -c '.snapshot' <<<"$target_activation_raw" | SanitizeRuntimeSnapshot)"
if ! "$OPENRESTY_BIN" -s reload -c "$GATEWAY_CONFIG_FILE"; then
    RecoverSource reload "OpenResty graceful reload failed"
fi
reload_ok=true
if ! ProbeReleaseUntil "$POST_SWITCH_PROBE_URL" "$EXPECTED_RELEASE_ID" "$TARGET_SLOT"; then
    RecoverSource public-release-probe "public gateway did not serve target release after reload"
fi
public_release_ok=true
if ! ProbeReleaseOnce "http://127.0.0.1:$target_port$POST_SWITCH_LOOPBACK_PATH" "$EXPECTED_RELEASE_ID" "$TARGET_SLOT"; then
    RecoverSource target-loopback-post-reload "target loopback release changed or failed its post-switch health probe after reload"
fi
target_loopback_after_reload_ok=true

if ! node "$ROOT_DIR/tools/deployment/slot-state.mjs" commit-transition --state "$SLOT_STATE_FILE" >/dev/null; then
    RecoverSource state-commit "target served traffic but active state commit failed"
fi
transition_started=0
state_commit_ok=true
if [[ "$DEFER_SOURCE_DRAIN" == "1" ]]; then
    source_runtime_deferred_raw="$(DeploymentControl status "$source_port")" ||
        GatewayFail source-runtime-status "target is committed active but source runtime status could not be captured before deferred drain" "target-remains-active-source-drain-needs-operator"
    source_runtime_after="$(SanitizeRuntimeSnapshot <<<"$source_runtime_deferred_raw")"
    source_drain_deferred=true
else
    if ! source_drain_raw="$(DeploymentControl drain "$source_port" \
        --slot "$source_slot" \
        --release "$source_release" \
        --generation "$source_generation" \
        --timeout-seconds "$DRAIN_TIMEOUT_SECONDS" \
        --wait)"; then
        GatewayFail source-drain "target is committed active but source runtime did not drain cleanly" "target-remains-active-source-drain-needs-operator"
    fi
    source_runtime_after="$(SanitizeRuntimeSnapshot <<<"$source_drain_raw")"
    source_drain_ok=true
fi
trap - INT TERM HUP
rm -f "$staged_config" "$backup_file"
if ! evidenceFile="$(WriteEvidence ok "" "" none)"; then
    printf '[gateway-switch] fatal stage=evidence-write: gateway switched but evidence persistence failed\n' >&2
    exit 1
fi
jq -cn \
    --arg status "ok" \
    --arg kind "$TRANSITION_KIND" \
    --arg sourceSlot "$source_slot" \
    --arg sourceRelease "$source_release" \
    --arg targetSlot "$TARGET_SLOT" \
    --arg targetRelease "$EXPECTED_RELEASE_ID" \
    --arg targetDigest "$target_digest" \
    --arg evidence "$evidenceFile" \
    --argjson sourceDrainDeferred "$source_drain_deferred" \
    '{status: $status, kind: $kind, source: {slot: $sourceSlot, releaseId: $sourceRelease}, target: {slot: $targetSlot, releaseId: $targetRelease, imageDigest: $targetDigest}, sourceDrainDeferred: $sourceDrainDeferred, evidence: $evidence}'

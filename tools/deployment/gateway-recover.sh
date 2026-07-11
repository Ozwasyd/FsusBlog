#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

ACTION="auto"
DRY_RUN=0
ACTIVE_UPSTREAM_FILE="${FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM:-/etc/openresty/fsusblog/active-upstream.conf}"
GATEWAY_CONFIG_FILE="${FSUSBLOG_GATEWAY_CONFIG_FILE:-/etc/openresty/nginx.conf}"
PUBLIC_PROBE_URL="${FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL:-}"
OPENRESTY_BIN="${FSUSBLOG_OPENRESTY_BIN:-openresty}"
EVIDENCE_DIR="${FSUSBLOG_GATEWAY_EVIDENCE_DIR:-/var/lib/fsusblog/deployment/evidence}"
DEPLOYMENT_ADMIN_HEADER_FILE="${FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE:-}"
DEPLOYMENT_CONTROL_ORIGIN="${FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN:-}"
DRAIN_TIMEOUT_SECONDS="${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-45}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --action) [[ $# -ge 2 ]] || slot_fail "--action requires auto, inspect, restore-source or commit-target"; ACTION="$2"; shift 2 ;;
    --state-file) [[ $# -ge 2 ]] || slot_fail "--state-file requires a path"; SLOT_STATE_FILE="$2"; shift 2 ;;
    --active-upstream) [[ $# -ge 2 ]] || slot_fail "--active-upstream requires a path"; ACTIVE_UPSTREAM_FILE="$2"; shift 2 ;;
    --gateway-config) [[ $# -ge 2 ]] || slot_fail "--gateway-config requires a path"; GATEWAY_CONFIG_FILE="$2"; shift 2 ;;
    --public-url) [[ $# -ge 2 ]] || slot_fail "--public-url requires a URL"; PUBLIC_PROBE_URL="$2"; shift 2 ;;
    --evidence-dir) [[ $# -ge 2 ]] || slot_fail "--evidence-dir requires a path"; EVIDENCE_DIR="$2"; shift 2 ;;
    --admin-header-file) [[ $# -ge 2 ]] || slot_fail "--admin-header-file requires a path"; DEPLOYMENT_ADMIN_HEADER_FILE="$2"; shift 2 ;;
    --control-origin) [[ $# -ge 2 ]] || slot_fail "--control-origin requires an origin"; DEPLOYMENT_CONTROL_ORIGIN="$2"; shift 2 ;;
    --drain-timeout-seconds) [[ $# -ge 2 ]] || slot_fail "--drain-timeout-seconds requires a value"; DRAIN_TIMEOUT_SECONDS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) slot_fail "unknown argument: $1" ;;
  esac
done

[[ "$ACTION" == "auto" || "$ACTION" == "inspect" || "$ACTION" == "restore-source" || "$ACTION" == "commit-target" ]] \
  || slot_fail "--action must be auto, inspect, restore-source or commit-target"
[[ -f "$ACTIVE_UPSTREAM_FILE" ]] || slot_fail "active upstream file is missing: $ACTIVE_UPSTREAM_FILE"
[[ -f "$GATEWAY_CONFIG_FILE" ]] || slot_fail "gateway config is missing: $GATEWAY_CONFIG_FILE"
[[ "$PUBLIC_PROBE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] \
  || { [[ "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" && "$PUBLIC_PROBE_URL" =~ ^http://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] \
    || slot_fail "public probe URL must be an explicit HTTPS /health/ready URL"; }
[[ -n "$DEPLOYMENT_CONTROL_ORIGIN" ]] || DEPLOYMENT_CONTROL_ORIGIN="${PUBLIC_PROBE_URL%/health/ready}"
[[ -f "$DEPLOYMENT_ADMIN_HEADER_FILE" ]] || slot_fail "deployment admin header file is required"
[[ "$DRAIN_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$DRAIN_TIMEOUT_SECONDS" -ge 5 && "$DRAIN_TIMEOUT_SECONDS" -le 300 ]] \
  || slot_fail "drain timeout must be between 5 and 300 seconds"
slot_require_command awk
slot_require_command curl
slot_require_command date
slot_require_command flock
slot_require_command jq
slot_require_command node
slot_require_command sleep
slot_require_command "$OPENRESTY_BIN"
slot_acquire_deployment_lock

started_epoch_ms="$(date -u +%s%3N)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
generation=0
state_status="unknown"
transition_kind="unknown"
source_slot=""
source_release=""
source_digest=""
target_slot=""
target_release=""
target_digest=""
upstream_slot=""
public_before_release=""
public_before_slot=""
public_after_release=""
public_after_slot=""
source_healthy=false
target_healthy=false
active_config_ok=false
reload_ok=false
public_release_ok=false
state_resolution_ok=false
source_runtime_status_ok=false
target_runtime_status_ok=false
target_activation_ok=false
source_drain_ok=false
target_neutralized_ok=false
source_active=false
target_ready=false
target_active=false
source_port=0
target_port=0
source_generation=0
target_generation=0
source_runtime_before=null
target_runtime_before=null
target_runtime_after=null
source_runtime_after=null
resolved_action="$ACTION"

read_release_headers() {
  local url="$1"
  local headers
  headers="$(curl -fsS --max-time 10 -D - -o /dev/null "$url")" || return 1
  HEADER_RELEASE="$(awk 'BEGIN { IGNORECASE=1 } /^X-Fsus-Release-Id:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' <<< "$headers")"
  HEADER_SLOT="$(awk 'BEGIN { IGNORECASE=1 } /^X-Fsus-Release-Slot:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' <<< "$headers")"
  [[ -n "$HEADER_RELEASE" && -n "$HEADER_SLOT" ]]
}

probe_release_until() {
  local url="$1"
  local expected_release="$2"
  local expected_slot="$3"
  local timeout="${FSUSBLOG_GATEWAY_PROBE_TIMEOUT_SECONDS:-30}"
  local interval="${FSUSBLOG_GATEWAY_PROBE_INTERVAL_SECONDS:-1}"
  [[ "$timeout" =~ ^[0-9]+$ && "$timeout" -ge 1 ]] || return 1
  [[ "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 ]] || return 1
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if read_release_headers "$url" && [[ "$HEADER_RELEASE" == "$expected_release" && "$HEADER_SLOT" == "$expected_slot" ]]; then
      public_after_release="$HEADER_RELEASE"
      public_after_slot="$HEADER_SLOT"
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

deployment_control() {
  local action="$1"
  local port="$2"
  shift 2
  "$ROOT_DIR/tools/deployment/deployment-control.sh" "$action" \
    --port "$port" \
    --admin-header-file "$DEPLOYMENT_ADMIN_HEADER_FILE" \
    --origin "$DEPLOYMENT_CONTROL_ORIGIN" \
    "$@"
}

sanitize_runtime_snapshot() {
  jq -c '{releaseId, slot, mode, state, generation, canReceiveTraffic, canClaimBackgroundWork, canAcceptNotificationStream, inFlightHttpRequests, notificationStreamConnections, activeBackgroundClaims, drain: {requested: .drain.requested, drained: .drain.drained, timedOut: .drain.timedOut, blockers: .drain.blockers}}'
}

write_recovery_evidence() {
  local status="$1"
  local message="${2:-}"
  local completed_epoch_ms completed_at duration_ms evidence_file evidence
  completed_epoch_ms="$(date -u +%s%3N)"
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  duration_ms=$((completed_epoch_ms - started_epoch_ms))
  mkdir -p "$EVIDENCE_DIR"
  evidence_file="$EVIDENCE_DIR/$(date -u +%Y%m%d%H%M%S%3N)-${generation}-recovery-$$.json"
  evidence="$(jq -cn \
    --arg status "$status" \
    --arg action "$resolved_action" \
    --arg transitionKind "$transition_kind" \
    --arg initialStateStatus "$state_status" \
    --arg startedAt "$started_at" \
    --arg completedAt "$completed_at" \
    --arg sourceSlot "$source_slot" \
    --arg sourceRelease "$source_release" \
    --arg sourceDigest "$source_digest" \
    --arg targetSlot "$target_slot" \
    --arg targetRelease "$target_release" \
    --arg targetDigest "$target_digest" \
    --arg upstreamSlot "$upstream_slot" \
    --arg publicBeforeRelease "$public_before_release" \
    --arg publicBeforeSlot "$public_before_slot" \
    --arg publicAfterRelease "$public_after_release" \
    --arg publicAfterSlot "$public_after_slot" \
    --arg error "$message" \
    --argjson generation "$generation" \
    --argjson durationMs "$duration_ms" \
    --argjson sourceRuntime "$source_healthy" \
    --argjson targetRuntime "$target_healthy" \
    --argjson activeConfigTest "$active_config_ok" \
    --argjson reload "$reload_ok" \
    --argjson publicReleaseProbe "$public_release_ok" \
    --argjson stateResolution "$state_resolution_ok" \
    --argjson sourceRuntimeStatus "$source_runtime_status_ok" \
    --argjson targetRuntimeStatus "$target_runtime_status_ok" \
    --argjson targetActivation "$target_activation_ok" \
    --argjson sourceDrain "$source_drain_ok" \
    --argjson targetNeutralized "$target_neutralized_ok" \
    --argjson sourceRuntimeBefore "$source_runtime_before" \
    --argjson targetRuntimeBefore "$target_runtime_before" \
    --argjson targetRuntimeAfter "$target_runtime_after" \
    --argjson sourceRuntimeAfter "$source_runtime_after" '
      {
        schema: "fsusblog.gateway-recovery-evidence.v1",
        kind: "recovery",
        status: $status,
        action: $action,
        transitionKind: $transitionKind,
        initialStateStatus: $initialStateStatus,
        generation: $generation,
        startedAtUtc: $startedAt,
        completedAtUtc: $completedAt,
        durationMs: $durationMs,
        source: {slot: $sourceSlot, releaseId: $sourceRelease, imageDigest: $sourceDigest},
        target: {slot: $targetSlot, releaseId: $targetRelease, imageDigest: $targetDigest},
        observedBefore: {upstreamSlot: $upstreamSlot, publicReleaseId: $publicBeforeRelease, publicSlot: $publicBeforeSlot},
        observedAfter: {publicReleaseId: $publicAfterRelease, publicSlot: $publicAfterSlot},
        checks: {
          sourceRuntime: $sourceRuntime,
          targetRuntime: $targetRuntime,
          activeConfigTest: $activeConfigTest,
          reload: $reload,
          publicReleaseProbe: $publicReleaseProbe,
          stateResolution: $stateResolution,
          sourceRuntimeStatus: $sourceRuntimeStatus,
          targetRuntimeStatus: $targetRuntimeStatus,
          targetActivation: $targetActivation,
          sourceDrain: $sourceDrain,
          targetNeutralized: $targetNeutralized
        },
        lifecycle: {
          sourceBefore: $sourceRuntimeBefore,
          targetBefore: $targetRuntimeBefore,
          targetAfterActivation: $targetRuntimeAfter,
          sourceAfterDrain: $sourceRuntimeAfter
        },
        error: (if $error == "" then null else $error end)
      }')"
  printf '%s\n' "$evidence" | node "$ROOT_DIR/tools/deployment/gateway-control.mjs" write-evidence --output "$evidence_file" >/dev/null
  printf '%s\n' "$evidence" | node "$ROOT_DIR/tools/deployment/gateway-control.mjs" write-evidence --output "$EVIDENCE_DIR/latest.json" >/dev/null
  printf '%s\n' "$evidence_file"
}

recovery_fail() {
  local message="$1"
  local evidence_file
  evidence_file="$(write_recovery_evidence failed "$message" 2>/dev/null || true)"
  [[ -n "$evidence_file" ]] && printf '[gateway-recover] evidence=%s\n' "$evidence_file" >&2
  printf '[gateway-recover] fatal: %s\n' "$message" >&2
  exit 1
}

runtime_is_expected() {
  local runtime="$1"
  local release="$2"
  local digest="$3"
  jq -e \
    --arg release "$release" \
    --arg digest "$digest" \
    '.exists and .running and .identityMatchesSlot and .loopbackOnly and .liveness == "ok" and .readiness == "ok" and .persisted.record.status == "running" and .release.releaseId == $release and .release.imageDigest == $digest and .persisted.record.releaseId == $release and .persisted.record.imageDigest == $digest' \
    >/dev/null 2>&1 <<< "$runtime"
}

runtime_identity_is_expected() {
  local runtime="$1"
  local release="$2"
  local digest="$3"
  jq -e \
    --arg release "$release" \
    --arg digest "$digest" \
    '.exists and .running and .identityMatchesSlot and .loopbackOnly and .persisted.record.status == "running" and .release.releaseId == $release and .release.imageDigest == $digest and .persisted.record.releaseId == $release and .persisted.record.imageDigest == $digest and (.release.deploymentGeneration | type == "number" and . >= 1) and .persisted.record.deploymentGeneration == .release.deploymentGeneration' \
    >/dev/null 2>&1 <<< "$runtime"
}

load_source_lifecycle() {
  local runtime="$1"
  source_port="$(jq -r '.port' <<< "$runtime")"
  source_generation="$(jq -r '.release.deploymentGeneration' <<< "$runtime")"
  local raw
  raw="$(deployment_control status "$source_port")" || return 1
  jq -e --arg release "$source_release" --arg slot "$source_slot" --argjson generation "$source_generation" \
    '.releaseId == $release and .slot == $slot and .generation == $generation' >/dev/null <<< "$raw" || return 1
  source_runtime_before="$(sanitize_runtime_snapshot <<< "$raw")"
  source_runtime_status_ok=true
  if [[ "$(jq -r '.mode == "active" and .state == "active" and .canReceiveTraffic == true' <<< "$raw")" == "true" ]]; then
    source_active=true
  fi
  return 0
}

load_target_lifecycle() {
  local runtime="$1"
  target_port="$(jq -r '.port' <<< "$runtime")"
  target_generation="$(jq -r '.release.deploymentGeneration' <<< "$runtime")"
  local raw
  raw="$(deployment_control status "$target_port")" || return 1
  jq -e --arg release "$target_release" --arg slot "$target_slot" --argjson generation "$target_generation" \
    '.releaseId == $release and .slot == $slot and .generation == $generation' >/dev/null <<< "$raw" || return 1
  target_runtime_before="$(sanitize_runtime_snapshot <<< "$raw")"
  target_runtime_status_ok=true
  if [[ "$(jq -r '.mode == "candidate" and .state == "ready" and .canReceiveTraffic == false and .canClaimBackgroundWork == false' <<< "$raw")" == "true" ]]; then
    target_ready=true
  fi
  if [[ "$(jq -r '.mode == "active" and .state == "active" and .canReceiveTraffic == true' <<< "$raw")" == "true" ]]; then
    target_active=true
  fi
  return 0
}

direct_release_is_expected() {
  local runtime="$1"
  local release="$2"
  local slot="$3"
  local port
  port="$(jq -r '.port' <<< "$runtime")"
  read_release_headers "http://127.0.0.1:$port/health/ready" \
    && [[ "$HEADER_RELEASE" == "$release" && "$HEADER_SLOT" == "$slot" ]]
}

activate_upstream() {
  local desired_slot="$1"
  local desired_release="$2"
  local current_slot="$3"
  local prepared="" prepared_file="" staged_config="" backup_file=""
  if [[ "$current_slot" != "$desired_slot" ]]; then
    prepared="$(node "$ROOT_DIR/tools/deployment/gateway-control.mjs" prepare \
      --slot "$desired_slot" --active "$ACTIVE_UPSTREAM_FILE" --config "$GATEWAY_CONFIG_FILE")" || return 1
    prepared_file="$(jq -r '.preparedFile' <<< "$prepared")"
    staged_config="$(jq -r '.stagedConfig' <<< "$prepared")"
    backup_file="$(dirname "$ACTIVE_UPSTREAM_FILE")/.recovery-backup-$(date -u +%Y%m%d%H%M%S)-$$.conf"
    if ! "$OPENRESTY_BIN" -t -c "$staged_config"; then
      rm -f "$prepared_file" "$staged_config"
      return 1
    fi
    if ! node "$ROOT_DIR/tools/deployment/gateway-control.mjs" install \
      --active "$ACTIVE_UPSTREAM_FILE" --prepared "$prepared_file" --backup "$backup_file" >/dev/null; then
      rm -f "$prepared_file" "$staged_config" "$backup_file"
      return 1
    fi
  fi

  if ! "$OPENRESTY_BIN" -t -c "$GATEWAY_CONFIG_FILE"; then
    [[ -n "$backup_file" && -f "$backup_file" ]] \
      && node "$ROOT_DIR/tools/deployment/gateway-control.mjs" restore --active "$ACTIVE_UPSTREAM_FILE" --backup "$backup_file" >/dev/null 2>&1 || true
    rm -f "$staged_config" "$backup_file"
    return 1
  fi
  active_config_ok=true
  if ! "$OPENRESTY_BIN" -s reload -c "$GATEWAY_CONFIG_FILE"; then
    [[ -n "$backup_file" && -f "$backup_file" ]] \
      && node "$ROOT_DIR/tools/deployment/gateway-control.mjs" restore --active "$ACTIVE_UPSTREAM_FILE" --backup "$backup_file" >/dev/null 2>&1 \
      && "$OPENRESTY_BIN" -t -c "$GATEWAY_CONFIG_FILE" >/dev/null 2>&1 \
      && "$OPENRESTY_BIN" -s reload -c "$GATEWAY_CONFIG_FILE" >/dev/null 2>&1 || true
    rm -f "$staged_config" "$backup_file"
    return 1
  fi
  reload_ok=true
  if ! probe_release_until "$PUBLIC_PROBE_URL" "$desired_release" "$desired_slot"; then
    [[ -n "$backup_file" && -f "$backup_file" ]] \
      && node "$ROOT_DIR/tools/deployment/gateway-control.mjs" restore --active "$ACTIVE_UPSTREAM_FILE" --backup "$backup_file" >/dev/null 2>&1 \
      && "$OPENRESTY_BIN" -t -c "$GATEWAY_CONFIG_FILE" >/dev/null 2>&1 \
      && "$OPENRESTY_BIN" -s reload -c "$GATEWAY_CONFIG_FILE" >/dev/null 2>&1 || true
    rm -f "$staged_config" "$backup_file"
    return 1
  fi
  public_release_ok=true
  rm -f "$staged_config" "$backup_file"
  return 0
}

state="$(slot_state_read)" || recovery_fail "unable to read durable gateway state"
state_status="$(jq -r '.status' <<< "$state")"

current_upstream="$(node "$ROOT_DIR/tools/deployment/gateway-control.mjs" inspect --file "$ACTIVE_UPSTREAM_FILE")" \
  || recovery_fail "active upstream file is invalid; refusing to guess traffic ownership"
upstream_slot="$(jq -r '.slot' <<< "$current_upstream")"
if read_release_headers "$PUBLIC_PROBE_URL"; then
  public_before_release="$HEADER_RELEASE"
  public_before_slot="$HEADER_SLOT"
fi

if [[ "$state_status" == "stable" ]]; then
  source_slot="$(jq -r '.activeSlot // ""' <<< "$state")"
  source_release="$(jq -r '.activeReleaseId // ""' <<< "$state")"
  source_digest="$(jq -r '.activeImageDigest // ""' <<< "$state")"
  generation="$(jq -r '.switchGeneration' <<< "$state")"
  [[ -n "$source_slot" && "$upstream_slot" == "$source_slot" \
    && "$public_before_release" == "$source_release" && "$public_before_slot" == "$source_slot" ]] \
    || recovery_fail "stable state disagrees with the active upstream or public release headers"
  source_runtime="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$source_slot" --state-file "$SLOT_STATE_FILE" 2>/dev/null || true)"
  runtime_is_expected "$source_runtime" "$source_release" "$source_digest" \
    && direct_release_is_expected "$source_runtime" "$source_release" "$source_slot" \
    || recovery_fail "stable source runtime identity or readiness is invalid"
  load_source_lifecycle "$source_runtime" \
    || recovery_fail "stable source deployment status cannot be verified"
  [[ "$source_active" == "true" ]] \
    || recovery_fail "stable source runtime is not Active"
  jq -cn \
    --arg slot "$source_slot" --arg release "$source_release" --arg digest "$source_digest" \
    --argjson generation "$generation" \
    --argjson runtimeGeneration "$source_generation" \
    '{status: "stable", action: "none", generation: $generation, active: {slot: $slot, releaseId: $release, imageDigest: $digest, runtimeGeneration: $runtimeGeneration, deploymentState: "active"}}'
  exit 0
fi

[[ "$state_status" == "switching" || "$state_status" == "rollback_required" ]] \
  || recovery_fail "unsupported gateway state status: $state_status"
pending="$(jq -c '.pendingTransition' <<< "$state")"
[[ "$pending" != "null" ]] || recovery_fail "$state_status state has no pending transition"
transition_kind="$(jq -r '.kind' <<< "$pending")"
generation="$(jq -r '.generation' <<< "$pending")"
source_slot="$(jq -r '.fromSlot' <<< "$pending")"
source_release="$(jq -r '.fromReleaseId' <<< "$pending")"
source_digest="$(jq -r '.fromImageDigest' <<< "$pending")"
target_slot="$(jq -r '.toSlot' <<< "$pending")"
target_release="$(jq -r '.toReleaseId' <<< "$pending")"
target_digest="$(jq -r '.toImageDigest' <<< "$pending")"

source_runtime="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$source_slot" --state-file "$SLOT_STATE_FILE" 2>/dev/null || true)"
target_runtime="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$target_slot" --state-file "$SLOT_STATE_FILE" 2>/dev/null || true)"
if runtime_identity_is_expected "$source_runtime" "$source_release" "$source_digest"; then
  load_source_lifecycle "$source_runtime" || true
fi
if runtime_identity_is_expected "$target_runtime" "$target_release" "$target_digest"; then
  load_target_lifecycle "$target_runtime" || true
fi
if runtime_is_expected "$source_runtime" "$source_release" "$source_digest" \
  && direct_release_is_expected "$source_runtime" "$source_release" "$source_slot"; then
  source_healthy=true
fi
if runtime_is_expected "$target_runtime" "$target_release" "$target_digest" \
  && direct_release_is_expected "$target_runtime" "$target_release" "$target_slot"; then
  target_healthy=true
fi

if [[ "$ACTION" == "auto" ]]; then
  if [[ "$upstream_slot" == "$target_slot" && "$public_before_slot" == "$target_slot" \
    && "$public_before_release" == "$target_release" && "$target_healthy" == "true" \
    && "$target_active" == "true" ]]; then
    resolved_action="commit-target"
  elif [[ "$source_healthy" == "true" && "$source_active" == "true" ]]; then
    resolved_action="restore-source"
  elif [[ "$target_healthy" == "true" && ( "$target_ready" == "true" || "$target_active" == "true" ) ]]; then
    resolved_action="commit-target"
  else
    resolved_action="blocked"
  fi
elif [[ "$ACTION" == "inspect" ]]; then
  resolved_action="inspect"
fi

diagnosis="$(jq -cn \
  --arg status "$state_status" \
  --arg transitionKind "$transition_kind" \
  --arg action "$resolved_action" \
  --arg upstreamSlot "$upstream_slot" \
  --arg publicRelease "$public_before_release" \
  --arg publicSlot "$public_before_slot" \
  --arg sourceSlot "$source_slot" \
  --arg sourceRelease "$source_release" \
  --arg targetSlot "$target_slot" \
  --arg targetRelease "$target_release" \
  --argjson generation "$generation" \
  --argjson sourceHealthy "$source_healthy" \
  --argjson targetHealthy "$target_healthy" \
  --argjson sourceActive "$source_active" \
  --argjson targetReady "$target_ready" \
  --argjson targetActive "$target_active" '
    {status: "recovery-required", durableStatus: $status, transitionKind: $transitionKind, generation: $generation, proposedAction: $action, observed: {upstreamSlot: $upstreamSlot, publicReleaseId: $publicRelease, publicSlot: $publicSlot}, source: {slot: $sourceSlot, releaseId: $sourceRelease, healthy: $sourceHealthy, active: $sourceActive}, target: {slot: $targetSlot, releaseId: $targetRelease, healthy: $targetHealthy, readyCandidate: $targetReady, active: $targetActive}}')"

if [[ "$DRY_RUN" == "1" || "$resolved_action" == "inspect" ]]; then
  printf '%s\n' "$diagnosis"
  exit 0
fi
[[ "$resolved_action" != "blocked" ]] \
  || recovery_fail "neither source nor target release is healthy; manual runtime recovery is required"

if [[ "$resolved_action" == "restore-source" ]]; then
  [[ "$source_healthy" == "true" && "$source_active" == "true" ]] \
    || recovery_fail "source release is not a verified Active runtime"
  activate_upstream "$source_slot" "$source_release" "$upstream_slot" \
    || recovery_fail "failed to restore and publicly verify the source release"
  if [[ "$target_runtime_status_ok" == "true" && "$target_active" == "true" ]]; then
    target_drain_raw="$(deployment_control drain "$target_port" \
      --slot "$target_slot" \
      --release "$target_release" \
      --generation "$target_generation" \
      --timeout-seconds "$DRAIN_TIMEOUT_SECONDS" \
      --wait)" \
      || recovery_fail "source traffic was restored but active target drain did not complete"
    target_runtime_after="$(sanitize_runtime_snapshot <<< "$target_drain_raw")"
    target_neutralized_ok=true
  elif [[ "$target_runtime_status_ok" == "true" \
    && "$(jq -r '.canReceiveTraffic == false and .canClaimBackgroundWork == false' <<< "$target_runtime_before")" == "true" ]]; then
    target_runtime_after="$target_runtime_before"
    target_neutralized_ok=true
  elif [[ "$(jq -r '(.exists == false) or (.running == false)' <<< "$target_runtime" 2>/dev/null || printf false)" == "true" ]]; then
    target_neutralized_ok=true
  else
    recovery_fail "source traffic was restored but target runtime could not be proven neutralized"
  fi
  node "$ROOT_DIR/tools/deployment/slot-state.mjs" abort-transition \
    --state "$SLOT_STATE_FILE" --message "gateway recovery restored source release" >/dev/null \
    || recovery_fail "source traffic was restored but durable transition abort failed"
  state_resolution_ok=true
else
  [[ "$target_healthy" == "true" && "$target_runtime_status_ok" == "true" \
    && ( "$target_ready" == "true" || "$target_active" == "true" ) ]] \
    || recovery_fail "target release is not a verified Ready Candidate or Active runtime"
  target_activation_raw="$(deployment_control activate "$target_port" \
    --slot "$target_slot" \
    --release "$target_release" \
    --generation "$target_generation")" \
    || recovery_fail "target runtime activation CAS failed during recovery"
  target_runtime_after="$(jq -c '.snapshot' <<< "$target_activation_raw" | sanitize_runtime_snapshot)"
  target_activation_ok=true
  activate_upstream "$target_slot" "$target_release" "$upstream_slot" \
    || recovery_fail "failed to activate and publicly verify the target release"
  node "$ROOT_DIR/tools/deployment/slot-state.mjs" commit-transition --state "$SLOT_STATE_FILE" >/dev/null \
    || recovery_fail "target traffic is active but durable transition commit failed"
  state_resolution_ok=true
  if [[ "$source_runtime_status_ok" == "true" && "$source_active" == "true" ]]; then
    source_drain_raw="$(deployment_control drain "$source_port" \
      --slot "$source_slot" \
      --release "$source_release" \
      --generation "$source_generation" \
      --timeout-seconds "$DRAIN_TIMEOUT_SECONDS" \
      --wait)" \
      || recovery_fail "target was committed but source drain did not complete"
    source_runtime_after="$(sanitize_runtime_snapshot <<< "$source_drain_raw")"
    source_drain_ok=true
  elif [[ "$source_runtime_status_ok" == "true" \
    && "$(jq -r '.state == "draining" and .drain.requested == true and .drain.drained == true and .drain.timedOut == false' <<< "$source_runtime_before")" == "true" ]]; then
    source_runtime_after="$source_runtime_before"
    source_drain_ok=true
  else
    recovery_fail "target was committed but complete source drain evidence is unavailable"
  fi
fi
evidence_file="$(write_recovery_evidence ok "")" \
  || { printf '[gateway-recover] traffic/state recovered but evidence persistence failed\n' >&2; exit 1; }
jq -cn \
  --arg status "ok" \
  --arg action "$resolved_action" \
  --arg sourceSlot "$source_slot" \
  --arg sourceRelease "$source_release" \
  --arg targetSlot "$target_slot" \
  --arg targetRelease "$target_release" \
  --arg evidence "$evidence_file" \
  --argjson generation "$generation" \
  '{status: $status, action: $action, generation: $generation, source: {slot: $sourceSlot, releaseId: $sourceRelease}, target: {slot: $targetSlot, releaseId: $targetRelease}, evidence: $evidence}'

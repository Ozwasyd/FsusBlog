#!/usr/bin/env bash
set -Euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLAN_TOOL="$SCRIPT_DIR/zero-downtime-rehearsal-plan.mjs"
NORMAL_WORKER_OBSERVER_SCRIPT="$SCRIPT_DIR/release-worker-normal-observer.mjs"
WORKER_OBSERVER_SERVICE_SCRIPT="$SCRIPT_DIR/release-worker-observer-service.mjs"
TOPOLOGY_SCRIPT="$SCRIPT_DIR/zero-downtime-topology.sh"
ROLLOUT_SCRIPT="$SCRIPT_DIR/release-rollout.sh"
FAULT_MATRIX_SCRIPT="$SCRIPT_DIR/zero-downtime-fault-matrix.mjs"
WORKER_DRILL_SCRIPT="$SCRIPT_DIR/release-worker-drill.mjs"
WORKER_RECONCILIATION_SCRIPT="$SCRIPT_DIR/release-worker-reconciliation.mjs"
MIGRATION_QUALIFICATION_SCRIPT="$SCRIPT_DIR/release-migration-qualification.mjs"
ROLLOUT_STATE_SCRIPT="$SCRIPT_DIR/rollout-state.mjs"
RESOURCE_POLICY="$ROOT_DIR/deploy/zero-downtime-resource-policy.json"

PLAN_FILE=""
MODE="all"
RUN_ID=""
RESOLVE_FILE=""
RESOLVED_PLAN=""
RUN_ROOT=""
COMMAND_JOURNAL=""
declare -a REQUESTED_MODES=()
declare -a OVERALL_ERRORS=()
declare -a ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS=()

usage() {
  cat <<'USAGE'
Usage: tools/deployment/zero-downtime-rehearsal.sh --plan <file> [options]

Runs destructive, local-only, repeatable zero-downtime rehearsals from a fail-closed plan.

Options:
  --mode <all|normal|explicit-rollback|post-switch-rollback|sigkill-resume>
  --run-id <safe unique id>  Refuses an existing run directory; no result reuse.

Modes:
  normal                Independent worker qualification, then fresh Blue -> Green rollout.
  explicit-rollback     Blue -> Green, then explicit Green -> Blue --rollback.
  post-switch-rollback  Exact fault matrix with automatic post-switch rollback, plus fresh success control.
  sigkill-resume        Kill the rollout process group with SIGKILL, adopt durable state, then --resume.

The plan must be Test/loopback-only. Secret values are accepted only through mode 0400/0600 files.
Every mode gets isolated topology, state, asset and evidence directories under repository .tmp.
USAGE
}

log() {
  printf '[zero-downtime-rehearsal] %s\n' "$1"
}

fatal() {
  printf '[zero-downtime-rehearsal] fatal: %s\n' "$1" >&2
  exit "${2:-1}"
}

internal_fault_fail() {
  printf '[zero-downtime-rehearsal:fault-case] fatal: %s\n' "$1" >&2
  exit 96
}

worker_observer_service_process_is_live() {
  local pid="$1" state
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$state" && "$state" != Z* ]]
}

worker_observer_service_process_matches() {
  local pid="$1" service_root="$2" index script_seen=0 state_seen=0
  local -a arguments=()
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  mapfile -d '' -t arguments <"/proc/$pid/cmdline" || return 1
  for ((index = 0; index < ${#arguments[@]}; index += 1)); do
    [[ "${arguments[$index]}" == "$WORKER_OBSERVER_SERVICE_SCRIPT" ]] && script_seen=1
    if [[ "${arguments[$index]}" == "--state-dir" \
      && "${arguments[$((index + 1))]:-}" == "$service_root/state" ]]; then
      state_seen=1
    fi
  done
  (( script_seen == 1 && state_seen == 1 ))
}

worker_observer_service_stop_process() {
  local service_root="$1" require_running="${2:-1}"
  local pid_file="$service_root/service.pid" pid="" was_running=0 status=0 state=""
  if [[ ! -f "$pid_file" || -L "$pid_file" ]]; then
    (( require_running == 0 )) && return 0
    return 1
  fi
  pid="$(tr -d '[:space:]' <"$pid_file")"
  if worker_observer_service_process_is_live "$pid"; then
    if ! worker_observer_service_process_matches "$pid" "$service_root"; then
      return 1
    fi
    was_running=1
    if [[ "$(ps -o sid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" == "$pid" ]]; then
      kill -TERM -- "-$pid" >/dev/null 2>&1 || true
    else
      kill -TERM "$pid" >/dev/null 2>&1 || true
      status=1
    fi
    for _ in {1..100}; do
      worker_observer_service_process_is_live "$pid" || break
      sleep 0.05
    done
    if worker_observer_service_process_is_live "$pid"; then
      if [[ "$(ps -o sid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" == "$pid" ]]; then
        kill -KILL -- "-$pid" >/dev/null 2>&1 || true
      else
        kill -KILL "$pid" >/dev/null 2>&1 || true
      fi
    fi
  fi
  wait "$pid" >/dev/null 2>&1 || true
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$state" && "$state" != Z* ]]; then
    status=1
  else
    rm -f "$pid_file"
  fi
  if (( require_running == 1 && was_running == 0 )); then
    status=1
  fi
  return "$status"
}

worker_observer_service_start_process() {
  local service_root="$1" service_plan="$2" rollout_state="$3" observer_env_source="$4" \
    admin_header="$5" log_root="$6"
  local private_env="$service_root/secrets/observer.env"
  local state_dir="$service_root/state" pid_file="$service_root/service.pid"
  local service_label="${service_root##*/}"
  local stdout_file="$log_root/$service_label.stdout"
  local stderr_file="$log_root/$service_label.stderr"
  local pid sid
  [[ ! -e "$service_root" && ! -L "$service_root" ]] || return 1
  [[ -f "$service_plan" && ! -L "$service_plan" ]] || return 1
  [[ -f "$observer_env_source" && ! -L "$observer_env_source" ]] || return 1
  [[ -f "$admin_header" && ! -L "$admin_header" ]] || return 1
  install -d -m 0700 "$service_root" "$service_root/secrets" "$state_dir" "$log_root" || return 1
  install -m 0600 "$observer_env_source" "$private_env" || return 1
  setsid env \
    ASPNETCORE_ENVIRONMENT=Test \
    FSUSBLOG_ROLLOUT_REHEARSAL=1 \
    FSUSBLOG_WORKER_OBSERVER_ENABLED=1 \
    FSUSBLOG_WORKER_OBSERVER_ROOT="$service_root" \
    node "$WORKER_OBSERVER_SERVICE_SCRIPT" \
      --plan "$service_plan" \
      --rollout-state "$rollout_state" \
      --env-file "$private_env" \
      --admin-header-file "$admin_header" \
      --state-dir "$state_dir" \
      >"$stdout_file" 2>"$stderr_file" &
  pid=$!
  sid="$(ps -o sid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$sid" != "$pid" ]]; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
    return 1
  fi
  if ! worker_observer_service_process_matches "$pid" "$service_root"; then
    kill -KILL -- "-$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
    return 1
  fi
  install -m 0600 /dev/null "$pid_file" || {
    kill -KILL -- "-$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
    return 1
  }
  printf '%s\n' "$pid" >"$pid_file"
  for _ in {1..200}; do
    if [[ -s "$stdout_file" ]] \
      && jq -e '.schema == "fsusblog.release-worker-observer-service-response.v1" and .status == "listening"' \
        "$stdout_file" >/dev/null 2>&1; then
      WORKER_OBSERVER_SERVICE_PROCESS_PID="$pid"
      return 0
    fi
    worker_observer_service_process_is_live "$pid" || break
    sleep 0.05
  done
  worker_observer_service_stop_process "$service_root" 0 >/dev/null 2>&1 || true
  return 1
}

internal_fault_context() {
  INTERNAL_RESOLVED_PLAN=""
  INTERNAL_CASE_ROOT=""
  INTERNAL_KIND=""
  INTERNAL_CASE=""
  INTERNAL_ROLLOUT_ID=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --resolved-plan) [[ $# -ge 2 ]] || internal_fault_fail "--resolved-plan requires a path"; INTERNAL_RESOLVED_PLAN="$2"; shift 2 ;;
      --case-root) [[ $# -ge 2 ]] || internal_fault_fail "--case-root requires a path"; INTERNAL_CASE_ROOT="$2"; shift 2 ;;
      --kind) [[ $# -ge 2 ]] || internal_fault_fail "--kind requires a value"; INTERNAL_KIND="$2"; shift 2 ;;
      --case) [[ $# -ge 2 ]] || internal_fault_fail "--case requires a value"; INTERNAL_CASE="$2"; shift 2 ;;
      --rollout-id) [[ $# -ge 2 ]] || internal_fault_fail "--rollout-id requires a value"; INTERNAL_ROLLOUT_ID="$2"; shift 2 ;;
      *) internal_fault_fail "unknown internal fault argument: $1" ;;
    esac
  done
  [[ -f "$INTERNAL_RESOLVED_PLAN" && ! -L "$INTERNAL_RESOLVED_PLAN" ]] \
    || internal_fault_fail "resolved plan must be a regular non-symlink file"
  jq -e '.schema == "fsusblog.zero-downtime-rehearsal-resolved-plan.v1" and .environment == "Test" and .nonProductionOnly == true' \
    "$INTERNAL_RESOLVED_PLAN" >/dev/null 2>&1 || internal_fault_fail "resolved plan is not a Test rehearsal plan"
  [[ "$INTERNAL_KIND" == "deploy" || "$INTERNAL_KIND" == "rollback" ]] || internal_fault_fail "fault kind is invalid"
  [[ "$INTERNAL_CASE" =~ ^[a-z][a-z0-9-]{2,63}$ ]] || internal_fault_fail "fault case is invalid"
  [[ "$INTERNAL_ROLLOUT_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$ ]] || internal_fault_fail "fault rollout id is invalid"
  local work_root
  work_root="$(jq -er '.workRoot' "$INTERNAL_RESOLVED_PLAN")" || internal_fault_fail "workRoot is missing"
  INTERNAL_CASE_ROOT="$(realpath -m "$INTERNAL_CASE_ROOT")"
  [[ "$INTERNAL_CASE_ROOT" == "$work_root/"* ]] || internal_fault_fail "fault case root escapes workRoot"
  INTERNAL_RUNTIME="$INTERNAL_CASE_ROOT/runtime"
  INTERNAL_SLOT_STATE="$INTERNAL_CASE_ROOT/slot-state.json"
  INTERNAL_ROLLOUT_STATE="$INTERNAL_CASE_ROOT/rollout-state.json"
  INTERNAL_EVIDENCE_ROOT="$INTERNAL_CASE_ROOT/rollouts"
  INTERNAL_EVIDENCE_DIR="$INTERNAL_EVIDENCE_ROOT/$INTERNAL_ROLLOUT_ID/evidence"
  INTERNAL_ENV="$INTERNAL_RUNTIME/secrets/rehearsal.env"
  INTERNAL_ADMIN="$INTERNAL_RUNTIME/secrets/admin-header.txt"
  INTERNAL_AUTH="$INTERNAL_RUNTIME/secrets/auth-storage-state.json"
  INTERNAL_PUBLIC_URL="$(jq -er '.publicUrl' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_CONTROL_ORIGIN="$(jq -er '.controlOrigin' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_NOTIFICATION_RESYNC_SCENARIO="$(jq -er '.evidenceInputs.notificationResyncScenario' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_TRAFFIC_BINDING_SOURCE="$(jq -er '.evidenceInputs.trafficBindingKey' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_TRAFFIC_BINDING="$INTERNAL_RUNTIME/secrets/traffic-binding.key"
  INTERNAL_ASSET_BROWSER_BINDING_SOURCE="$(jq -er '.evidenceInputs.assetBrowserBindingKey' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_ASSET_BROWSER_BINDING="$INTERNAL_RUNTIME/secrets/asset-browser-binding.key"
  INTERNAL_PUBLIC_PORT="$(jq -er '.publicPort' "$INTERNAL_RESOLVED_PLAN")"
  if [[ "$INTERNAL_KIND" == "deploy" ]]; then
    INTERNAL_SOURCE_SLOT=blue
    INTERNAL_SOURCE_MANIFEST="$(jq -er '.source.manifest' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_SOURCE_PREVIOUS_ROLLBACK_RELEASE="$(jq -er '.source.previousRollbackRelease' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_TARGET_MANIFEST="$(jq -er '.target.manifest' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_ASSET_SCENARIO="$(jq -er '.assets.deployScenario' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_WORKER_KEY=deploy
  else
    INTERNAL_SOURCE_SLOT=green
    INTERNAL_SOURCE_MANIFEST="$(jq -er '.target.manifest' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_SOURCE_PREVIOUS_ROLLBACK_RELEASE="$(jq -er '.source.releaseId' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_TARGET_MANIFEST="$(jq -er '.source.manifest' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_ASSET_SCENARIO="$(jq -er '.assets.rollbackScenario' "$INTERNAL_RESOLVED_PLAN")"
    INTERNAL_WORKER_KEY=rollback
  fi
  INTERNAL_NORMAL_SCENARIO="$(jq -er ".workers.$INTERNAL_WORKER_KEY.normalScenario.file" "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_OBSERVER_SERVICE_PLAN="$(jq -er ".workers.$INTERNAL_WORKER_KEY.observerServicePlan.file" "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_OBSERVER_ENV_SOURCE="$(jq -er '.workers.observerEnvFile' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_OBSERVER_SERVICE_ROOT="$INTERNAL_CASE_ROOT/worker-observer-service"
  INTERNAL_WORKER_START_STAGE="$(jq -er ".workers.$INTERNAL_WORKER_KEY.startStage" "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_WORKER_TIMEOUT="$(jq -er '.workers.timeoutSeconds' "$INTERNAL_RESOLVED_PLAN")"
  INTERNAL_WORKER_LEDGER="$INTERNAL_EVIDENCE_DIR/worker-normal-ledger.json"
}

internal_fault_setup() {
  internal_fault_context "$@"
  [[ ! -e "$INTERNAL_RUNTIME" && ! -e "$INTERNAL_SLOT_STATE" && ! -e "$INTERNAL_ROLLOUT_STATE" ]] \
    || internal_fault_fail "fault case state/runtime already exists"
  mkdir -p "$INTERNAL_RUNTIME/secrets" "$INTERNAL_EVIDENCE_DIR"
  install -m 0600 "$(jq -er '.envFile' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_ENV" \
    || internal_fault_fail "unable to install case env"
  install -m 0600 "$(jq -er '.adminHeaderFile' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_ADMIN" \
    || internal_fault_fail "unable to install case admin header"
  install -m 0600 "$(jq -er '.notificationAuthStorageState' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_AUTH" \
    || internal_fault_fail "unable to install case auth storage state"
  install -m 0600 "$INTERNAL_TRAFFIC_BINDING_SOURCE" "$INTERNAL_TRAFFIC_BINDING" \
    || internal_fault_fail "unable to install case traffic binding key"
  install -m 0600 "$INTERNAL_ASSET_BROWSER_BINDING_SOURCE" "$INTERNAL_ASSET_BROWSER_BINDING" \
    || internal_fault_fail "unable to install case asset browser binding key"
  FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE="$INTERNAL_SOURCE_PREVIOUS_ROLLBACK_RELEASE" \
  bash "$TOPOLOGY_SCRIPT" up \
    --env-file "$INTERNAL_ENV" --source-manifest "$INTERNAL_SOURCE_MANIFEST" --source-slot "$INTERNAL_SOURCE_SLOT" \
    --work-dir "$INTERNAL_RUNTIME" --public-port "$INTERNAL_PUBLIC_PORT" --state-file "$INTERNAL_SLOT_STATE" \
    >"$INTERNAL_CASE_ROOT/topology-up.stdout" 2>"$INTERNAL_CASE_ROOT/topology-up.stderr" \
    || internal_fault_fail "fault case topology startup failed"
  trap 'worker_observer_service_stop_process "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true; exit 96' HUP INT TERM
  if ! worker_observer_service_start_process \
    "$INTERNAL_OBSERVER_SERVICE_ROOT" \
    "$INTERNAL_OBSERVER_SERVICE_PLAN" \
    "$INTERNAL_ROLLOUT_STATE" \
    "$INTERNAL_OBSERVER_ENV_SOURCE" \
    "$INTERNAL_ADMIN" \
    "$INTERNAL_CASE_ROOT"; then
    internal_fault_fail "worker observer service failed during case setup"
  fi
  local observer_run_id="normal-fault-$INTERNAL_CASE-$INTERNAL_ROLLOUT_ID"
  observer_run_id="${observer_run_id:0:120}"
  setsid node "$NORMAL_WORKER_OBSERVER_SCRIPT" \
    --plan "$INTERNAL_NORMAL_SCENARIO" \
    --rollout-state "$INTERNAL_ROLLOUT_STATE" \
    --source-drain "$INTERNAL_EVIDENCE_DIR/source-drain-gate.json" \
    --admin-header-file "$INTERNAL_ADMIN" \
    --out "$INTERNAL_WORKER_LEDGER" \
    --run-id "$observer_run_id" \
    --start-stage "$INTERNAL_WORKER_START_STAGE" \
    --timeout-ms "$((INTERNAL_WORKER_TIMEOUT * 1000))" \
    >"$INTERNAL_CASE_ROOT/normal-worker-observer.stdout" \
    2>"$INTERNAL_CASE_ROOT/normal-worker-observer.stderr" &
  local observer_pid=$!
  local observer_sid
  observer_sid="$(ps -o sid= -p "$observer_pid" 2>/dev/null | tr -d ' ')"
  if [[ "$observer_sid" != "$observer_pid" ]]; then
    kill -KILL "$observer_pid" >/dev/null 2>&1 || true
    worker_observer_service_stop_process "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true
    internal_fault_fail "normal observer process group is not isolated"
  fi
  printf '%s\n' "$observer_pid" >"$INTERNAL_CASE_ROOT/normal-worker-observer.pid"
  sleep 0.05
  if ! kill -0 "$observer_pid" >/dev/null 2>&1; then
    worker_observer_service_stop_process "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true
    internal_fault_fail "normal observer exited during case setup"
  fi
  trap - HUP INT TERM
}

internal_fault_rollout() {
  internal_fault_context "$@"
  [[ -f "$INTERNAL_SLOT_STATE" && -f "$INTERNAL_ENV" && -f "$INTERNAL_ADMIN" ]] \
    || internal_fault_fail "fault case topology/state is missing"
  local manifest="$INTERNAL_TARGET_MANIFEST"
  if [[ "$INTERNAL_CASE" == "manifest-digest-mismatch" ]]; then
    manifest="$INTERNAL_CASE_ROOT/manifest-digest-mismatch.json"
    jq '.imageDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
      "$INTERNAL_TARGET_MANIFEST" >"$manifest" || internal_fault_fail "unable to create digest mismatch manifest"
  fi
  local openresty_bin="${FSUSBLOG_OPENRESTY_BIN:-$SCRIPT_DIR/rehearsal-openresty.sh}"
  exec env \
    ASPNETCORE_ENVIRONMENT=Test \
    FSUSBLOG_ROLLOUT_REHEARSAL=1 \
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1 \
    FSUSBLOG_REHEARSAL_WORK_DIR="$INTERNAL_RUNTIME" \
    FSUSBLOG_REHEARSAL_SLOT_STATE_FILE="$INTERNAL_SLOT_STATE" \
    FSUSBLOG_SLOT_STATE_FILE="$INTERNAL_SLOT_STATE" \
    FSUSBLOG_REHEARSAL_GATEWAY_DIR="$INTERNAL_RUNTIME/gateway" \
    FSUSBLOG_REHEARSAL_GATEWAY_CONFIG="$INTERNAL_RUNTIME/gateway/openresty.conf" \
    FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM="$INTERNAL_RUNTIME/gateway/active-upstream.conf" \
    FSUSBLOG_GATEWAY_CONFIG_FILE="$INTERNAL_RUNTIME/gateway/openresty.conf" \
    FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL="$INTERNAL_PUBLIC_URL" \
    FSUSBLOG_OPENRESTY_BIN="$openresty_bin" \
    FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN="$INTERNAL_CONTROL_ORIGIN" \
    FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE="$INTERNAL_ADMIN" \
    FSUSBLOG_DEPLOYMENT_LOCK_FILE="$INTERNAL_RUNTIME/deployment.lock" \
    FSUSBLOG_GATEWAY_EVIDENCE_DIR="$INTERNAL_RUNTIME/gateway-evidence" \
    FSUSBLOG_ROLLOUT_DISK_PATH="$INTERNAL_RUNTIME" \
    FSUSBLOG_ROLLOUT_SOURCE_MANIFEST="$INTERNAL_SOURCE_MANIFEST" \
    FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO="$INTERNAL_NOTIFICATION_RESYNC_SCENARIO" \
    FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER="$INTERNAL_WORKER_LEDGER" \
    bash "$ROLLOUT_SCRIPT" \
      --rollout-id "$INTERNAL_ROLLOUT_ID" \
      --release-manifest "$manifest" \
      --env-file "$INTERNAL_ENV" \
      --slot-state-file "$INTERNAL_SLOT_STATE" \
      --rollout-state-file "$INTERNAL_ROLLOUT_STATE" \
      --evidence-root "$INTERNAL_EVIDENCE_ROOT" \
      --backup-restore-evidence "$(jq -er '.evidenceInputs.backupRestore' "$INTERNAL_RESOLVED_PLAN")" \
      --migration-server-dll "$(jq -er '.target.migrationServerDll' "$INTERNAL_RESOLVED_PLAN")" \
      --traffic-scenario "$(jq -er '.evidenceInputs.trafficScenario' "$INTERNAL_RESOLVED_PLAN")" \
      --traffic-binding-key-file "$INTERNAL_TRAFFIC_BINDING" \
      --notification-auth-storage-state "$INTERNAL_AUTH" \
      --notification-evidence "$INTERNAL_EVIDENCE_DIR/notification-stream.json" \
      --asset-compatibility-scenario "$INTERNAL_ASSET_SCENARIO" \
      --asset-compatibility-evidence "$INTERNAL_EVIDENCE_DIR/asset-compatibility.json" \
      --asset-browser-binding-key-file "$INTERNAL_ASSET_BROWSER_BINDING" \
      --worker-ledger "$INTERNAL_WORKER_LEDGER" \
      --worker-reconciliation-evidence "$INTERNAL_EVIDENCE_DIR/worker-reconciliation.json" \
      --resource-budget-evidence "$INTERNAL_EVIDENCE_DIR/resource-budget.json" \
      --fault-injection-evidence "$INTERNAL_CASE_ROOT/fault-matrix-pending.json" \
      --public-url "$INTERNAL_PUBLIC_URL" \
      --admin-header-file "$INTERNAL_ADMIN" \
      --control-origin "$INTERNAL_CONTROL_ORIGIN" \
      --asset-store "$INTERNAL_CASE_ROOT/assets" \
      --retention-state "$INTERNAL_CASE_ROOT/assets/retention-state.json"
}

internal_fault_teardown() {
  internal_fault_context "$@"
  local status=0 pid=""
  if [[ -f "$INTERNAL_CASE_ROOT/normal-worker-observer.pid" ]]; then
    pid="$(tr -d '[:space:]' <"$INTERNAL_CASE_ROOT/normal-worker-observer.pid")"
    if [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]]; then
      kill -TERM -- "-$pid" >/dev/null 2>&1 || true
      for _ in {1..50}; do
        kill -0 "$pid" >/dev/null 2>&1 || break
        sleep 0.05
      done
      kill -KILL -- "-$pid" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -f "$INTERNAL_OBSERVER_SERVICE_ROOT/service.pid" ]]; then
    if ! worker_observer_service_stop_process "$INTERNAL_OBSERVER_SERVICE_ROOT" 1; then
      status=1
    fi
  elif [[ -d "$INTERNAL_OBSERVER_SERVICE_ROOT" ]]; then
    worker_observer_service_stop_process "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || status=1
  fi
  if [[ -d "$INTERNAL_RUNTIME" ]]; then
    bash "$TOPOLOGY_SCRIPT" down \
      --env-file "$INTERNAL_ENV" --work-dir "$INTERNAL_RUNTIME" \
      --public-port "$INTERNAL_PUBLIC_PORT" --state-file "$INTERNAL_SLOT_STATE" \
      >"$INTERNAL_CASE_ROOT/topology-down.stdout" 2>"$INTERNAL_CASE_ROOT/topology-down.stderr" || status=$?
  fi
  return "$status"
}

if [[ "${1:-}" == "__fault-case-setup" ]]; then
  shift
  internal_fault_setup "$@"
  exit $?
fi
if [[ "${1:-}" == "__fault-case-rollout" ]]; then
  shift
  internal_fault_rollout "$@"
fi
if [[ "${1:-}" == "__fault-case-teardown" ]]; then
  shift
  internal_fault_teardown "$@"
  exit $?
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) [[ $# -ge 2 ]] || fatal "--plan requires a path"; PLAN_FILE="$2"; shift 2 ;;
    --mode) [[ $# -ge 2 ]] || fatal "--mode requires a value"; MODE="$2"; shift 2 ;;
    --run-id) [[ $# -ge 2 ]] || fatal "--run-id requires a value"; RUN_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fatal "unknown argument: $1" ;;
  esac
done

[[ -n "$PLAN_FILE" ]] || fatal "--plan is required"
[[ -f "$PLAN_FILE" && ! -L "$PLAN_FILE" ]] || fatal "plan must be a regular non-symlink file"
case "$MODE" in
  all) REQUESTED_MODES=(normal explicit-rollback post-switch-rollback sigkill-resume) ;;
  normal|explicit-rollback|post-switch-rollback|sigkill-resume) REQUESTED_MODES=("$MODE") ;;
  *) fatal "unsupported mode: $MODE" ;;
esac
for command in bash curl date docker flock install jq kill mkdir mktemp mv node ps realpath rm setsid sleep stat tr; do
  command -v "$command" >/dev/null 2>&1 || fatal "required command is missing: $command"
done
for file in "$PLAN_TOOL" "$NORMAL_WORKER_OBSERVER_SCRIPT" "$WORKER_OBSERVER_SERVICE_SCRIPT" "$TOPOLOGY_SCRIPT" "$ROLLOUT_SCRIPT" "$FAULT_MATRIX_SCRIPT" \
  "$WORKER_DRILL_SCRIPT" "$WORKER_RECONCILIATION_SCRIPT" "$MIGRATION_QUALIFICATION_SCRIPT" \
  "$ROLLOUT_STATE_SCRIPT" "$RESOURCE_POLICY"; do
  [[ -f "$file" && ! -L "$file" ]] || fatal "required repository file is missing or symlinked: $file"
done

PLAN_FILE="$(realpath "$PLAN_FILE")"
RESOLVE_FILE="$ROOT_DIR/.tmp/.zero-downtime-rehearsal-resolve.$$.$RANDOM.json"
[[ ! -L "$ROOT_DIR/.tmp" ]] || fatal "repository .tmp must not be a symbolic link"
mkdir -p "$ROOT_DIR/.tmp"
cleanup_resolve() {
  local service_root
  for service_root in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
    worker_observer_service_stop_process "$service_root" 0 >/dev/null 2>&1 \
      || worker_observer_service_stop_process "$service_root" 0 >/dev/null 2>&1 \
      || true
  done
  rm -f "$RESOLVE_FILE"
}
trap cleanup_resolve EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
node "$PLAN_TOOL" resolve --plan "$PLAN_FILE" --repo-root "$ROOT_DIR" --out "$RESOLVE_FILE" >/dev/null \
  || fatal "rehearsal plan resolution failed"
export ASPNETCORE_ENVIRONMENT=Test
export FSUSBLOG_ASPNETCORE_ENVIRONMENT=Test
export FSUSBLOG_SCHEMA_QUALIFICATION_ENABLED=true

WORK_ROOT="$(jq -er '.workRoot' "$RESOLVE_FILE")" || fatal "resolved workRoot is missing"
REHEARSAL_ID="$(jq -er '.rehearsalId' "$RESOLVE_FILE")" || fatal "resolved rehearsalId is missing"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
fi
[[ "$RUN_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{2,47}$ && "$RUN_ID" != *..* ]] || fatal "run id is invalid"
RUN_ROOT="$WORK_ROOT/$REHEARSAL_ID/$RUN_ID"
[[ ! -e "$RUN_ROOT" && ! -L "$RUN_ROOT" ]] || fatal "run directory already exists or is symlinked; evidence reuse is forbidden: $RUN_ROOT"
mkdir -p "$RUN_ROOT/evidence" "$RUN_ROOT/logs"
RESOLVED_PLAN="$RUN_ROOT/resolved-plan.json"
mv "$RESOLVE_FILE" "$RESOLVED_PLAN"
RESOLVE_FILE=""
COMMAND_JOURNAL="$RUN_ROOT/evidence/commands.tsv"
: >"$COMMAND_JOURNAL"

PUBLIC_URL="$(jq -er '.publicUrl' "$RESOLVED_PLAN")"
CONTROL_ORIGIN="$(jq -er '.controlOrigin' "$RESOLVED_PLAN")"
PUBLIC_PORT="$(jq -er '.publicPort' "$RESOLVED_PLAN")"
SOURCE_MANIFEST="$(jq -er '.source.manifest' "$RESOLVED_PLAN")"
TARGET_MANIFEST="$(jq -er '.target.manifest' "$RESOLVED_PLAN")"
SOURCE_RELEASE="$(jq -er '.source.releaseId' "$RESOLVED_PLAN")"
SOURCE_PREVIOUS_ROLLBACK_RELEASE="$(jq -er '.source.previousRollbackRelease' "$RESOLVED_PLAN")"
TARGET_RELEASE="$(jq -er '.target.releaseId' "$RESOLVED_PLAN")"
MIGRATION_DLL="$(jq -er '.target.migrationServerDll' "$RESOLVED_PLAN")"
BACKUP_EVIDENCE="$(jq -er '.evidenceInputs.backupRestore' "$RESOLVED_PLAN")"
TRAFFIC_SCENARIO="$(jq -er '.evidenceInputs.trafficScenario' "$RESOLVED_PLAN")"
TRAFFIC_BINDING_KEY="$(jq -er '.evidenceInputs.trafficBindingKey' "$RESOLVED_PLAN")"
ASSET_BROWSER_BINDING_KEY="$(jq -er '.evidenceInputs.assetBrowserBindingKey' "$RESOLVED_PLAN")"
NOTIFICATION_RESYNC_SCENARIO="$(jq -er '.evidenceInputs.notificationResyncScenario' "$RESOLVED_PLAN")"
PLAN_ENV_FILE="$(jq -er '.envFile' "$RESOLVED_PLAN")"
PLAN_ADMIN_HEADER="$(jq -er '.adminHeaderFile' "$RESOLVED_PLAN")"
PLAN_AUTH_STATE="$(jq -er '.notificationAuthStorageState' "$RESOLVED_PLAN")"
PLAN_WORKER_OBSERVER_ENV="$(jq -er '.workers.observerEnvFile' "$RESOLVED_PLAN")"

record_command() {
  local label="$1" status="$2"
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$label" "$status" >>"$COMMAND_JOURNAL"
}

run_logged() {
  local log_root="$1" label="$2"
  shift 2
  mkdir -p "$log_root"
  "$@" >"$log_root/$label.stdout" 2>"$log_root/$label.stderr"
  local status=$?
  record_command "$label" "$status"
  return "$status"
}

add_error() {
  local message="$1"
  OVERALL_ERRORS+=("$message")
  printf '[zero-downtime-rehearsal] error: %s\n' "$message" >&2
}

process_group_is_isolated() {
  local pid="$1" sid
  sid="$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ "$sid" == "$pid" ]]
}

stop_process_group() {
  local pid="$1" signal="${2:-TERM}"
  kill -0 "$pid" >/dev/null 2>&1 || return 0
  if process_group_is_isolated "$pid"; then
    kill "-$signal" -- "-$pid" >/dev/null 2>&1 || true
  else
    kill "-$signal" "$pid" >/dev/null 2>&1 || true
  fi
}

register_worker_observer_service_root() {
  local existing
  for existing in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
    [[ "$existing" == "$1" ]] && return 1
  done
  ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS+=("$1")
}

unregister_worker_observer_service_root() {
  local removed="$1" item
  local -a retained=()
  for item in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
    [[ "$item" == "$removed" ]] || retained+=("$item")
  done
  ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS=("${retained[@]}")
}

start_worker_observer_service() {
  local phase_root="$1" phase="$2" state_file="$3" worker_key="$4" runtime="$5"
  local service_plan service_root
  [[ "$phase" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{1,127}$ && "$phase" != *..* ]] || return 1
  service_plan="$(jq -er ".workers.$worker_key.observerServicePlan.file" "$RESOLVED_PLAN")" || return 1
  service_root="$phase_root/worker-observer-service-$phase"
  WORKER_OBSERVER_SERVICE_ROOT="$service_root"
  WORKER_OBSERVER_SERVICE_PID=""
  register_worker_observer_service_root "$service_root" || return 1
  if ! worker_observer_service_start_process \
    "$service_root" \
    "$service_plan" \
    "$state_file" \
    "$PLAN_WORKER_OBSERVER_ENV" \
    "$runtime/secrets/admin-header.txt" \
    "$phase_root/logs"; then
    unregister_worker_observer_service_root "$service_root"
    WORKER_OBSERVER_SERVICE_ROOT=""
    record_command "$phase-worker-observer-service-start" 1
    return 1
  fi
  WORKER_OBSERVER_SERVICE_PID="$WORKER_OBSERVER_SERVICE_PROCESS_PID"
  record_command "$phase-worker-observer-service-start" 0
}

stop_worker_observer_service() {
  local phase="$1" require_running="${2:-1}" status=0 service_root="${WORKER_OBSERVER_SERVICE_ROOT:-}"
  [[ -n "$service_root" ]] || return 0
  worker_observer_service_stop_process "$service_root" "$require_running" || status=$?
  record_command "$phase-worker-observer-service-stop" "$status"
  if [[ ! -f "$service_root/service.pid" ]]; then
    unregister_worker_observer_service_root "$service_root"
    WORKER_OBSERVER_SERVICE_ROOT=""
    WORKER_OBSERVER_SERVICE_PID=""
  fi
  return "$status"
}

wait_for_json() {
  local file="$1" expression="$2" timeout_seconds="$3" watched_pid="${4:-}" deadline
  deadline=$(( $(date +%s) + timeout_seconds ))
  while (( $(date +%s) <= deadline )); do
    if [[ -f "$file" ]]; then
      jq -e "$expression" "$file" >/dev/null 2>&1 && return 0
      jq -e '.status == "fail" or (.errors | type == "array" and length > 0)' "$file" >/dev/null 2>&1 && return 1
    fi
    if [[ -n "$watched_pid" ]] && ! kill -0 "$watched_pid" >/dev/null 2>&1; then
      return 1
    fi
    sleep 0.05
  done
  return 1
}

prepare_topology() {
  local base="$1" source_slot="$2" source_manifest="$3"
  local previous_rollback_release
  TOPOLOGY_BASE="$base"
  TOPOLOGY_RUNTIME="$base/runtime"
  TOPOLOGY_STATE="$(dirname "$base")/states/slots.json"
  TOPOLOGY_ENV="$TOPOLOGY_RUNTIME/secrets/rehearsal.env"
  TOPOLOGY_ADMIN="$TOPOLOGY_RUNTIME/secrets/admin-header.txt"
  TOPOLOGY_AUTH="$TOPOLOGY_RUNTIME/secrets/auth-storage-state.json"
  mkdir -p "$TOPOLOGY_RUNTIME/secrets" "$(dirname "$TOPOLOGY_STATE")" "$base/logs"
  install -m 0600 "$PLAN_ENV_FILE" "$TOPOLOGY_ENV" || return 1
  install -m 0600 "$PLAN_ADMIN_HEADER" "$TOPOLOGY_ADMIN" || return 1
  install -m 0600 "$PLAN_AUTH_STATE" "$TOPOLOGY_AUTH" || return 1
  install -m 0600 "$TRAFFIC_BINDING_KEY" "$TOPOLOGY_RUNTIME/secrets/traffic-binding.key" || return 1
  install -m 0600 "$ASSET_BROWSER_BINDING_KEY" "$TOPOLOGY_RUNTIME/secrets/asset-browser-binding.key" || return 1
  if [[ "$(realpath "$source_manifest")" == "$(realpath "$SOURCE_MANIFEST")" ]]; then
    previous_rollback_release="$SOURCE_PREVIOUS_ROLLBACK_RELEASE"
  elif [[ "$(realpath "$source_manifest")" == "$(realpath "$TARGET_MANIFEST")" ]]; then
    previous_rollback_release="$SOURCE_RELEASE"
  else
    return 1
  fi
  run_logged "$base/logs" topology-up env \
    FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE="$previous_rollback_release" \
    bash "$TOPOLOGY_SCRIPT" up \
    --env-file "$TOPOLOGY_ENV" --source-manifest "$source_manifest" --source-slot "$source_slot" \
    --work-dir "$TOPOLOGY_RUNTIME" --public-port "$PUBLIC_PORT" --state-file "$TOPOLOGY_STATE"
}

teardown_topology() {
  local base="$1"
  [[ -d "$base/runtime" ]] || return 0
  run_logged "$base/logs" topology-down bash "$TOPOLOGY_SCRIPT" down \
    --env-file "$base/runtime/secrets/rehearsal.env" --work-dir "$base/runtime" \
    --public-port "$PUBLIC_PORT" --state-file "$(dirname "$base")/states/slots.json"
}

rollout_environment() {
  local runtime="$1" state="$2" source_manifest="$3"
  ROLLOUT_ENV=(
    env
    ASPNETCORE_ENVIRONMENT=Test
    FSUSBLOG_ROLLOUT_REHEARSAL=1
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1
    FSUSBLOG_REHEARSAL_WORK_DIR="$runtime"
    FSUSBLOG_REHEARSAL_SLOT_STATE_FILE="$state"
    FSUSBLOG_SLOT_STATE_FILE="$state"
    FSUSBLOG_REHEARSAL_GATEWAY_DIR="$runtime/gateway"
    FSUSBLOG_REHEARSAL_GATEWAY_CONFIG="$runtime/gateway/openresty.conf"
    FSUSBLOG_GATEWAY_ACTIVE_UPSTREAM="$runtime/gateway/active-upstream.conf"
    FSUSBLOG_GATEWAY_CONFIG_FILE="$runtime/gateway/openresty.conf"
    FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL="$PUBLIC_URL"
    FSUSBLOG_OPENRESTY_BIN="$SCRIPT_DIR/rehearsal-openresty.sh"
    FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN="$CONTROL_ORIGIN"
    FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE="$runtime/secrets/admin-header.txt"
    FSUSBLOG_DEPLOYMENT_LOCK_FILE="$runtime/deployment.lock"
    FSUSBLOG_GATEWAY_EVIDENCE_DIR="$runtime/gateway-evidence"
    FSUSBLOG_ROLLOUT_DISK_PATH="$runtime"
    FSUSBLOG_ROLLOUT_SOURCE_MANIFEST="$source_manifest"
    FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO="$NOTIFICATION_RESYNC_SCENARIO"
  )
}

build_rollout_args() {
  local phase_root="$1" state_file="$2" slot_state="$3" runtime="$4" manifest="$5" \
    asset_scenario="$6" fault_evidence="$7" worker_evidence="$8"
  local evidence_root="$phase_root/rollouts"
  local evidence_dir="$evidence_root/$9/evidence"
  mkdir -p "$phase_root" "$evidence_root" "$evidence_dir"
  ROLLOUT_EVIDENCE_DIR="$evidence_dir"
  ROLLOUT_ARGS=(
    --release-manifest "$manifest"
    --env-file "$runtime/secrets/rehearsal.env"
    --slot-state-file "$slot_state"
    --rollout-state-file "$state_file"
    --evidence-root "$evidence_root"
    --backup-restore-evidence "$BACKUP_EVIDENCE"
    --migration-server-dll "$MIGRATION_DLL"
    --traffic-scenario "$TRAFFIC_SCENARIO"
    --traffic-binding-key-file "$runtime/secrets/traffic-binding.key"
    --notification-auth-storage-state "$runtime/secrets/auth-storage-state.json"
    --notification-evidence "$evidence_dir/notification-stream.json"
    --asset-compatibility-scenario "$asset_scenario"
    --asset-compatibility-evidence "$evidence_dir/asset-compatibility.json"
    --asset-browser-binding-key-file "$runtime/secrets/asset-browser-binding.key"
    --worker-reconciliation-evidence "$worker_evidence"
    --resource-budget-evidence "$evidence_dir/resource-budget.json"
    --fault-injection-evidence "$fault_evidence"
    --public-url "$PUBLIC_URL"
    --admin-header-file "$runtime/secrets/admin-header.txt"
    --control-origin "$CONTROL_ORIGIN"
    --asset-store "$phase_root/assets"
    --retention-state "$phase_root/assets/retention-state.json"
  )
}

derive_rollout_id() {
  node "$PLAN_TOOL" derive-rollout-id --role "$1" --phase "$2" --release "$3" --run-id "$RUN_ID"
}

run_fault_matrix() {
  local mode_root="$1" phase="$2" kind="$3" output="$4" rollout_id="$5"
  local fault_root="$mode_root/faults/$phase" plan="$fault_root/plan.json"
  mkdir -p "$fault_root" "$mode_root/evidence" "$mode_root/logs"
  if ! run_logged "$mode_root/logs" "fault-plan-$phase" node "$PLAN_TOOL" materialize-fault \
    --plan "$RESOLVED_PLAN" --run-root "$fault_root" --kind "$kind" --rollout-id "$rollout_id" --out "$plan"; then
    return 1
  fi
  if ! run_logged "$mode_root/logs" "fault-matrix-$phase" node "$FAULT_MATRIX_SCRIPT" \
    --plan "$plan" --work-dir "$fault_root/cases" --out "$output"; then
    return 1
  fi
  jq -e '.schema == "fsusblog.zero-downtime-fault-matrix.v1" and .status == "pass" and .caseCount == 13' \
    "$output" >/dev/null 2>&1
}

start_normal_worker_observer() {
  local phase_root="$1" phase="$2" state_file="$3" worker_key="$4" runtime="$5"
  local scenario start_stage timeout_seconds run_id
  scenario="$(jq -er ".workers.$worker_key.normalScenario.file" "$RESOLVED_PLAN")" || return 1
  start_stage="$(jq -er ".workers.$worker_key.startStage" "$RESOLVED_PLAN")" || return 1
  timeout_seconds="$(jq -er '.workers.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
  run_id="normal-$phase-$RUN_ID"
  run_id="${run_id:0:120}"
  NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
  mkdir -p "$phase_root/logs" "$ROLLOUT_EVIDENCE_DIR"
  setsid node "$NORMAL_WORKER_OBSERVER_SCRIPT" \
    --plan "$scenario" \
    --rollout-state "$state_file" \
    --source-drain "$ROLLOUT_EVIDENCE_DIR/source-drain-gate.json" \
    --admin-header-file "$runtime/secrets/admin-header.txt" \
    --out "$NORMAL_WORKER_LEDGER" \
    --run-id "$run_id" \
    --start-stage "$start_stage" \
    --timeout-ms "$((timeout_seconds * 1000))" \
    >"$phase_root/logs/normal-worker-observer.stdout" \
    2>"$phase_root/logs/normal-worker-observer.stderr" &
  NORMAL_WORKER_PID=$!
  record_command "$phase-normal-worker-observer-start" 0
  process_group_is_isolated "$NORMAL_WORKER_PID"
}

execute_rollout_with_normal_observer() {
  local phase_root="$1" phase="$2" state_file="$3" worker_key="$4" log_root="$5" label="$6"
  shift 6
  local observer_status=0 observer_done=0 rollout_status=0 rollout_pid service_failed=0
  LAST_ROLLOUT_STATUS=1
  NORMAL_WORKER_PID=""
  NORMAL_WORKER_LEDGER=""
  if ! start_worker_observer_service "$phase_root" "$phase" "$state_file" "$worker_key" "$TOPOLOGY_RUNTIME"; then
    add_error "$phase worker observer service failed to start"
    return 1
  fi
  if ! start_normal_worker_observer "$phase_root" "$phase" "$state_file" "$worker_key" "$TOPOLOGY_RUNTIME"; then
    [[ -n "${NORMAL_WORKER_PID:-}" ]] && stop_process_group "$NORMAL_WORKER_PID" TERM
    stop_worker_observer_service "$phase" 1 >/dev/null 2>&1 || true
    add_error "$phase normal worker observer failed to start in an isolated process group"
    return 1
  fi
  ROLLOUT_ENV+=(
    FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER="$NORMAL_WORKER_LEDGER"
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$NORMAL_WORKER_LEDGER"
  )
  local -a command=("$@" --worker-ledger "$NORMAL_WORKER_LEDGER")
  setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${command[@]}" \
    >"$log_root/$label.stdout" 2>"$log_root/$label.stderr" &
  rollout_pid=$!
  record_command "$label-start" 0
  if ! process_group_is_isolated "$rollout_pid"; then
    stop_process_group "$rollout_pid" TERM
    stop_process_group "$NORMAL_WORKER_PID" TERM
    wait "$rollout_pid" >/dev/null 2>&1 || true
    wait "$NORMAL_WORKER_PID" >/dev/null 2>&1 || true
    stop_worker_observer_service "$phase" 1 >/dev/null 2>&1 || true
    add_error "$phase rollout failed to start in an isolated process group"
    return 1
  fi
  while kill -0 "$rollout_pid" >/dev/null 2>&1; do
    if ! worker_observer_service_process_is_live "$WORKER_OBSERVER_SERVICE_PID"; then
      service_failed=1
      stop_process_group "$NORMAL_WORKER_PID" TERM
      stop_process_group "$rollout_pid" TERM
      break
    fi
    if (( observer_done == 0 )) && ! kill -0 "$NORMAL_WORKER_PID" >/dev/null 2>&1; then
      wait "$NORMAL_WORKER_PID"
      observer_status=$?
      observer_done=1
      record_command "$phase-normal-worker-observer-exit" "$observer_status"
      if (( observer_status != 0 )); then
        stop_process_group "$rollout_pid" TERM
        break
      fi
    fi
    sleep 0.1
  done
  wait "$rollout_pid"
  rollout_status=$?
  record_command "$label" "$rollout_status"
  if (( observer_done == 0 )); then
    if (( rollout_status != 0 )); then
      stop_process_group "$NORMAL_WORKER_PID" TERM
    fi
    wait "$NORMAL_WORKER_PID"
    observer_status=$?
    record_command "$phase-normal-worker-observer-exit" "$observer_status"
  fi
  if ! stop_worker_observer_service "$phase" 1; then
    service_failed=1
    add_error "$phase worker observer service exited early or could not be stopped"
  fi
  LAST_ROLLOUT_STATUS="$rollout_status"
  if (( rollout_status != 0 || observer_status != 0 || service_failed != 0 )); then
    add_error "$phase rollout/normal-worker observer service failed (rollout=$rollout_status observer=$observer_status service=$service_failed)"
    return 1
  fi
  [[ -f "$NORMAL_WORKER_LEDGER" ]] || { add_error "$phase normal worker ledger is missing"; return 1; }
  jq -e '.schema == "fsusblog.release-worker-event-ledger.v1" and .mode == "normal" and .status == "pass" and (.events | length) == 8' \
    "$NORMAL_WORKER_LEDGER" >/dev/null 2>&1
}

run_worker_qualification_drill() {
  local mode_root="$1" phase="$2" source_slot="$3" source_manifest="$4" target_manifest="$5" \
    target_release="$6" asset_scenario="$7" fault_evidence="$8" worker_key="$9"
  local qual_root="$mode_root/qualification/$phase"
  local topology_root="$qual_root/topology"
  local rollout_state="$qual_root/rollout-state.json"
  local rollout_id
  local scenario start_stage timeout_seconds worker_root ledger health control run_id armed_rel authorize_rel terminated_rel
  local release_pid="" drill_pid="" release_status=0 drill_status=0 failed=0 observer_service_started=0
  scenario="$(jq -er ".workers.$worker_key.scenario" "$RESOLVED_PLAN")" || return 1
  start_stage="$(jq -er ".workers.$worker_key.startStage" "$RESOLVED_PLAN")" || return 1
  timeout_seconds="$(jq -er '.workers.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
  armed_rel="$(jq -er ".workers.$worker_key.coordination.armedFile" "$RESOLVED_PLAN")" || return 1
  authorize_rel="$(jq -er ".workers.$worker_key.coordination.authorizeFile" "$RESOLVED_PLAN")" || return 1
  terminated_rel="$(jq -er ".workers.$worker_key.coordination.terminatedFile" "$RESOLVED_PLAN")" || return 1
  worker_root="$qual_root/worker"
  ledger="$worker_root/ledger.json"
  health="$qual_root/target-health.json"
  control="$qual_root/worker-qualification-control.json"
  run_id="worker-$phase-$RUN_ID"
  run_id="${run_id:0:120}"
  rollout_id="$(derive_rollout_id qualification "$(basename "$mode_root")-$phase" "$target_release")" || return 1
  mkdir -p "$qual_root/logs" "$worker_root"

  if ! prepare_topology "$topology_root" "$source_slot" "$source_manifest"; then
    add_error "$phase qualification topology startup failed"
    teardown_topology "$topology_root" >/dev/null 2>&1 || true
    return 1
  fi
  rollout_environment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$source_manifest"
  build_rollout_args "$qual_root" "$rollout_state" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
    "$target_manifest" "$asset_scenario" "$fault_evidence" "$qual_root/unused-normal-worker-evidence.json" "$rollout_id"
  ROLLOUT_ARGS+=(--rollout-id "$rollout_id")

  if ! start_worker_observer_service "$qual_root" "qualification-$phase" "$rollout_state" "$worker_key" "$TOPOLOGY_RUNTIME"; then
    add_error "$phase qualification worker observer service failed to start"
    failed=1
  else
    observer_service_started=1
  fi
  if (( failed == 0 )); then
    setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
      >"$qual_root/logs/release-rollout.stdout" 2>"$qual_root/logs/release-rollout.stderr" &
    release_pid=$!
    record_command "$phase-qualification-rollout-start" 0
    if ! process_group_is_isolated "$release_pid"; then
      add_error "$phase qualification rollout did not get an isolated process group"
      failed=1
    fi
  fi
  if (( failed == 0 )) && ! node "$PLAN_TOOL" wait-stage --state "$rollout_state" --stage "$start_stage" \
    --timeout-ms "$((timeout_seconds * 1000))" >"$qual_root/logs/wait-worker-stage.stdout" \
    2>"$qual_root/logs/wait-worker-stage.stderr"; then
    add_error "$phase qualification rollout did not reach worker start stage"
    failed=1
  fi
  if (( failed == 0 )); then
    setsid env FSUSBLOG_WORKER_DRILL_ROOT="$qual_root" node "$WORKER_DRILL_SCRIPT" \
      --plan "$scenario" --rollout-state "$rollout_state" --work-dir "$worker_root" --out ledger.json --run-id "$run_id" \
      >"$qual_root/logs/worker-drill.stdout" 2>"$qual_root/logs/worker-drill.stderr" &
    drill_pid=$!
    record_command "$phase-worker-drill-start" 0
    if ! process_group_is_isolated "$drill_pid"; then
      add_error "$phase worker drill did not get an isolated process group"
      failed=1
    fi
  fi
  local armed_file="$worker_root/$armed_rel" authorize_file="$worker_root/$authorize_rel" terminated_file="$worker_root/$terminated_rel"
  if (( failed == 0 )) && ! wait_for_json "$armed_file" \
    ".schema == \"fsusblog.release-worker-drill-signal.v1\" and .stage == \"armed\" and .runId == \"$run_id\"" \
    "$timeout_seconds" "$drill_pid"; then
    add_error "$phase worker qualification never produced a valid armed signal"
    failed=1
  fi
  if (( failed == 0 )) && ! node "$PLAN_TOOL" wait-stage --state "$rollout_state" --stage active-fence \
    --timeout-ms "$((timeout_seconds * 1000))" >"$qual_root/logs/wait-active-fence.stdout" \
    2>"$qual_root/logs/wait-active-fence.stderr"; then
    add_error "$phase qualification missed the controlled active-fence window"
    failed=1
  fi
  if (( failed == 0 )) && ! run_logged "$qual_root/logs" authorize-worker node "$PLAN_TOOL" authorize-worker \
    --state "$rollout_state" --armed "$armed_file" --out "$authorize_file" --run-id "$run_id"; then
    add_error "$phase worker termination authorization failed"
    failed=1
  fi
  if [[ -n "$drill_pid" ]]; then
    if (( failed != 0 )); then
      stop_process_group "$drill_pid" TERM
    fi
    wait "$drill_pid"
    drill_status=$?
    record_command "$phase-worker-drill-exit" "$drill_status"
    drill_pid=""
    if (( drill_status != 0 )); then
      add_error "$phase worker drill failed with exit $drill_status"
      failed=1
    fi
  fi
  if (( failed == 0 )) && ! wait_for_json "$terminated_file" \
    ".schema == \"fsusblog.release-worker-drill-signal.v1\" and .stage == \"source-terminated\" and .forced == true and .runId == \"$run_id\"" \
    30; then
    add_error "$phase worker qualification lacks forced termination signal"
    failed=1
  fi

  if [[ -n "$release_pid" ]]; then
    stop_process_group "$release_pid" TERM
    wait "$release_pid"
    release_status=$?
    record_command "$phase-qualification-rollout-stop" "$release_status"
    release_pid=""
  fi
  if (( observer_service_started == 1 )); then
    if ! stop_worker_observer_service "qualification-$phase" 1; then
      add_error "$phase qualification worker observer service exited early or could not be stopped"
      failed=1
    fi
    observer_service_started=0
  fi
  if (( failed == 0 )) && ! run_logged "$qual_root/logs" worker-health node "$PLAN_TOOL" worker-health \
    --state "$rollout_state" --ledger "$ledger" --out "$health"; then
    add_error "$phase worker target health derivation failed"
    failed=1
  fi
  if (( failed == 0 )) && ! run_logged "$qual_root/logs" worker-qualification-control node "$PLAN_TOOL" worker-qualification \
    --state "$rollout_state" --ledger "$ledger" --scenario "$scenario" --out "$control"; then
    add_error "$phase worker qualification control failed"
    failed=1
  fi
  if ! teardown_topology "$topology_root"; then
    add_error "$phase qualification topology teardown failed"
    failed=1
  fi
  (( failed == 0 ))
}

run_migration_qualification_drill() {
  local mode_root="$1" phase="$2" source_slot="$3" source_manifest="$4" target_manifest="$5" \
    target_release="$6" asset_scenario="$7" fault_evidence="$8"
  local qualification_root="$mode_root/migration-qualification/$phase"
  local topology_root="$qualification_root/topology"
  local rollout_state="$qualification_root/rollout-state.json"
  local rollout_id scenario_file evidence_file work_dir run_id timeout_seconds
  local hold_ready="$qualification_root/handshake/candidate-readiness.ready.json"
  local hold_release="$qualification_root/handshake/candidate-readiness.release.json"
  local release_pid="" release_status=0 failed=0
  local source_port target_port source_origin target_origin
  local source_body="$qualification_root/inputs/source-write.json"
  local target_body="$qualification_root/inputs/target-write.json"
  local contract_window="$qualification_root/inputs/contract-window-open.json"
  local contract_qualified="$qualification_root/inputs/contract-qualified.json"
  timeout_seconds="$(jq -er '.migrationQualification.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
  rollout_id="$(derive_rollout_id qualification "migration-$phase-$(basename "$mode_root")" "$target_release")" || return 1
  run_id="migration-$phase-$RUN_ID"
  run_id="${run_id:0:120}"
  scenario_file="$qualification_root/scenario.json"
  evidence_file="$qualification_root/migration-qualification.json"
  work_dir="$qualification_root/run"
  mkdir -p "$qualification_root/logs" "$qualification_root/inputs" "$qualification_root/handshake"

  jq -n --arg operationId "source-$run_id" '{operationId:$operationId,sequence:1}' >"$source_body"
  jq -n --arg operationId "target-$run_id" '{operationId:$operationId,sequence:2}' >"$target_body"
  jq -n '
    {
      currentReleaseUsesOldSchema:false,
      previousRollbackReleaseUsesOldSchema:true,
      backfillComplete:true,
      backfillVerified:true,
      observationStartedAtUtc:((now - 2678400)|todateiso8601),
      backupRestoreVerifiedAtUtc:(now|todateiso8601),
      slotSwitchInProgress:false,
      destructiveChangeConfirmed:false,
      rollbackManifestSealed:false,
      oldWritesDisabled:false,
      exclusiveModeEnabled:false
    }
  ' >"$contract_window"
  jq -n '
    {
      currentReleaseUsesOldSchema:false,
      previousRollbackReleaseUsesOldSchema:false,
      backfillComplete:true,
      backfillVerified:true,
      observationStartedAtUtc:((now - 2678400)|todateiso8601),
      backupRestoreVerifiedAtUtc:(now|todateiso8601),
      slotSwitchInProgress:false,
      destructiveChangeConfirmed:true,
      rollbackManifestSealed:true,
      oldWritesDisabled:true,
      exclusiveModeEnabled:true
    }
  ' >"$contract_qualified"

  if ! prepare_topology "$topology_root" "$source_slot" "$source_manifest"; then
    add_error "$phase migration qualification topology startup failed"
    teardown_topology "$topology_root" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ "$source_slot" == "blue" ]]; then
    source_port="${FSUSBLOG_BLUE_PORT:-8081}"
    target_port="${FSUSBLOG_GREEN_PORT:-8082}"
  else
    source_port="${FSUSBLOG_GREEN_PORT:-8082}"
    target_port="${FSUSBLOG_BLUE_PORT:-8081}"
  fi
  source_origin="http://127.0.0.1:$source_port"
  target_origin="http://127.0.0.1:$target_port"
  rollout_environment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$source_manifest"
  build_rollout_args "$qualification_root" "$rollout_state" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
    "$target_manifest" "$asset_scenario" "$fault_evidence" "$qualification_root/unused-worker-evidence.json" "$rollout_id"
  ROLLOUT_ARGS+=(--rollout-id "$rollout_id")
  ROLLOUT_ENV+=(
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE=candidate-readiness
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE="$hold_ready"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE="$hold_release"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS="$timeout_seconds"
  )

  setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
    >"$qualification_root/logs/release-rollout.stdout" \
    2>"$qualification_root/logs/release-rollout.stderr" &
  release_pid=$!
  record_command "$phase-migration-qualification-rollout-start" 0
  if ! process_group_is_isolated "$release_pid"; then
    add_error "$phase migration qualification rollout did not get an isolated process group"
    failed=1
  fi
  if (( failed == 0 )) && ! wait_for_json "$hold_ready" \
    ".schema == \"fsusblog.release-rollout-rehearsal-stage-hold.v1\" and .stage == \"candidate-readiness\" and .rolloutId == \"$rollout_id\"" \
    "$timeout_seconds" "$release_pid"; then
    add_error "$phase migration qualification rollout did not reach dual-slot candidate readiness hold"
    failed=1
  fi

  if (( failed == 0 )) && ! run_logged "$qualification_root/logs" materialize-migration-scenario \
    node "$PLAN_TOOL" materialize-migration-qualification \
      --plan "$RESOLVED_PLAN" \
      --run-root "$qualification_root" \
      --runtime "$TOPOLOGY_RUNTIME" \
      --database-isolation-id "$run_id" \
      --source-origin "$source_origin" \
      --target-origin "$target_origin" \
      --env-file "$TOPOLOGY_ENV" \
      --admin-header-file "$TOPOLOGY_ADMIN" \
      --source-write-body "$source_body" \
      --target-write-body "$target_body" \
      --contract-window-evidence "$contract_window" \
      --contract-qualified-evidence "$contract_qualified" \
      --out "$scenario_file"; then
    add_error "$phase migration qualification scenario materialization failed"
    failed=1
  fi
  if (( failed == 0 )) && ! run_logged "$qualification_root/logs" migration-qualification \
    env ASPNETCORE_ENVIRONMENT=Test FSUSBLOG_ROLLOUT_REHEARSAL=1 \
      node "$MIGRATION_QUALIFICATION_SCRIPT" \
        --scenario "$scenario_file" \
        --rollout-state "$rollout_state" \
        --release-manifest "$target_manifest" \
        --work-dir "$work_dir" \
        --out "$evidence_file" \
        --run-id "$run_id"; then
    add_error "$phase migration qualification ten-case run failed"
    failed=1
  fi
  if [[ -n "$release_pid" ]]; then
    stop_process_group "$release_pid" TERM
    wait "$release_pid" || release_status=$?
    record_command "$phase-migration-qualification-rollout-stop" "$release_status"
    release_pid=""
  fi
  if [[ -f "$evidence_file" ]]; then
    jq -e --arg rolloutId "$rollout_id" '
      .schema == "fsusblog.release-migration-qualification-evidence.v1"
      and .status == "pass"
      and .rolloutId == $rolloutId
      and (.cases | length == 10)
      and (.errors | type == "array" and length == 0)
    ' "$evidence_file" >/dev/null 2>&1 || failed=1
  else
    failed=1
  fi
  if ! teardown_topology "$topology_root"; then
    add_error "$phase migration qualification topology teardown failed"
    failed=1
  fi
  (( failed == 0 ))
}

finalize_worker_qualification() {
  local mode_root="$1" phase="$2" normal_state="$3"
  local qual_root="$mode_root/qualification/$phase"
  local reconciliation="$qual_root/worker-reconciliation.json"
  local final="$qual_root/worker-qualification.json"
  local qualification_id
  qualification_id="$(jq -er '.qualificationId' "$qual_root/worker-qualification-control.json")" || return 1
  if ! run_logged "$qual_root/logs" worker-qualification-reconciliation node "$WORKER_RECONCILIATION_SCRIPT" \
    --mode qualification \
    --rollout-state "$qual_root/rollout-state.json" \
    --normal-rollout-state "$normal_state" \
    --ledger "$qual_root/worker/ledger.json" \
    --qualification-id "$qualification_id" \
    --qualification-control "$qual_root/worker-qualification-control.json" \
    --resource-policy "$RESOURCE_POLICY" \
    --target-health "$qual_root/target-health.json" \
    --out "$reconciliation"; then
    add_error "$phase worker qualification reconciliation failed"
    return 1
  fi
  if ! run_logged "$qual_root/logs" worker-qualification-finalize node "$PLAN_TOOL" finalize-worker-qualification \
    --control "$qual_root/worker-qualification-control.json" --reconciliation "$reconciliation" --out "$final"; then
    add_error "$phase worker qualification seal failed"
    return 1
  fi
  jq -e '.schema == "fsusblog.release-worker-qualification-evidence.v1" and .status == "pass"' "$final" >/dev/null 2>&1
}

run_success_rollout() {
  local mode_root="$1" phase="$2" manifest="$3" asset_scenario="$4" fault_evidence="$5" kind="$6"
  local state_file="$mode_root/states/$phase-rollout.json"
  local target_release rollout_id worker_evidence phase_root
  if [[ "$kind" == "rollback" ]]; then
    target_release="$SOURCE_RELEASE"
  else
    target_release="$TARGET_RELEASE"
  fi
  rollout_id="$(derive_rollout_id normal "$(basename "$mode_root")-$phase" "$target_release")" || return 1
  phase_root="$mode_root/rollouts/$phase"
  worker_evidence="$phase_root/rollouts/$rollout_id/evidence/worker-reconciliation.json"
  rollout_environment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$([[ "$kind" == "rollback" ]] && printf '%s' "$TARGET_MANIFEST" || printf '%s' "$SOURCE_MANIFEST")"
  build_rollout_args "$phase_root" "$state_file" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
    "$manifest" "$asset_scenario" "$fault_evidence" "$worker_evidence" "$rollout_id"
  ROLLOUT_ENV+=(
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH="$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json"
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION="$worker_evidence"
  )
  local -a args=("${ROLLOUT_ARGS[@]}" --rollout-id "$rollout_id")
  [[ "$kind" == "rollback" ]] && args+=(--rollback)
  execute_rollout_with_normal_observer "$phase_root" "$phase" "$state_file" \
    "$([[ "$kind" == "rollback" ]] && printf rollback || printf deploy)" \
    "$mode_root/logs" "release-rollout-$phase" "${args[@]}"
}

verify_mode() {
  local mode_root="$1" mode="$2"
  mkdir -p "$mode_root/evidence"
  run_logged "$mode_root/logs" verify-mode node "$PLAN_TOOL" verify-mode \
    --plan "$RESOLVED_PLAN" --mode "$mode" --mode-root "$mode_root" \
    --out "$mode_root/evidence/rehearsal-mode.json"
}

run_normal_like_mode() {
  local mode="$1" mode_root="$RUN_ROOT/modes/$mode"
  local failed=0 deploy_fault="$mode_root/evidence/fault-matrix.json"
  local deploy_asset deploy_rollout_id
  deploy_asset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
  deploy_rollout_id="$(derive_rollout_id normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
  mkdir -p "$mode_root/evidence" "$mode_root/logs" "$mode_root/states"
  log "mode=$mode phase=fault-matrix"
  if ! run_fault_matrix "$mode_root" deploy deploy "$deploy_fault" "$deploy_rollout_id"; then
    add_error "$mode deploy fault matrix failed"
    failed=1
  fi
  if (( failed == 0 )); then
    log "mode=$mode phase=migration-qualification"
    run_migration_qualification_drill "$mode_root" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
      "$TARGET_RELEASE" "$deploy_asset" "$deploy_fault" || failed=1
  fi
  if (( failed == 0 )); then
    log "mode=$mode phase=worker-qualification"
    run_worker_qualification_drill "$mode_root" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
      "$TARGET_RELEASE" "$deploy_asset" "$deploy_fault" deploy || failed=1
  fi
  if (( failed == 0 )); then
    log "mode=$mode phase=fresh-blue-green"
    if ! prepare_topology "$mode_root/topology" blue "$SOURCE_MANIFEST"; then
      add_error "$mode main topology startup failed"
      failed=1
    elif ! run_success_rollout "$mode_root" deploy "$TARGET_MANIFEST" "$deploy_asset" "$deploy_fault" deploy; then
      add_error "$mode fresh Blue to Green rollout failed"
      failed=1
    fi
  fi
  if [[ -f "$mode_root/states/deploy-rollout.json" ]]; then
    finalize_worker_qualification "$mode_root" deploy "$mode_root/states/deploy-rollout.json" || failed=1
  fi
  if ! verify_mode "$mode_root" "$mode"; then
    add_error "$mode semantic verification failed"
    failed=1
  fi
  if ! teardown_topology "$mode_root/topology"; then
    add_error "$mode main topology teardown failed"
    failed=1
  fi
  (( failed == 0 ))
}

run_explicit_rollback_mode() {
  local mode="explicit-rollback" mode_root="$RUN_ROOT/modes/explicit-rollback"
  local failed=0 deploy_fault="$mode_root/evidence/fault-matrix.json" rollback_fault="$mode_root/evidence/fault-matrix-rollback.json"
  local deploy_asset rollback_asset deploy_rollout_id rollback_rollout_id
  deploy_asset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
  rollback_asset="$(jq -er '.assets.rollbackScenario' "$RESOLVED_PLAN")" || return 1
  deploy_rollout_id="$(derive_rollout_id normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
  rollback_rollout_id="$(derive_rollout_id normal "$mode-rollback" "$SOURCE_RELEASE")" || return 1
  mkdir -p "$mode_root/evidence" "$mode_root/logs" "$mode_root/states"
  run_fault_matrix "$mode_root" deploy deploy "$deploy_fault" "$deploy_rollout_id" || { add_error "$mode deploy fault matrix failed"; failed=1; }
  run_fault_matrix "$mode_root" rollback rollback "$rollback_fault" "$rollback_rollout_id" || { add_error "$mode rollback fault matrix failed"; failed=1; }
  if (( failed == 0 )); then
    run_migration_qualification_drill "$mode_root" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
      "$TARGET_RELEASE" "$deploy_asset" "$deploy_fault" || failed=1
    run_migration_qualification_drill "$mode_root" rollback green "$TARGET_MANIFEST" "$SOURCE_MANIFEST" \
      "$SOURCE_RELEASE" "$rollback_asset" "$rollback_fault" || failed=1
  fi
  if (( failed == 0 )); then
    run_worker_qualification_drill "$mode_root" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
      "$TARGET_RELEASE" "$deploy_asset" "$deploy_fault" deploy || failed=1
    run_worker_qualification_drill "$mode_root" rollback green "$TARGET_MANIFEST" "$SOURCE_MANIFEST" \
      "$SOURCE_RELEASE" "$rollback_asset" "$rollback_fault" rollback || failed=1
  fi
  if (( failed == 0 )); then
    if ! prepare_topology "$mode_root/topology" blue "$SOURCE_MANIFEST"; then
      add_error "$mode main topology startup failed"
      failed=1
    else
      run_success_rollout "$mode_root" deploy "$TARGET_MANIFEST" "$deploy_asset" "$deploy_fault" deploy \
        || { add_error "$mode Blue to Green rollout failed"; failed=1; }
      if (( failed == 0 )); then
        run_success_rollout "$mode_root" rollback "$SOURCE_MANIFEST" "$rollback_asset" "$rollback_fault" rollback \
          || { add_error "$mode explicit Green to Blue rollback failed"; failed=1; }
      fi
    fi
  fi
  [[ -f "$mode_root/states/deploy-rollout.json" ]] \
    && finalize_worker_qualification "$mode_root" deploy "$mode_root/states/deploy-rollout.json" || failed=1
  [[ -f "$mode_root/states/rollback-rollout.json" ]] \
    && finalize_worker_qualification "$mode_root" rollback "$mode_root/states/rollback-rollout.json" || failed=1
  verify_mode "$mode_root" "$mode" || { add_error "$mode semantic verification failed"; failed=1; }
  teardown_topology "$mode_root/topology" || { add_error "$mode main topology teardown failed"; failed=1; }
  (( failed == 0 ))
}

run_sigkill_interruption() {
  local mode_root="$1" interrupt_stage="$2" deploy_asset="$3"
  local stage_root="$mode_root/interruptions/$interrupt_stage"
  local state_file="$stage_root/states/deploy-rollout.json"
  local fault_evidence="$stage_root/evidence/fault-matrix.json"
  local hold_ready="$stage_root/handshake/$interrupt_stage.ready.json"
  local hold_release="$stage_root/handshake/$interrupt_stage.release.json"
  local rollout_id release_pid="" initial_status=0 resume_status=1 orphan_action=""
  local timeout_seconds failed=0 topology_started=0 observer_started=0 observer_service_started=0 reuse_worker_artifacts=0
  timeout_seconds="$(jq -er '.hostInterruption.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
  rollout_id="$(derive_rollout_id normal "sigkill-resume-$interrupt_stage-deploy" "$TARGET_RELEASE")" || return 1
  mkdir -p "$stage_root/evidence" "$stage_root/logs" "$stage_root/states"

  if ! run_fault_matrix "$stage_root" deploy deploy "$fault_evidence" "$rollout_id"; then
    add_error "sigkill-resume $interrupt_stage fault matrix failed"
    return 1
  fi
  if ! prepare_topology "$stage_root/topology" blue "$SOURCE_MANIFEST"; then
    add_error "sigkill-resume $interrupt_stage topology startup failed"
    return 1
  fi
  topology_started=1
  rollout_environment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$SOURCE_MANIFEST"
  build_rollout_args "$stage_root/rollouts/deploy" "$state_file" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
    "$TARGET_MANIFEST" "$deploy_asset" "$fault_evidence" \
    "$stage_root/rollouts/deploy/rollouts/$rollout_id/evidence/worker-reconciliation.json" "$rollout_id"
  ROLLOUT_ARGS+=(--rollout-id "$rollout_id")
  ROLLOUT_ENV+=(
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH="$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json"
    FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION="$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE="$interrupt_stage"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE="$hold_ready"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE="$hold_release"
    FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS="$timeout_seconds"
  )
  if ! start_worker_observer_service "$stage_root/rollouts/deploy" "initial-$interrupt_stage" \
    "$state_file" resume "$TOPOLOGY_RUNTIME"; then
    add_error "sigkill-resume $interrupt_stage initial worker observer service failed to start"
    failed=1
  else
    observer_service_started=1
    if ! start_normal_worker_observer "$stage_root/rollouts/deploy" "initial-$interrupt_stage" \
      "$state_file" resume "$TOPOLOGY_RUNTIME"; then
      [[ -n "${NORMAL_WORKER_PID:-}" ]] && stop_process_group "$NORMAL_WORKER_PID" TERM
      add_error "sigkill-resume $interrupt_stage initial normal observer failed to start"
      failed=1
    else
      observer_started=1
      ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER="$NORMAL_WORKER_LEDGER"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$NORMAL_WORKER_LEDGER"
      )
      setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" --worker-ledger "$NORMAL_WORKER_LEDGER" \
        >"$stage_root/logs/release-rollout-initial.stdout" 2>"$stage_root/logs/release-rollout-initial.stderr" &
      release_pid=$!
      record_command "sigkill-$interrupt_stage-initial-rollout-start" 0
    fi
  fi
  if (( failed == 0 )); then
    if ! process_group_is_isolated "$release_pid"; then
      add_error "sigkill-resume $interrupt_stage rollout process group is not isolated"
      failed=1
    elif ! wait_for_json "$hold_ready" \
      ".schema == \"fsusblog.release-rollout-rehearsal-stage-hold.v1\" and .status == \"ready\" and .rolloutId == \"$rollout_id\" and .stage == \"$interrupt_stage\" and (.errors | type == \"array\" and length == 0)" \
      "$timeout_seconds" "$release_pid"; then
      add_error "sigkill-resume did not reach deterministic $interrupt_stage hold"
      failed=1
    elif ! worker_observer_service_process_is_live "$WORKER_OBSERVER_SERVICE_PID"; then
      add_error "sigkill-resume $interrupt_stage worker observer service exited before interruption"
      failed=1
    else
      if ! kill -KILL -- "-$release_pid" >/dev/null 2>&1; then
        add_error "sigkill-resume could not SIGKILL $interrupt_stage process group"
        failed=1
      fi
      wait "$release_pid"
      initial_status=$?
      release_pid=""
      record_command "sigkill-$interrupt_stage-initial-rollout-exit" "$initial_status"
      if (( initial_status != 137 )); then
        add_error "sigkill-resume $interrupt_stage exited $initial_status instead of 137"
        failed=1
      fi
    fi
  fi
  if [[ -n "$release_pid" ]]; then
    stop_process_group "$release_pid" KILL
    wait "$release_pid" >/dev/null 2>&1 || true
    release_pid=""
  fi

  if (( observer_started == 1 )); then
    if (( failed != 0 )) || [[ "$interrupt_stage" == "source-drain" ]]; then
      stop_process_group "$NORMAL_WORKER_PID" TERM
    fi
    local initial_observer_status=0
    wait "$NORMAL_WORKER_PID" >/dev/null 2>&1 || initial_observer_status=$?
    record_command "sigkill-$interrupt_stage-initial-normal-worker-observer-exit" "$initial_observer_status"
    observer_started=0
  fi
  if (( observer_service_started == 1 )); then
    if ! stop_worker_observer_service "initial-$interrupt_stage" 1; then
      add_error "sigkill-resume $interrupt_stage initial worker observer service exited early or could not be stopped"
      failed=1
    fi
    observer_service_started=0
  fi
  if jq -e '.schema == "fsusblog.release-worker-event-ledger.v1" and .mode == "normal" and .status == "pass"' \
      "$NORMAL_WORKER_LEDGER" >/dev/null 2>&1 \
    && jq -e '.schema == "fsusblog.release-rollout-gate.v1" and .gate == "target-health" and .status == "pass"' \
      "$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json" >/dev/null 2>&1 \
    && jq -e '.schema == "fsusblog.release-worker-reconciliation-evidence.v2" and .mode == "normal" and .status == "pass"' \
      "$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json" >/dev/null 2>&1 \
    && jq -e --arg rolloutId "$rollout_id" '.schema == "fsusblog.release-traffic-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
      "$ROLLOUT_EVIDENCE_DIR/public-traffic.json" >/dev/null 2>&1 \
    && jq -e --arg rolloutId "$rollout_id" '.schema == "fsusblog.release-notification-stream-evidence.v1" and .contractVersion == 2 and .status == "pass" and .rolloutId == $rolloutId' \
      "$ROLLOUT_EVIDENCE_DIR/notification-stream.json" >/dev/null 2>&1 \
    && jq -e --arg rolloutId "$rollout_id" '.schema == "fsusblog.release-asset-compatibility-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
      "$ROLLOUT_EVIDENCE_DIR/asset-compatibility.json" >/dev/null 2>&1 \
    && jq -e --arg rolloutId "$rollout_id" '.schema == "fsusblog.release-resource-budget-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
      "$ROLLOUT_EVIDENCE_DIR/resource-budget.json" >/dev/null 2>&1; then
    reuse_worker_artifacts=1
  elif [[ "$interrupt_stage" != "source-drain" ]]; then
    add_error "sigkill-resume $interrupt_stage lost finalized normal worker artifacts before resume"
    failed=1
  else
    local interrupted_artifact
    for interrupted_artifact in \
      "$NORMAL_WORKER_LEDGER" \
      "$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json" \
      "$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json"; do
      if [[ -f "$interrupted_artifact" ]]; then
        mv "$interrupted_artifact" "$stage_root/evidence/initial-interrupted-$(basename "$interrupted_artifact")"
      fi
    done
  fi

  if (( failed == 0 )); then
    if ! node "$PLAN_TOOL" inspect-orphan --state "$state_file" --stage "$interrupt_stage" \
      >"$stage_root/evidence/orphan-inspection.json" 2>"$stage_root/logs/orphan-inspection.stderr"; then
      add_error "sigkill-resume $interrupt_stage orphan state is not safely classifiable"
      failed=1
    else
      orphan_action="$(jq -er '.action' "$stage_root/evidence/orphan-inspection.json")" || failed=1
      if [[ "$orphan_action" == "fail-running-stage" ]] \
        && ! run_logged "$stage_root/logs" adopt-orphan node "$ROLLOUT_STATE_SCRIPT" fail-stage \
          --state "$state_file" --stage "$interrupt_stage" --error host_sigkill_rehearsal; then
        add_error "sigkill-resume $interrupt_stage orphan stage could not be durably failed"
        failed=1
      fi
    fi
  fi
  if (( failed == 0 )); then
    ROLLOUT_ENV+=(
      FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE=
      FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE=
      FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE=
    )
    if (( reuse_worker_artifacts == 0 )); then
      if execute_rollout_with_normal_observer "$stage_root/rollouts/deploy" "$interrupt_stage" "$state_file" resume \
        "$stage_root/logs" release-rollout-resume "${ROLLOUT_ARGS[@]}" --resume; then
        resume_status="$LAST_ROLLOUT_STATUS"
      else
        resume_status="${LAST_ROLLOUT_STATUS:-1}"
        add_error "sigkill-resume $interrupt_stage --resume failed with exit $resume_status"
        failed=1
      fi
    else
      setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
        --worker-ledger "$NORMAL_WORKER_LEDGER" --resume \
        >"$stage_root/logs/release-rollout-resume.stdout" 2>"$stage_root/logs/release-rollout-resume.stderr" &
      release_pid=$!
      record_command "sigkill-$interrupt_stage-reuse-final-artifacts-resume-start" 0
      if ! process_group_is_isolated "$release_pid"; then
        stop_process_group "$release_pid" TERM
        add_error "sigkill-resume $interrupt_stage reused-artifact resume process group is not isolated"
        failed=1
      fi
      wait "$release_pid"
      resume_status=$?
      release_pid=""
      record_command "sigkill-$interrupt_stage-reuse-final-artifacts-resume" "$resume_status"
      if (( resume_status != 0 )); then
        add_error "sigkill-resume $interrupt_stage reused-artifact --resume failed with exit $resume_status"
        failed=1
      fi
    fi
  fi
  if (( failed == 0 )) && ! run_logged "$stage_root/logs" sigkill-evidence node "$PLAN_TOOL" sigkill-evidence \
    --state "$state_file" --stage "$interrupt_stage" --initial-exit "$initial_status" \
    --orphan-action "$orphan_action" --resume-exit "$resume_status" --hold-ready "$hold_ready" \
    --out "$stage_root/evidence/sigkill-resume.json"; then
    add_error "sigkill-resume $interrupt_stage evidence sealing failed"
    failed=1
  fi
  if (( topology_started == 1 )) && ! teardown_topology "$stage_root/topology"; then
    add_error "sigkill-resume $interrupt_stage topology teardown failed"
    failed=1
  fi
  (( failed == 0 ))
}

run_sigkill_resume_mode() {
  local mode="sigkill-resume" mode_root="$RUN_ROOT/modes/sigkill-resume"
  local failed=0 control_fault="$mode_root/evidence/fault-matrix.json" deploy_asset control_rollout_id
  local control_topology_started=0
  deploy_asset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
  control_rollout_id="$(derive_rollout_id normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
  mkdir -p "$mode_root/evidence" "$mode_root/logs" "$mode_root/states"

  if ! run_fault_matrix "$mode_root" deploy deploy "$control_fault" "$control_rollout_id"; then
    add_error "$mode control fault matrix failed"
    failed=1
  fi
  if [[ -f "$control_fault" ]] && ! run_migration_qualification_drill "$mode_root" deploy blue \
    "$SOURCE_MANIFEST" "$TARGET_MANIFEST" "$TARGET_RELEASE" "$deploy_asset" "$control_fault"; then
    failed=1
  fi
  if [[ -f "$control_fault" ]] && ! run_worker_qualification_drill "$mode_root" deploy blue \
    "$SOURCE_MANIFEST" "$TARGET_MANIFEST" "$TARGET_RELEASE" "$deploy_asset" "$control_fault" resume; then
    failed=1
  fi
  if [[ -f "$control_fault" ]]; then
    if ! prepare_topology "$mode_root/topology" blue "$SOURCE_MANIFEST"; then
      add_error "$mode fresh control topology startup failed"
      failed=1
    else
      control_topology_started=1
      if ! run_success_rollout "$mode_root" deploy "$TARGET_MANIFEST" "$deploy_asset" "$control_fault" deploy; then
        add_error "$mode fresh uninterrupted control rollout failed"
        failed=1
      fi
    fi
  fi
  if [[ -f "$mode_root/states/deploy-rollout.json" ]] \
    && ! finalize_worker_qualification "$mode_root" deploy "$mode_root/states/deploy-rollout.json"; then
    failed=1
  fi
  if (( control_topology_started == 1 )) && ! teardown_topology "$mode_root/topology"; then
    add_error "$mode fresh control topology teardown failed"
    failed=1
  fi

  local interrupt_stage
  while IFS= read -r interrupt_stage; do
    [[ -n "$interrupt_stage" ]] || continue
    run_sigkill_interruption "$mode_root" "$interrupt_stage" "$deploy_asset" || failed=1
  done < <(jq -er '.hostInterruption.stages[]' "$RESOLVED_PLAN")

  if ! run_logged "$mode_root/logs" sigkill-matrix node "$PLAN_TOOL" sigkill-matrix \
    --mode-root "$mode_root" --out "$mode_root/evidence/sigkill-resume.json"; then
    add_error "$mode late-stage SIGKILL matrix sealing failed"
    failed=1
  fi
  verify_mode "$mode_root" "$mode" || { add_error "$mode semantic verification failed"; failed=1; }
  (( failed == 0 ))
}

log "run=$RUN_ID modes=${REQUESTED_MODES[*]} root=$RUN_ROOT"
for requested_mode in "${REQUESTED_MODES[@]}"; do
  log "mode=$requested_mode status=starting"
  case "$requested_mode" in
    normal|post-switch-rollback)
      run_normal_like_mode "$requested_mode" || add_error "$requested_mode mode failed"
      ;;
    explicit-rollback)
      run_explicit_rollback_mode || add_error "explicit-rollback mode failed"
      ;;
    sigkill-resume)
      run_sigkill_resume_mode || add_error "sigkill-resume mode failed"
      ;;
  esac
done

reports='[]'
for requested_mode in "${REQUESTED_MODES[@]}"; do
  report="$RUN_ROOT/modes/$requested_mode/evidence/rehearsal-mode.json"
  if [[ -f "$report" ]]; then
    reports="$(jq -c --argjson item "$(jq -c . "$report")" '. + [$item]' <<<"$reports")"
  else
    reports="$(jq -c --arg mode "$requested_mode" '. + [{mode:$mode,status:"fail",errors:["mode evidence is missing"]}]' <<<"$reports")"
  fi
done
overall_errors='[]'
if (( ${#OVERALL_ERRORS[@]} > 0 )); then
  overall_errors="$(printf '%s\n' "${OVERALL_ERRORS[@]}" | jq -R . | jq -s .)"
fi
summary_status="$(jq -r --argjson errors "$overall_errors" \
  'if length > 0 and all(.status == "pass") and ($errors | length) == 0 then "pass" else "fail" end' <<<"$reports")"
jq -n \
  --arg runId "$RUN_ID" --arg rehearsalId "$REHEARSAL_ID" --arg status "$summary_status" \
  --arg root "$RUN_ROOT" --arg plan "$RESOLVED_PLAN" --argjson modes "$reports" --argjson errors "$overall_errors" \
  '{schema:"fsusblog.zero-downtime-rehearsal-summary.v1",status:$status,runId:$runId,rehearsalId:$rehearsalId,nonProductionOnly:true,runRoot:$root,resolvedPlan:$plan,modes:$modes,errors:$errors,completedAtUtc:(now|todateiso8601)}' \
  >"$RUN_ROOT/evidence/rehearsal-summary.json"

if [[ "$summary_status" != "pass" || ${#OVERALL_ERRORS[@]} -gt 0 ]]; then
  printf '[zero-downtime-rehearsal] status=fail summary=%s failures=%s\n' \
    "$RUN_ROOT/evidence/rehearsal-summary.json" "${#OVERALL_ERRORS[@]}" >&2
  exit 1
fi
log "status=pass summary=$RUN_ROOT/evidence/rehearsal-summary.json"

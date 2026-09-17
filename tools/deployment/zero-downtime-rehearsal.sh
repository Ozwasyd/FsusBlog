#!/usr/bin/env bash
set -Eeuo pipefail
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
RESOURCE_POLICY="$ROOT_DIR/config/deployment/zero-downtime-resource-policy.json"

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
PROCESS_START_ATTEMPTS=600
PROCESS_START_POLL_SECONDS=0.05

Usage() {
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

Log() {
    printf '[zero-downtime-rehearsal] %s\n' "$1"
}

Fatal() {
    printf '[zero-downtime-rehearsal] fatal: %s\n' "$1" >&2
    exit "${2:-1}"
}

InternalFaultFail() {
    printf '[zero-downtime-rehearsal:fault-case] fatal: %s\n' "$1" >&2
    exit 96
}

WorkerObserverServiceProcessIsLive() {
    local pid="$1" state
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
    kill -0 "$pid" >/dev/null 2>&1 || return 1
    state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$state" && "$state" != Z* ]]
}

WorkerObserverServiceProcessMatches() {
    local pid="$1" serviceRoot="$2" index scriptSeen=0 stateSeen=0
    local -a arguments=()
    [[ -r "/proc/$pid/cmdline" ]] || return 1
    mapfile -d '' -t arguments <"/proc/$pid/cmdline" || return 1
    for ((index = 0; index < ${#arguments[@]}; index += 1)); do
        [[ "${arguments[$index]}" == "$WORKER_OBSERVER_SERVICE_SCRIPT" ]] && scriptSeen=1
        if [[ "${arguments[$index]}" == "--state-dir" &&
            "${arguments[$((index + 1))]:-}" == "$serviceRoot/state" ]]; then
            stateSeen=1
        fi
    done
    ((scriptSeen == 1 && stateSeen == 1))
}

WaitForWorkerObserverServiceProcess() {
    local pid="$1" serviceRoot="$2" attempt
    for ((attempt = 0; attempt < PROCESS_START_ATTEMPTS; attempt += 1)); do
        WorkerObserverServiceProcessIsLive "$pid" || return 1
        if ProcessGroupIsIsolated "$pid" &&
            WorkerObserverServiceProcessMatches "$pid" "$serviceRoot"; then
            return 0
        fi
        sleep "$PROCESS_START_POLL_SECONDS"
    done
    return 1
}

WorkerObserverServiceStopProcess() {
    local serviceRoot="$1" requireRunning="${2:-1}"
    local pidFile="$serviceRoot/service.pid" pid="" wasRunning=0 status=0 state=""
    if [[ ! -f "$pidFile" || -L "$pidFile" ]]; then
        ((requireRunning == 0)) && return 0
        return 1
    fi
    pid="$(tr -d '[:space:]' <"$pidFile")"
    if WorkerObserverServiceProcessIsLive "$pid"; then
        if ! WorkerObserverServiceProcessMatches "$pid" "$serviceRoot"; then
            return 1
        fi
        wasRunning=1
        if [[ "$(ps -o sid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" == "$pid" ]]; then
            kill -TERM -- "-$pid" >/dev/null 2>&1 || true
        else
            kill -TERM "$pid" >/dev/null 2>&1 || true
            status=1
        fi
        for _ in {1..100}; do
            WorkerObserverServiceProcessIsLive "$pid" || break
            sleep 0.05
        done
        if WorkerObserverServiceProcessIsLive "$pid"; then
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
        rm -f "$pidFile"
    fi
    if ((requireRunning == 1 && wasRunning == 0)); then
        status=1
    fi
    return "$status"
}

WorkerObserverServiceStartProcess() {
    local serviceRoot="$1" servicePlan="$2" rolloutState="$3" observerEnvSource="$4" \
        adminHeader="$5" logRoot="$6"
    local privateEnv="$serviceRoot/secrets/observer.env"
    local stateDir="$serviceRoot/state" pidFile="$serviceRoot/service.pid"
    local serviceLabel="${serviceRoot##*/}"
    local stdoutFile="$logRoot/$serviceLabel.stdout"
    local stderrFile="$logRoot/$serviceLabel.stderr"
    local pid attempt
    [[ ! -e "$serviceRoot" && ! -L "$serviceRoot" ]] || return 1
    [[ -f "$servicePlan" && ! -L "$servicePlan" ]] || return 1
    [[ -f "$observerEnvSource" && ! -L "$observerEnvSource" ]] || return 1
    [[ -f "$adminHeader" && ! -L "$adminHeader" ]] || return 1
    install -d -m 0700 "$serviceRoot" "$serviceRoot/secrets" "$stateDir" "$logRoot" || return 1
    install -m 0600 "$observerEnvSource" "$privateEnv" || return 1
    setsid env \
        ASPNETCORE_ENVIRONMENT=Test \
        FSUSBLOG_ROLLOUT_REHEARSAL=1 \
        FSUSBLOG_WORKER_OBSERVER_ENABLED=1 \
        FSUSBLOG_WORKER_OBSERVER_ROOT="$serviceRoot" \
        node "$WORKER_OBSERVER_SERVICE_SCRIPT" \
        --plan "$servicePlan" \
        --rollout-state "$rolloutState" \
        --env-file "$privateEnv" \
        --admin-header-file "$adminHeader" \
        --state-dir "$stateDir" \
        >"$stdoutFile" 2>"$stderrFile" &
    pid=$!
    if ! WaitForWorkerObserverServiceProcess "$pid" "$serviceRoot"; then
        StopProcessGroup "$pid" KILL
        wait "$pid" >/dev/null 2>&1 || true
        return 1
    fi
    install -m 0600 /dev/null "$pidFile" || {
        StopProcessGroup "$pid" KILL
        wait "$pid" >/dev/null 2>&1 || true
        return 1
    }
    printf '%s\n' "$pid" >"$pidFile"
    for ((attempt = 0; attempt < PROCESS_START_ATTEMPTS; attempt += 1)); do
        if [[ -s "$stdoutFile" ]] &&
            jq -e '.schema == "fsusblog.release-worker-observer-service-response.v1" and .status == "listening"' \
                "$stdoutFile" >/dev/null 2>&1; then
            WORKER_OBSERVER_SERVICE_PROCESS_PID="$pid"
            return 0
        fi
        WorkerObserverServiceProcessIsLive "$pid" || break
        sleep "$PROCESS_START_POLL_SECONDS"
    done
    WorkerObserverServiceStopProcess "$serviceRoot" 0 >/dev/null 2>&1 || true
    return 1
}

InternalFaultContext() {
    INTERNAL_RESOLVED_PLAN=""
    INTERNAL_CASE_ROOT=""
    INTERNAL_KIND=""
    INTERNAL_CASE=""
    INTERNAL_ROLLOUT_ID=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --resolved-plan)
                [[ $# -ge 2 ]] || InternalFaultFail "--resolved-plan requires a path"
                INTERNAL_RESOLVED_PLAN="$2"
                shift 2
                ;;
            --case-root)
                [[ $# -ge 2 ]] || InternalFaultFail "--case-root requires a path"
                INTERNAL_CASE_ROOT="$2"
                shift 2
                ;;
            --kind)
                [[ $# -ge 2 ]] || InternalFaultFail "--kind requires a value"
                INTERNAL_KIND="$2"
                shift 2
                ;;
            --case)
                [[ $# -ge 2 ]] || InternalFaultFail "--case requires a value"
                INTERNAL_CASE="$2"
                shift 2
                ;;
            --rollout-id)
                [[ $# -ge 2 ]] || InternalFaultFail "--rollout-id requires a value"
                INTERNAL_ROLLOUT_ID="$2"
                shift 2
                ;;
            *) InternalFaultFail "unknown internal fault argument: $1" ;;
        esac
    done
    [[ -f "$INTERNAL_RESOLVED_PLAN" && ! -L "$INTERNAL_RESOLVED_PLAN" ]] ||
        InternalFaultFail "resolved plan must be a regular non-symlink file"
    jq -e '.schema == "fsusblog.zero-downtime-rehearsal-resolved-plan.v1" and .environment == "Test" and .nonProductionOnly == true' \
        "$INTERNAL_RESOLVED_PLAN" >/dev/null 2>&1 || InternalFaultFail "resolved plan is not a Test rehearsal plan"
    [[ "$INTERNAL_KIND" == "deploy" || "$INTERNAL_KIND" == "rollback" ]] || InternalFaultFail "fault kind is invalid"
    [[ "$INTERNAL_CASE" =~ ^[a-z][a-z0-9-]{2,63}$ ]] || InternalFaultFail "fault case is invalid"
    [[ "$INTERNAL_ROLLOUT_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$ ]] || InternalFaultFail "fault rollout id is invalid"
    local workRoot
    workRoot="$(jq -er '.workRoot' "$INTERNAL_RESOLVED_PLAN")" || InternalFaultFail "workRoot is missing"
    INTERNAL_CASE_ROOT="$(realpath -m "$INTERNAL_CASE_ROOT")"
    [[ "$INTERNAL_CASE_ROOT" == "$workRoot/"* ]] || InternalFaultFail "fault case root escapes workRoot"
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

InternalFaultSetup() {
    InternalFaultContext "$@"
    [[ ! -e "$INTERNAL_RUNTIME" && ! -e "$INTERNAL_SLOT_STATE" && ! -e "$INTERNAL_ROLLOUT_STATE" ]] ||
        InternalFaultFail "fault case state/runtime already exists"
    mkdir -p "$INTERNAL_RUNTIME/secrets" "$INTERNAL_EVIDENCE_DIR"
    install -m 0600 "$(jq -er '.envFile' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_ENV" ||
        InternalFaultFail "unable to install case env"
    install -m 0600 "$(jq -er '.adminHeaderFile' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_ADMIN" ||
        InternalFaultFail "unable to install case admin header"
    install -m 0600 "$(jq -er '.notificationAuthStorageState' "$INTERNAL_RESOLVED_PLAN")" "$INTERNAL_AUTH" ||
        InternalFaultFail "unable to install case auth storage state"
    install -m 0600 "$INTERNAL_TRAFFIC_BINDING_SOURCE" "$INTERNAL_TRAFFIC_BINDING" ||
        InternalFaultFail "unable to install case traffic binding key"
    install -m 0600 "$INTERNAL_ASSET_BROWSER_BINDING_SOURCE" "$INTERNAL_ASSET_BROWSER_BINDING" ||
        InternalFaultFail "unable to install case asset browser binding key"
    FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE="$INTERNAL_SOURCE_PREVIOUS_ROLLBACK_RELEASE" \
        bash "$TOPOLOGY_SCRIPT" up \
        --env-file "$INTERNAL_ENV" --source-manifest "$INTERNAL_SOURCE_MANIFEST" --source-slot "$INTERNAL_SOURCE_SLOT" \
        --work-dir "$INTERNAL_RUNTIME" --public-port "$INTERNAL_PUBLIC_PORT" --state-file "$INTERNAL_SLOT_STATE" \
        >"$INTERNAL_CASE_ROOT/topology-up.stdout" 2>"$INTERNAL_CASE_ROOT/topology-up.stderr" ||
        InternalFaultFail "fault case topology startup failed"
    trap 'WorkerObserverServiceStopProcess "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true; exit 96' HUP INT TERM
    if ! WorkerObserverServiceStartProcess \
        "$INTERNAL_OBSERVER_SERVICE_ROOT" \
        "$INTERNAL_OBSERVER_SERVICE_PLAN" \
        "$INTERNAL_ROLLOUT_STATE" \
        "$INTERNAL_OBSERVER_ENV_SOURCE" \
        "$INTERNAL_ADMIN" \
        "$INTERNAL_CASE_ROOT"; then
        InternalFaultFail "worker observer service failed during case setup"
    fi
    local observerRunId="normal-fault-$INTERNAL_CASE-$INTERNAL_ROLLOUT_ID"
    observerRunId="${observerRunId:0:120}"
    setsid node "$NORMAL_WORKER_OBSERVER_SCRIPT" \
        --plan "$INTERNAL_NORMAL_SCENARIO" \
        --rollout-state "$INTERNAL_ROLLOUT_STATE" \
        --source-drain "$INTERNAL_EVIDENCE_DIR/source-drain-gate.json" \
        --admin-header-file "$INTERNAL_ADMIN" \
        --out "$INTERNAL_WORKER_LEDGER" \
        --run-id "$observerRunId" \
        --start-stage "$INTERNAL_WORKER_START_STAGE" \
        --timeout-ms "$((INTERNAL_WORKER_TIMEOUT * 1000))" \
        >"$INTERNAL_CASE_ROOT/normal-worker-observer.stdout" \
        2>"$INTERNAL_CASE_ROOT/normal-worker-observer.stderr" &
    local observerPid=$!
    if ! WaitForIsolatedProcessGroup "$observerPid"; then
        kill -KILL "$observerPid" >/dev/null 2>&1 || true
        WorkerObserverServiceStopProcess "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true
        InternalFaultFail "normal observer process group is not isolated"
    fi
    printf '%s\n' "$observerPid" >"$INTERNAL_CASE_ROOT/normal-worker-observer.pid"
    sleep 0.05
    if ! kill -0 "$observerPid" >/dev/null 2>&1; then
        WorkerObserverServiceStopProcess "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || true
        InternalFaultFail "normal observer exited during case setup"
    fi
    trap - HUP INT TERM
}

InternalFaultRollout() {
    InternalFaultContext "$@"
    [[ -f "$INTERNAL_SLOT_STATE" && -f "$INTERNAL_ENV" && -f "$INTERNAL_ADMIN" ]] ||
        InternalFaultFail "fault case topology/state is missing"
    local manifest="$INTERNAL_TARGET_MANIFEST"
    if [[ "$INTERNAL_CASE" == "manifest-digest-mismatch" ]]; then
        manifest="$INTERNAL_CASE_ROOT/manifest-digest-mismatch.json"
        jq '.imageDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
            "$INTERNAL_TARGET_MANIFEST" >"$manifest" || InternalFaultFail "unable to create digest mismatch manifest"
    fi
    local openrestyBin="${FSUSBLOG_OPENRESTY_BIN:-$SCRIPT_DIR/rehearsal-openresty.sh}"
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
        FSUSBLOG_OPENRESTY_BIN="$openrestyBin" \
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

InternalFaultTeardown() {
    InternalFaultContext "$@"
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
        if ! WorkerObserverServiceStopProcess "$INTERNAL_OBSERVER_SERVICE_ROOT" 1; then
            status=1
        fi
    elif [[ -d "$INTERNAL_OBSERVER_SERVICE_ROOT" ]]; then
        WorkerObserverServiceStopProcess "$INTERNAL_OBSERVER_SERVICE_ROOT" 0 >/dev/null 2>&1 || status=1
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
    InternalFaultSetup "$@"
    exit $?
fi
if [[ "${1:-}" == "__fault-case-rollout" ]]; then
    shift
    InternalFaultRollout "$@"
fi
if [[ "${1:-}" == "__fault-case-teardown" ]]; then
    shift
    InternalFaultTeardown "$@"
    exit $?
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan)
            [[ $# -ge 2 ]] || Fatal "--plan requires a path"
            PLAN_FILE="$2"
            shift 2
            ;;
        --mode)
            [[ $# -ge 2 ]] || Fatal "--mode requires a value"
            MODE="$2"
            shift 2
            ;;
        --run-id)
            [[ $# -ge 2 ]] || Fatal "--run-id requires a value"
            RUN_ID="$2"
            shift 2
            ;;
        -h | --help)
            Usage
            exit 0
            ;;
        *) Fatal "unknown argument: $1" ;;
    esac
done

[[ -n "$PLAN_FILE" ]] || Fatal "--plan is required"
[[ -f "$PLAN_FILE" && ! -L "$PLAN_FILE" ]] || Fatal "plan must be a regular non-symlink file"
case "$MODE" in
    all) REQUESTED_MODES=(normal explicit-rollback post-switch-rollback sigkill-resume) ;;
    normal | explicit-rollback | post-switch-rollback | sigkill-resume) REQUESTED_MODES=("$MODE") ;;
    *) Fatal "unsupported mode: $MODE" ;;
esac
for command in bash curl date docker flock install jq kill mkdir mktemp mv node ps realpath rm setsid sleep stat tr; do
    command -v "$command" >/dev/null 2>&1 || Fatal "required command is missing: $command"
done
for file in "$PLAN_TOOL" "$NORMAL_WORKER_OBSERVER_SCRIPT" "$WORKER_OBSERVER_SERVICE_SCRIPT" "$TOPOLOGY_SCRIPT" "$ROLLOUT_SCRIPT" "$FAULT_MATRIX_SCRIPT" \
    "$WORKER_DRILL_SCRIPT" "$WORKER_RECONCILIATION_SCRIPT" "$MIGRATION_QUALIFICATION_SCRIPT" \
    "$ROLLOUT_STATE_SCRIPT" "$RESOURCE_POLICY"; do
    [[ -f "$file" && ! -L "$file" ]] || Fatal "required repository file is missing or symlinked: $file"
done

PLAN_FILE="$(realpath "$PLAN_FILE")"
RESOLVE_FILE="$ROOT_DIR/.tmp/.zero-downtime-rehearsal-resolve.$$.$RANDOM.json"
[[ ! -L "$ROOT_DIR/.tmp" ]] || Fatal "repository .tmp must not be a symbolic link"
mkdir -p "$ROOT_DIR/.tmp"
CleanupResolve() {
    local serviceRoot
    for serviceRoot in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
        WorkerObserverServiceStopProcess "$serviceRoot" 0 >/dev/null 2>&1 ||
            WorkerObserverServiceStopProcess "$serviceRoot" 0 >/dev/null 2>&1 ||
            true
    done
    rm -f "$RESOLVE_FILE"
}
trap CleanupResolve EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
node "$PLAN_TOOL" resolve --plan "$PLAN_FILE" --repo-root "$ROOT_DIR" --out "$RESOLVE_FILE" >/dev/null ||
    Fatal "rehearsal plan resolution failed"
export ASPNETCORE_ENVIRONMENT=Test
export FSUSBLOG_ASPNETCORE_ENVIRONMENT=Test
export FSUSBLOG_SCHEMA_QUALIFICATION_ENABLED=true

WORK_ROOT="$(jq -er '.workRoot' "$RESOLVE_FILE")" || Fatal "resolved workRoot is missing"
REHEARSAL_ID="$(jq -er '.rehearsalId' "$RESOLVE_FILE")" || Fatal "resolved rehearsalId is missing"
if [[ -z "$RUN_ID" ]]; then
    RUN_ID="run-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
fi
[[ "$RUN_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{2,47}$ && "$RUN_ID" != *..* ]] || Fatal "run id is invalid"
RUN_ROOT="$WORK_ROOT/$REHEARSAL_ID/$RUN_ID"
[[ ! -e "$RUN_ROOT" && ! -L "$RUN_ROOT" ]] || Fatal "run directory already exists or is symlinked; evidence reuse is forbidden: $RUN_ROOT"
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

RecordCommand() {
    local label="$1" status="$2"
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$label" "$status" >>"$COMMAND_JOURNAL"
}

RunLogged() {
    local logRoot="$1" label="$2"
    shift 2
    mkdir -p "$logRoot"
    "$@" >"$logRoot/$label.stdout" 2>"$logRoot/$label.stderr"
    local status=$?
    RecordCommand "$label" "$status"
    return "$status"
}

AddError() {
    local message="$1"
    OVERALL_ERRORS+=("$message")
    printf '[zero-downtime-rehearsal] error: %s\n' "$message" >&2
}

ProcessGroupIsIsolated() {
    local pid="$1" sid
    sid="$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [[ "$sid" == "$pid" ]]
}

WaitForIsolatedProcessGroup() {
    local pid="$1" attempt state
    [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 1
    for ((attempt = 0; attempt < PROCESS_START_ATTEMPTS; attempt += 1)); do
        state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
        [[ -n "$state" && "$state" != Z* ]] || return 1
        ProcessGroupIsIsolated "$pid" && return 0
        sleep "$PROCESS_START_POLL_SECONDS"
    done
    return 1
}

StopProcessGroup() {
    local pid="$1" signal="${2:-TERM}"
    kill -0 "$pid" >/dev/null 2>&1 || return 0
    if ProcessGroupIsIsolated "$pid"; then
        kill "-$signal" -- "-$pid" >/dev/null 2>&1 || true
    else
        kill "-$signal" "$pid" >/dev/null 2>&1 || true
    fi
}

RegisterWorkerObserverServiceRoot() {
    local existing
    for existing in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
        [[ "$existing" == "$1" ]] && return 1
    done
    ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS+=("$1")
}

UnregisterWorkerObserverServiceRoot() {
    local removed="$1" item
    local -a retained=()
    for item in "${ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS[@]}"; do
        [[ "$item" == "$removed" ]] || retained+=("$item")
    done
    ACTIVE_WORKER_OBSERVER_SERVICE_ROOTS=("${retained[@]}")
}

StartWorkerObserverService() {
    local phaseRoot="$1" phase="$2" stateFile="$3" workerKey="$4" runtime="$5"
    local servicePlan serviceRoot
    [[ "$phase" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{1,127}$ && "$phase" != *..* ]] || return 1
    servicePlan="$(jq -er ".workers.$workerKey.observerServicePlan.file" "$RESOLVED_PLAN")" || return 1
    serviceRoot="$phaseRoot/worker-observer-service-$phase"
    WORKER_OBSERVER_SERVICE_ROOT="$serviceRoot"
    WORKER_OBSERVER_SERVICE_PID=""
    RegisterWorkerObserverServiceRoot "$serviceRoot" || return 1
    if ! WorkerObserverServiceStartProcess \
        "$serviceRoot" \
        "$servicePlan" \
        "$stateFile" \
        "$PLAN_WORKER_OBSERVER_ENV" \
        "$runtime/secrets/admin-header.txt" \
        "$phaseRoot/logs"; then
        UnregisterWorkerObserverServiceRoot "$serviceRoot"
        WORKER_OBSERVER_SERVICE_ROOT=""
        RecordCommand "$phase-worker-observer-service-start" 1
        return 1
    fi
    WORKER_OBSERVER_SERVICE_PID="$WORKER_OBSERVER_SERVICE_PROCESS_PID"
    RecordCommand "$phase-worker-observer-service-start" 0
}

StopWorkerObserverService() {
    local phase="$1" requireRunning="${2:-1}" status=0 serviceRoot="${WORKER_OBSERVER_SERVICE_ROOT:-}"
    [[ -n "$serviceRoot" ]] || return 0
    WorkerObserverServiceStopProcess "$serviceRoot" "$requireRunning" || status=$?
    RecordCommand "$phase-worker-observer-service-stop" "$status"
    if [[ ! -f "$serviceRoot/service.pid" ]]; then
        UnregisterWorkerObserverServiceRoot "$serviceRoot"
        WORKER_OBSERVER_SERVICE_ROOT=""
        WORKER_OBSERVER_SERVICE_PID=""
    fi
    return "$status"
}

WaitForJson() {
    local file="$1" expression="$2" timeoutSeconds="$3" watchedPid="${4:-}" deadline
    deadline=$(($(date +%s) + timeoutSeconds))
    while (($(date +%s) <= deadline)); do
        if [[ -f "$file" ]]; then
            jq -e "$expression" "$file" >/dev/null 2>&1 && return 0
            jq -e '.status == "fail" or (.errors | type == "array" and length > 0)' "$file" >/dev/null 2>&1 && return 1
        fi
        if [[ -n "$watchedPid" ]] && ! kill -0 "$watchedPid" >/dev/null 2>&1; then
            return 1
        fi
        sleep 0.05
    done
    return 1
}

PrepareTopology() {
    local base="$1" sourceSlot="$2" sourceManifest="$3"
    local previousRollbackRelease
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
    if [[ "$(realpath "$sourceManifest")" == "$(realpath "$SOURCE_MANIFEST")" ]]; then
        previousRollbackRelease="$SOURCE_PREVIOUS_ROLLBACK_RELEASE"
    elif [[ "$(realpath "$sourceManifest")" == "$(realpath "$TARGET_MANIFEST")" ]]; then
        previousRollbackRelease="$SOURCE_RELEASE"
    else
        return 1
    fi
    RunLogged "$base/logs" topology-up env \
        FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE="$previousRollbackRelease" \
        bash "$TOPOLOGY_SCRIPT" up \
        --env-file "$TOPOLOGY_ENV" --source-manifest "$sourceManifest" --source-slot "$sourceSlot" \
        --work-dir "$TOPOLOGY_RUNTIME" --public-port "$PUBLIC_PORT" --state-file "$TOPOLOGY_STATE"
}

TeardownTopology() {
    local base="$1"
    [[ -d "$base/runtime" ]] || return 0
    RunLogged "$base/logs" topology-down bash "$TOPOLOGY_SCRIPT" down \
        --env-file "$base/runtime/secrets/rehearsal.env" --work-dir "$base/runtime" \
        --public-port "$PUBLIC_PORT" --state-file "$(dirname "$base")/states/slots.json"
}

RolloutEnvironment() {
    local runtime="$1" state="$2" sourceManifest="$3"
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
        FSUSBLOG_ROLLOUT_SOURCE_MANIFEST="$sourceManifest"
        FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO="$NOTIFICATION_RESYNC_SCENARIO"
    )
}

BuildRolloutArgs() {
    local phaseRoot="$1" stateFile="$2" slotState="$3" runtime="$4" manifest="$5" \
        assetScenario="$6" faultEvidence="$7" workerEvidence="$8"
    local evidenceRoot="$phaseRoot/rollouts"
    local evidenceDir="$evidenceRoot/$9/evidence"
    mkdir -p "$phaseRoot" "$evidenceRoot" "$evidenceDir"
    ROLLOUT_EVIDENCE_DIR="$evidenceDir"
    ROLLOUT_ARGS=(
        --release-manifest "$manifest"
        --env-file "$runtime/secrets/rehearsal.env"
        --slot-state-file "$slotState"
        --rollout-state-file "$stateFile"
        --evidence-root "$evidenceRoot"
        --backup-restore-evidence "$BACKUP_EVIDENCE"
        --migration-server-dll "$MIGRATION_DLL"
        --traffic-scenario "$TRAFFIC_SCENARIO"
        --traffic-binding-key-file "$runtime/secrets/traffic-binding.key"
        --notification-auth-storage-state "$runtime/secrets/auth-storage-state.json"
        --notification-evidence "$evidenceDir/notification-stream.json"
        --asset-compatibility-scenario "$assetScenario"
        --asset-compatibility-evidence "$evidenceDir/asset-compatibility.json"
        --asset-browser-binding-key-file "$runtime/secrets/asset-browser-binding.key"
        --worker-reconciliation-evidence "$workerEvidence"
        --resource-budget-evidence "$evidenceDir/resource-budget.json"
        --fault-injection-evidence "$faultEvidence"
        --public-url "$PUBLIC_URL"
        --admin-header-file "$runtime/secrets/admin-header.txt"
        --control-origin "$CONTROL_ORIGIN"
        --asset-store "$phaseRoot/assets"
        --retention-state "$phaseRoot/assets/retention-state.json"
    )
}

DeriveRolloutId() {
    node "$PLAN_TOOL" derive-rollout-id --role "$1" --phase "$2" --release "$3" --run-id "$RUN_ID"
}

RunFaultMatrix() {
    local modeRoot="$1" phase="$2" kind="$3" output="$4" rolloutId="$5"
    local faultRoot="$modeRoot/faults/$phase"
    local plan="$faultRoot/plan.json"
    mkdir -p "$faultRoot" "$modeRoot/evidence" "$modeRoot/logs"
    if ! RunLogged "$modeRoot/logs" "fault-plan-$phase" node "$PLAN_TOOL" materialize-fault \
        --plan "$RESOLVED_PLAN" --run-root "$faultRoot" --kind "$kind" --rollout-id "$rolloutId" --out "$plan"; then
        return 1
    fi
    if ! RunLogged "$modeRoot/logs" "fault-matrix-$phase" node "$FAULT_MATRIX_SCRIPT" \
        --plan "$plan" --work-dir "$faultRoot/cases" --out "$output"; then
        return 1
    fi
    jq -e '.schema == "fsusblog.zero-downtime-fault-matrix.v1" and .status == "pass" and .caseCount == 13' \
        "$output" >/dev/null 2>&1
}

StartNormalWorkerObserver() {
    local phaseRoot="$1" phase="$2" stateFile="$3" workerKey="$4" runtime="$5"
    local scenario startStage timeoutSeconds runId
    scenario="$(jq -er ".workers.$workerKey.normalScenario.file" "$RESOLVED_PLAN")" || return 1
    startStage="$(jq -er ".workers.$workerKey.startStage" "$RESOLVED_PLAN")" || return 1
    timeoutSeconds="$(jq -er '.workers.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
    runId="normal-$phase-$RUN_ID"
    runId="${runId:0:120}"
    NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
    mkdir -p "$phaseRoot/logs" "$ROLLOUT_EVIDENCE_DIR"
    setsid node "$NORMAL_WORKER_OBSERVER_SCRIPT" \
        --plan "$scenario" \
        --rollout-state "$stateFile" \
        --source-drain "$ROLLOUT_EVIDENCE_DIR/source-drain-gate.json" \
        --admin-header-file "$runtime/secrets/admin-header.txt" \
        --out "$NORMAL_WORKER_LEDGER" \
        --run-id "$runId" \
        --start-stage "$startStage" \
        --timeout-ms "$((timeoutSeconds * 1000))" \
        >"$phaseRoot/logs/normal-worker-observer.stdout" \
        2>"$phaseRoot/logs/normal-worker-observer.stderr" &
    NORMAL_WORKER_PID=$!
    RecordCommand "$phase-normal-worker-observer-start" 0
    WaitForIsolatedProcessGroup "$NORMAL_WORKER_PID"
}

ExecuteRolloutWithNormalObserver() {
    local phaseRoot="$1" phase="$2" stateFile="$3" workerKey="$4" logRoot="$5" label="$6"
    shift 6
    local observerStatus=0 observerDone=0 rolloutStatus=0 rolloutPid serviceFailed=0
    LAST_ROLLOUT_STATUS=1
    NORMAL_WORKER_PID=""
    NORMAL_WORKER_LEDGER=""
    if ! StartWorkerObserverService "$phaseRoot" "$phase" "$stateFile" "$workerKey" "$TOPOLOGY_RUNTIME"; then
        AddError "$phase worker observer service failed to start"
        return 1
    fi
    if ! StartNormalWorkerObserver "$phaseRoot" "$phase" "$stateFile" "$workerKey" "$TOPOLOGY_RUNTIME"; then
        [[ -n "${NORMAL_WORKER_PID:-}" ]] && StopProcessGroup "$NORMAL_WORKER_PID" TERM
        StopWorkerObserverService "$phase" 1 >/dev/null 2>&1 || true
        AddError "$phase normal worker observer failed to start in an isolated process group"
        return 1
    fi
    ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER="$NORMAL_WORKER_LEDGER"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$NORMAL_WORKER_LEDGER"
    )
    local -a command=("$@" --worker-ledger "$NORMAL_WORKER_LEDGER")
    setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${command[@]}" \
        >"$logRoot/$label.stdout" 2>"$logRoot/$label.stderr" &
    rolloutPid=$!
    RecordCommand "$label-start" 0
    if ! WaitForIsolatedProcessGroup "$rolloutPid"; then
        StopProcessGroup "$rolloutPid" TERM
        StopProcessGroup "$NORMAL_WORKER_PID" TERM
        wait "$rolloutPid" >/dev/null 2>&1 || true
        wait "$NORMAL_WORKER_PID" >/dev/null 2>&1 || true
        StopWorkerObserverService "$phase" 1 >/dev/null 2>&1 || true
        AddError "$phase rollout failed to start in an isolated process group"
        return 1
    fi
    while kill -0 "$rolloutPid" >/dev/null 2>&1; do
        if ! WorkerObserverServiceProcessIsLive "$WORKER_OBSERVER_SERVICE_PID"; then
            serviceFailed=1
            StopProcessGroup "$NORMAL_WORKER_PID" TERM
            StopProcessGroup "$rolloutPid" TERM
            break
        fi
        if ((observerDone == 0)) && ! kill -0 "$NORMAL_WORKER_PID" >/dev/null 2>&1; then
            wait "$NORMAL_WORKER_PID"
            observerStatus=$?
            observerDone=1
            RecordCommand "$phase-normal-worker-observer-exit" "$observerStatus"
            if ((observerStatus != 0)); then
                StopProcessGroup "$rolloutPid" TERM
                break
            fi
        fi
        sleep 0.1
    done
    wait "$rolloutPid"
    rolloutStatus=$?
    RecordCommand "$label" "$rolloutStatus"
    if ((observerDone == 0)); then
        if ((rolloutStatus != 0)); then
            StopProcessGroup "$NORMAL_WORKER_PID" TERM
        fi
        wait "$NORMAL_WORKER_PID"
        observerStatus=$?
        RecordCommand "$phase-normal-worker-observer-exit" "$observerStatus"
    fi
    if ! StopWorkerObserverService "$phase" 1; then
        serviceFailed=1
        AddError "$phase worker observer service exited early or could not be stopped"
    fi
    LAST_ROLLOUT_STATUS="$rolloutStatus"
    if ((rolloutStatus != 0 || observerStatus != 0 || serviceFailed != 0)); then
        AddError "$phase rollout/normal-worker observer service failed (rollout=$rolloutStatus observer=$observerStatus service=$serviceFailed)"
        return 1
    fi
    [[ -f "$NORMAL_WORKER_LEDGER" ]] || {
        AddError "$phase normal worker ledger is missing"
        return 1
    }
    jq -e '.schema == "fsusblog.release-worker-event-ledger.v1" and .mode == "normal" and .status == "pass" and (.events | length) == 8' \
        "$NORMAL_WORKER_LEDGER" >/dev/null 2>&1
}

RunWorkerQualificationDrill() {
    local modeRoot="$1" phase="$2" sourceSlot="$3" sourceManifest="$4" targetManifest="$5" \
        targetRelease="$6" assetScenario="$7" faultEvidence="$8" workerKey="$9"
    local qualRoot="$modeRoot/qualification/$phase"
    local topologyRoot="$qualRoot/topology"
    local rolloutState="$qualRoot/rollout-state.json"
    local rolloutId
    local scenario startStage timeoutSeconds holdTimeoutSeconds workerRoot ledger health control runId armedRel authorizeRel terminatedRel
    local holdReady holdRelease
    local releasePid="" drillPid="" releaseStatus=0 drillStatus=0 failed=0 observerServiceStarted=0
    scenario="$(jq -er ".workers.$workerKey.scenario" "$RESOLVED_PLAN")" || return 1
    startStage="$(jq -er ".workers.$workerKey.startStage" "$RESOLVED_PLAN")" || return 1
    timeoutSeconds="$(jq -er '.workers.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
    holdTimeoutSeconds="$timeoutSeconds"
    ((holdTimeoutSeconds > 300)) && holdTimeoutSeconds=300
    armedRel="$(jq -er ".workers.$workerKey.coordination.armedFile" "$RESOLVED_PLAN")" || return 1
    authorizeRel="$(jq -er ".workers.$workerKey.coordination.authorizeFile" "$RESOLVED_PLAN")" || return 1
    terminatedRel="$(jq -er ".workers.$workerKey.coordination.terminatedFile" "$RESOLVED_PLAN")" || return 1
    workerRoot="$qualRoot/worker"
    ledger="$workerRoot/ledger.json"
    health="$qualRoot/target-health.json"
    control="$qualRoot/worker-qualification-control.json"
    holdReady="$qualRoot/handshake/active-fence.ready.json"
    holdRelease="$qualRoot/handshake/active-fence.release.json"
    runId="worker-$phase-$RUN_ID"
    runId="${runId:0:120}"
    rolloutId="$(DeriveRolloutId qualification "$(basename "$modeRoot")-$phase" "$targetRelease")" || return 1
    mkdir -p "$qualRoot/logs" "$workerRoot" "$qualRoot/handshake"

    if ! PrepareTopology "$topologyRoot" "$sourceSlot" "$sourceManifest"; then
        AddError "$phase qualification topology startup failed"
        TeardownTopology "$topologyRoot" >/dev/null 2>&1 || true
        return 1
    fi
    RolloutEnvironment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$sourceManifest"
    BuildRolloutArgs "$qualRoot" "$rolloutState" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
        "$targetManifest" "$assetScenario" "$faultEvidence" "$qualRoot/unused-normal-worker-evidence.json" "$rolloutId"
    ROLLOUT_ARGS+=(--rollout-id "$rolloutId")
    ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE=active-fence
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE="$holdReady"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE="$holdRelease"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS="$holdTimeoutSeconds"
    )

    if ! StartWorkerObserverService "$qualRoot" "qualification-$phase" "$rolloutState" "$workerKey" "$TOPOLOGY_RUNTIME"; then
        AddError "$phase qualification worker observer service failed to start"
        failed=1
    else
        observerServiceStarted=1
    fi
    if ((failed == 0)); then
        setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
            >"$qualRoot/logs/release-rollout.stdout" 2>"$qualRoot/logs/release-rollout.stderr" &
        releasePid=$!
        RecordCommand "$phase-qualification-rollout-start" 0
        if ! WaitForIsolatedProcessGroup "$releasePid"; then
            AddError "$phase qualification rollout did not get an isolated process group"
            failed=1
        fi
    fi
    if ((failed == 0)) && ! node "$PLAN_TOOL" wait-stage --state "$rolloutState" --stage "$startStage" \
        --timeout-ms "$((timeoutSeconds * 1000))" >"$qualRoot/logs/wait-worker-stage.stdout" \
        2>"$qualRoot/logs/wait-worker-stage.stderr"; then
        AddError "$phase qualification rollout did not reach worker start stage"
        failed=1
    fi
    if ((failed == 0)); then
        setsid env FSUSBLOG_WORKER_DRILL_ROOT="$qualRoot" node "$WORKER_DRILL_SCRIPT" \
            --plan "$scenario" --rollout-state "$rolloutState" --work-dir "$workerRoot" --out ledger.json --run-id "$runId" \
            >"$qualRoot/logs/worker-drill.stdout" 2>"$qualRoot/logs/worker-drill.stderr" &
        drillPid=$!
        RecordCommand "$phase-worker-drill-start" 0
        if ! WaitForIsolatedProcessGroup "$drillPid"; then
            AddError "$phase worker drill did not get an isolated process group"
            failed=1
        fi
    fi
    local armedFile="$workerRoot/$armedRel" authorizeFile="$workerRoot/$authorizeRel" terminatedFile="$workerRoot/$terminatedRel"
    if ((failed == 0)) && ! WaitForJson "$armedFile" \
        ".schema == \"fsusblog.release-worker-drill-signal.v1\" and .stage == \"armed\" and .runId == \"$runId\"" \
        "$timeoutSeconds" "$drillPid"; then
        AddError "$phase worker qualification never produced a valid armed signal"
        failed=1
    fi
    if ((failed == 0)) && ! WaitForJson "$holdReady" \
        ".schema == \"fsusblog.release-rollout-rehearsal-stage-hold.v1\" and .stage == \"active-fence\" and .rolloutId == \"$rolloutId\"" \
        "$timeoutSeconds" "$releasePid"; then
        AddError "$phase qualification missed the controlled active-fence window"
        failed=1
    fi
    if ((failed == 0)) && ! RunLogged "$qualRoot/logs" authorize-worker node "$PLAN_TOOL" authorize-worker \
        --state "$rolloutState" --armed "$armedFile" --out "$authorizeFile" --run-id "$runId"; then
        AddError "$phase worker termination authorization failed"
        failed=1
    fi
    if [[ -n "$drillPid" ]]; then
        if ((failed != 0)); then
            StopProcessGroup "$drillPid" TERM
        fi
        wait "$drillPid"
        drillStatus=$?
        RecordCommand "$phase-worker-drill-exit" "$drillStatus"
        drillPid=""
        if ((drillStatus != 0)); then
            AddError "$phase worker drill failed with exit $drillStatus"
            failed=1
        fi
    fi
    if ((failed == 0)) && ! WaitForJson "$terminatedFile" \
        ".schema == \"fsusblog.release-worker-drill-signal.v1\" and .stage == \"source-terminated\" and .forced == true and .runId == \"$runId\"" \
        30; then
        AddError "$phase worker qualification lacks forced termination signal"
        failed=1
    fi

    if [[ -n "$releasePid" ]]; then
        StopProcessGroup "$releasePid" TERM
        wait "$releasePid"
        releaseStatus=$?
        RecordCommand "$phase-qualification-rollout-stop" "$releaseStatus"
        releasePid=""
    fi
    if ((observerServiceStarted == 1)); then
        if ! StopWorkerObserverService "qualification-$phase" 1; then
            AddError "$phase qualification worker observer service exited early or could not be stopped"
            failed=1
        fi
        observerServiceStarted=0
    fi
    if ((failed == 0)) && ! RunLogged "$qualRoot/logs" worker-health node "$PLAN_TOOL" worker-health \
        --state "$rolloutState" --ledger "$ledger" --out "$health"; then
        AddError "$phase worker target health derivation failed"
        failed=1
    fi
    if ((failed == 0)) && ! RunLogged "$qualRoot/logs" worker-qualification-control node "$PLAN_TOOL" worker-qualification \
        --state "$rolloutState" --ledger "$ledger" --scenario "$scenario" --out "$control"; then
        AddError "$phase worker qualification control failed"
        failed=1
    fi
    if ! TeardownTopology "$topologyRoot"; then
        AddError "$phase qualification topology teardown failed"
        failed=1
    fi
    ((failed == 0))
}

RunMigrationQualificationDrill() {
    local modeRoot="$1" phase="$2" sourceSlot="$3" sourceManifest="$4" targetManifest="$5" \
        targetRelease="$6" assetScenario="$7" faultEvidence="$8"
    local qualificationRoot="$modeRoot/migration-qualification/$phase"
    local topologyRoot="$qualificationRoot/topology"
    local rolloutState="$qualificationRoot/rollout-state.json"
    local rolloutId scenarioFile evidenceFile workDir runId timeoutSeconds
    local holdReady="$qualificationRoot/handshake/candidate-readiness.ready.json"
    local holdRelease="$qualificationRoot/handshake/candidate-readiness.release.json"
    local releasePid="" releaseStatus=0 failed=0
    local sourcePort targetPort sourceOrigin targetOrigin
    local sourceBody="$qualificationRoot/inputs/source-write.json"
    local targetBody="$qualificationRoot/inputs/target-write.json"
    local contractWindow="$qualificationRoot/inputs/contract-window-open.json"
    local contractQualified="$qualificationRoot/inputs/contract-qualified.json"
    timeoutSeconds="$(jq -er '.migrationQualification.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
    rolloutId="$(DeriveRolloutId qualification "migration-$phase-$(basename "$modeRoot")" "$targetRelease")" || return 1
    runId="migration-$phase-$RUN_ID"
    runId="${runId:0:120}"
    scenarioFile="$qualificationRoot/scenario.json"
    evidenceFile="$qualificationRoot/migration-qualification.json"
    workDir="$qualificationRoot/run"
    mkdir -p "$qualificationRoot/logs" "$qualificationRoot/inputs" "$qualificationRoot/handshake"

    jq -n --arg operationId "source-$runId" '{operationId:$operationId,sequence:1}' >"$sourceBody"
    jq -n --arg operationId "target-$runId" '{operationId:$operationId,sequence:2}' >"$targetBody"
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
  ' >"$contractWindow"
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
  ' >"$contractQualified"

    if ! PrepareTopology "$topologyRoot" "$sourceSlot" "$sourceManifest"; then
        AddError "$phase migration qualification topology startup failed"
        TeardownTopology "$topologyRoot" >/dev/null 2>&1 || true
        return 1
    fi
    if [[ "$sourceSlot" == "blue" ]]; then
        sourcePort="${FSUSBLOG_BLUE_PORT:-8081}"
        targetPort="${FSUSBLOG_GREEN_PORT:-8082}"
    else
        sourcePort="${FSUSBLOG_GREEN_PORT:-8082}"
        targetPort="${FSUSBLOG_BLUE_PORT:-8081}"
    fi
    sourceOrigin="http://127.0.0.1:$sourcePort"
    targetOrigin="http://127.0.0.1:$targetPort"
    RolloutEnvironment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$sourceManifest"
    BuildRolloutArgs "$qualificationRoot" "$rolloutState" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
        "$targetManifest" "$assetScenario" "$faultEvidence" "$qualificationRoot/unused-worker-evidence.json" "$rolloutId"
    ROLLOUT_ARGS+=(--rollout-id "$rolloutId")
    ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE=candidate-readiness
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE="$holdReady"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE="$holdRelease"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS="$timeoutSeconds"
    )

    setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
        >"$qualificationRoot/logs/release-rollout.stdout" \
        2>"$qualificationRoot/logs/release-rollout.stderr" &
    releasePid=$!
    RecordCommand "$phase-migration-qualification-rollout-start" 0
    if ! WaitForIsolatedProcessGroup "$releasePid"; then
        AddError "$phase migration qualification rollout did not get an isolated process group"
        failed=1
    fi
    if ((failed == 0)) && ! WaitForJson "$holdReady" \
        ".schema == \"fsusblog.release-rollout-rehearsal-stage-hold.v1\" and .stage == \"candidate-readiness\" and .rolloutId == \"$rolloutId\"" \
        "$timeoutSeconds" "$releasePid"; then
        AddError "$phase migration qualification rollout did not reach dual-slot candidate readiness hold"
        failed=1
    fi

    if ((failed == 0)) && ! RunLogged "$qualificationRoot/logs" materialize-migration-scenario \
        node "$PLAN_TOOL" materialize-migration-qualification \
        --plan "$RESOLVED_PLAN" \
        --run-root "$qualificationRoot" \
        --runtime "$TOPOLOGY_RUNTIME" \
        --database-isolation-id "$runId" \
        --source-origin "$sourceOrigin" \
        --target-origin "$targetOrigin" \
        --env-file "$TOPOLOGY_ENV" \
        --admin-header-file "$TOPOLOGY_ADMIN" \
        --source-write-body "$sourceBody" \
        --target-write-body "$targetBody" \
        --contract-window-evidence "$contractWindow" \
        --contract-qualified-evidence "$contractQualified" \
        --out "$scenarioFile"; then
        AddError "$phase migration qualification scenario materialization failed"
        failed=1
    fi
    if ((failed == 0)) && ! RunLogged "$qualificationRoot/logs" migration-qualification \
        env ASPNETCORE_ENVIRONMENT=Test FSUSBLOG_ROLLOUT_REHEARSAL=1 \
        node "$MIGRATION_QUALIFICATION_SCRIPT" \
        --scenario "$scenarioFile" \
        --rollout-state "$rolloutState" \
        --release-manifest "$targetManifest" \
        --work-dir "$workDir" \
        --out "$evidenceFile" \
        --run-id "$runId"; then
        AddError "$phase migration qualification ten-case run failed"
        failed=1
    fi
    if [[ -n "$releasePid" ]]; then
        StopProcessGroup "$releasePid" TERM
        wait "$releasePid" || releaseStatus=$?
        RecordCommand "$phase-migration-qualification-rollout-stop" "$releaseStatus"
        releasePid=""
    fi
    if [[ -f "$evidenceFile" ]]; then
        jq -e --arg rolloutId "$rolloutId" '
      .schema == "fsusblog.release-migration-qualification-evidence.v1"
      and .status == "pass"
      and .rolloutId == $rolloutId
      and (.cases | length == 10)
      and (.errors | type == "array" and length == 0)
    ' "$evidenceFile" >/dev/null 2>&1 || failed=1
    else
        failed=1
    fi
    if ! TeardownTopology "$topologyRoot"; then
        AddError "$phase migration qualification topology teardown failed"
        failed=1
    fi
    ((failed == 0))
}

FinalizeWorkerQualification() {
    local modeRoot="$1" phase="$2" normalState="$3"
    local qualRoot="$modeRoot/qualification/$phase"
    local reconciliation="$qualRoot/worker-reconciliation.json"
    local final="$qualRoot/worker-qualification.json"
    local qualificationId
    qualificationId="$(jq -er '.qualificationId' "$qualRoot/worker-qualification-control.json")" || return 1
    if ! RunLogged "$qualRoot/logs" worker-qualification-reconciliation node "$WORKER_RECONCILIATION_SCRIPT" \
        --mode qualification \
        --rollout-state "$qualRoot/rollout-state.json" \
        --normal-rollout-state "$normalState" \
        --ledger "$qualRoot/worker/ledger.json" \
        --qualification-id "$qualificationId" \
        --qualification-control "$qualRoot/worker-qualification-control.json" \
        --resource-policy "$RESOURCE_POLICY" \
        --target-health "$qualRoot/target-health.json" \
        --out "$reconciliation"; then
        AddError "$phase worker qualification reconciliation failed"
        return 1
    fi
    if ! RunLogged "$qualRoot/logs" worker-qualification-finalize node "$PLAN_TOOL" finalize-worker-qualification \
        --control "$qualRoot/worker-qualification-control.json" --reconciliation "$reconciliation" --out "$final"; then
        AddError "$phase worker qualification seal failed"
        return 1
    fi
    jq -e '.schema == "fsusblog.release-worker-qualification-evidence.v1" and .status == "pass"' "$final" >/dev/null 2>&1
}

RunSuccessRollout() {
    local modeRoot="$1" phase="$2" manifest="$3" assetScenario="$4" faultEvidence="$5" kind="$6"
    local stateFile="$modeRoot/states/$phase-rollout.json"
    local targetRelease rolloutId workerEvidence phaseRoot
    if [[ "$kind" == "rollback" ]]; then
        targetRelease="$SOURCE_RELEASE"
    else
        targetRelease="$TARGET_RELEASE"
    fi
    rolloutId="$(DeriveRolloutId normal "$(basename "$modeRoot")-$phase" "$targetRelease")" || return 1
    phaseRoot="$modeRoot/rollouts/$phase"
    workerEvidence="$phaseRoot/rollouts/$rolloutId/evidence/worker-reconciliation.json"
    RolloutEnvironment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$([[ "$kind" == "rollback" ]] && printf '%s' "$TARGET_MANIFEST" || printf '%s' "$SOURCE_MANIFEST")"
    BuildRolloutArgs "$phaseRoot" "$stateFile" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
        "$manifest" "$assetScenario" "$faultEvidence" "$workerEvidence" "$rolloutId"
    ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH="$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION="$workerEvidence"
    )
    local -a args=("${ROLLOUT_ARGS[@]}" --rollout-id "$rolloutId")
    [[ "$kind" == "rollback" ]] && args+=(--rollback)
    ExecuteRolloutWithNormalObserver "$phaseRoot" "$phase" "$stateFile" \
        "$([[ "$kind" == "rollback" ]] && printf rollback || printf deploy)" \
        "$modeRoot/logs" "release-rollout-$phase" "${args[@]}"
}

VerifyMode() {
    local modeRoot="$1" mode="$2"
    mkdir -p "$modeRoot/evidence"
    RunLogged "$modeRoot/logs" verify-mode node "$PLAN_TOOL" verify-mode \
        --plan "$RESOLVED_PLAN" --mode "$mode" --mode-root "$modeRoot" \
        --out "$modeRoot/evidence/rehearsal-mode.json"
}

RunNormalLikeMode() {
    local mode="$1"
    local modeRoot="$RUN_ROOT/modes/$mode"
    local failed=0 deployFault="$modeRoot/evidence/fault-matrix.json"
    local deployAsset deployRolloutId
    deployAsset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
    deployRolloutId="$(DeriveRolloutId normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
    mkdir -p "$modeRoot/evidence" "$modeRoot/logs" "$modeRoot/states"
    Log "mode=$mode phase=fault-matrix"
    if ! RunFaultMatrix "$modeRoot" deploy deploy "$deployFault" "$deployRolloutId"; then
        AddError "$mode deploy fault matrix failed"
        failed=1
    fi
    if ((failed == 0)); then
        Log "mode=$mode phase=migration-qualification"
        RunMigrationQualificationDrill "$modeRoot" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
            "$TARGET_RELEASE" "$deployAsset" "$deployFault" || failed=1
    fi
    if ((failed == 0)); then
        Log "mode=$mode phase=worker-qualification"
        RunWorkerQualificationDrill "$modeRoot" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
            "$TARGET_RELEASE" "$deployAsset" "$deployFault" deploy || failed=1
    fi
    if ((failed == 0)); then
        Log "mode=$mode phase=fresh-blue-green"
        if ! PrepareTopology "$modeRoot/topology" blue "$SOURCE_MANIFEST"; then
            AddError "$mode main topology startup failed"
            failed=1
        elif ! RunSuccessRollout "$modeRoot" deploy "$TARGET_MANIFEST" "$deployAsset" "$deployFault" deploy; then
            AddError "$mode fresh Blue to Green rollout failed"
            failed=1
        fi
    fi
    if [[ -f "$modeRoot/states/deploy-rollout.json" ]]; then
        FinalizeWorkerQualification "$modeRoot" deploy "$modeRoot/states/deploy-rollout.json" || failed=1
    fi
    if ! VerifyMode "$modeRoot" "$mode"; then
        AddError "$mode semantic verification failed"
        failed=1
    fi
    if ! TeardownTopology "$modeRoot/topology"; then
        AddError "$mode main topology teardown failed"
        failed=1
    fi
    ((failed == 0))
}

RunExplicitRollbackMode() {
    local mode="explicit-rollback"
    local modeRoot="$RUN_ROOT/modes/explicit-rollback"
    local failed=0 deployFault="$modeRoot/evidence/fault-matrix.json" rollbackFault="$modeRoot/evidence/fault-matrix-rollback.json"
    local deployAsset rollbackAsset deployRolloutId rollbackRolloutId
    deployAsset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
    rollbackAsset="$(jq -er '.assets.rollbackScenario' "$RESOLVED_PLAN")" || return 1
    deployRolloutId="$(DeriveRolloutId normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
    rollbackRolloutId="$(DeriveRolloutId normal "$mode-rollback" "$SOURCE_RELEASE")" || return 1
    mkdir -p "$modeRoot/evidence" "$modeRoot/logs" "$modeRoot/states"
    RunFaultMatrix "$modeRoot" deploy deploy "$deployFault" "$deployRolloutId" || {
        AddError "$mode deploy fault matrix failed"
        failed=1
    }
    RunFaultMatrix "$modeRoot" rollback rollback "$rollbackFault" "$rollbackRolloutId" || {
        AddError "$mode rollback fault matrix failed"
        failed=1
    }
    if ((failed == 0)); then
        RunMigrationQualificationDrill "$modeRoot" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
            "$TARGET_RELEASE" "$deployAsset" "$deployFault" || failed=1
        RunMigrationQualificationDrill "$modeRoot" rollback green "$TARGET_MANIFEST" "$SOURCE_MANIFEST" \
            "$SOURCE_RELEASE" "$rollbackAsset" "$rollbackFault" || failed=1
    fi
    if ((failed == 0)); then
        RunWorkerQualificationDrill "$modeRoot" deploy blue "$SOURCE_MANIFEST" "$TARGET_MANIFEST" \
            "$TARGET_RELEASE" "$deployAsset" "$deployFault" deploy || failed=1
        RunWorkerQualificationDrill "$modeRoot" rollback green "$TARGET_MANIFEST" "$SOURCE_MANIFEST" \
            "$SOURCE_RELEASE" "$rollbackAsset" "$rollbackFault" rollback || failed=1
    fi
    if ((failed == 0)); then
        if ! PrepareTopology "$modeRoot/topology" blue "$SOURCE_MANIFEST"; then
            AddError "$mode main topology startup failed"
            failed=1
        else
            RunSuccessRollout "$modeRoot" deploy "$TARGET_MANIFEST" "$deployAsset" "$deployFault" deploy ||
                {
                    AddError "$mode Blue to Green rollout failed"
                    failed=1
                }
            if ((failed == 0)); then
                RunSuccessRollout "$modeRoot" rollback "$SOURCE_MANIFEST" "$rollbackAsset" "$rollbackFault" rollback ||
                    {
                        AddError "$mode explicit Green to Blue rollback failed"
                        failed=1
                    }
            fi
        fi
    fi
    [[ -f "$modeRoot/states/deploy-rollout.json" ]] &&
        FinalizeWorkerQualification "$modeRoot" deploy "$modeRoot/states/deploy-rollout.json" || failed=1
    [[ -f "$modeRoot/states/rollback-rollout.json" ]] &&
        FinalizeWorkerQualification "$modeRoot" rollback "$modeRoot/states/rollback-rollout.json" || failed=1
    VerifyMode "$modeRoot" "$mode" || {
        AddError "$mode semantic verification failed"
        failed=1
    }
    TeardownTopology "$modeRoot/topology" || {
        AddError "$mode main topology teardown failed"
        failed=1
    }
    ((failed == 0))
}

RunSigkillInterruption() {
    local modeRoot="$1" interruptStage="$2" deployAsset="$3"
    local stageRoot="$modeRoot/interruptions/$interruptStage"
    local stateFile="$stageRoot/states/deploy-rollout.json"
    local faultEvidence="$stageRoot/evidence/fault-matrix.json"
    local holdReady="$stageRoot/handshake/$interruptStage.ready.json"
    local holdRelease="$stageRoot/handshake/$interruptStage.release.json"
    local rolloutId releasePid="" initialStatus=0 resumeStatus=1 orphanAction=""
    local timeoutSeconds failed=0 topologyStarted=0 observerStarted=0 observerServiceStarted=0 reuseWorkerArtifacts=0
    timeoutSeconds="$(jq -er '.hostInterruption.timeoutSeconds' "$RESOLVED_PLAN")" || return 1
    rolloutId="$(DeriveRolloutId normal "sigkill-resume-$interruptStage-deploy" "$TARGET_RELEASE")" || return 1
    mkdir -p "$stageRoot/evidence" "$stageRoot/logs" "$stageRoot/states"

    if ! RunFaultMatrix "$stageRoot" deploy deploy "$faultEvidence" "$rolloutId"; then
        AddError "sigkill-resume $interruptStage fault matrix failed"
        return 1
    fi
    if ! PrepareTopology "$stageRoot/topology" blue "$SOURCE_MANIFEST"; then
        AddError "sigkill-resume $interruptStage topology startup failed"
        return 1
    fi
    topologyStarted=1
    RolloutEnvironment "$TOPOLOGY_RUNTIME" "$TOPOLOGY_STATE" "$SOURCE_MANIFEST"
    BuildRolloutArgs "$stageRoot/rollouts/deploy" "$stateFile" "$TOPOLOGY_STATE" "$TOPOLOGY_RUNTIME" \
        "$TARGET_MANIFEST" "$deployAsset" "$faultEvidence" \
        "$stageRoot/rollouts/deploy/rollouts/$rolloutId/evidence/worker-reconciliation.json" "$rolloutId"
    ROLLOUT_ARGS+=(--rollout-id "$rolloutId")
    ROLLOUT_ENV+=(
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$ROLLOUT_EVIDENCE_DIR/worker-normal-ledger.json"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH="$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json"
        FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION="$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE="$interruptStage"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE="$holdReady"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE="$holdRelease"
        FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS="$timeoutSeconds"
    )
    if ! StartWorkerObserverService "$stageRoot/rollouts/deploy" "initial-$interruptStage" \
        "$stateFile" resume "$TOPOLOGY_RUNTIME"; then
        AddError "sigkill-resume $interruptStage initial worker observer service failed to start"
        failed=1
    else
        observerServiceStarted=1
        if ! StartNormalWorkerObserver "$stageRoot/rollouts/deploy" "initial-$interruptStage" \
            "$stateFile" resume "$TOPOLOGY_RUNTIME"; then
            [[ -n "${NORMAL_WORKER_PID:-}" ]] && StopProcessGroup "$NORMAL_WORKER_PID" TERM
            AddError "sigkill-resume $interruptStage initial normal observer failed to start"
            failed=1
        else
            observerStarted=1
            ROLLOUT_ENV+=(
                FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER="$NORMAL_WORKER_LEDGER"
                FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER="$NORMAL_WORKER_LEDGER"
            )
            setsid "${ROLLOUT_ENV[@]}" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" --worker-ledger "$NORMAL_WORKER_LEDGER" \
                >"$stageRoot/logs/release-rollout-initial.stdout" 2>"$stageRoot/logs/release-rollout-initial.stderr" &
            releasePid=$!
            RecordCommand "sigkill-$interruptStage-initial-rollout-start" 0
        fi
    fi
    if ((failed == 0)); then
        if ! WaitForIsolatedProcessGroup "$releasePid"; then
            AddError "sigkill-resume $interruptStage rollout process group is not isolated"
            failed=1
        elif ! WaitForJson "$holdReady" \
            ".schema == \"fsusblog.release-rollout-rehearsal-stage-hold.v1\" and .status == \"ready\" and .rolloutId == \"$rolloutId\" and .stage == \"$interruptStage\" and (.errors | type == \"array\" and length == 0)" \
            "$timeoutSeconds" "$releasePid"; then
            AddError "sigkill-resume did not reach deterministic $interruptStage hold"
            failed=1
        elif ! WorkerObserverServiceProcessIsLive "$WORKER_OBSERVER_SERVICE_PID"; then
            AddError "sigkill-resume $interruptStage worker observer service exited before interruption"
            failed=1
        else
            if ! kill -KILL -- "-$releasePid" >/dev/null 2>&1; then
                AddError "sigkill-resume could not SIGKILL $interruptStage process group"
                failed=1
            fi
            wait "$releasePid"
            initialStatus=$?
            releasePid=""
            RecordCommand "sigkill-$interruptStage-initial-rollout-exit" "$initialStatus"
            if ((initialStatus != 137)); then
                AddError "sigkill-resume $interruptStage exited $initialStatus instead of 137"
                failed=1
            fi
        fi
    fi
    if [[ -n "$releasePid" ]]; then
        StopProcessGroup "$releasePid" KILL
        wait "$releasePid" >/dev/null 2>&1 || true
        releasePid=""
    fi

    if ((observerStarted == 1)); then
        if ((failed != 0)) || [[ "$interruptStage" == "source-drain" ]]; then
            StopProcessGroup "$NORMAL_WORKER_PID" TERM
        fi
        local initialObserverStatus=0
        wait "$NORMAL_WORKER_PID" >/dev/null 2>&1 || initialObserverStatus=$?
        RecordCommand "sigkill-$interruptStage-initial-normal-worker-observer-exit" "$initialObserverStatus"
        observerStarted=0
    fi
    if ((observerServiceStarted == 1)); then
        if ! StopWorkerObserverService "initial-$interruptStage" 1; then
            AddError "sigkill-resume $interruptStage initial worker observer service exited early or could not be stopped"
            failed=1
        fi
        observerServiceStarted=0
    fi
    if jq -e '.schema == "fsusblog.release-worker-event-ledger.v1" and .mode == "normal" and .status == "pass"' \
        "$NORMAL_WORKER_LEDGER" >/dev/null 2>&1 &&
        jq -e '.schema == "fsusblog.release-rollout-gate.v1" and .gate == "target-health" and .status == "pass"' \
            "$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json" >/dev/null 2>&1 &&
        jq -e '.schema == "fsusblog.release-worker-reconciliation-evidence.v2" and .mode == "normal" and .status == "pass"' \
            "$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json" >/dev/null 2>&1 &&
        jq -e --arg rolloutId "$rolloutId" '.schema == "fsusblog.release-traffic-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
            "$ROLLOUT_EVIDENCE_DIR/public-traffic.json" >/dev/null 2>&1 &&
        jq -e --arg rolloutId "$rolloutId" '.schema == "fsusblog.release-notification-stream-evidence.v1" and .contractVersion == 2 and .status == "pass" and .rolloutId == $rolloutId' \
            "$ROLLOUT_EVIDENCE_DIR/notification-stream.json" >/dev/null 2>&1 &&
        jq -e --arg rolloutId "$rolloutId" '.schema == "fsusblog.release-asset-compatibility-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
            "$ROLLOUT_EVIDENCE_DIR/asset-compatibility.json" >/dev/null 2>&1 &&
        jq -e --arg rolloutId "$rolloutId" '.schema == "fsusblog.release-resource-budget-evidence.v1" and .status == "pass" and .rolloutId == $rolloutId' \
            "$ROLLOUT_EVIDENCE_DIR/resource-budget.json" >/dev/null 2>&1; then
        reuseWorkerArtifacts=1
    elif [[ "$interruptStage" != "source-drain" ]]; then
        AddError "sigkill-resume $interruptStage lost finalized normal worker artifacts before resume"
        failed=1
    else
        local interruptedArtifact
        for interruptedArtifact in \
            "$NORMAL_WORKER_LEDGER" \
            "$ROLLOUT_EVIDENCE_DIR/worker-normal-target-health.json" \
            "$ROLLOUT_EVIDENCE_DIR/worker-reconciliation.json"; do
            if [[ -f "$interruptedArtifact" ]]; then
                mv "$interruptedArtifact" "$stageRoot/evidence/initial-interrupted-$(basename "$interruptedArtifact")"
            fi
        done
    fi

    if ((failed == 0)); then
        if ! node "$PLAN_TOOL" inspect-orphan --state "$stateFile" --stage "$interruptStage" \
            >"$stageRoot/evidence/orphan-inspection.json" 2>"$stageRoot/logs/orphan-inspection.stderr"; then
            AddError "sigkill-resume $interruptStage orphan state is not safely classifiable"
            failed=1
        else
            orphanAction="$(jq -er '.action' "$stageRoot/evidence/orphan-inspection.json")" || failed=1
            if [[ "$orphanAction" == "fail-running-stage" ]] &&
                ! RunLogged "$stageRoot/logs" adopt-orphan node "$ROLLOUT_STATE_SCRIPT" fail-stage \
                    --state "$stateFile" --stage "$interruptStage" --error host_sigkill_rehearsal; then
                AddError "sigkill-resume $interruptStage orphan stage could not be durably failed"
                failed=1
            fi
        fi
    fi
    if ((failed == 0)); then
        ROLLOUT_ENV+=(
            FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE=
            FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE=
            FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE=
        )
        if ((reuseWorkerArtifacts == 0)); then
            if ExecuteRolloutWithNormalObserver "$stageRoot/rollouts/deploy" "$interruptStage" "$stateFile" resume \
                "$stageRoot/logs" release-rollout-resume "${ROLLOUT_ARGS[@]}" --resume; then
                resumeStatus="$LAST_ROLLOUT_STATUS"
            else
                resumeStatus="${LAST_ROLLOUT_STATUS:-1}"
                AddError "sigkill-resume $interruptStage --resume failed with exit $resumeStatus"
                failed=1
            fi
        else
            local resumeReady="$stageRoot/handshake/reuse-final-artifacts-resume.ready.json"
            rm -f "$resumeReady"
            setsid "${ROLLOUT_ENV[@]}" bash -c '
                readyFile="$1"
                shift
                sessionId="$(ps -o sid= -p "$$" 2>/dev/null | tr -d "[:space:]")"
                [[ "$sessionId" == "$$" ]] || exit 97
                printf \
                    "{\"schema\":\"fsusblog.zero-downtime-isolated-process-ready.v1\",\"pid\":%s,\"sessionId\":%s}\n" \
                    "$$" "$sessionId" >"$readyFile"
                exec "$@"
            ' fsusblog-isolated-resume "$resumeReady" bash "$ROLLOUT_SCRIPT" "${ROLLOUT_ARGS[@]}" \
                --worker-ledger "$NORMAL_WORKER_LEDGER" --resume \
                >"$stageRoot/logs/release-rollout-resume.stdout" 2>"$stageRoot/logs/release-rollout-resume.stderr" &
            releasePid=$!
            RecordCommand "sigkill-$interruptStage-reuse-final-artifacts-resume-start" 0
            if ! WaitForJson "$resumeReady" \
                ".schema == \"fsusblog.zero-downtime-isolated-process-ready.v1\" and .pid == $releasePid and .sessionId == $releasePid" \
                "$timeoutSeconds" "$releasePid"; then
                StopProcessGroup "$releasePid" TERM
                AddError "sigkill-resume $interruptStage reused-artifact resume lacks isolated startup proof"
                failed=1
            fi
            wait "$releasePid"
            resumeStatus=$?
            releasePid=""
            RecordCommand "sigkill-$interruptStage-reuse-final-artifacts-resume" "$resumeStatus"
            if ((resumeStatus != 0)); then
                AddError "sigkill-resume $interruptStage reused-artifact --resume failed with exit $resumeStatus"
                failed=1
            fi
        fi
    fi
    if ((failed == 0)) && ! RunLogged "$stageRoot/logs" sigkill-evidence node "$PLAN_TOOL" sigkill-evidence \
        --state "$stateFile" --stage "$interruptStage" --initial-exit "$initialStatus" \
        --orphan-action "$orphanAction" --resume-exit "$resumeStatus" --hold-ready "$holdReady" \
        --out "$stageRoot/evidence/sigkill-resume.json"; then
        AddError "sigkill-resume $interruptStage evidence sealing failed"
        failed=1
    fi
    if ((topologyStarted == 1)) && ! TeardownTopology "$stageRoot/topology"; then
        AddError "sigkill-resume $interruptStage topology teardown failed"
        failed=1
    fi
    ((failed == 0))
}

RunSigkillResumeMode() {
    local mode="sigkill-resume"
    local modeRoot="$RUN_ROOT/modes/sigkill-resume"
    local failed=0 controlFault="$modeRoot/evidence/fault-matrix.json" deployAsset controlRolloutId
    local controlTopologyStarted=0
    deployAsset="$(jq -er '.assets.deployScenario' "$RESOLVED_PLAN")" || return 1
    controlRolloutId="$(DeriveRolloutId normal "$mode-deploy" "$TARGET_RELEASE")" || return 1
    mkdir -p "$modeRoot/evidence" "$modeRoot/logs" "$modeRoot/states"

    if ! RunFaultMatrix "$modeRoot" deploy deploy "$controlFault" "$controlRolloutId"; then
        AddError "$mode control fault matrix failed"
        failed=1
    fi
    if [[ -f "$controlFault" ]] && ! RunMigrationQualificationDrill "$modeRoot" deploy blue \
        "$SOURCE_MANIFEST" "$TARGET_MANIFEST" "$TARGET_RELEASE" "$deployAsset" "$controlFault"; then
        failed=1
    fi
    if [[ -f "$controlFault" ]] && ! RunWorkerQualificationDrill "$modeRoot" deploy blue \
        "$SOURCE_MANIFEST" "$TARGET_MANIFEST" "$TARGET_RELEASE" "$deployAsset" "$controlFault" resume; then
        failed=1
    fi
    if [[ -f "$controlFault" ]]; then
        if ! PrepareTopology "$modeRoot/topology" blue "$SOURCE_MANIFEST"; then
            AddError "$mode fresh control topology startup failed"
            failed=1
        else
            controlTopologyStarted=1
            if ! RunSuccessRollout "$modeRoot" deploy "$TARGET_MANIFEST" "$deployAsset" "$controlFault" deploy; then
                AddError "$mode fresh uninterrupted control rollout failed"
                failed=1
            fi
        fi
    fi
    if [[ -f "$modeRoot/states/deploy-rollout.json" ]] &&
        ! FinalizeWorkerQualification "$modeRoot" deploy "$modeRoot/states/deploy-rollout.json"; then
        failed=1
    fi
    if ((controlTopologyStarted == 1)) && ! TeardownTopology "$modeRoot/topology"; then
        AddError "$mode fresh control topology teardown failed"
        failed=1
    fi

    local interruptStage
    while IFS= read -r interruptStage; do
        [[ -n "$interruptStage" ]] || continue
        RunSigkillInterruption "$modeRoot" "$interruptStage" "$deployAsset" || failed=1
    done < <(jq -er '.hostInterruption.stages[]' "$RESOLVED_PLAN")

    if ! RunLogged "$modeRoot/logs" sigkill-matrix node "$PLAN_TOOL" sigkill-matrix \
        --mode-root "$modeRoot" --out "$modeRoot/evidence/sigkill-resume.json"; then
        AddError "$mode late-stage SIGKILL matrix sealing failed"
        failed=1
    fi
    VerifyMode "$modeRoot" "$mode" || {
        AddError "$mode semantic verification failed"
        failed=1
    }
    ((failed == 0))
}

Log "run=$RUN_ID modes=${REQUESTED_MODES[*]} root=$RUN_ROOT"
for requested_mode in "${REQUESTED_MODES[@]}"; do
    Log "mode=$requested_mode status=starting"
    case "$requested_mode" in
        normal | post-switch-rollback)
            RunNormalLikeMode "$requested_mode" || AddError "$requested_mode mode failed"
            ;;
        explicit-rollback)
            RunExplicitRollbackMode || AddError "explicit-rollback mode failed"
            ;;
        sigkill-resume)
            RunSigkillResumeMode || AddError "sigkill-resume mode failed"
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
if ((${#OVERALL_ERRORS[@]} > 0)); then
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
Log "status=pass summary=$RUN_ROOT/evidence/rehearsal-summary.json"

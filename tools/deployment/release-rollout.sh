#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

RELEASE_MANIFEST=""
ROLLOUT_STATE_FILE="${FSUSBLOG_ROLLOUT_STATE_FILE:-}"
ROLLOUT_EVIDENCE_ROOT="${FSUSBLOG_ROLLOUT_EVIDENCE_ROOT:-/var/lib/fsusblog/deployment/rollouts}"
BACKUP_RESTORE_EVIDENCE="${FSUSBLOG_BACKUP_RESTORE_EVIDENCE:-}"
MIGRATION_SERVER_DLL="${FSUSBLOG_MIGRATION_SERVER_DLL:-}"
PRODUCTION_BUILD_RECEIPT="${FSUSBLOG_PRODUCTION_BUILD_RECEIPT_HOST_PATH:-}"
TRAFFIC_SCENARIO="${FSUSBLOG_ROLLOUT_TRAFFIC_SCENARIO:-}"
TRAFFIC_BINDING_KEY_FILE="${FSUSBLOG_ROLLOUT_TRAFFIC_BINDING_KEY_FILE:-}"
NOTIFICATION_AUTH_STORAGE_STATE="${FSUSBLOG_ROLLOUT_NOTIFICATION_AUTH_STORAGE_STATE:-}"
NOTIFICATION_RESYNC_SCENARIO="${FSUSBLOG_ROLLOUT_NOTIFICATION_RESYNC_SCENARIO:-}"
NOTIFICATION_EVIDENCE="${FSUSBLOG_ROLLOUT_NOTIFICATION_EVIDENCE:-}"
ASSET_COMPATIBILITY_EVIDENCE="${FSUSBLOG_ROLLOUT_ASSET_COMPATIBILITY_EVIDENCE:-}"
ASSET_COMPATIBILITY_SCENARIO="${FSUSBLOG_ROLLOUT_ASSET_COMPATIBILITY_SCENARIO:-}"
ASSET_BROWSER_BINDING_KEY_FILE="${FSUSBLOG_ROLLOUT_ASSET_BROWSER_BINDING_KEY_FILE:-}"
WORKER_RECONCILIATION_EVIDENCE="${FSUSBLOG_ROLLOUT_WORKER_RECONCILIATION_EVIDENCE:-${FSUSBLOG_ROLLOUT_NORMAL_WORKER_RECONCILIATION:-}}"
WORKER_EVENT_LEDGER="${FSUSBLOG_ROLLOUT_WORKER_EVENT_LEDGER:-${FSUSBLOG_ROLLOUT_NORMAL_WORKER_LEDGER:-}}"
RESOURCE_BUDGET_EVIDENCE="${FSUSBLOG_ROLLOUT_RESOURCE_BUDGET_EVIDENCE:-}"
FAULT_INJECTION_EVIDENCE="${FSUSBLOG_ROLLOUT_FAULT_INJECTION_EVIDENCE:-}"
CHALLENGE_KIND_TARGET_MAP="${FSUSBLOG_CHALLENGE_KIND_CUTOVER_TARGET_MAP:-}"
PERCEPTION_V3_RELEASE_TARGET="${FSUSBLOG_PERCEPTION_V3_RELEASE_TARGET:-}"
PERCEPTION_V3_POOL_MANIFEST="${FSUSBLOG_PERCEPTION_V3_POOL_MANIFEST:-}"
PERCEPTION_V3_POLICY_VERSION="${FSUSBLOG_PERCEPTION_V3_POLICY_VERSION:-}"
OPERATOR_NOTE_FILE="${FSUSBLOG_ROLLOUT_OPERATOR_NOTE:-}"
OPERATOR_NOTE_EXPLICIT=0
[[ -z "$OPERATOR_NOTE_FILE" ]] || OPERATOR_NOTE_EXPLICIT=1
PUBLIC_PROBE_URL="${FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL:-}"
PUBLIC_BASE_URL=""
ADMIN_HEADER_FILE="${FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE:-}"
CONTROL_ORIGIN="${FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN:-}"
ASSET_STORE="${FSUSBLOG_RELEASE_ASSET_STORE:-/var/lib/fsusblog/release-assets}"
RETENTION_STATE="${FSUSBLOG_RELEASE_RETENTION_STATE:-}"
DRY_RUN=0
NO_SWITCH=0
ROLLBACK=0
RESUME=0
TRAFFIC_PID=""
RESOURCE_PID=""
NOTIFICATION_PID=""
ASSET_COMPATIBILITY_PID=""
TRAFFIC_ADOPTED=0
RESOURCE_ADOPTED=0
NOTIFICATION_ADOPTED=0
ASSET_COMPATIBILITY_ADOPTED=0
PRESERVE_BACKGROUND_PROBES_ON_EXIT=0
ROLLOUT_ID=""
REQUESTED_ROLLOUT_ID="${FSUSBLOG_ROLLOUT_ID:-}"
SOURCE_SLOT=""
SOURCE_RELEASE=""
SOURCE_DIGEST=""
SOURCE_GENERATION=0
TARGET_SLOT=""
TARGET_RELEASE=""
TARGET_DIGEST=""
TARGET_GENERATION=0
TARGET_PORT=0
SOURCE_PORT=0
EVIDENCE_DIR=""
TRAFFIC_SNAPSHOT=""
TRAFFIC_FINAL=""
TRAFFIC_STOP_FILE=""
FINAL_EVIDENCE=""
PRESEAL_EVIDENCE=""
RESOURCE_SNAPSHOT=""
RESOURCE_STOP_FILE=""
NOTIFICATION_SNAPSHOT=""
NOTIFICATION_STOP_FILE=""
ASSET_COMPATIBILITY_CHECKPOINT=""
ASSET_COMPATIBILITY_READY_FILE=""
ASSET_COMPATIBILITY_SWITCH_FILE=""
ASSET_COMPATIBILITY_GC_REVIEWED=""
ASSET_COMPATIBILITY_GC_FILE=""
ASSET_COMPATIBILITY_GC_EVIDENCE=""
TARGET_HEALTH_EVIDENCE="${FSUSBLOG_ROLLOUT_NORMAL_WORKER_TARGET_HEALTH:-}"
TRAFFIC_PID_FILE=""
RESOURCE_PID_FILE=""
NOTIFICATION_PID_FILE=""
ASSET_COMPATIBILITY_PID_FILE=""

Usage() {
    cat <<'USAGE'
Usage: tools/deployment/release-rollout.sh --release-manifest <file> [options]

This is the only supported production rollout entry. It serializes and persists:
  immutable manifest -> capacity/backup/Expand -> assets -> isolated candidate/smoke/compatibility
  -> provisional gateway switch -> source drain + legacy cutover -> active fence activation -> public verification -> source stop -> evidence seal

Required evidence/configuration:
  --release-manifest <file>           Immutable CI release manifest.
  --backup-restore-evidence <file>    Recent successful real restore drill.
  --migration-server-dll <file>       Exact target FsusBlog.Server.dll migration runner.
  --production-build-receipt <file>   Exact sealed CI receipt beside its immutable artifact domains.
  --traffic-scenario <file>           Full HTTP scenario including auth/write/upload/admin read.
  --traffic-binding-key-file <file>   Mode 0400/0600 key for final traffic evidence HMAC verification.
  --notification-evidence <file>      Cross-switch guest/auth event reconciliation evidence.
  --notification-resync-scenario <file> Real guest/auth full-state snapshot and watermark contract.
  --asset-compatibility-evidence <file> Old hashed asset and Service Worker drill evidence.
  --asset-compatibility-scenario <file> Automatic N/N-1 asset drill scenario; generates the evidence above.
  --asset-browser-binding-key-file <file> Mode 0400/0600 key for controlled-browser evidence binding.
  --worker-reconciliation-evidence <file> Background side-effect reconciliation evidence.
  --worker-ledger <file>               Live eight-kind normal-rollout worker ledger input.
  --resource-budget-evidence <file>   Dual-slot resource budget evidence.
  --fault-injection-evidence <file>   Automated rollout fault matrix evidence.
  --challenge-kind-target-map <file> Independent numeric-to-wire JSON target map for the mandatory cutover.
  --perception-v3-release-target <file> Generated backend/shared/frontend V3 target map.
  --perception-v3-pool-manifest <file> Exact active immutable V3 pool manifest.
  --perception-v3-policy-version <id> Exact active RiskControl policy snapshot version.

Modes:
  --dry-run       Validate immutable inputs/state and print the exact ordered plan without mutation.
  --no-switch     Start, materialize and verify the candidate; do not mutate public traffic/fence.
  --rollback      Roll out the manifest that exactly matches the durable previous slot/release.
  --resume        Resume an existing durable rollout state after stage-specific recovery.

Paths/config:
  --env-file <file> --slot-state-file <file> --rollout-state-file <file>
  --rollout-id <id> --evidence-root <dir> --public-url <https /health/ready URL>
  --admin-header-file <0400|0600 file> --control-origin <https origin>
  --asset-store <dir> --retention-state <file> [--operator-note <structured JSON file>]

Safety-critical gates cannot be skipped. A failed stage records evidence and compensation state;
the active slot is never stopped by generic cleanup or an abnormal script exit.
USAGE
}

RolloutLog() {
    printf '[release-rollout] %s\n' "$1"
}

RolloutFail() {
    printf '[release-rollout] fatal: %s\n' "$1" >&2
    exit "${2:-1}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --release-manifest)
            [[ $# -ge 2 ]] || RolloutFail "--release-manifest requires a path"
            RELEASE_MANIFEST="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || RolloutFail "--env-file requires a path"
            PRODUCTION_ENV_FILE="$2"
            shift 2
            ;;
        --slot-state-file)
            [[ $# -ge 2 ]] || RolloutFail "--slot-state-file requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        --rollout-state-file)
            [[ $# -ge 2 ]] || RolloutFail "--rollout-state-file requires a path"
            ROLLOUT_STATE_FILE="$2"
            shift 2
            ;;
        --rollout-id)
            [[ $# -ge 2 ]] || RolloutFail "--rollout-id requires a value"
            REQUESTED_ROLLOUT_ID="$2"
            shift 2
            ;;
        --evidence-root)
            [[ $# -ge 2 ]] || RolloutFail "--evidence-root requires a path"
            ROLLOUT_EVIDENCE_ROOT="$2"
            shift 2
            ;;
        --backup-restore-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--backup-restore-evidence requires a path"
            BACKUP_RESTORE_EVIDENCE="$2"
            shift 2
            ;;
        --migration-server-dll)
            [[ $# -ge 2 ]] || RolloutFail "--migration-server-dll requires a path"
            MIGRATION_SERVER_DLL="$2"
            shift 2
            ;;
        --production-build-receipt)
            [[ $# -ge 2 ]] || RolloutFail "--production-build-receipt requires a path"
            PRODUCTION_BUILD_RECEIPT="$2"
            shift 2
            ;;
        --traffic-scenario)
            [[ $# -ge 2 ]] || RolloutFail "--traffic-scenario requires a path"
            TRAFFIC_SCENARIO="$2"
            shift 2
            ;;
        --traffic-binding-key-file)
            [[ $# -ge 2 ]] || RolloutFail "--traffic-binding-key-file requires a path"
            TRAFFIC_BINDING_KEY_FILE="$2"
            shift 2
            ;;
        --notification-auth-storage-state)
            [[ $# -ge 2 ]] || RolloutFail "--notification-auth-storage-state requires a path"
            NOTIFICATION_AUTH_STORAGE_STATE="$2"
            shift 2
            ;;
        --notification-resync-scenario)
            [[ $# -ge 2 ]] || RolloutFail "--notification-resync-scenario requires a path"
            NOTIFICATION_RESYNC_SCENARIO="$2"
            shift 2
            ;;
        --notification-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--notification-evidence requires a path"
            NOTIFICATION_EVIDENCE="$2"
            shift 2
            ;;
        --asset-compatibility-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--asset-compatibility-evidence requires a path"
            ASSET_COMPATIBILITY_EVIDENCE="$2"
            shift 2
            ;;
        --asset-compatibility-scenario)
            [[ $# -ge 2 ]] || RolloutFail "--asset-compatibility-scenario requires a path"
            ASSET_COMPATIBILITY_SCENARIO="$2"
            shift 2
            ;;
        --asset-browser-binding-key-file)
            [[ $# -ge 2 ]] || RolloutFail "--asset-browser-binding-key-file requires a path"
            ASSET_BROWSER_BINDING_KEY_FILE="$2"
            shift 2
            ;;
        --worker-reconciliation-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--worker-reconciliation-evidence requires a path"
            WORKER_RECONCILIATION_EVIDENCE="$2"
            shift 2
            ;;
        --worker-ledger)
            [[ $# -ge 2 ]] || RolloutFail "--worker-ledger requires a path"
            WORKER_EVENT_LEDGER="$2"
            shift 2
            ;;
        --resource-budget-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--resource-budget-evidence requires a path"
            RESOURCE_BUDGET_EVIDENCE="$2"
            shift 2
            ;;
        --fault-injection-evidence)
            [[ $# -ge 2 ]] || RolloutFail "--fault-injection-evidence requires a path"
            FAULT_INJECTION_EVIDENCE="$2"
            shift 2
            ;;
        --challenge-kind-target-map)
            [[ $# -ge 2 ]] || RolloutFail "--challenge-kind-target-map requires a path"
            CHALLENGE_KIND_TARGET_MAP="$2"
            shift 2
            ;;
        --perception-v3-release-target)
            [[ $# -ge 2 ]] || RolloutFail "--perception-v3-release-target requires a path"
            PERCEPTION_V3_RELEASE_TARGET="$2"
            shift 2
            ;;
        --perception-v3-pool-manifest)
            [[ $# -ge 2 ]] || RolloutFail "--perception-v3-pool-manifest requires a path"
            PERCEPTION_V3_POOL_MANIFEST="$2"
            shift 2
            ;;
        --perception-v3-policy-version)
            [[ $# -ge 2 ]] || RolloutFail "--perception-v3-policy-version requires a value"
            PERCEPTION_V3_POLICY_VERSION="$2"
            shift 2
            ;;
        --public-url)
            [[ $# -ge 2 ]] || RolloutFail "--public-url requires a URL"
            PUBLIC_PROBE_URL="$2"
            shift 2
            ;;
        --admin-header-file)
            [[ $# -ge 2 ]] || RolloutFail "--admin-header-file requires a path"
            ADMIN_HEADER_FILE="$2"
            shift 2
            ;;
        --control-origin)
            [[ $# -ge 2 ]] || RolloutFail "--control-origin requires an origin"
            CONTROL_ORIGIN="$2"
            shift 2
            ;;
        --asset-store)
            [[ $# -ge 2 ]] || RolloutFail "--asset-store requires a path"
            ASSET_STORE="$2"
            shift 2
            ;;
        --retention-state)
            [[ $# -ge 2 ]] || RolloutFail "--retention-state requires a path"
            RETENTION_STATE="$2"
            shift 2
            ;;
        --operator-note)
            [[ $# -ge 2 ]] || RolloutFail "--operator-note requires a path"
            OPERATOR_NOTE_FILE="$2"
            OPERATOR_NOTE_EXPLICIT=1
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --no-switch)
            NO_SWITCH=1
            shift
            ;;
        --rollback)
            ROLLBACK=1
            shift
            ;;
        --resume)
            RESUME=1
            shift
            ;;
        -h | --help)
            Usage
            exit 0
            ;;
        *) RolloutFail "unknown argument: $1" ;;
    esac
done

[[ -n "$RELEASE_MANIFEST" ]] || RolloutFail "--release-manifest is required"
[[ -f "$RELEASE_MANIFEST" ]] || RolloutFail "release manifest not found: $RELEASE_MANIFEST"
[[ "$NO_SWITCH" == "0" || "$ROLLBACK" == "0" ]] || RolloutFail "--no-switch and --rollback are mutually exclusive"
[[ "$DRY_RUN" == "0" || "$RESUME" == "0" ]] || RolloutFail "--dry-run cannot resume mutable state"
[[ -z "$REQUESTED_ROLLOUT_ID" || "$REQUESTED_ROLLOUT_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$ ]] ||
    RolloutFail "--rollout-id is invalid"
[[ "$PUBLIC_PROBE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/health/ready$ ]] ||
    { [[ "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" && "$PUBLIC_PROBE_URL" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/health/ready$ ]] ||
        RolloutFail "public URL must be an explicit HTTPS /health/ready URL"; }
PUBLIC_BASE_URL="${PUBLIC_PROBE_URL%/health/ready}"
[[ -n "$CONTROL_ORIGIN" ]] || CONTROL_ORIGIN="$PUBLIC_BASE_URL"

for command in awk curl date flock jq node realpath stat tr; do
    SlotRequireCommand "$command"
done

ReadInitialState() {
    local state
    if [[ "$RESUME" == "1" ]]; then
        [[ -n "$ROLLOUT_STATE_FILE" ]] || RolloutFail "--resume requires an explicit --rollout-state-file"
        [[ -f "$ROLLOUT_STATE_FILE" ]] || RolloutFail "--resume state is missing: $ROLLOUT_STATE_FILE"
        state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")" ||
            RolloutFail "unable to read durable rollout state"
        ROLLOUT_ID="$(jq -r '.rolloutId' <<<"$state")"
        [[ -z "$REQUESTED_ROLLOUT_ID" || "$REQUESTED_ROLLOUT_ID" == "$ROLLOUT_ID" ]] ||
            RolloutFail "--rollout-id does not match the durable resume state"
        SOURCE_SLOT="$(jq -r '.source.slot' <<<"$state")"
        SOURCE_RELEASE="$(jq -r '.source.releaseId' <<<"$state")"
        SOURCE_DIGEST="$(jq -r '.source.imageDigest' <<<"$state")"
        SOURCE_GENERATION="$(jq -r '.source.runtimeGeneration' <<<"$state")"
        TARGET_SLOT="$(jq -r '.target.slot' <<<"$state")"
        TARGET_RELEASE="$(jq -r '.target.releaseId' <<<"$state")"
        TARGET_DIGEST="$(jq -r '.target.imageDigest' <<<"$state")"
        TARGET_GENERATION="$(jq -r '.target.runtimeGeneration' <<<"$state")"
        [[ "$(jq -r '.kind' <<<"$state")" == "rollback" ]] && ROLLBACK=1
        SlotRequire "$SOURCE_SLOT"
        SlotRequire "$TARGET_SLOT"
        node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
            --manifest "$RELEASE_MANIFEST" --slot "$TARGET_SLOT" \
            --release-id "$TARGET_RELEASE" --image-digest "$TARGET_DIGEST" >/dev/null ||
            RolloutFail "resume manifest does not match the durable rollout target"
        ConfigureRolloutPaths
        return
    fi

    state="$(SlotStateReadCurrent)" || RolloutFail "unable to read durable slot state"
    [[ "$(jq -r '.status' <<<"$state")" == "stable" ]] || RolloutFail "gateway state is not stable; recover it before rollout"
    SOURCE_SLOT="$(jq -r '.activeSlot // ""' <<<"$state")"
    SOURCE_RELEASE="$(jq -r '.activeReleaseId // ""' <<<"$state")"
    SOURCE_DIGEST="$(jq -r '.activeImageDigest // ""' <<<"$state")"
    SOURCE_GENERATION="$(jq -r --arg slot "$SOURCE_SLOT" '.slots[$slot].deploymentGeneration // 0' <<<"$state")"
    SlotRequire "$SOURCE_SLOT"
    node "$ROOT_DIR/tools/release/release-id.mjs" validate "$SOURCE_RELEASE" >/dev/null ||
        RolloutFail "active release identity is invalid"
    [[ "$SOURCE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || RolloutFail "active image digest is invalid"
    [[ "$SOURCE_GENERATION" =~ ^[0-9]+$ && "$SOURCE_GENERATION" -ge 1 ]] || RolloutFail "active runtime generation is invalid"

    if [[ "$ROLLBACK" == "1" ]]; then
        TARGET_SLOT="$(jq -r '.previousSlot // ""' <<<"$state")"
    else
        TARGET_SLOT="$([[ "$SOURCE_SLOT" == "blue" ]] && printf green || printf blue)"
    fi
    SlotRequire "$TARGET_SLOT"

    local manifestResult
    manifestResult="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
        --manifest "$RELEASE_MANIFEST" --slot "$TARGET_SLOT")" ||
        RolloutFail "release manifest validation failed"
    TARGET_RELEASE="$(jq -r '.releaseId' <<<"$manifestResult")"
    TARGET_DIGEST="$(jq -r '.imageDigest' <<<"$manifestResult")"
    [[ "$TARGET_RELEASE" != "$SOURCE_RELEASE" ]] || RolloutFail "target release must differ from active release"
    [[ "$TARGET_DIGEST" != "$SOURCE_DIGEST" ]] || RolloutFail "target digest must differ from active digest"
    if [[ "$ROLLBACK" == "1" ]]; then
        [[ "$(jq -r '.previousReleaseId' <<<"$state")" == "$TARGET_RELEASE" &&
        "$(jq -r '.previousImageDigest' <<<"$state")" == "$TARGET_DIGEST" ]] ||
            RolloutFail "rollback manifest does not exactly match the durable previous release"
    fi

    ROLLOUT_ID="${REQUESTED_ROLLOUT_ID:-$([[ "$ROLLBACK" == "1" ]] && printf rollback || printf deploy)-${TARGET_RELEASE}}"
    [[ -n "$ROLLOUT_STATE_FILE" ]] || ROLLOUT_STATE_FILE="$ROLLOUT_EVIDENCE_ROOT/$ROLLOUT_ID/state.json"
    ConfigureRolloutPaths
}

ConfigureRolloutPaths() {
    SOURCE_PORT="$(SlotPort "$SOURCE_SLOT")"
    TARGET_PORT="$(SlotPort "$TARGET_SLOT")"
    EVIDENCE_DIR="$ROLLOUT_EVIDENCE_ROOT/$ROLLOUT_ID/evidence"
    TRAFFIC_SNAPSHOT="$EVIDENCE_DIR/public-traffic.snapshot.json"
    TRAFFIC_FINAL="$EVIDENCE_DIR/public-traffic.json"
    TRAFFIC_STOP_FILE="$EVIDENCE_DIR/public-traffic.stop"
    FINAL_EVIDENCE="$EVIDENCE_DIR/release-rollout.json"
    PRESEAL_EVIDENCE="$EVIDENCE_DIR/release-rollout-preseal.json"
    RESOURCE_SNAPSHOT="$EVIDENCE_DIR/resource-budget.snapshot.json"
    RESOURCE_STOP_FILE="$EVIDENCE_DIR/resource-budget.stop"
    NOTIFICATION_SNAPSHOT="$EVIDENCE_DIR/notification-stream.snapshot.json"
    NOTIFICATION_STOP_FILE="$EVIDENCE_DIR/notification-stream.stop"
    ASSET_COMPATIBILITY_CHECKPOINT="$EVIDENCE_DIR/asset-compatibility.checkpoint.json"
    ASSET_COMPATIBILITY_READY_FILE="$EVIDENCE_DIR/asset-compatibility.ready.json"
    ASSET_COMPATIBILITY_SWITCH_FILE="$EVIDENCE_DIR/asset-compatibility.switched.json"
    ASSET_COMPATIBILITY_GC_REVIEWED="$EVIDENCE_DIR/asset-gc-dry-run.json"
    ASSET_COMPATIBILITY_GC_FILE="$EVIDENCE_DIR/asset-compatibility.gc-complete.json"
    ASSET_COMPATIBILITY_GC_EVIDENCE="$EVIDENCE_DIR/asset-gc.json"
    [[ -n "$TARGET_HEALTH_EVIDENCE" ]] || TARGET_HEALTH_EVIDENCE="$EVIDENCE_DIR/target-health.json"
    TRAFFIC_PID_FILE="$EVIDENCE_DIR/public-traffic.pid"
    RESOURCE_PID_FILE="$EVIDENCE_DIR/resource-budget.pid"
    NOTIFICATION_PID_FILE="$EVIDENCE_DIR/notification-stream.pid"
    ASSET_COMPATIBILITY_PID_FILE="$EVIDENCE_DIR/asset-compatibility.pid"
    [[ -n "$RESOURCE_BUDGET_EVIDENCE" ]] || RESOURCE_BUDGET_EVIDENCE="$EVIDENCE_DIR/resource-budget.json"
    [[ -n "$WORKER_RECONCILIATION_EVIDENCE" ]] || WORKER_RECONCILIATION_EVIDENCE="$EVIDENCE_DIR/worker-reconciliation.json"
    if [[ -n "$NOTIFICATION_AUTH_STORAGE_STATE" && -z "$NOTIFICATION_EVIDENCE" ]]; then
        NOTIFICATION_EVIDENCE="$EVIDENCE_DIR/notification-stream.json"
    fi
    if [[ -n "$ASSET_COMPATIBILITY_SCENARIO" && -z "$ASSET_COMPATIBILITY_EVIDENCE" ]]; then
        ASSET_COMPATIBILITY_EVIDENCE="$EVIDENCE_DIR/asset-compatibility.json"
    fi
    [[ -n "$OPERATOR_NOTE_FILE" ]] || OPERATOR_NOTE_FILE="$EVIDENCE_DIR/operator-note.json"
}

AdoptProbePid() {
    local pidFile="$1" expectedScript="$2" expectedAnchor="$3" pid commandLine
    [[ -f "$pidFile" ]] || return 1
    pid="$(<"$pidFile")"
    [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || {
        rm -f "$pidFile"
        return 1
    }
    commandLine="$(tr '\0' '\n' <"/proc/$pid/cmdline")"
    [[ "$commandLine" == *"$expectedScript"* && "$commandLine" == *"$expectedAnchor"* ]] ||
        {
            rm -f "$pidFile"
            return 1
        }
    printf '%s\n' "$pid"
}

RecordProbePid() {
    local pidFile="$1" pid="$2" temporary="${1}.tmp-$$"
    printf '%s\n' "$pid" >"$temporary"
    mv -f "$temporary" "$pidFile"
}

FinalProbeArtifactMatches() {
    local file="$1" schema="$2"
    [[ -f "$file" ]] || return 1
    jq -e --arg schema "$schema" --arg rolloutId "$ROLLOUT_ID" '
    .schema == $schema
    and .status == "pass"
    and .rolloutId == $rolloutId
    and (.errors | type == "array" and length == 0)
  ' "$file" >/dev/null 2>&1
}

TrafficProbeArtifactMatches() {
    local file="$1"
    [[ -f "$file" && -f "$TRAFFIC_SCENARIO" && -f "$TRAFFIC_BINDING_KEY_FILE" ]] || return 1
    node "$ROOT_DIR/tools/deployment/release-traffic-evidence-verify.mjs" \
        --evidence "$file" \
        --scenario "$TRAFFIC_SCENARIO" \
        --binding-key-file "$TRAFFIC_BINDING_KEY_FILE" \
        --rollout-id "$ROLLOUT_ID" >/dev/null 2>&1
}

AssetCompatibilityArtifactMatches() {
    local file="$1"
    [[ -f "$file" && -f "$ASSET_COMPATIBILITY_SCENARIO" && -f "$ASSET_BROWSER_BINDING_KEY_FILE" ]] || return 1
    node "$ROOT_DIR/tools/deployment/release-asset-compatibility-evidence-verify.mjs" \
        --evidence "$file" \
        --scenario "$ASSET_COMPATIBILITY_SCENARIO" \
        --binding-key-file "$ASSET_BROWSER_BINDING_KEY_FILE" \
        --rollout-id "$ROLLOUT_ID" >/dev/null 2>&1
}

NotificationProbeArtifactMatches() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    jq -e --arg rolloutId "$ROLLOUT_ID" '
    .schema == "fsusblog.release-notification-stream-evidence.v1"
    and .contractVersion == 2
    and .status == "pass"
    and .rolloutId == $rolloutId
    and .serviceRestartObserved == true
    and .cursorReplayVerified == true
    and .replayMissFullResyncVerified == true
    and .businessEventsExactlyOnce == true
    and .slowClientDidNotBlockDrain == true
    and .missingEventCount == 0
    and .duplicateAppliedEventCount == 0
    and .duplicateBusinessEventCount == 0
    and (.inputBindings.resyncScenario.sha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    and ([.resync[]?[]? | select(.phase == "replay-miss" and .status == "pass" and (.watermark | type == "number") and (.contentSha256 | test("^sha256:[0-9a-f]{64}$")))] | length >= 2)
    and ([.resync[]?[]? | select(.phase == "final" and .status == "pass" and (.watermark | type == "number") and (.contentSha256 | test("^sha256:[0-9a-f]{64}$")))] | length >= 2)
    and (.errors | type == "array" and length == 0)
  ' "$file" >/dev/null 2>&1
}

ContinuousProbeArtifactsReady() {
    TrafficProbeArtifactMatches "$TRAFFIC_FINAL" &&
        NotificationProbeArtifactMatches "$NOTIFICATION_EVIDENCE" &&
        FinalProbeArtifactMatches "$RESOURCE_BUDGET_EVIDENCE" "fsusblog.release-resource-budget-evidence.v1"
}

RequireContinuousProbeArtifacts() {
    ContinuousProbeArtifactsReady ||
        RolloutFail "final traffic, notification and resource evidence must be successful and bound to rollout $ROLLOUT_ID before source stop"
}

RolloutStageCompleted() {
    local stage="$1"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE" |
        jq -e --arg stage "$stage" '.completedStages | index($stage) != null' >/dev/null
}

RehearsalStageHold() {
    local stage="$1" requested="${FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_STAGE:-}"
    [[ -n "$requested" && "$requested" == "$stage" ]] || return 0
    [[ "${FSUSBLOG_ROLLOUT_REHEARSAL:-0}" == "1" &&
        "${ASPNETCORE_ENVIRONMENT:-}" == "Test" &&
        "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" ]] ||
        RolloutFail "rehearsal stage hold is permitted only in the explicit Test loopback rehearsal"
    local readyFile="${FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_READY_FILE:-}"
    local releaseFile="${FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_RELEASE_FILE:-}"
    local timeoutSeconds="${FSUSBLOG_ROLLOUT_REHEARSAL_HOLD_TIMEOUT_SECONDS:-120}"
    [[ -n "$readyFile" && -n "$releaseFile" ]] || RolloutFail "rehearsal stage hold requires ready and release files"
    [[ "$timeoutSeconds" =~ ^[0-9]+$ && "$timeoutSeconds" -ge 1 && "$timeoutSeconds" -le 300 ]] ||
        RolloutFail "rehearsal stage hold timeout must be 1..300 seconds"
    readyFile="$(realpath -m "$readyFile")"
    releaseFile="$(realpath -m "$releaseFile")"
    local rehearsalRoot
    rehearsalRoot="$(realpath -m "$ROOT_DIR/.tmp")"
    local controlledPath
    for controlledPath in "$ROLLOUT_STATE_FILE" "$EVIDENCE_DIR" "$readyFile" "$releaseFile"; do
        [[ "$controlledPath" == "$rehearsalRoot/"* ]] ||
            RolloutFail "rehearsal stage hold paths must stay under repository .tmp"
    done
    mkdir -p "$(dirname "$readyFile")" "$(dirname "$releaseFile")"
    rm -f "$readyFile" "$releaseFile"
    local temporary="${readyFile}.tmp-$$"
    jq -n --arg rolloutId "$ROLLOUT_ID" --arg stage "$stage" --arg readyAtUtc "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '
    {schema:"fsusblog.release-rollout-rehearsal-stage-hold.v1",status:"ready",rolloutId:$rolloutId,stage:$stage,readyAtUtc:$readyAtUtc,errors:[]}
  ' >"$temporary"
    mv -f "$temporary" "$readyFile"
    local deadline=$((SECONDS + timeoutSeconds))
    while true; do
        if [[ -f "$releaseFile" ]] && jq -e --arg rolloutId "$ROLLOUT_ID" --arg stage "$stage" '
      .schema == "fsusblog.release-rollout-rehearsal-stage-release.v1"
      and .rolloutId == $rolloutId and .stage == $stage and .release == true
    ' "$releaseFile" >/dev/null 2>&1; then
            rm -f "$readyFile" "$releaseFile"
            return 0
        fi
        ((SECONDS < deadline)) || RolloutFail "rehearsal stage hold timed out for $stage"
        sleep 0.01
    done
}

WaitForAdoptedProbe() {
    local pid="$1" timeoutSeconds="${FSUSBLOG_ROLLOUT_PROBE_STOP_TIMEOUT_SECONDS:-900}" deadline
    [[ "$timeoutSeconds" =~ ^[0-9]+$ && "$timeoutSeconds" -ge 1 && "$timeoutSeconds" -le 1800 ]] || return 1
    deadline=$((SECONDS + timeoutSeconds))
    while kill -0 "$pid" >/dev/null 2>&1; do
        ((SECONDS < deadline)) || return 1
        sleep 0.1
    done
}

SlotPort() {
    local slot="$1"
    if [[ "$slot" == "blue" ]]; then
        printf '%s\n' "${FSUSBLOG_BLUE_PORT:-8081}"
    else
        printf '%s\n' "${FSUSBLOG_GREEN_PORT:-8082}"
    fi
}

PrintDryRun() {
    local state plannedGeneration
    state="$(SlotStateReadCurrent)"
    plannedGeneration="$(($(jq -r '.runtimeGeneration' <<<"$state") + 1))"
    jq -cn \
        --arg rolloutId "$ROLLOUT_ID" \
        --arg kind "$([[ "$ROLLBACK" == "1" ]] && printf rollback || printf deploy)" \
        --arg manifest "$(realpath "$RELEASE_MANIFEST")" \
        --arg sourceSlot "$SOURCE_SLOT" --arg sourceRelease "$SOURCE_RELEASE" --arg sourceDigest "$SOURCE_DIGEST" \
        --arg targetSlot "$TARGET_SLOT" --arg targetRelease "$TARGET_RELEASE" --arg targetDigest "$TARGET_DIGEST" \
        --arg stateFile "$ROLLOUT_STATE_FILE" \
        --argjson sourceGeneration "$SOURCE_GENERATION" \
        --argjson targetGeneration "$plannedGeneration" \
        --argjson noSwitch "$([[ "$NO_SWITCH" == "1" ]] && printf true || printf false)" \
        --argjson stages "$(printf '%s\n' manifest-validate capacity-preflight backup-restore-gate expand-migration asset-materialize candidate-start candidate-readiness candidate-smoke compatibility-smoke gateway-switch source-drain active-fence public-verify source-stop release-evidence | jq -R . | jq -s .)" '
    {
      schema: "fsusblog.release-rollout-plan.v1",
      status: "dry-run",
      rolloutId: $rolloutId,
      kind: $kind,
      manifest: $manifest,
      stateFile: $stateFile,
      source: {slot: $sourceSlot, releaseId: $sourceRelease, imageDigest: $sourceDigest, generation: $sourceGeneration},
      target: {slot: $targetSlot, releaseId: $targetRelease, imageDigest: $targetDigest, generation: $targetGeneration},
      candidateOnly: $noSwitch,
      stages: (if $noSwitch then $stages[0:9] else $stages end),
      safety: {exclusiveHostLock: true, immutableDigest: true, activeSlotCleanupForbidden: true, criticalGatesSkippable: false}
    }'
}

RequireRuntimeInputs() {
    for entry in \
        "backup restore evidence:$BACKUP_RESTORE_EVIDENCE" \
        "migration server DLL:$MIGRATION_SERVER_DLL" \
        "production build receipt:$PRODUCTION_BUILD_RECEIPT" \
        "traffic scenario:$TRAFFIC_SCENARIO" \
        "traffic binding key:$TRAFFIC_BINDING_KEY_FILE" \
        "asset compatibility scenario:$ASSET_COMPATIBILITY_SCENARIO" \
        "asset browser binding key:$ASSET_BROWSER_BINDING_KEY_FILE"; do
        local label="${entry%%:*}" file="${entry#*:}"
        [[ -f "$file" ]] || RolloutFail "$label is required and must exist: ${file:-<empty>}"
    done
    [[ -f "$PRODUCTION_ENV_FILE" ]] || RolloutFail "production env file is missing: $PRODUCTION_ENV_FILE"
    [[ -f "$ADMIN_HEADER_FILE" ]] || RolloutFail "deployment admin header file is missing"
    if [[ "$NO_SWITCH" == "0" ]]; then
        [[ -f "$CHALLENGE_KIND_TARGET_MAP" ]] ||
            RolloutFail "challenge kind cutover target map is required and must exist: ${CHALLENGE_KIND_TARGET_MAP:-<empty>}"
        [[ -f "$PERCEPTION_V3_RELEASE_TARGET" ]] ||
            RolloutFail "PerceptionCharacterV3 release target is required and must exist: ${PERCEPTION_V3_RELEASE_TARGET:-<empty>}"
        [[ -f "$PERCEPTION_V3_POOL_MANIFEST" ]] ||
            RolloutFail "PerceptionCharacterV3 pool manifest is required and must exist: ${PERCEPTION_V3_POOL_MANIFEST:-<empty>}"
        [[ "$PERCEPTION_V3_POLICY_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] ||
            RolloutFail "PerceptionCharacterV3 policy version is missing or invalid"
        jq -e '
          .schema == "fsusblog.security.perception-character-v3-release-target.v1"
          and (.contractDigest | test("^[0-9a-f]{64}$"))
          and (.aedsSchemaFingerprint | test("^[0-9a-f]{64}$"))
          and (.targetFingerprint | test("^[0-9a-f]{64}$"))
        ' "$PERCEPTION_V3_RELEASE_TARGET" >/dev/null ||
            RolloutFail "PerceptionCharacterV3 release target is invalid"
        jq -e --slurpfile target "$PERCEPTION_V3_RELEASE_TARGET" '
          .schema == "fsusblog.security.perception-character-v3.pool-manifest.v1"
          and (.generationId | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
          and .contractDigest == $target[0].contractDigest
        ' "$PERCEPTION_V3_POOL_MANIFEST" >/dev/null ||
            RolloutFail "PerceptionCharacterV3 pool manifest is not bound to the release target"
        jq -e '
          type == "array" and length == 3
          and ([.[].numericKind] | (sort == [3,10,13]) and ((unique | length) == 3))
          and ([.[].wireName] | all(.[]; type == "string" and length > 0) and ((unique | length) == 3))
        ' "$CHALLENGE_KIND_TARGET_MAP" >/dev/null ||
            RolloutFail "challenge kind cutover target map must contain unique numeric kinds 3/10/13 and unique wire names"
        local challengeKindTargetFingerprint
        challengeKindTargetFingerprint="$(node --input-type=module - "$CHALLENGE_KIND_TARGET_MAP" <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const targets = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  .toSorted((left, right) => left.numericKind - right.numericKind || left.wireName.localeCompare(right.wireName, 'en'))
const canonical = targets.map((target) => `${target.numericKind}\0${target.wireName}\n`).join('')
process.stdout.write(createHash('sha256').update(canonical, 'utf8').digest('hex'))
NODE
)"
        [[ "$challengeKindTargetFingerprint" == "48e9440c0b09fcd494d11f3773d7190f703bcb1295c171c3242ea9d3ea484c19" ]] ||
            RolloutFail "challenge kind cutover target map is not the authoritative retired mapping"
    fi
    local mode
    mode="$(stat -c '%a' "$ADMIN_HEADER_FILE")"
    [[ "$mode" == "400" || "$mode" == "600" ]] || RolloutFail "deployment admin header file must have mode 0400 or 0600"
    [[ ! -L "$TRAFFIC_BINDING_KEY_FILE" ]] || RolloutFail "traffic binding key must not be a symbolic link"
    mode="$(stat -c '%a' "$TRAFFIC_BINDING_KEY_FILE")"
    [[ "$mode" == "400" || "$mode" == "600" ]] || RolloutFail "traffic binding key must have mode 0400 or 0600"
    [[ ! -L "$ASSET_BROWSER_BINDING_KEY_FILE" ]] || RolloutFail "asset browser binding key must not be a symbolic link"
    mode="$(stat -c '%a' "$ASSET_BROWSER_BINDING_KEY_FILE")"
    [[ "$mode" == "400" || "$mode" == "600" ]] || RolloutFail "asset browser binding key must have mode 0400 or 0600"
    jq -e '
    .schema == "fsusblog.release-traffic-scenario.v1"
    and (.sessionChains | type == "array" and length > 0)
    and (.releaseIdentityPolicy.schema == "fsusblog.release-traffic-release-policy.v1")
    and (.releaseIdentityPolicy.required == true)
    and (.finalBinding.schema == "fsusblog.release-traffic-final-binding-plan.v1")
    and (.finalBinding.required == true)
    and (.finalBinding.algorithm == "hmac-sha256")
    and any(.requests[]?; .holdAcrossGatewaySwitch.requireTargetResponse == true)
    and any(.requests[]?; (.responseAssertions.aeds.frameTypes | type == "array" and length > 0))
  ' "$TRAFFIC_SCENARIO" >/dev/null ||
        RolloutFail "traffic scenario must require session, AEDS, gateway hold, release identity and HMAC evidence"
    if [[ -n "$NOTIFICATION_AUTH_STORAGE_STATE" ]]; then
        [[ -f "$NOTIFICATION_AUTH_STORAGE_STATE" ]] || RolloutFail "notification auth storage state is missing"
        mode="$(stat -c '%a' "$NOTIFICATION_AUTH_STORAGE_STATE")"
        [[ "$mode" == "400" || "$mode" == "600" ]] || RolloutFail "notification auth storage state must have mode 0400 or 0600"
        [[ -f "$NOTIFICATION_RESYNC_SCENARIO" ]] || RolloutFail "notification full-state resync scenario is required"
    fi
    if [[ -n "$ASSET_COMPATIBILITY_SCENARIO" ]]; then
        [[ -f "$ASSET_COMPATIBILITY_SCENARIO" ]] || RolloutFail "asset compatibility scenario is missing"
        local assetIdentityOk
        assetIdentityOk="$(jq -r --arg source "$SOURCE_RELEASE" --arg target "$TARGET_RELEASE" '
      .schema == "fsusblog.release-asset-compatibility-scenario.v1"
      and .oldReleaseId == $source
      and .newReleaseId == $target
      and (.drillId | type == "string" and test("^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$"))
      and .browser.required == true
    ' "$ASSET_COMPATIBILITY_SCENARIO" 2>/dev/null || printf false)"
        [[ "$assetIdentityOk" == "true" ]] || RolloutFail "asset compatibility scenario is not bound to the exact source/target releases"
    fi
    mkdir -p "$ASSET_STORE/releases"
    chmod 0755 "$ASSET_STORE" "$ASSET_STORE/releases"
    [[ -n "$RETENTION_STATE" ]] || RETENTION_STATE="$ASSET_STORE/retention-state.json"
}

RecoverInterruptedStage() {
    local state stage attempt stdoutFile stderrFile evidenceFile startedAt completedAt evidenceStatus
    state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
    stage="$(jq -r '.currentStage // ""' <<<"$state")"
    [[ -n "$stage" ]] || return 0
    attempt="$(jq -r --arg stage "$stage" '[.stages[] | select(.stage == $stage)] | length' <<<"$state")"
    stdoutFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stdout"
    stderrFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stderr"
    evidenceFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.json"

    if [[ -f "$evidenceFile" ]]; then
        evidenceStatus="$(jq -r --arg rolloutId "$ROLLOUT_ID" --arg stage "$stage" '
      if .schema == "fsusblog.release-rollout-stage-evidence.v1"
        and .rolloutId == $rolloutId and .stage == $stage and (.status == "ok" or .status == "failed")
      then .status else "invalid" end
    ' "$evidenceFile" 2>/dev/null || printf invalid)"
        completedAt="$(jq -r '.completedAtUtc // empty' "$evidenceFile" 2>/dev/null || true)"
        case "$evidenceStatus" in
            ok)
                node "$ROOT_DIR/tools/deployment/rollout-state.mjs" complete-stage \
                    --state "$ROLLOUT_STATE_FILE" --stage "$stage" --evidence "$evidenceFile" --at "$completedAt" >/dev/null
                RolloutLog "resume recovered completed stage=$stage from immutable evidence"
                return 0
                ;;
            failed)
                node "$ROOT_DIR/tools/deployment/rollout-state.mjs" fail-stage \
                    --state "$ROLLOUT_STATE_FILE" --stage "$stage" --error interrupted_stage_failed \
                    --evidence "$evidenceFile" --at "$completedAt" >/dev/null
                return 0
                ;;
            *) RolloutFail "interrupted stage evidence is present but invalid: $evidenceFile" ;;
        esac
    fi

    : >>"$stdoutFile"
    : >>"$stderrFile"
    startedAt="$(jq -r '.stages[-1].startedAtUtc' <<<"$state")"
    completedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    printf '[release-rollout] prior orchestrator disappeared before stage completion was durably recorded\n' >>"$stderrFile"
    node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" stage \
        --state "$ROLLOUT_STATE_FILE" --stage "$stage" --status failed --exit-code 130 \
        --command-id host-interruption --started-at "$startedAt" --completed-at "$completedAt" \
        --stdout "$stdoutFile" --stderr "$stderrFile" --out "$evidenceFile" >/dev/null
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" fail-stage \
        --state "$ROLLOUT_STATE_FILE" --stage "$stage" --error host_interruption \
        --evidence "$evidenceFile" --at "$completedAt" >/dev/null
    RolloutLog "resume converted interrupted stage=$stage into durable recovery evidence"
}

CreateOrResumeState() {
    mkdir -p "$EVIDENCE_DIR/commands" "$EVIDENCE_DIR/recoveries"
    if [[ "$RESUME" == "1" ]]; then
        [[ -f "$ROLLOUT_STATE_FILE" ]] || RolloutFail "--resume state is missing: $ROLLOUT_STATE_FILE"
        local state
        state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
        [[ "$(jq -r --arg id "$ROLLOUT_ID" --arg target "$TARGET_RELEASE" '.rolloutId == $id and .target.releaseId == $target' <<<"$state")" == "true" ]] ||
            RolloutFail "resume state does not match the requested rollout"
        TARGET_GENERATION="$(jq -r '.target.runtimeGeneration' <<<"$state")"
        RecoverInterruptedStage
        state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
        case "$(jq -r '.status' <<<"$state")" in
            completed | candidate_ready | rolled_back | aborted) RolloutFail "rollout state is already terminal" ;;
            recovery_required)
                RecoverPendingState
                state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
                case "$(jq -r '.status' <<<"$state")" in
                    rolled_back | aborted)
                        RolloutLog "status=$(jq -r '.status' <<<"$state") rollout=$ROLLOUT_ID; start a new rollout for another attempt"
                        exit 92
                        ;;
                esac
                ;;
        esac
        return
    fi
    [[ ! -e "$ROLLOUT_STATE_FILE" ]] || RolloutFail "rollout state already exists; use --resume"
    local reservation
    reservation="$(node "$ROOT_DIR/tools/deployment/slot-state.mjs" reserve-generation \
        --state "$SLOT_STATE_FILE" --slot "$TARGET_SLOT")" ||
        RolloutFail "unable to reserve target runtime generation"
    TARGET_GENERATION="$(jq -r '.generation' <<<"$reservation")"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" create \
        --state "$ROLLOUT_STATE_FILE" \
        --rollout-id "$ROLLOUT_ID" \
        --kind "$([[ "$ROLLBACK" == "1" ]] && printf rollback || printf deploy)" \
        --manifest "$(realpath "$RELEASE_MANIFEST")" \
        --slot-state "$SLOT_STATE_FILE" \
        --source-slot "$SOURCE_SLOT" --source-release "$SOURCE_RELEASE" --source-digest "$SOURCE_DIGEST" --source-generation "$SOURCE_GENERATION" \
        --target-slot "$TARGET_SLOT" --target-release "$TARGET_RELEASE" --target-digest "$TARGET_DIGEST" --target-generation "$TARGET_GENERATION" \
        >/dev/null
}

StartPublicTraffic() {
    [[ -n "$TRAFFIC_PID" ]] && return
    if TrafficProbeArtifactMatches "$TRAFFIC_FINAL"; then
        RolloutLog "reusing immutable final public traffic evidence for rollout=$ROLLOUT_ID"
        return 0
    fi
    if TRAFFIC_PID="$(AdoptProbePid "$TRAFFIC_PID_FILE" release-traffic-probe.mjs "$ROLLOUT_STATE_FILE")"; then
        TRAFFIC_ADOPTED=1
        RolloutLog "adopted continuous public traffic probe pid=$TRAFFIC_PID"
        return
    fi
    TRAFFIC_PID=""
    TRAFFIC_ADOPTED=0
    rm -f "$TRAFFIC_STOP_FILE"
    node "$ROOT_DIR/tools/deployment/release-traffic-probe.mjs" \
        --base-url "$PUBLIC_BASE_URL" \
        --scenario "$TRAFFIC_SCENARIO" \
        --rollout-state "$ROLLOUT_STATE_FILE" \
        --snapshot "$TRAFFIC_SNAPSHOT" \
        --out "$TRAFFIC_FINAL" \
        --stop-file "$TRAFFIC_STOP_FILE" \
        --binding-key-file "$TRAFFIC_BINDING_KEY_FILE" \
        --probe-mode public-rollout \
        --concurrency "${FSUSBLOG_ROLLOUT_TRAFFIC_CONCURRENCY:-8}" \
        --interval-ms "${FSUSBLOG_ROLLOUT_TRAFFIC_INTERVAL_MS:-25}" \
        --expect-releases both \
        >"$EVIDENCE_DIR/public-traffic.process.stdout" \
        2>"$EVIDENCE_DIR/public-traffic.process.stderr" 9>&- &
    TRAFFIC_PID=$!
    TRAFFIC_ADOPTED=0
    RecordProbePid "$TRAFFIC_PID_FILE" "$TRAFFIC_PID"
}

StopPublicTraffic() {
    [[ -n "$TRAFFIC_PID" ]] || return 0
    : >"$TRAFFIC_STOP_FILE"
    local status=0
    if [[ "$TRAFFIC_ADOPTED" == "1" ]]; then
        WaitForAdoptedProbe "$TRAFFIC_PID" || status=$?
    else
        wait "$TRAFFIC_PID" || status=$?
    fi
    TRAFFIC_PID=""
    TRAFFIC_ADOPTED=0
    rm -f "$TRAFFIC_PID_FILE"
    return "$status"
}

StartResourceProbe() {
    [[ -n "$RESOURCE_PID" ]] && return
    if FinalProbeArtifactMatches "$RESOURCE_BUDGET_EVIDENCE" "fsusblog.release-resource-budget-evidence.v1" &&
        TrafficProbeArtifactMatches "$TRAFFIC_FINAL" &&
        NotificationProbeArtifactMatches "$NOTIFICATION_EVIDENCE"; then
        RolloutLog "reusing immutable final resource evidence for rollout=$ROLLOUT_ID"
        return 0
    fi
    if RESOURCE_PID="$(AdoptProbePid "$RESOURCE_PID_FILE" release-resource-probe.mjs "$ROLLOUT_STATE_FILE")"; then
        RESOURCE_ADOPTED=1
        RolloutLog "adopted resource probe pid=$RESOURCE_PID"
        return
    fi
    RESOURCE_PID=""
    RESOURCE_ADOPTED=0
    rm -f "$RESOURCE_STOP_FILE"
    node "$ROOT_DIR/tools/deployment/release-resource-probe.mjs" \
        --rollout-state "$ROLLOUT_STATE_FILE" \
        --source-container "fsus-app-$SOURCE_SLOT" --target-container "fsus-app-$TARGET_SLOT" \
        --policy "$ROOT_DIR/config/deployment/zero-downtime-resource-policy.json" \
        --snapshot "$RESOURCE_SNAPSHOT" --out "$RESOURCE_BUDGET_EVIDENCE" --stop-file "$RESOURCE_STOP_FILE" \
        --disk-path "${FSUSBLOG_ROLLOUT_DISK_PATH:-/var/lib/docker}" \
        --gateway-evidence "${FSUSBLOG_GATEWAY_EVIDENCE_DIR:-/var/lib/fsusblog/deployment/evidence}/latest.json" \
        --drain-evidence "$EVIDENCE_DIR/source-drain-gate.json" \
        --notification-evidence "$NOTIFICATION_EVIDENCE" \
        --traffic-evidence "$TRAFFIC_FINAL" \
        >"$EVIDENCE_DIR/resource-budget.process.stdout" \
        2>"$EVIDENCE_DIR/resource-budget.process.stderr" 9>&- &
    RESOURCE_PID=$!
    RESOURCE_ADOPTED=0
    RecordProbePid "$RESOURCE_PID_FILE" "$RESOURCE_PID"
}

StopResourceProbe() {
    [[ -n "$RESOURCE_PID" ]] || return 0
    : >"$RESOURCE_STOP_FILE"
    local status=0
    if [[ "$RESOURCE_ADOPTED" == "1" ]]; then
        WaitForAdoptedProbe "$RESOURCE_PID" || status=$?
    else
        wait "$RESOURCE_PID" || status=$?
    fi
    RESOURCE_PID=""
    RESOURCE_ADOPTED=0
    rm -f "$RESOURCE_PID_FILE"
    return "$status"
}

StartNotificationProbe() {
    if NotificationProbeArtifactMatches "$NOTIFICATION_EVIDENCE"; then
        RolloutLog "reusing immutable final notification evidence for rollout=$ROLLOUT_ID"
        return 0
    fi
    [[ -n "$NOTIFICATION_AUTH_STORAGE_STATE" ]] || return 0
    [[ -n "$NOTIFICATION_PID" ]] && return 0
    if NOTIFICATION_PID="$(AdoptProbePid "$NOTIFICATION_PID_FILE" release-notification-probe.mjs "$ROLLOUT_STATE_FILE")"; then
        NOTIFICATION_ADOPTED=1
        RolloutLog "adopted notification stream probe pid=$NOTIFICATION_PID"
        return
    fi
    NOTIFICATION_PID=""
    NOTIFICATION_ADOPTED=0
    rm -f "$NOTIFICATION_STOP_FILE"
    node "$ROOT_DIR/tools/deployment/release-notification-probe.mjs" \
        --base-url "$PUBLIC_BASE_URL" --source-port "$SOURCE_PORT" --target-port "$TARGET_PORT" \
        --rollout-state "$ROLLOUT_STATE_FILE" --auth-storage-state "$NOTIFICATION_AUTH_STORAGE_STATE" \
        --resync-scenario "$NOTIFICATION_RESYNC_SCENARIO" \
        --admin-header-file "$ADMIN_HEADER_FILE" --control-origin "$CONTROL_ORIGIN" \
        --snapshot "$NOTIFICATION_SNAPSHOT" --out "$NOTIFICATION_EVIDENCE" --stop-file "$NOTIFICATION_STOP_FILE" \
        --drain-evidence "$EVIDENCE_DIR/source-drain-gate.json" \
        >"$EVIDENCE_DIR/notification-stream.process.stdout" \
        2>"$EVIDENCE_DIR/notification-stream.process.stderr" 9>&- &
    NOTIFICATION_PID=$!
    NOTIFICATION_ADOPTED=0
    RecordProbePid "$NOTIFICATION_PID_FILE" "$NOTIFICATION_PID"
}

StopNotificationProbe() {
    [[ -n "$NOTIFICATION_PID" ]] || return 0
    : >"$NOTIFICATION_STOP_FILE"
    local status=0
    if [[ "$NOTIFICATION_ADOPTED" == "1" ]]; then
        WaitForAdoptedProbe "$NOTIFICATION_PID" || status=$?
    else
        wait "$NOTIFICATION_PID" || status=$?
    fi
    NOTIFICATION_PID=""
    NOTIFICATION_ADOPTED=0
    rm -f "$NOTIFICATION_PID_FILE"
    return "$status"
}

StartAssetCompatibilityProbe() {
    [[ -n "$ASSET_COMPATIBILITY_SCENARIO" ]] || return 0
    if AssetCompatibilityArtifactMatches "$ASSET_COMPATIBILITY_EVIDENCE"; then
        return 0
    fi
    [[ -z "$ASSET_COMPATIBILITY_PID" ]] || return 0
    if ASSET_COMPATIBILITY_PID="$(AdoptProbePid "$ASSET_COMPATIBILITY_PID_FILE" release-asset-compatibility-probe.mjs "$ASSET_COMPATIBILITY_EVIDENCE")"; then
        ASSET_COMPATIBILITY_ADOPTED=1
        RolloutLog "adopted asset compatibility probe pid=$ASSET_COMPATIBILITY_PID"
        return
    fi
    ASSET_COMPATIBILITY_PID=""
    ASSET_COMPATIBILITY_ADOPTED=0
    rm -f "$ASSET_COMPATIBILITY_CHECKPOINT" "$ASSET_COMPATIBILITY_READY_FILE" \
        "$ASSET_COMPATIBILITY_SWITCH_FILE" "$ASSET_COMPATIBILITY_GC_FILE"
    FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE="$ASSET_BROWSER_BINDING_KEY_FILE" \
        node "$ROOT_DIR/tools/deployment/release-asset-compatibility-probe.mjs" \
        --scenario "$ASSET_COMPATIBILITY_SCENARIO" \
        --checkpoint "$ASSET_COMPATIBILITY_CHECKPOINT" \
        --ready-file "$ASSET_COMPATIBILITY_READY_FILE" \
        --switch-file "$ASSET_COMPATIBILITY_SWITCH_FILE" \
        --gc-file "$ASSET_COMPATIBILITY_GC_FILE" \
        --gc-evidence "$ASSET_COMPATIBILITY_GC_EVIDENCE" \
        --out "$ASSET_COMPATIBILITY_EVIDENCE" \
        --rollout-id "$ROLLOUT_ID" \
        --signal-timeout-ms "${FSUSBLOG_ASSET_DRILL_TIMEOUT_MS:-900000}" \
        >"$EVIDENCE_DIR/asset-compatibility.process.stdout" \
        2>"$EVIDENCE_DIR/asset-compatibility.process.stderr" 9>&- &
    ASSET_COMPATIBILITY_PID=$!
    ASSET_COMPATIBILITY_ADOPTED=0
    RecordProbePid "$ASSET_COMPATIBILITY_PID_FILE" "$ASSET_COMPATIBILITY_PID"
}

CancelAssetCompatibilityProbe() {
    [[ -n "$ASSET_COMPATIBILITY_PID" ]] || return 0
    kill -TERM "$ASSET_COMPATIBILITY_PID" >/dev/null 2>&1 || true
    if [[ "$ASSET_COMPATIBILITY_ADOPTED" == "1" ]]; then
        WaitForAdoptedProbe "$ASSET_COMPATIBILITY_PID" >/dev/null 2>&1 || true
    else
        wait "$ASSET_COMPATIBILITY_PID" >/dev/null 2>&1 || true
    fi
    ASSET_COMPATIBILITY_PID=""
    ASSET_COMPATIBILITY_ADOPTED=0
    rm -f "$ASSET_COMPATIBILITY_PID_FILE"
}

WaitForAssetCheckpoint() {
    [[ -n "$ASSET_COMPATIBILITY_PID" ]] || return 0
    local timeoutSeconds="${FSUSBLOG_ASSET_CHECKPOINT_TIMEOUT_SECONDS:-120}" deadline
    [[ "$timeoutSeconds" =~ ^[0-9]+$ && "$timeoutSeconds" -ge 1 && "$timeoutSeconds" -le 900 ]] ||
        {
            printf '[release-rollout] asset checkpoint timeout must be 1..900 seconds\n' >&2
            return 1
        }
    deadline=$((SECONDS + timeoutSeconds))
    while [[ ! -f "$ASSET_COMPATIBILITY_READY_FILE" ]]; do
        kill -0 "$ASSET_COMPATIBILITY_PID" >/dev/null 2>&1 ||
            {
                wait "$ASSET_COMPATIBILITY_PID" || true
                ASSET_COMPATIBILITY_PID=""
                return 1
            }
        ((SECONDS < deadline)) || return 1
        sleep 0.1
    done
    jq -e --arg drillId "$(jq -r '.drillId' "$ASSET_COMPATIBILITY_SCENARIO")" '
    .schema == "fsusblog.release-asset-compatibility-signal.v1"
    and .stage == "ready"
    and .drillId == $drillId
  ' "$ASSET_COMPATIBILITY_READY_FILE" >/dev/null
}

WriteAssetCompatibilitySignal() {
    local file="$1" stage="$2" drillId temporary
    drillId="$(jq -r '.drillId' "$ASSET_COMPATIBILITY_SCENARIO")"
    temporary="${file}.tmp-$$"
    jq -n --arg drillId "$drillId" --arg stage "$stage" \
        --arg observedAtUtc "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '
    {schema:"fsusblog.release-asset-compatibility-signal.v1",drillId:$drillId,stage:$stage,observedAtUtc:$observedAtUtc}
  ' >"$temporary"
    mv -f "$temporary" "$file"
}

CompleteAssetCompatibilityProbe() {
    [[ -n "$ASSET_COMPATIBILITY_PID" ]] || return 0
    WaitForAssetCheckpoint
    WriteAssetCompatibilitySignal "$ASSET_COMPATIBILITY_SWITCH_FILE" switched
    node "$ROOT_DIR/tools/storage/gc-release-assets.mjs" --dry-run \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" \
        --out "$ASSET_COMPATIBILITY_GC_REVIEWED" >/dev/null
    jq -e '.schema == "fsusblog.release-assets.gc-evidence.v1" and .status == "dry-run" and .dryRun == true' \
        "$ASSET_COMPATIBILITY_GC_REVIEWED" >/dev/null
    node "$ROOT_DIR/tools/storage/gc-release-assets.mjs" --apply \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" \
        --slot-state "$SLOT_STATE_FILE" --rollout-state "$ROLLOUT_STATE_FILE" \
        --reviewed-dry-run "$ASSET_COMPATIBILITY_GC_REVIEWED" \
        --deployment-lock "$DEPLOYMENT_LOCK_FILE" \
        --out "$ASSET_COMPATIBILITY_GC_EVIDENCE" >/dev/null
    jq -e '.schema == "fsusblog.release-assets.gc-evidence.v1" and .status == "ok" and .dryRun == false' \
        "$ASSET_COMPATIBILITY_GC_EVIDENCE" >/dev/null
    WriteAssetCompatibilitySignal "$ASSET_COMPATIBILITY_GC_FILE" gc-complete
    local status=0
    if [[ "$ASSET_COMPATIBILITY_ADOPTED" == "1" ]]; then
        WaitForAdoptedProbe "$ASSET_COMPATIBILITY_PID" || status=$?
    else
        wait "$ASSET_COMPATIBILITY_PID" || status=$?
    fi
    ASSET_COMPATIBILITY_PID=""
    ASSET_COMPATIBILITY_ADOPTED=0
    rm -f "$ASSET_COMPATIBILITY_PID_FILE"
    [[ "$status" == "0" ]] || return "$status"
    AssetCompatibilityArtifactMatches "$ASSET_COMPATIBILITY_EVIDENCE"
}

EnsureBackgroundProbesAlive() {
    [[ -z "$TRAFFIC_PID" || -e "/proc/$TRAFFIC_PID" ]] || {
        printf '[release-rollout] continuous public traffic probe exited before switch\n' >&2
        return 1
    }
    [[ -z "$RESOURCE_PID" || -e "/proc/$RESOURCE_PID" ]] || {
        printf '[release-rollout] resource probe exited before switch\n' >&2
        return 1
    }
    [[ -z "$NOTIFICATION_PID" || -e "/proc/$NOTIFICATION_PID" ]] || {
        printf '[release-rollout] notification stream probe exited before switch\n' >&2
        return 1
    }
    [[ -z "$ASSET_COMPATIBILITY_PID" || -e "/proc/$ASSET_COMPATIBILITY_PID" ]] || {
        printf '[release-rollout] asset compatibility probe exited before switch\n' >&2
        return 1
    }
}

CleanupBackgroundProbes() {
    [[ "$PRESERVE_BACKGROUND_PROBES_ON_EXIT" == "0" ]] || return 0
    StopPublicTraffic >/dev/null 2>&1 || true
    StopResourceProbe >/dev/null 2>&1 || true
    StopNotificationProbe >/dev/null 2>&1 || true
    CancelAssetCompatibilityProbe >/dev/null 2>&1 || true
}

CurrentStage() {
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE" | jq -r '.currentStage // ""'
}

WaitForTrafficBaseline() {
    local minimum="${FSUSBLOG_ROLLOUT_MIN_BASELINE_REQUESTS:-96}" timeoutSeconds="${FSUSBLOG_ROLLOUT_BASELINE_TIMEOUT_SECONDS:-120}" deadline
    [[ "$minimum" =~ ^[0-9]+$ && "$minimum" -ge 12 && "$minimum" -le 100000 ]] ||
        {
            printf '[release-rollout] minimum baseline requests must be 12..100000\n' >&2
            return 1
        }
    [[ "$timeoutSeconds" =~ ^[0-9]+$ && "$timeoutSeconds" -ge 1 && "$timeoutSeconds" -le 900 ]] ||
        {
            printf '[release-rollout] baseline timeout must be 1..900 seconds\n' >&2
            return 1
        }
    deadline=$((SECONDS + timeoutSeconds))
    while true; do
        [[ -n "$TRAFFIC_PID" ]] && kill -0 "$TRAFFIC_PID" >/dev/null 2>&1 || return 1
        if [[ -f "$TRAFFIC_SNAPSHOT" ]] && jq -e --argjson minimum "$minimum" '
      (.phaseLatencyMs.baseline.samples // 0) >= $minimum
      and (["home","archive","article","binary","search","static","login","refresh","protected-read","write","upload","admin-health"]
        | all(. as $category | (.categoryCounts[$category] // 0) > 0))
    ' "$TRAFFIC_SNAPSHOT" >/dev/null 2>&1; then
            return 0
        fi
        ((SECONDS < deadline)) || return 1
        sleep 0.1
    done
}

WaitForWorkerLedger() {
    local timeoutSeconds="${FSUSBLOG_WORKER_LEDGER_TIMEOUT_SECONDS:-300}" deadline
    [[ -n "$WORKER_EVENT_LEDGER" ]] || return 1
    [[ "$timeoutSeconds" =~ ^[0-9]+$ && "$timeoutSeconds" -ge 1 && "$timeoutSeconds" -le 1800 ]] || return 1
    deadline=$((SECONDS + timeoutSeconds))
    while [[ ! -f "$WORKER_EVENT_LEDGER" ]]; do
        ((SECONDS < deadline)) || return 1
        sleep 0.1
    done
}

InterruptRollout() {
    local signal="$1" stage state attempt stdoutFile stderrFile evidenceFile startedAt completedAt
    state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE" 2>/dev/null || true)"
    stage="$(jq -r '.currentStage // ""' <<<"$state" 2>/dev/null || true)"
    if [[ -n "$stage" ]]; then
        attempt="$(jq -r --arg stage "$stage" '[.stages[] | select(.stage == $stage)] | length' <<<"$state")"
        stdoutFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stdout"
        stderrFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stderr"
        evidenceFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.json"
        if [[ ! -f "$evidenceFile" ]]; then
            : >>"$stdoutFile"
            : >>"$stderrFile"
            startedAt="$(jq -r '.stages[-1].startedAtUtc' <<<"$state")"
            completedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
            printf '[release-rollout] orchestrator interrupted by %s\n' "$signal" >>"$stderrFile"
            node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" stage \
                --state "$ROLLOUT_STATE_FILE" --stage "$stage" --status failed --exit-code 130 \
                --command-id "signal-${signal}" --started-at "$startedAt" --completed-at "$completedAt" \
                --stdout "$stdoutFile" --stderr "$stderrFile" --out "$evidenceFile" >/dev/null 2>&1 || true
            node "$ROOT_DIR/tools/deployment/rollout-state.mjs" fail-stage \
                --state "$ROLLOUT_STATE_FILE" --stage "$stage" --error "script_interrupted_${signal}" \
                --evidence "$evidenceFile" --at "$completedAt" >/dev/null 2>&1 || true
        fi
    fi
    PRESERVE_BACKGROUND_PROBES_ON_EXIT=1
    printf '[release-rollout] interrupted by %s; active slot was not stopped; resume from %s\n' "$signal" "$ROLLOUT_STATE_FILE" >&2
    exit 130
}

trap 'InterruptRollout INT' INT
trap 'InterruptRollout TERM' TERM
trap 'InterruptRollout HUP' HUP
trap 'CleanupBackgroundProbes' EXIT

RunStage() {
    local stage="$1" commandId="$2"
    shift 2
    local state completed attempt started completedAt stdoutFile stderrFile evidenceFile exitCode=0 evidenceExit=0
    state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
    completed="$(jq -r --arg stage "$stage" '.completedStages | index($stage) != null' <<<"$state")"
    if [[ "$completed" == "true" ]]; then
        RolloutLog "resume skip completed stage=$stage"
        return 0
    fi
    [[ "$(jq -r '.status' <<<"$state")" != "recovery_required" ]] || RolloutFail "stage=$stage cannot run before recovery"
    attempt="$(($(jq -r --arg stage "$stage" '[.stages[] | select(.stage == $stage)] | length' <<<"$state") + 1))"
    stdoutFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stdout"
    stderrFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.stderr"
    evidenceFile="$EVIDENCE_DIR/commands/${stage}.attempt-${attempt}.json"
    started="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" start-stage \
        --state "$ROLLOUT_STATE_FILE" --stage "$stage" --at "$started" >/dev/null
    RolloutLog "stage=$stage status=running"
    RehearsalStageHold "$stage"
    set +e
    "$@" >"$stdoutFile" 2>"$stderrFile"
    exitCode=$?
    set -e
    completedAt="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    set +e
    node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" stage \
        --state "$ROLLOUT_STATE_FILE" --stage "$stage" \
        --status "$([[ "$exitCode" == "0" ]] && printf ok || printf failed)" \
        --exit-code "$exitCode" --command-id "$commandId" \
        --started-at "$started" --completed-at "$completedAt" \
        --stdout "$stdoutFile" --stderr "$stderrFile" --out "$evidenceFile" \
        >/dev/null
    evidenceExit=$?
    set -e
    if [[ "$evidenceExit" != "0" ]]; then
        exitCode=70
        printf '[release-rollout] stage evidence write failed for %s\n' "$stage" >>"$stderrFile"
    fi
    if [[ "$exitCode" == "0" ]]; then
        node "$ROOT_DIR/tools/deployment/rollout-state.mjs" complete-stage \
            --state "$ROLLOUT_STATE_FILE" --stage "$stage" --evidence "$evidenceFile" --at "$completedAt" >/dev/null
        RolloutLog "stage=$stage status=ok evidence=$evidenceFile"
        return 0
    fi
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" fail-stage \
        --state "$ROLLOUT_STATE_FILE" --stage "$stage" --error "stage_failed_${exitCode}" \
        --evidence "$evidenceFile" --at "$completedAt" >/dev/null
    RolloutLog "stage=$stage status=failed exit=$exitCode evidence=$evidenceFile"
    RecoverPendingState || true
    if [[ "$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE" | jq -r '.status')" == "running" ]]; then
        PRESERVE_BACKGROUND_PROBES_ON_EXIT=1
        RolloutLog "continuous probes preserved for --resume"
    fi
    exit "$((20 + $(StageIndex "$stage")))"
}

StageIndex() {
    local wanted="$1" index=0 stage
    for stage in manifest-validate capacity-preflight backup-restore-gate expand-migration asset-materialize candidate-start candidate-readiness candidate-smoke compatibility-smoke gateway-switch source-drain active-fence public-verify source-stop release-evidence; do
        [[ "$stage" == "$wanted" ]] && {
            printf '%s\n' "$index"
            return
        }
        index=$((index + 1))
    done
    printf '79\n'
}

RecoverPendingState() {
    local state action failedStage recoveryFile recoveryStdout recoveryStderr status=0
    state="$(node "$ROOT_DIR/tools/deployment/rollout-state.mjs" read --state "$ROLLOUT_STATE_FILE")"
    [[ "$(jq -r '.status' <<<"$state")" == "recovery_required" ]] || return 0
    action="$(jq -r '.recovery.action' <<<"$state")"
    failedStage="$(jq -r '.recovery.failedStage' <<<"$state")"
    recoveryFile="$EVIDENCE_DIR/recoveries/${failedStage}.${action}.json"
    recoveryStdout="$EVIDENCE_DIR/recoveries/${failedStage}.${action}.stdout"
    recoveryStderr="$EVIDENCE_DIR/recoveries/${failedStage}.${action}.stderr"
    case "$action" in
        preserve-source-stop-candidate)
            set +e
            "$ROOT_DIR/tools/deployment/slot-stop.sh" --slot "$TARGET_SLOT" --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" --rollout-state "$ROLLOUT_STATE_FILE" >"$recoveryStdout" 2>"$recoveryStderr"
            status=$?
            set -e
            ;;
        gateway-recover)
            set +e
            "$ROOT_DIR/tools/deployment/gateway-recover.sh" \
                --state-file "$SLOT_STATE_FILE" --public-url "$PUBLIC_PROBE_URL" \
                --admin-header-file "$ADMIN_HEADER_FILE" --control-origin "$CONTROL_ORIGIN" \
                >"$recoveryStdout" 2>"$recoveryStderr"
            status=$?
            set -e
            ;;
        rollback-gateway-to-source)
            set +e
            "$ROOT_DIR/tools/deployment/release-rollout-recovery.sh" rollback-to-source \
                --rollout-state "$ROLLOUT_STATE_FILE" --slot-state "$SLOT_STATE_FILE" \
                --env-file "$PRODUCTION_ENV_FILE" --source-manifest "${FSUSBLOG_ROLLOUT_SOURCE_MANIFEST:-}" \
                --public-url "$PUBLIC_PROBE_URL" --admin-header-file "$ADMIN_HEADER_FILE" --control-origin "$CONTROL_ORIGIN" \
                --out "$recoveryFile" >"$recoveryStdout" 2>"$recoveryStderr"
            status=$?
            set -e
            if [[ "$status" == "0" ]]; then
                node "$ROOT_DIR/tools/deployment/rollout-state.mjs" complete-recovery \
                    --state "$ROLLOUT_STATE_FILE" --action "$action" --evidence "$recoveryFile" --terminal-status rolled_back >/dev/null
                return 0
            fi
            ;;
        resume-release-activation-same-cutover | resume-release-evidence)
            jq -cn --arg action "$action" --arg failedStage "$failedStage" \
                '{schema:"fsusblog.release-rollout-recovery.v1",status:"ok",action:$action,failedStage:$failedStage,idempotentRetryRequired:true}' >"$recoveryFile"
            status=0
            ;;
        retain-source-report-cleanup-blocker | manual-contract-recovery)
            RolloutLog "recovery action=$action requires explicit operator resolution; old container is retained"
            return 90
            ;;
        *) RolloutFail "unknown recovery action: $action" ;;
    esac
    if [[ "$status" == "0" ]]; then
        if [[ ! -f "$recoveryFile" ]]; then
            jq -cn --arg action "$action" --arg failedStage "$failedStage" \
                --arg stdout "$recoveryStdout" --arg stderr "$recoveryStderr" \
                '{schema:"fsusblog.release-rollout-recovery.v1",status:"ok",action:$action,failedStage:$failedStage,stdout:$stdout,stderr:$stderr}' >"$recoveryFile"
        fi
        node "$ROOT_DIR/tools/deployment/rollout-state.mjs" complete-recovery \
            --state "$ROLLOUT_STATE_FILE" --action "$action" --evidence "$recoveryFile" >/dev/null
        RolloutLog "recovery action=$action status=ok evidence=$recoveryFile"
        return 0
    fi
    [[ -f "$recoveryFile" ]] || jq -cn --arg action "$action" --arg failedStage "$failedStage" --argjson exitCode "$status" \
        '{schema:"fsusblog.release-rollout-recovery.v1",status:"failed",action:$action,failedStage:$failedStage,exitCode:$exitCode}' >"$recoveryFile"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" fail-recovery \
        --state "$ROLLOUT_STATE_FILE" --action "$action" --evidence "$recoveryFile" --error "recovery_failed_${status}" >/dev/null || true
    RolloutLog "recovery action=$action status=failed; active slot was not stopped"
    return 91
}

StageManifestValidate() {
    node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
        --manifest "$RELEASE_MANIFEST" --slot "$TARGET_SLOT" --release-id "$TARGET_RELEASE" --image-digest "$TARGET_DIGEST"
}

StageCapacityPreflight() {
    "$ROOT_DIR/tools/deployment/slot-preflight.sh" \
        --slot "$TARGET_SLOT" --release-manifest "$RELEASE_MANIFEST" \
        --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE"
}

StageBackupRestoreGate() {
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" backup-restore \
        --input "$BACKUP_RESTORE_EVIDENCE" \
        --max-age-seconds "${FSUSBLOG_BACKUP_RESTORE_MAX_AGE_SECONDS:-604800}" \
        --out "$EVIDENCE_DIR/backup-restore-gate.json"
}

StageExpandMigration() {
    local migrationOutput="$EVIDENCE_DIR/migration-expand.json"
    if [[ "$ROLLBACK" == "1" ]]; then
        jq -cn '{schema:"fsusblog.online-migration-rollout.v1",status:"ok",phase:"expand",action:"not-required-for-rollback",contractApplied:false,errors:[]}' >"$migrationOutput"
    else
        "$ROOT_DIR/tools/db/run-online-migrations.sh" \
            --server-dll "$MIGRATION_SERVER_DLL" --release-manifest "$RELEASE_MANIFEST" \
            --env-file "$PRODUCTION_ENV_FILE" --phase expand >"$migrationOutput"
    fi
    jq -e '
    type == "object"
    and (.status == "ok" or .status == "pass" or .status == "completed")
    and (.phase == "expand")
    and ((.errors // []) | type == "array" and length == 0)
  ' "$migrationOutput" >/dev/null
    cat "$migrationOutput"
    WaitForTrafficBaseline
}

StageCandidateStart() {
    "$ROOT_DIR/tools/deployment/slot-start.sh" \
        --slot "$TARGET_SLOT" --release-manifest "$RELEASE_MANIFEST" \
        --production-build-receipt "$ASSET_STORE/releases/$TARGET_RELEASE/production-build-receipt.json" \
        --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" \
        --deployment-generation "$TARGET_GENERATION" --rollout-state "$ROLLOUT_STATE_FILE"
}

StageCandidateReadiness() {
    local statusFile="$EVIDENCE_DIR/candidate-status.json"
    "$ROOT_DIR/tools/deployment/slot-status.sh" --slot "$TARGET_SLOT" --state-file "$SLOT_STATE_FILE" >"$statusFile"
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" candidate-readiness \
        --input "$statusFile" --slot "$TARGET_SLOT" --release "$TARGET_RELEASE" \
        --digest "$TARGET_DIGEST" --generation "$TARGET_GENERATION" \
        --out "$EVIDENCE_DIR/candidate-readiness-gate.json"
}

StageAssetMaterialize() {
    node "$ROOT_DIR/tools/storage/materialize-release-assets.mjs" \
        --release-manifest "$RELEASE_MANIFEST" --slot "$TARGET_SLOT" \
        --store "$ASSET_STORE" --build-receipt "$PRODUCTION_BUILD_RECEIPT" \
        --runtime-release-asset-root /app/release-assets \
        --out "$EVIDENCE_DIR/asset-materialization.json"
    node "$ROOT_DIR/tools/storage/prepare-release-retention.mjs" prepare \
        --rollout-state "$ROLLOUT_STATE_FILE" --slot-state "$SLOT_STATE_FILE" \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" \
        --out "$EVIDENCE_DIR/asset-retention-prepared.json"
    node "$ROOT_DIR/tools/storage/verify-retained-assets.mjs" \
        --release-manifest "$RELEASE_MANIFEST" --slot "$TARGET_SLOT" \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" \
        --out "$EVIDENCE_DIR/retained-assets-before-switch.json"
}

VerifyPublicAotWarmEvidence() {
    node "$ROOT_DIR/tools/frontend/verify-public-aot-warm-evidence.mjs" \
        --report "$EVIDENCE_DIR/public-aot-warm.json" --require-scope all \
        --expected-release "$TARGET_RELEASE" --expected-slot "$TARGET_SLOT" \
        --expected-public-origin "$PUBLIC_PROBE_URL" \
        --max-age-seconds "${FSUSBLOG_PUBLIC_AOT_WARM_EVIDENCE_MAX_AGE_SECONDS:-900}"
}

StageCandidateSmoke() {
    local stopFile="$EVIDENCE_DIR/candidate-smoke.stop"
    local publicAotReport="$EVIDENCE_DIR/public-aot-warm.json"
    FSUSBLOG_BASE_URL="http://127.0.0.1:$TARGET_PORT" \
        FSUSBLOG_SYNC_PUBLIC_AOT_SIDECARS_TO_DIST=0 \
        node "$ROOT_DIR/tools/frontend/warm-public-aot-cache.mjs" \
        --scope all --fail-fast --report "$publicAotReport" \
        --expected-release "$TARGET_RELEASE" --expected-slot "$TARGET_SLOT" \
        --expected-public-origin "$PUBLIC_PROBE_URL"
    VerifyPublicAotWarmEvidence
    FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1 node "$ROOT_DIR/tools/deployment/release-traffic-probe.mjs" \
        --base-url "http://127.0.0.1:$TARGET_PORT" \
        --scenario "$TRAFFIC_SCENARIO" --rollout-state "$ROLLOUT_STATE_FILE" \
        --snapshot "$EVIDENCE_DIR/candidate-smoke.snapshot.json" \
        --out "$EVIDENCE_DIR/candidate-smoke.json" --stop-file "$stopFile" \
        --binding-key-file "$TRAFFIC_BINDING_KEY_FILE" --probe-mode candidate-direct \
        --concurrency "${FSUSBLOG_CANDIDATE_SMOKE_CONCURRENCY:-4}" --rounds 1 --expect-releases target
}

StageCompatibilitySmoke() {
    local previousRelease
    previousRelease="$(SlotStateReadCurrent | jq -r '.previousReleaseId // .activeReleaseId')"
    node "$ROOT_DIR/tools/storage/check-release-compatibility.mjs" \
        --candidate "$TARGET_RELEASE" --active "$SOURCE_RELEASE" --previous "$previousRelease" \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" --out "$EVIDENCE_DIR/compatibility-matrix.json" \
        >/dev/null
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" compatibility \
        --input "$EVIDENCE_DIR/compatibility-matrix.json" --out "$EVIDENCE_DIR/compatibility-gate.json"
}

StageGatewaySwitch() {
    node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
        --manifest "$RELEASE_MANIFEST" --verify-artifacts true --activation-preflight true \
        --activation-plan "${FSUSBLOG_CURRENT_ACTIVATION_PLAN:?explicit current activation plan required}" \
        --activation-plan-sha256 "${FSUSBLOG_CURRENT_ACTIVATION_PLAN_SHA256:?explicit current activation plan digest required}" \
        --trust-policy "${FSUSBLOG_RELEASE_TRUST_POLICY:?explicit independent trust policy required}" \
        --trust-policy-sha256 "${FSUSBLOG_RELEASE_TRUST_POLICY_SHA256:?explicit independent trust digest required}" ||
        RolloutFail "current activation admission failed before gateway switch"
    VerifyPublicAotWarmEvidence
    WaitForTrafficBaseline
    WaitForAssetCheckpoint
    EnsureBackgroundProbesAlive
    "$ROOT_DIR/tools/deployment/gateway-switch.sh" \
        --to "$TARGET_SLOT" --release "$TARGET_RELEASE" --image-digest "$TARGET_DIGEST" \
        --kind "$([[ "$ROLLBACK" == "1" ]] && printf rollback || printf switch)" \
        --state-file "$SLOT_STATE_FILE" --public-url "$PUBLIC_PROBE_URL" \
        --admin-header-file "$ADMIN_HEADER_FILE" --control-origin "$CONTROL_ORIGIN" \
        --defer-source-drain --rollout-state-file "$ROLLOUT_STATE_FILE"
}

MarkGatewaySwitch() {
    local generation
    generation="$(SlotStateReadCurrent | jq -r '.switchGeneration')"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" mark-switch \
        --state "$ROLLOUT_STATE_FILE" --generation "$generation" >/dev/null
}

StageActiveFence() {
    node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" revoke \
        --port "$SOURCE_PORT" --release "$SOURCE_RELEASE" --slot "$SOURCE_SLOT" \
        --generation "$SOURCE_GENERATION" \
        --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --out "$EVIDENCE_DIR/active-release-fence-source-revoke.json"
    node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" status \
        --port "$TARGET_PORT" --release "$TARGET_RELEASE" --slot "$TARGET_SLOT" \
        --generation "$TARGET_GENERATION" \
        --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --out "$EVIDENCE_DIR/active-release-fence-verified.json"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" mark-activation \
        --state "$ROLLOUT_STATE_FILE" >/dev/null
}

StagePublicVerify() {
    CompleteAssetCompatibilityProbe
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" traffic-checkpoint \
        --input "$TRAFFIC_SNAPSHOT" --target-release "$TARGET_RELEASE" \
        --min-requests "${FSUSBLOG_ROLLOUT_MIN_PUBLIC_REQUESTS:-100}" \
        --out "$EVIDENCE_DIR/public-traffic-checkpoint.json"
    "$ROOT_DIR/tools/deployment/slot-status.sh" --slot "$TARGET_SLOT" --state-file "$SLOT_STATE_FILE" \
        >"$EVIDENCE_DIR/target-status-active.json"
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" target-health \
        --rollout-state "$ROLLOUT_STATE_FILE" \
        --slot-status "$EVIDENCE_DIR/target-status-active.json" \
        --active-fence "$EVIDENCE_DIR/active-release-fence.json" \
        --source-revoke "$EVIDENCE_DIR/active-release-fence-source-revoke.json" \
        --fence-verify "$EVIDENCE_DIR/active-release-fence-verified.json" \
        --traffic-checkpoint "$EVIDENCE_DIR/public-traffic-checkpoint.json" \
        --out "$TARGET_HEALTH_EVIDENCE"
    WaitForWorkerLedger
    node "$ROOT_DIR/tools/deployment/release-worker-reconciliation.mjs" \
        --mode normal --rollout-state "$ROLLOUT_STATE_FILE" \
        --ledger "$WORKER_EVENT_LEDGER" \
        --source-drain "$EVIDENCE_DIR/source-drain-gate.json" \
        --target-health "$TARGET_HEALTH_EVIDENCE" \
        --out "$WORKER_RECONCILIATION_EVIDENCE"
    StopPublicTraffic
    StopNotificationProbe
    StopResourceProbe
    RequireContinuousProbeArtifacts
    node "$ROOT_DIR/tools/storage/prepare-release-retention.mjs" complete-drain \
        --rollout-state "$ROLLOUT_STATE_FILE" --slot-state "$SLOT_STATE_FILE" \
        --store "$ASSET_STORE" --state "$RETENTION_STATE" \
        --out "$EVIDENCE_DIR/asset-retention-drain-complete.json"
}

StageSourceDrain() {
    node "$ROOT_DIR/tools/deployment/notification-stream-restart.mjs" restart \
        --port "$SOURCE_PORT" --release "$SOURCE_RELEASE" --slot "$SOURCE_SLOT" --generation "$SOURCE_GENERATION" \
        --reason deployment_drain --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --out "$EVIDENCE_DIR/notification-stream-restart.json" >/dev/null
    "$ROOT_DIR/tools/deployment/deployment-control.sh" drain \
        --slot "$SOURCE_SLOT" --release "$SOURCE_RELEASE" --generation "$SOURCE_GENERATION" --port "$SOURCE_PORT" \
        --timeout-seconds "${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-45}" --admin-header-file "$ADMIN_HEADER_FILE" \
        --origin "$CONTROL_ORIGIN" --wait >"$EVIDENCE_DIR/source-drain.snapshot.json"
    node "$ROOT_DIR/tools/deployment/release-rollout-gate.mjs" source-drain \
        --input "$EVIDENCE_DIR/source-drain.snapshot.json" \
        --notification "$EVIDENCE_DIR/notification-stream-restart.json" \
        --out "$EVIDENCE_DIR/source-drain-gate.json"
    # The backend cutover endpoint requires an exact target authorization fence. Acquiring it
    # here does not commit rollout activation: activationCommitted remains false until the later
    # active-fence stage verifies cutover evidence, revokes source ownership and marks activation.
    node "$ROOT_DIR/tools/deployment/active-release-fence.mjs" acquire \
        --port "$TARGET_PORT" --release "$TARGET_RELEASE" --slot "$TARGET_SLOT" \
        --generation "$TARGET_GENERATION" --digest "$TARGET_DIGEST" \
        --expected-release "$SOURCE_RELEASE" --expected-slot "$SOURCE_SLOT" --expected-generation "$SOURCE_GENERATION" \
        --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --out "$EVIDENCE_DIR/active-release-fence.json"
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" mark-destructive-cutover \
        --state "$ROLLOUT_STATE_FILE" >/dev/null
    # Irreversible boundary: source issuance is revoked and all source in-flight work is drained.
    # Resume uses this same operation id, so a crash after the mutation reads the durable receipt.
    node "$ROOT_DIR/tools/deployment/invoke-security-challenge-kind-cutover.mjs" \
        --port "$TARGET_PORT" --release-id "$TARGET_RELEASE" --slot "$TARGET_SLOT" \
        --generation "$TARGET_GENERATION" --operation-id "$ROLLOUT_ID:challenge-kind-cutover" \
        --targets "$CHALLENGE_KIND_TARGET_MAP" \
        --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --receipt "$EVIDENCE_DIR/challenge-kind-cutover-receipt.json" >/dev/null
    node "$ROOT_DIR/tools/security/verify-security-challenge-kind-cutover.mjs" \
        --receipt "$EVIDENCE_DIR/challenge-kind-cutover-receipt.json" \
        --targets "$CHALLENGE_KIND_TARGET_MAP" \
        --release-id "$TARGET_RELEASE" --slot "$TARGET_SLOT" --generation "$TARGET_GENERATION" \
        >"$EVIDENCE_DIR/challenge-kind-cutover-acceptance.json"
    node "$ROOT_DIR/tools/deployment/invoke-perception-character-v3-cutover.mjs" \
        --port "$TARGET_PORT" --release-id "$TARGET_RELEASE" --slot "$TARGET_SLOT" \
        --generation "$TARGET_GENERATION" --operation-id "$ROLLOUT_ID:perception-character-v3-cutover" \
        --release-target "$PERCEPTION_V3_RELEASE_TARGET" \
        --pool-manifest "$PERCEPTION_V3_POOL_MANIFEST" \
        --policy-version "$PERCEPTION_V3_POLICY_VERSION" \
        --admin-header-file "$ADMIN_HEADER_FILE" --origin "$CONTROL_ORIGIN" \
        --receipt "$EVIDENCE_DIR/perception-character-v3-cutover-receipt.json" >/dev/null
    node "$ROOT_DIR/tools/deployment/verify-release-challenge-kind-cutover.mjs" \
        --rollout-state "$ROLLOUT_STATE_FILE" \
        --active-fence "$EVIDENCE_DIR/active-release-fence.json" \
        --cutover-acceptance "$EVIDENCE_DIR/challenge-kind-cutover-acceptance.json" \
        --perception-v3-cutover "$EVIDENCE_DIR/perception-character-v3-cutover-receipt.json" \
        --release-target "$PERCEPTION_V3_RELEASE_TARGET" \
        --pool-manifest "$PERCEPTION_V3_POOL_MANIFEST" \
        --policy-version "$PERCEPTION_V3_POLICY_VERSION" \
        --asset-materialization "$EVIDENCE_DIR/asset-materialization.json" \
        --public-aot-warm "$EVIDENCE_DIR/public-aot-warm.json" \
        --out "$EVIDENCE_DIR/challenge-kind-cutover-gate.json" >/dev/null
}

StageSourceStop() {
    "$ROOT_DIR/tools/deployment/slot-stop.sh" \
        --slot "$SOURCE_SLOT" --env-file "$PRODUCTION_ENV_FILE" --state-file "$SLOT_STATE_FILE" \
        --rollout-state "$ROLLOUT_STATE_FILE"
}

ArtifactArgs() {
    printf '%s\n' \
        --artifact "publicTraffic=$TRAFFIC_FINAL" \
        --artifact "notificationStream=$NOTIFICATION_EVIDENCE" \
        --artifact "assetCompatibility=$ASSET_COMPATIBILITY_EVIDENCE" \
        --artifact "workerReconciliation=$WORKER_RECONCILIATION_EVIDENCE" \
        --artifact "resourceBudget=$RESOURCE_BUDGET_EVIDENCE" \
        --artifact "faultInjection=$FAULT_INJECTION_EVIDENCE"
}

EnsureOperatorNote() {
    if [[ -f "$OPERATOR_NOTE_FILE" ]]; then
        jq -e --arg rolloutId "$ROLLOUT_ID" '
      .schema == "fsusblog.release-rollout-operator-note.v1"
      and .rolloutId == $rolloutId
      and (.provided | type == "boolean")
      and (.note | type == "string" and length <= 4000)
      and (.errors | type == "array" and length == 0)
    ' "$OPERATOR_NOTE_FILE" >/dev/null ||
            RolloutFail "operator note is not a valid structured note for rollout $ROLLOUT_ID"
        return 0
    fi
    [[ "$OPERATOR_NOTE_EXPLICIT" == "0" ]] || RolloutFail "explicit operator note file is missing: $OPERATOR_NOTE_FILE"
    local temporary="${OPERATOR_NOTE_FILE}.tmp-$$"
    mkdir -p "$(dirname "$OPERATOR_NOTE_FILE")"
    jq -n --arg rolloutId "$ROLLOUT_ID" --arg createdAtUtc "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '
    {
      schema:"fsusblog.release-rollout-operator-note.v1",
      rolloutId:$rolloutId,
      provided:false,
      author:null,
      note:"",
      createdAtUtc:$createdAtUtc,
      errors:[]
    }
  ' >"$temporary"
    mv -f "$temporary" "$OPERATOR_NOTE_FILE"
}

AuxiliaryArgs() {
    local gatewayEvidence
    gatewayEvidence="${FSUSBLOG_GATEWAY_EVIDENCE_DIR:-/var/lib/fsusblog/deployment/evidence}/latest.json"
    printf '%s\n' \
        --auxiliary "releaseManifest=$RELEASE_MANIFEST" \
        --auxiliary "backupRestoreGate=$EVIDENCE_DIR/backup-restore-gate.json" \
        --auxiliary "migrationExpand=$EVIDENCE_DIR/migration-expand.json" \
        --auxiliary "candidateReadiness=$EVIDENCE_DIR/candidate-readiness-gate.json" \
        --auxiliary "assetMaterialization=$EVIDENCE_DIR/asset-materialization.json" \
        --auxiliary "retentionPrepared=$EVIDENCE_DIR/asset-retention-prepared.json" \
        --auxiliary "retainedAssets=$EVIDENCE_DIR/retained-assets-before-switch.json" \
        --auxiliary "publicAotWarm=$EVIDENCE_DIR/public-aot-warm.json" \
        --auxiliary "candidateSmoke=$EVIDENCE_DIR/candidate-smoke.json" \
        --auxiliary "compatibilityMatrix=$EVIDENCE_DIR/compatibility-matrix.json" \
        --auxiliary "gatewayTransition=$gatewayEvidence" \
        --auxiliary "activeFenceAcquire=$EVIDENCE_DIR/active-release-fence.json" \
        --auxiliary "activeFenceSourceRevoke=$EVIDENCE_DIR/active-release-fence-source-revoke.json" \
        --auxiliary "activeFenceVerify=$EVIDENCE_DIR/active-release-fence-verified.json" \
        --auxiliary "challengeKindCutoverReceipt=$EVIDENCE_DIR/challenge-kind-cutover-receipt.json" \
        --auxiliary "challengeKindCutoverAcceptance=$EVIDENCE_DIR/challenge-kind-cutover-acceptance.json" \
        --auxiliary "challengeKindCutoverGate=$EVIDENCE_DIR/challenge-kind-cutover-gate.json" \
        --auxiliary "perceptionCharacterV3Cutover=$EVIDENCE_DIR/perception-character-v3-cutover-receipt.json" \
        --auxiliary "publicTrafficCheckpoint=$EVIDENCE_DIR/public-traffic-checkpoint.json" \
        --auxiliary "sourceDrainSnapshot=$EVIDENCE_DIR/source-drain.snapshot.json" \
        --auxiliary "sourceDrainGate=$EVIDENCE_DIR/source-drain-gate.json" \
        --auxiliary "targetHealth=$TARGET_HEALTH_EVIDENCE" \
        --auxiliary "retentionDrainComplete=$EVIDENCE_DIR/asset-retention-drain-complete.json" \
        --auxiliary "operatorNote=$OPERATOR_NOTE_FILE"
}

StageReleaseEvidence() {
    RequireContinuousProbeArtifacts
    EnsureOperatorNote
    local -a args=()
    mapfile -t args < <(ArtifactArgs)
    local -a auxiliary=()
    mapfile -t auxiliary < <(AuxiliaryArgs)
    args+=("${auxiliary[@]}")
    node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" preseal \
        --state "$ROLLOUT_STATE_FILE" --out "$PRESEAL_EVIDENCE" --replace "${args[@]}"
}

FinalizeRollout() {
    EnsureOperatorNote
    local -a args=()
    mapfile -t args < <(ArtifactArgs)
    local -a auxiliary=()
    mapfile -t auxiliary < <(AuxiliaryArgs)
    args+=("${auxiliary[@]}")
    if [[ -f "$FINAL_EVIDENCE" ]]; then
        [[ "$(jq -r --arg rolloutId "$ROLLOUT_ID" '.rolloutId == $rolloutId' "$FINAL_EVIDENCE" 2>/dev/null || printf false)" == "true" ]] ||
            RolloutFail "existing final evidence belongs to another rollout"
    else
        node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" finalize \
            --state "$ROLLOUT_STATE_FILE" --out "$FINAL_EVIDENCE" "${args[@]}" >/dev/null
    fi
    node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" verify --evidence "$FINAL_EVIDENCE" >/dev/null
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" complete \
        --state "$ROLLOUT_STATE_FILE" --evidence "$FINAL_EVIDENCE" >/dev/null
    RolloutLog "status=completed rollout=$ROLLOUT_ID evidence=$FINAL_EVIDENCE"
}

SlotAcquireDeploymentLock
export FSUSBLOG_DEPLOYMENT_LOCK_FD="${FSUSBLOG_DEPLOYMENT_LOCK_FD:-9}"
export FSUSBLOG_ROLLOUT_ENTRY=1
ReadInitialState
if [[ "$DRY_RUN" == "1" ]]; then
    PrintDryRun
    exit 0
fi

RequireRuntimeInputs
PRODUCTION_BUILD_RECEIPT="$(realpath "$PRODUCTION_BUILD_RECEIPT")"
export FSUSBLOG_PRODUCTION_BUILD_RECEIPT_HOST_PATH="$PRODUCTION_BUILD_RECEIPT"
export FSUSBLOG_RELEASE_ASSET_STORE="$ASSET_STORE"
CreateOrResumeState
if RolloutStageCompleted source-drain; then
    RequireContinuousProbeArtifacts
else
    StartPublicTraffic
    StartNotificationProbe
    StartResourceProbe
fi
StartAssetCompatibilityProbe

RunStage manifest-validate immutable-manifest StageManifestValidate
RunStage capacity-preflight host-capacity StageCapacityPreflight
RunStage backup-restore-gate backup-restore-evidence StageBackupRestoreGate
RunStage expand-migration online-expand StageExpandMigration
RunStage asset-materialize immutable-assets StageAssetMaterialize
RunStage candidate-start isolated-candidate StageCandidateStart
RunStage candidate-readiness release-aware-readiness StageCandidateReadiness
RunStage candidate-smoke direct-candidate-smoke StageCandidateSmoke
RunStage compatibility-smoke n-nminus1-compatibility StageCompatibilitySmoke

if [[ "$NO_SWITCH" == "1" ]]; then
    StopPublicTraffic || true
    StopNotificationProbe || true
    StopResourceProbe || true
    CancelAssetCompatibilityProbe || true
    node "$ROOT_DIR/tools/deployment/rollout-state.mjs" candidate-only --state "$ROLLOUT_STATE_FILE" >/dev/null
    RolloutLog "status=candidate_ready rollout=$ROLLOUT_ID state=$ROLLOUT_STATE_FILE"
    exit 0
fi

for file in "$NOTIFICATION_EVIDENCE" "$ASSET_COMPATIBILITY_EVIDENCE" "$WORKER_EVENT_LEDGER" "$WORKER_RECONCILIATION_EVIDENCE" "$RESOURCE_BUDGET_EVIDENCE" "$FAULT_INJECTION_EVIDENCE"; do
    [[ -n "$file" ]] || RolloutFail "a required final evidence output/input path was not configured before traffic switch"
done

RunStage gateway-switch atomic-gateway-switch StageGatewaySwitch
MarkGatewaySwitch
RunStage source-drain graceful-source-drain-and-cutover StageSourceDrain
RunStage active-fence active-release-cas StageActiveFence
RunStage public-verify continuous-public-traffic StagePublicVerify
RunStage source-stop retained-source-stop StageSourceStop
RunStage release-evidence immutable-release-evidence StageReleaseEvidence
FinalizeRollout

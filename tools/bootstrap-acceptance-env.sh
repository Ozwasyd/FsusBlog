#!/usr/bin/env bash
# fixture-catalog: consumer acceptance-bootstrap acceptance-representative
if ((BASH_VERSINFO[0] < 4)); then
    for candidate in "${FSUSBLOG_BASH:-}" /opt/homebrew/bin/bash /usr/local/bin/bash; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            exec "$candidate" "$0" "$@"
        fi
    done
    printf '%s\n' 'acceptance bootstrap requires Bash 4 or newer' >&2
    exit 1
fi
PATH="$(dirname "$BASH"):$PATH"
export PATH
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FSUSBLOG_REPOSITORY_ROOT_DIGEST="$(
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$ROOT_DIR" | sha256sum | awk '{printf "sha256:%s", $1}'
    else
        printf '%s' "$ROOT_DIR" | shasum -a 256 | awk '{printf "sha256:%s", $1}'
    fi
)"
export FSUSBLOG_REPOSITORY_ROOT_DIGEST
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_WWWROOT_DIR="${FSUSBLOG_BACKEND_WEBROOT:-$ROOT_DIR/src/backend/wwwroot}"
FrontendDistDir() {
    printf '%s' "${FSUSBLOG_FRONTEND_DIST_ROOT:-$CLIENT_DIR/dist}"
}
FSUSBLOG_TEST_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}"
NS_SLUG="$(printf '%s' "$FSUSBLOG_TEST_NAMESPACE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-' | sed -E 's/^-+|-+$//g')"
[[ -n "$NS_SLUG" && "$NS_SLUG" != "." && "$NS_SLUG" != ".." ]] || NS_SLUG="local"
FSUSBLOG_TEST_NAMESPACE="$NS_SLUG"
TMP_DIR="${FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/acceptance}/$NS_SLUG"
ENV_DIR="${FSUSBLOG_ACCEPTANCE_ENV_ROOT:-$ROOT_DIR/.tmp/env}"
FIXTURE_DIR="${FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT:-$ROOT_DIR/.tmp/fixtures}/$NS_SLUG"
PUBLIC_ID_PROJECTION_FILE="$FIXTURE_DIR/public-content-projection.json"
FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR="$FIXTURE_DIR/runtime-cache-inputs/${FSUSBLOG_TEST_RUN_ID:-uninitialized}"
mkdir -p "$TMP_DIR"
mkdir -p "$ENV_DIR" "$FIXTURE_DIR"

NowMonotonicMs() {
    "${FSUSBLOG_NODE:-node}" -e 'process.stdout.write(String(process.hrtime.bigint() / 1_000_000n))'
}

RandomBase64Key() {
    "${FSUSBLOG_NODE:-node}" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'
}

PORT_LEASE_SCRIPT="$ROOT_DIR/tools/test-matrix/production-fresh-port-lease.mjs"
PORT_LEASE_MANIFEST_FILE="${FSUSBLOG_PORT_LEASE_MANIFEST_FILE:-$TMP_DIR/port-leases.json}"
PORT_LEASE_SOCKET_ID="$(
    printf '%s\0%s\0%s' \
        "$ROOT_DIR" \
        "${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
        "$NS_SLUG" |
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum | awk '{printf "%.24s", $1}'
        else
            shasum -a 256 | awk '{printf "%.24s", $1}'
        fi
)"
PORT_LEASE_CONTROL_SOCKET="${FSUSBLOG_PORT_LEASE_CONTROL_SOCKET:-/tmp/fsusb-pl-$PORT_LEASE_SOCKET_ID.sock}"
PORT_LEASE_TOKEN_FILE="${FSUSBLOG_PORT_LEASE_TOKEN_FILE:-$TMP_DIR/port-lease.token}"
PORT_LEASE_PID_FILE="${FSUSBLOG_PORT_LEASE_PID_FILE:-$TMP_DIR/port-lease.pid}"
PORT_LEASE_TERMINAL_RECEIPT_FILE="${FSUSBLOG_PORT_LEASE_TERMINAL_RECEIPT_FILE:-$TMP_DIR/port-lease-terminal.json}"
PORT_LEASE_DAEMON_LOG="$TMP_DIR/port-lease-daemon.log"
PORT_LEASE_DAEMON_PID=""
PORT_LEASED_ROLES=""

PortLeaseCli() {
    "${FSUSBLOG_NODE:-node}" "$PORT_LEASE_SCRIPT" "$@"
}

ProductionFreshPortVariable() {
    case "$1" in
        postgres) printf 'FSUSBLOG_POSTGRES_PORT' ;;
        redis) printf 'FSUSBLOG_REDIS_PORT' ;;
        debug-backend) printf 'FSUSBLOG_DEBUG_BACKEND_PORT' ;;
        debug-frontend) printf 'FSUSBLOG_DEBUG_FRONTEND_PORT' ;;
        release-preview) printf 'FSUSBLOG_RELEASE_PREVIEW_PORT' ;;
        *) return 1 ;;
    esac
}

ProductionFreshAssignPort() {
    case "$1" in
        postgres) POSTGRES_PORT="$2" ;;
        redis) REDIS_PORT="$2" ;;
        debug-backend) DEBUG_BACKEND_PORT="$2" ;;
        debug-frontend) DEBUG_FRONTEND_PORT="$2" ;;
        release-preview) RELEASE_PREVIEW_PORT="$2" ;;
        *) return 1 ;;
    esac
}

LeaseRoleActive() {
    local role="$1"
    [[ -n "$PORT_LEASED_ROLES" && ",$PORT_LEASED_ROLES," == *",$role,"* ]]
}

PortLeasePortIsBound() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -H -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR == 1 { found = 1 } END { exit found ? 0 : 1 }'
        return
    fi
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1
}

ReleasePortLeaseBeforeBind() {
    local role="$1"
    local label="$2"
    if ! LeaseRoleActive "$role"; then
        return 0
    fi
    printf '[acceptance:bootstrap] port lease %s (%s) handoff begin\n' "$role" "$label"
    PortLeaseCli release-before-bind \
        --manifest "$PORT_LEASE_MANIFEST_FILE" \
        --token-file "$PORT_LEASE_TOKEN_FILE" \
        --role "$role"
}

CompletePortLeaseHandoff() {
    local role="$1"
    local label="$2"
    local listenerIdentityRef="$3"
    if ! LeaseRoleActive "$role"; then
        return 0
    fi
    printf '[acceptance:bootstrap] port lease %s (%s) bound listener=%s\n' "$role" "$label" "$listenerIdentityRef"
    PortLeaseCli complete-handoff \
        --manifest "$PORT_LEASE_MANIFEST_FILE" \
        --token-file "$PORT_LEASE_TOKEN_FILE" \
        --role "$role" \
        --listener-identity-ref "$listenerIdentityRef"
}

FailPortLeaseHandoff() {
    local role="$1"
    local label="$2"
    local reason="$3"
    if ! LeaseRoleActive "$role"; then
        return 0
    fi
    PortLeaseCli fail-handoff \
        --manifest "$PORT_LEASE_MANIFEST_FILE" \
        --token-file "$PORT_LEASE_TOKEN_FILE" \
        --role "$role" \
        --reason "$reason" >/dev/null 2>&1 || true
}

ReleaseAllPortLeases() {
    local reason="${1:-bootstrap-exit}"
    if [[ -z "$PORT_LEASED_ROLES" || -z "$PORT_LEASE_DAEMON_PID" ]]; then
        PORT_LEASED_ROLES=""
        return 0
    fi
    if ! kill -0 "$PORT_LEASE_DAEMON_PID" >/dev/null 2>&1; then
        PortLeaseCli recover --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1 || true
        PORT_LEASED_ROLES=""
        return 0
    fi
    printf '[acceptance:bootstrap] releasing production fresh port leases (%s)\n' "$reason"
    PortLeaseCli release-all \
        --manifest "$PORT_LEASE_MANIFEST_FILE" \
        --token-file "$PORT_LEASE_TOKEN_FILE" \
        --reason "$reason" >/dev/null 2>&1 || true
    PORT_LEASED_ROLES=""
}

VerifyLeasePortsMatchManifest() {
    local roles="$1"
    local role portVar manifestPort envPort
    for role in ${roles//,/ }; do
        portVar="$(ProductionFreshPortVariable "$role")" || return 1
        manifestPort="$(PortLeaseCli get-port --manifest "$PORT_LEASE_MANIFEST_FILE" --role "$role" 2>/dev/null || true)"
        if [[ -v $portVar ]]; then
            envPort="${!portVar}"
        else
            envPort=""
        fi
        if [[ -z "$manifestPort" ]] || [[ -n "$envPort" && "$manifestPort" != "$envPort" ]]; then
            printf '[acceptance:bootstrap] port lease role %s env=%s manifest=%s mismatch\n' "$role" "${envPort:-}" "${manifestPort:-}" >&2
            return 1
        fi
    done
    return 0
}

StartPortLeaseReservationDaemon() {
    local serveRoles="$1"
    local pinArgs="${2:-}"
    rm -f "$PORT_LEASE_CONTROL_SOCKET" "$PORT_LEASE_TOKEN_FILE" "$PORT_LEASE_PID_FILE"
    local -a pinOption=()
    if [[ -n "$pinArgs" ]]; then
        pinOption=(--pin "$pinArgs")
    fi
    if command -v setsid >/dev/null 2>&1; then
        setsid "${FSUSBLOG_NODE:-node}" "$PORT_LEASE_SCRIPT" serve \
            --run-id "${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
            --namespace "$NS_SLUG" \
            --roles "$serveRoles" \
            "${pinOption[@]}" \
            --manifest "$PORT_LEASE_MANIFEST_FILE" \
            --control-socket "$PORT_LEASE_CONTROL_SOCKET" \
            --token-file "$PORT_LEASE_TOKEN_FILE" \
            --pid-file "$PORT_LEASE_PID_FILE" \
            --terminal-receipt "$PORT_LEASE_TERMINAL_RECEIPT_FILE" \
            >"$PORT_LEASE_DAEMON_LOG" 2>&1 </dev/null &
    else
        nohup "${FSUSBLOG_NODE:-node}" "$PORT_LEASE_SCRIPT" serve \
            --run-id "${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
            --namespace "$NS_SLUG" \
            --roles "$serveRoles" \
            "${pinOption[@]}" \
            --manifest "$PORT_LEASE_MANIFEST_FILE" \
            --control-socket "$PORT_LEASE_CONTROL_SOCKET" \
            --token-file "$PORT_LEASE_TOKEN_FILE" \
            --pid-file "$PORT_LEASE_PID_FILE" \
            --terminal-receipt "$PORT_LEASE_TERMINAL_RECEIPT_FILE" \
            >"$PORT_LEASE_DAEMON_LOG" 2>&1 </dev/null &
    fi
    local deadline
    deadline="$(($(NowMonotonicMs) + 15000))"
    PORT_LEASE_DAEMON_PID=""
    while (($(NowMonotonicMs) < deadline)); do
        if [[ -f "$PORT_LEASE_PID_FILE" && -S "$PORT_LEASE_CONTROL_SOCKET" ]]; then
            PORT_LEASE_DAEMON_PID="$(cat "$PORT_LEASE_PID_FILE" 2>/dev/null || true)"
            if [[ -n "$PORT_LEASE_DAEMON_PID" ]] && kill -0 "$PORT_LEASE_DAEMON_PID" >/dev/null 2>&1; then
                break
            fi
            PORT_LEASE_DAEMON_PID=""
        fi
        sleep 0.1
    done
    if [[ -z "$PORT_LEASE_DAEMON_PID" ]] || ! kill -0 "$PORT_LEASE_DAEMON_PID" >/dev/null 2>&1; then
        printf '[acceptance:bootstrap] port lease reservation daemon failed to start\n' >&2
        tail -20 "$PORT_LEASE_DAEMON_LOG" >&2 || true
        return 1
    fi
    if ! PortLeaseCli verify --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1; then
        printf '[acceptance:bootstrap] port lease manifest verification failed; refusing unsealed ports\n' >&2
        return 1
    fi
    printf '[acceptance:bootstrap] started port lease reservation daemon pid=%s roles=%s\n' \
        "$PORT_LEASE_DAEMON_PID" "$serveRoles"
}

AssignPortsFromLeaseManifest() {
    local role port portVar
    for role in postgres redis debug-backend debug-frontend release-preview; do
        port="$(PortLeaseCli get-port --manifest "$PORT_LEASE_MANIFEST_FILE" --role "$role" 2>/dev/null || true)"
        if [[ -z "$port" ]] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
            printf '[acceptance:bootstrap] port lease role %s did not resolve a port\n' "$role" >&2
            return 1
        fi
        ProductionFreshAssignPort "$role" "$port"
        portVar="$(ProductionFreshPortVariable "$role")"
        export "$portVar=$port"
    done
}

AcquireProductionFreshPortLeases() {
    # 1) Explicit reattach: env file (or caller) references an active sealed lease set.
    if [[ -n "${FSUSBLOG_PORT_LEASED_ROLES:-}" ]]; then
        if [[ -n "${FSUSBLOG_PORT_LEASE_DAEMON_PID:-}" ]] &&
            kill -0 "$FSUSBLOG_PORT_LEASE_DAEMON_PID" >/dev/null 2>&1 &&
            [[ -S "$PORT_LEASE_CONTROL_SOCKET" ]] &&
            [[ -f "$PORT_LEASE_MANIFEST_FILE" ]]; then
            PORT_LEASE_DAEMON_PID="$FSUSBLOG_PORT_LEASE_DAEMON_PID"
            if ! PortLeaseCli verify --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1; then
                printf '[acceptance:bootstrap] port lease manifest verification failed; refusing unsealed ports\n' >&2
                return 1
            fi
            if ! VerifyLeasePortsMatchManifest "$FSUSBLOG_PORT_LEASED_ROLES"; then
                printf '[acceptance:bootstrap] refusing env reuse with ports that do not match the sealed manifest\n' >&2
                return 1
            fi
            PORT_LEASED_ROLES="$FSUSBLOG_PORT_LEASED_ROLES"
            printf '[acceptance:bootstrap] reusing port lease reservation daemon pid=%s roles=%s\n' \
                "$PORT_LEASE_DAEMON_PID" "$PORT_LEASED_ROLES"
            AssignPortsFromLeaseManifest
            return 0
        fi

        # Reservation owner died. If every leased port is already bound by a live
        # listener, the reservation was effectively handed off before the crash and
        # the run may proceed without reallocating (existing ownership checks still
        # validate reuse). Otherwise fail closed instead of silently re-choosing ports.
        PortLeaseCli recover --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1 || true
        local role portVar unbound=0
        for role in ${FSUSBLOG_PORT_LEASED_ROLES//,/ }; do
            portVar="$(ProductionFreshPortVariable "$role")"
            if [[ -z "${!portVar:-}" ]] || ! PortLeasePortIsBound "${!portVar}"; then
                printf '[acceptance:bootstrap] port lease %s is not bound by a live listener and its reservation owner is dead; refusing stale env reuse\n' "$role" >&2
                unbound=1
            fi
        done
        if ((unbound == 1)); then
            return 1
        fi
        printf '[acceptance:bootstrap] port lease reservation owner is dead but all leased ports are bound; treating handoff as complete\n'
        PORT_LEASED_ROLES=""
        PORT_LEASE_DAEMON_PID=""
        return 0
    fi

    # 2) Existing daemon from pid/control/manifest (covers partial reruns without metadata).
    local existingDaemonPid=""
    if [[ -f "$PORT_LEASE_PID_FILE" ]]; then
        existingDaemonPid="$(cat "$PORT_LEASE_PID_FILE" 2>/dev/null || true)"
    fi
    if [[ -n "$existingDaemonPid" ]] && kill -0 "$existingDaemonPid" >/dev/null 2>&1 &&
        [[ -S "$PORT_LEASE_CONTROL_SOCKET" ]] && [[ -f "$PORT_LEASE_MANIFEST_FILE" ]]; then
        PORT_LEASE_DAEMON_PID="$existingDaemonPid"
        if ! PortLeaseCli verify --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1; then
            printf '[acceptance:bootstrap] port lease manifest verification failed; refusing unsealed ports\n' >&2
            return 1
        fi
        local manifestRoles
        manifestRoles="$(PortLeaseCli roles --manifest "$PORT_LEASE_MANIFEST_FILE" 2>/dev/null || true)"
        if [[ -z "$manifestRoles" ]] || ! VerifyLeasePortsMatchManifest "$manifestRoles"; then
            printf '[acceptance:bootstrap] existing port lease manifest is inconsistent with env ports; refusing reuse\n' >&2
            return 1
        fi
        PORT_LEASED_ROLES="$manifestRoles"
        printf '[acceptance:bootstrap] reusing port lease reservation daemon pid=%s roles=%s\n' \
            "$PORT_LEASE_DAEMON_PID" "$PORT_LEASED_ROLES"
        AssignPortsFromLeaseManifest
        return 0
    fi
    if [[ -f "$PORT_LEASE_MANIFEST_FILE" ]]; then
        PortLeaseCli recover --manifest "$PORT_LEASE_MANIFEST_FILE" >/dev/null 2>&1 || true
    fi

    # 3) Fresh daemon. Missing roles are allocated freely; explicitly configured
    #    ports are pinned to the exact numbers so env writes only reference sealed leases.
    local role portVar
    local missingRoles=""
    local pinArgs=""
    for role in postgres redis debug-backend debug-frontend release-preview; do
        portVar="$(ProductionFreshPortVariable "$role")"
        if [[ -z "${!portVar:-}" ]]; then
            missingRoles="${missingRoles:+$missingRoles,}$role"
        else
            pinArgs="${pinArgs:+$pinArgs,}$role:${!portVar}"
        fi
    done
    if [[ -z "$missingRoles" ]]; then
        # All ports pinned. Adopt without a daemon only when every configured port
        # already has a live listener (legacy env reuse); otherwise the daemon must
        # reserve the exact ports to close the probe-to-bind race.
        local allBound=1
        for role in postgres redis debug-backend debug-frontend release-preview; do
            portVar="$(ProductionFreshPortVariable "$role")"
            if ! PortLeasePortIsBound "${!portVar}"; then
                allBound=0
                break
            fi
        done
        if ((allBound == 1)); then
            printf '[acceptance:bootstrap] all configured ports already have live listeners; adopting without a reservation daemon\n'
            PORT_LEASED_ROLES=""
            PORT_LEASE_DAEMON_PID=""
            return 0
        fi
    fi
    if ! StartPortLeaseReservationDaemon 'postgres,redis,debug-backend,debug-frontend,release-preview' "$pinArgs"; then
        return 1
    fi
    PORT_LEASED_ROLES='postgres,redis,debug-backend,debug-frontend,release-preview'
    AssignPortsFromLeaseManifest
}

ENV_FILE="$ENV_DIR/$NS_SLUG.env"
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        case "$key" in
            FSUSBLOG_POSTGRES_PORT) FSUSBLOG_POSTGRES_PORT="$value" ;;
            FSUSBLOG_REDIS_PORT) FSUSBLOG_REDIS_PORT="$value" ;;
            FSUSBLOG_DEBUG_BACKEND_PORT) FSUSBLOG_DEBUG_BACKEND_PORT="$value" ;;
            FSUSBLOG_DEBUG_FRONTEND_PORT) FSUSBLOG_DEBUG_FRONTEND_PORT="$value" ;;
            FSUSBLOG_RELEASE_PREVIEW_PORT) FSUSBLOG_RELEASE_PREVIEW_PORT="$value" ;;
            FSUSBLOG_DEBUG_FRONTEND_URL) FSUSBLOG_DEBUG_FRONTEND_URL="$value" ;;
            FSUSBLOG_DEBUG_BACKEND_URL) FSUSBLOG_DEBUG_BACKEND_URL="$value" ;;
            FSUSBLOG_RELEASE_PREVIEW_URL) FSUSBLOG_RELEASE_PREVIEW_URL="$value" ;;
            FSUSBLOG_POSTGRES_CONTAINER_NAME) FSUSBLOG_POSTGRES_CONTAINER_NAME="$value" ;;
            FSUSBLOG_REDIS_CONTAINER_NAME) FSUSBLOG_REDIS_CONTAINER_NAME="$value" ;;
            FSUSBLOG_NOTIFICATION_DRILL_SECRET) FSUSBLOG_NOTIFICATION_DRILL_SECRET="$value" ;;
            FSUSBLOG_DATA_ROOT) FSUSBLOG_DATA_ROOT="$value" ;;
            FSUSBLOG_RELEASE_DERIVED_ROOT) FSUSBLOG_RELEASE_DERIVED_ROOT="$value" ;;
            FSUSBLOG_RELEASE_ID) FSUSBLOG_RELEASE_ID="$value" ;;
            FSUSBLOG_PORT_LEASED_ROLES) FSUSBLOG_PORT_LEASED_ROLES="$value" ;;
            FSUSBLOG_PORT_LEASE_DAEMON_PID) FSUSBLOG_PORT_LEASE_DAEMON_PID="$value" ;;
            HumanReadProof__SigningKey) HUMAN_READ_PROOF_SIGNING_KEY="$value" ;;
            HumanReadProof__Dedup__CurrentKey) HUMAN_READ_PROOF_DEDUP_KEY="$value" ;;
            ReadAnalyticsPrivacy__NoiseKey) READ_ANALYTICS_NOISE_KEY="$value" ;;
        esac
    done <"$ENV_FILE"
fi

if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}" == "1" ]]; then
    POSTGRES_PORT="${FSUSBLOG_POSTGRES_PORT:-20000}"
    REDIS_PORT="${FSUSBLOG_REDIS_PORT:-22000}"
    DEBUG_BACKEND_PORT="${FSUSBLOG_DEBUG_BACKEND_PORT:-24000}"
    DEBUG_FRONTEND_PORT="${FSUSBLOG_DEBUG_FRONTEND_PORT:-26000}"
    RELEASE_PREVIEW_PORT="${FSUSBLOG_RELEASE_PREVIEW_PORT:-28000}"
else
    AcquireProductionFreshPortLeases
fi

PORT_LEASE_RELEASE_ON_EXIT=1
if [[ "${1:-}" == "--prepare-env-only" ]]; then
    PORT_LEASE_RELEASE_ON_EXIT=0
fi
PortLeaseReleaseTrap() {
    local reason="${1:-bootstrap-exit}"
    if ((PORT_LEASE_RELEASE_ON_EXIT == 1)); then
        ReleaseAllPortLeases "$reason"
    fi
}
trap 'PortLeaseReleaseTrap bootstrap-exit' EXIT
trap 'PortLeaseReleaseTrap signal-term; exit 143' TERM
trap 'PortLeaseReleaseTrap signal-int; exit 130' INT

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:${DEBUG_FRONTEND_PORT}}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:${DEBUG_BACKEND_PORT}}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:${RELEASE_PREVIEW_PORT}}"
CORS_ALLOWED_HOSTS_VALUE="${CORS_ALLOWED_HOSTS:-${DEBUG_FRONTEND_URL},${RELEASE_PREVIEW_URL},http://localhost:${DEBUG_FRONTEND_PORT},http://localhost:${RELEASE_PREVIEW_PORT}}"
POSTGRES_CONTAINER="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-fsusblog-test-postgres-$NS_SLUG}"
REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER_NAME:-fsusblog-test-redis-$NS_SLUG}"
POSTGRES_IMAGE_REFERENCE='postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
REDIS_IMAGE_REFERENCE='redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf'
EXECUTION_SERVICE_ENVELOPE_FILE="$FIXTURE_DIR/execution-envelope-services.json"
if [[ ! "$POSTGRES_CONTAINER" =~ ^fsusblog-(dev|test|ci)([-_.A-Za-z0-9]*)$ ]]; then
    POSTGRES_CONTAINER="fsusblog-test-postgres-$NS_SLUG"
fi
if [[ ! "$REDIS_CONTAINER" =~ ^fsusblog-(dev|test|ci)([-_.A-Za-z0-9]*)$ ]]; then
    REDIS_CONTAINER="fsusblog-test-redis-$NS_SLUG"
fi
TEST_DATA_ROOT="${FSUSBLOG_DATA_ROOT:-$ROOT_DIR/.tmp/data/$NS_SLUG}"
if [[ -z "${FSUSBLOG_RELEASE_ID:-}" ]]; then
    TEST_RELEASE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
    TEST_RELEASE_COMMIT_EPOCH="$(git -C "$ROOT_DIR" show -s --format=%ct "$TEST_RELEASE_COMMIT")"
    FSUSBLOG_RELEASE_ID="$(
        "${FSUSBLOG_NODE:-node}" - "$TEST_RELEASE_COMMIT_EPOCH" "$TEST_RELEASE_COMMIT" <<'NODE'
const epoch = Number.parseInt(process.argv[2], 10)
const commit = process.argv[3]
if (!Number.isSafeInteger(epoch) || epoch < 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('acceptance release identity source is invalid')
}
const timestamp = new Date(epoch * 1000).toISOString().replace(/\D/gu, '').slice(0, 14)
process.stdout.write(`${timestamp}-${commit.slice(0, 12)}`)
NODE
    )"
fi
FSUSBLOG_RELEASE_DERIVED_ROOT="${FSUSBLOG_RELEASE_DERIVED_ROOT:-$TEST_DATA_ROOT/release-derived}"
export FSUSBLOG_RELEASE_DERIVED_ROOT FSUSBLOG_RELEASE_ID
mkdir -p "$FSUSBLOG_RELEASE_DERIVED_ROOT"
POSTGRES_CONNECTION="Host=127.0.0.1;Port=${POSTGRES_PORT};Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true"
REDIS_CONNECTION="127.0.0.1:${REDIS_PORT}"
NOTIFICATION_DRILL_SECRET="${FSUSBLOG_NOTIFICATION_DRILL_SECRET:-fsus-notification-drill-$NS_SLUG}"
JWT_SECRET="${FSUSBLOG_TEST_JWT_SECRET:-fsusblog-local-acceptance-jwt-secret-${NS_SLUG}-change-me}"
JWT_KEY_VERSION="${FSUSBLOG_TEST_JWT_KEY_VERSION:-acceptance-v1}"
JWT_ISSUER="${FSUSBLOG_TEST_JWT_ISSUER:-FsusBlogServer}"
JWT_AUDIENCE="${FSUSBLOG_TEST_JWT_AUDIENCE:-FsusBlogClient}"
JWT_ACCESS_TOKEN_EXPIRES_MINUTES="${FSUSBLOG_TEST_JWT_ACCESS_TOKEN_EXPIRES_MINUTES:-1440}"
JWT_ROTATION_WINDOW_DAYS="${FSUSBLOG_TEST_JWT_ROTATION_WINDOW_DAYS:-30}"
POW_SIGNING_KEY="${FSUSBLOG_TEST_POW_SIGNING_KEY:-fsusblog-local-acceptance-pow-signing-key-${NS_SLUG}}"
POW_BASE_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_BASE_DIFFICULTY:-8}"
POW_MAX_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY:-8}"
RECOVERY_KEY_PEPPER="${FSUSBLOG_TEST_RECOVERY_KEY_PEPPER:-fsusblog-local-acceptance-recovery-key-pepper-${NS_SLUG}}"
MFA_TICKET_SIGNING_KEY="${FSUSBLOG_TEST_MFA_TICKET_SIGNING_KEY:-fsusblog-local-acceptance-mfa-ticket-signing-key-${NS_SLUG}}"
HUMAN_READ_PROOF_SIGNING_KEY="${HUMAN_READ_PROOF_SIGNING_KEY:-${FSUSBLOG_TEST_HUMAN_READ_PROOF_SIGNING_KEY:-$(RandomBase64Key)}}"
HUMAN_READ_PROOF_DEDUP_KEY="${HUMAN_READ_PROOF_DEDUP_KEY:-${FSUSBLOG_TEST_HUMAN_READ_PROOF_DEDUP_KEY:-$(RandomBase64Key)}}"
READ_ANALYTICS_NOISE_KEY="${READ_ANALYTICS_NOISE_KEY:-${FSUSBLOG_TEST_READ_ANALYTICS_NOISE_KEY:-$(RandomBase64Key)}}"
VISIT_LOG_IP_KEY_EPOCH="${FSUSBLOG_TEST_VISIT_LOG_IP_KEY_EPOCH:-1}"
VISIT_LOG_IP_KEY="${FSUSBLOG_TEST_VISIT_LOG_IP_KEY:-HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4=}"
MODERATION_PEPPER="${FSUSBLOG_TEST_MODERATION_PEPPER:-fsusblog-local-acceptance-moderation-pepper-${NS_SLUG}}"
MODERATION_REGION_IP_HASH_KEY="${FSUSBLOG_TEST_MODERATION_REGION_IP_HASH_KEY:-fsusblog-local-acceptance-region-ip-hash-key-${NS_SLUG}}"
SUBSCRIPTION_EMAIL_HASH_PEPPER="${FSUSBLOG_TEST_SUBSCRIPTION_EMAIL_HASH_PEPPER:-fsusblog-local-acceptance-subscription-email-hash-pepper-${NS_SLUG}}"
ANONYMOUS_SUBJECT_HASH_PEPPER="${FSUSBLOG_TEST_ANONYMOUS_SUBJECT_HASH_PEPPER:-fsusblog-local-acceptance-anonymous-subject-hash-pepper-${NS_SLUG}}"
ANONYMOUS_ROOT_ATTESTATION_KEY="${FSUSBLOG_TEST_ANONYMOUS_ROOT_ATTESTATION_KEY:-fsusblog-local-acceptance-anonymous-root-attestation-key-${NS_SLUG}}"
ANONYMOUS_NULLIFIER_PEPPER="${FSUSBLOG_TEST_ANONYMOUS_NULLIFIER_PEPPER:-fsusblog-local-acceptance-anonymous-nullifier-pepper-${NS_SLUG}}"
ANONYMOUS_IDENTITY_MODE="${FSUSBLOG_ANONYMOUS_IDENTITY_MODE:-1}"
RISK_PUBLIC_READ_CHALLENGE_ENABLED="${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_CHALLENGE_ENABLED:-false}"
PUBLIC_READ_PERMIT_LIMIT="${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_PERMIT_LIMIT:-100000}"
PUBLIC_READ_QUEUE_LIMIT="${FSUSBLOG_ACCEPTANCE_PUBLIC_READ_QUEUE_LIMIT:-10000}"
NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT="${FSUSBLOG_ACCEPTANCE_NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT:-50}"
LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="${FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET:-fsusblog-local-public-content-fixture-secret-${NS_SLUG}-${FSUSBLOG_TEST_RUN_ID:-local}}"
LOCAL_AUTH_FIXTURE_SECRET="${FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET:-fsusblog-local-auth-fixture-secret-${NS_SLUG}-${FSUSBLOG_TEST_RUN_ID:-local}}"
ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET="${FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET:-fsusblog-account-profile-preference-fixture-secret-${NS_SLUG}-${FSUSBLOG_TEST_RUN_ID:-local}}"
ACCEPTANCE_LOG_MAX_KIB="${FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB:-262144}"
if [[ ! "$ACCEPTANCE_LOG_MAX_KIB" =~ ^[0-9]+$ ]] || ((ACCEPTANCE_LOG_MAX_KIB < 1024)); then
    printf '[acceptance:bootstrap] FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB must be an integer >= 1024\n' >&2
    exit 1
fi
ulimit -f "$ACCEPTANCE_LOG_MAX_KIB"
PERCEPTION_SEALED_TOKEN_KEY="${FSUSBLOG_TEST_PERCEPTION_SEALED_TOKEN_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}"
FORCE_BOOTSTRAP="${FSUSBLOG_FORCE_BOOTSTRAP:-${CI:+1}}"
POW_READY_MAX_DIFFICULTY="${POW_MAX_DIFFICULTY}"
FIXTURE_PROFILE_PLAN_FILE=""
FIXTURE_PROFILE_ID=""
FIXTURE_PROFILE_SOURCE=""
FIXTURE_CATALOG_DIGEST=""
FIXTURE_CAPABILITY_DIGEST=""
FIXTURE_MUTATION_POLICY=""
FIXTURE_CAPABILITY_IDS=""
FIXTURE_PRODUCER_IDS=""
FIXTURE_REQUIRES_PUBLIC=0
FIXTURE_REQUIRES_DEMO=0
FIXTURE_REQUIRES_LOCAL_AUTH=0
FIXTURE_REQUIRES_ZK_ANONYMOUS=0
FIXTURE_REQUIRES_ANTI_SPAM_MODEL=0
FIXTURE_RECEIPT_FILE=""
FIXTURE_RECEIPT_DIGEST=""
FIXTURE_RECEIPT_TERMINAL_STATUS=""
ENVIRONMENT_READY_RECEIPT_FILE=""
RUNTIME_TOPOLOGY_INPUT_FILE=""
CURRENT_SCHEMA_CANDIDATE_ASSEMBLY=""
if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
    # A dedicated Browser Contract runtime is intentionally deterministic.  Do not
    # sample live CPU, memory, PID, or scheduler-grant state while bootstrapping it.
    PUBLIC_AOT_BACKFILL_CONCURRENCY=1
    PUBLIC_AOT_SSR_WORKER_COUNT=1
    RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU=1
else
    PUBLIC_AOT_BACKFILL_CONCURRENCY="${FSUSBLOG_PUBLIC_AOT_BACKFILL_CONCURRENCY:-$(
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-public-aot-concurrency.mjs"
    )}"
    PUBLIC_AOT_SSR_WORKER_COUNT="${FSUSBLOG_PUBLIC_AOT_SSR_WORKER_COUNT:-$PUBLIC_AOT_BACKFILL_CONCURRENCY}"
    RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU="${FSUSBLOG_RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU:-$(
        "${FSUSBLOG_NODE:-node}" --input-type=module -e '
      import fs from "node:fs";
      import os from "node:os";
      const policy = fs.readFileSync("tests/performance/perf-policy.yml", "utf8");
      const burst = policy.match(/(?:^|\n)([ \t]+)burst:\n([\s\S]*?)(?=\n\1\S|$)/u)?.[2] ?? "";
      const concurrency = Number(burst.match(/^[ \t]+concurrency:\s*(\d+)\s*$/mu)?.[1]);
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("burst concurrency is unavailable");
      const cpu = os.availableParallelism?.() ?? os.cpus().length;
      process.stdout.write(String(Math.max(1, Math.ceil(concurrency / cpu))));
    '
    )}"
fi
PUBLIC_AOT_SSR_CLIENT_ROOT="${FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT:-}"
PUBLIC_AOT_SSR_WORKER_SCRIPT="${FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT:-}"
if [[ ! "$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU" =~ ^[1-9][0-9]*$ ]]; then
    printf '[acceptance:bootstrap] FSUSBLOG_RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU must be a positive integer\n' >&2
    exit 1
fi
if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" == "1" && -z "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
    PUBLIC_AOT_SSR_WORKER_SCRIPT='./dist/server/server-public-ssr.bundle.mjs'
fi

PublishRuntimeObserverAuthority() {
    local phase="$1"
    if [[ -z "${FSUSBLOG_RUNTIME_SESSION_RECEIPT:-}" ||
        -z "${FSUSBLOG_RUNTIME_ORDER_FINGERPRINT_KEY_FILE:-}" ||
        -z "${FSUSBLOG_RUNTIME_ORDER_AUTHORITY_FILE:-}" ]]; then
        return 0
    fi
    local -a args=(
        --phase "$phase"
        --output "$FSUSBLOG_RUNTIME_ORDER_AUTHORITY_FILE"
        --session-receipt "$FSUSBLOG_RUNTIME_SESSION_RECEIPT"
        --environment "$ENV_FILE"
        --fingerprint-key "$FSUSBLOG_RUNTIME_ORDER_FINGERPRINT_KEY_FILE"
    )
    if [[ "$phase" == "ready" ]]; then
        args+=(
            --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE"
            --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE"
            --runtime-topology "$FIXTURE_DIR/runtime-topology.json"
            --fixture-receipt "$FIXTURE_RECEIPT_FILE"
            --aot-warm-report "${FSUSBLOG_PUBLIC_AOT_WARM_REPORT:-$TMP_DIR/public-aot-warm-evidence.json}"
            --object-storage-root "$FIXTURE_DIR/runtime-object-storage"
            --backend-process-identity "$TMP_DIR/backend.identity.json"
            --frontend-process-identity "$TMP_DIR/dev-server.identity.json"
            --release-process-identity "$TMP_DIR/preview.identity.json"
            --backend-executable "${FSUSBLOG_BACKEND_SERVER_DLL:?runtime observer requires backend executable}"
            --frontend-executable "$CLIENT_DIR/node_modules/vite/bin/vite.js"
            --release-executable "$CLIENT_DIR/node_modules/vite/bin/vite.js"
        )
        if [[ -n "${FSUSBLOG_RUNTIME_ORDER_BROWSER_STORAGE_FILE:-}" ]]; then
            args+=(--browser-storage "$FSUSBLOG_RUNTIME_ORDER_BROWSER_STORAGE_FILE")
        fi
    fi
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-runtime/production-observer-authority.mjs" "${args[@]}"
}

WriteEnvFile() {
    cat >"$ENV_FILE" <<EOF
FSUSBLOG_TEST_NAMESPACE=$FSUSBLOG_TEST_NAMESPACE
FSUSBLOG_POSTGRES_PORT=$POSTGRES_PORT
FSUSBLOG_REDIS_PORT=$REDIS_PORT
FSUSBLOG_DEBUG_BACKEND_PORT=$DEBUG_BACKEND_PORT
FSUSBLOG_DEBUG_FRONTEND_PORT=$DEBUG_FRONTEND_PORT
FSUSBLOG_RELEASE_PREVIEW_PORT=$RELEASE_PREVIEW_PORT
FSUSBLOG_DEBUG_FRONTEND_URL=$DEBUG_FRONTEND_URL
FSUSBLOG_DEBUG_BACKEND_URL=$DEBUG_BACKEND_URL
FSUSBLOG_RELEASE_PREVIEW_URL=$RELEASE_PREVIEW_URL
FSUSBLOG_POSTGRES_CONTAINER_NAME=$POSTGRES_CONTAINER
FSUSBLOG_REDIS_CONTAINER_NAME=$REDIS_CONTAINER
FSUSBLOG_TEST_SERVICE_ENVELOPE_FILE=$EXECUTION_SERVICE_ENVELOPE_FILE
FSUSBLOG_PORT_LEASED_ROLES=${PORT_LEASED_ROLES:-}
FSUSBLOG_PORT_LEASE_DAEMON_PID=${PORT_LEASE_DAEMON_PID:-}
FSUSBLOG_PORT_LEASE_MANIFEST_FILE=$PORT_LEASE_MANIFEST_FILE
FSUSBLOG_NOTIFICATION_DRILL_SECRET=$NOTIFICATION_DRILL_SECRET
FSUSBLOG_DATA_ROOT=$TEST_DATA_ROOT
FSUSBLOG_RELEASE_DERIVED_ROOT=$FSUSBLOG_RELEASE_DERIVED_ROOT
FSUSBLOG_RELEASE_ID=$FSUSBLOG_RELEASE_ID
FSUSBLOG_PUBLIC_ID_PROJECTION_FILE=$PUBLIC_ID_PROJECTION_FILE
FSUSBLOG_FIXTURE_ROOT=${FSUSBLOG_FIXTURE_ROOT:-$FIXTURE_DIR}
FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR=$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR
FSUSBLOG_FIXTURE_SERVICE_GENERATION=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-uninitialized}
FSUSBLOG_RUNTIME_CONFIGURATION=${FSUSBLOG_RUNTIME_CONFIGURATION:-}
FSUSBLOG_RUNTIME_NO_BUILD=${FSUSBLOG_RUNTIME_NO_BUILD:-0}
FSUSBLOG_TEST_RUN_ID=${FSUSBLOG_TEST_RUN_ID:-}
FSUSBLOG_TEST_BUSINESS_EPOCH_UTC=${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-}
FSUSBLOG_TEMPORAL_CONTEXT_FILE=${FSUSBLOG_TEMPORAL_CONTEXT_FILE:-}
FSUSBLOG_PHYSICAL_BUNDLE_ID=${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}
FSUSBLOG_STEP_ID=${FSUSBLOG_STEP_ID:-}
FSUSBLOG_TEST_RUNTIME_MODE=${FSUSBLOG_TEST_RUNTIME_MODE:-single}
FSUSBLOG_TEST_NODE_COUNT=${FSUSBLOG_TEST_NODE_COUNT:-1}
FSUSBLOG_TEST_ARTIFACT_STORAGE=${FSUSBLOG_TEST_ARTIFACT_STORAGE:-local}
FSUSBLOG_TEST_COORDINATION_STORE=${FSUSBLOG_TEST_COORDINATION_STORE:-none}
FSUSBLOG_TEST_CLUSTER_SCENARIO=${FSUSBLOG_TEST_CLUSTER_SCENARIO:-none}
FSUSBLOG_TEST_CLUSTER_BOOTSTRAP=${FSUSBLOG_TEST_CLUSTER_BOOTSTRAP:-none}
FSUSBLOG_TEST_CLUSTER_FIXTURES=${FSUSBLOG_TEST_CLUSTER_FIXTURES:-}
FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}
FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID=${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}
FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET=${FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET:-}
FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET=${FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET:-}
ConnectionStrings__DefaultConnection=$POSTGRES_CONNECTION
ConnectionStrings__Redis=$REDIS_CONNECTION
RedisOptions__Configuration=$REDIS_CONNECTION
RedisOptions__InstanceName=FsusBlog_${NS_SLUG}_
NotificationStream__DrillSecret=$NOTIFICATION_DRILL_SECRET
Jwt__KeyVersion=$JWT_KEY_VERSION
Jwt__SecretKey=$JWT_SECRET
Jwt__Issuer=$JWT_ISSUER
Jwt__Audience=$JWT_AUDIENCE
Jwt__AccessTokenExpiresMinutes=$JWT_ACCESS_TOKEN_EXPIRES_MINUTES
Jwt__RotationWindowDays=$JWT_ROTATION_WINDOW_DAYS
Security__Pow__SigningKey=$POW_SIGNING_KEY
Security__Pow__BaseDifficulty=$POW_BASE_DIFFICULTY
Security__Pow__MaxDifficulty=$POW_MAX_DIFFICULTY
Security__PerceptionSealedToken__CurrentKeyVersion=dev
Security__PerceptionSealedToken__Keys__dev=$PERCEPTION_SEALED_TOKEN_KEY
Security__RecoveryKeyPepper=$RECOVERY_KEY_PEPPER
MfaChallenge__TicketSigningKey=$MFA_TICKET_SIGNING_KEY
HumanReadProof__SigningKey=$HUMAN_READ_PROOF_SIGNING_KEY
HumanReadProof__Dedup__CurrentKey=$HUMAN_READ_PROOF_DEDUP_KEY
ReadAnalyticsPrivacy__NoiseKey=$READ_ANALYTICS_NOISE_KEY
VisitLog__IpPseudonymization__CurrentEpoch=$VISIT_LOG_IP_KEY_EPOCH
VisitLog__IpPseudonymization__CurrentKey=$VISIT_LOG_IP_KEY
Moderation__Pepper=$MODERATION_PEPPER
Moderation__RegionPolicy__IpHashKey=$MODERATION_REGION_IP_HASH_KEY
Subscription__EmailHashPepper=$SUBSCRIPTION_EMAIL_HASH_PEPPER
AnonymousCredentialIssuer__IssuerPublicKeyId=local-acceptance-issuer
AnonymousCredentialIssuer__SubjectHashPepper=$ANONYMOUS_SUBJECT_HASH_PEPPER
AnonymousCredentialRoot__AttestationKey=$ANONYMOUS_ROOT_ATTESTATION_KEY
AnonymousCredentialRoot__AttestationKeyId=local-acceptance-root
AnonymousIdentity__NullifierPepper=$ANONYMOUS_NULLIFIER_PEPPER
FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$ANONYMOUS_IDENTITY_MODE
Security__RiskControl__PublicReadChallenge__Enabled=$RISK_PUBLIC_READ_CHALLENGE_ENABLED
RateLimiting__PublicReadPermitLimit=$PUBLIC_READ_PERMIT_LIMIT
RateLimiting__PublicReadQueueLimit=$PUBLIC_READ_QUEUE_LIMIT
NotificationStream__MaxConnectionsPerAccount=$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT
PublicAot__BackfillConcurrency=$PUBLIC_AOT_BACKFILL_CONCURRENCY
PublicAot__SsrWorkerCount=$PUBLIC_AOT_SSR_WORKER_COUNT
PublicAot__SsrClientRoot=$PUBLIC_AOT_SSR_CLIENT_ROOT
PublicAot__SsrWorkerScript=$PUBLIC_AOT_SSR_WORKER_SCRIPT
ActiveReleaseFence__AllowSyntheticLocalFence=true
RuntimeTuning__ThreadPool__Enabled=true
RuntimeTuning__ThreadPool__MinThreadsPerCpu=$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU
ASPNETCORE_URLS=http://127.0.0.1:$DEBUG_BACKEND_PORT
ASPNETCORE_ENVIRONMENT=Development
Testing__EnforceProductionCsp=true
CORS_ALLOWED_HOSTS=$CORS_ALLOWED_HOSTS_VALUE
AuthCookies__AllowInsecureTransportCookies=true
EOF
    PublishRuntimeObserverAuthority config
}

Log() {
    printf '[acceptance:bootstrap] %s\n' "$1"
}

RepositoryRelativePath() {
    "${FSUSBLOG_NODE:-node}" - "$ROOT_DIR" "$1" <<'NODE'
const path = require('node:path')
const root = path.resolve(process.argv[2])
const target = path.resolve(process.argv[3])
if (target === root || !target.startsWith(`${root}${path.sep}`)) {
  throw new Error(`CI production build destination escapes repository: ${target}`)
}
process.stdout.write(path.relative(root, target).replaceAll(path.sep, '/'))
NODE
}

MaterializeCiProductionBuild() {
    local artifactRoot="${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}"
    if [[ -z "$artifactRoot" ]]; then
        return
    fi
    local receiptFile="$artifactRoot/receipt.json"
    if [[ ! -f "$receiptFile" ]]; then
        Log "immutable CI production receipt is missing: $receiptFile"
        return 1
    fi
    local -a domains=()
    mapfile -t domains < <(
        "${FSUSBLOG_NODE:-node}" - "$receiptFile" <<'NODE'
const fs = require('node:fs')
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!Array.isArray(receipt.domains) || receipt.domains.length === 0) throw new Error('CI production receipt has no domains')
for (const domain of receipt.domains) process.stdout.write(`${domain.name}\n`)
NODE
    )
    local producerWorkflow producerRunId producerRunAttempt producerJob
    if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
        producerWorkflow="${GITHUB_WORKFLOW:?GITHUB_WORKFLOW is required for GitHub production artifact materialization}"
        producerRunId="$GITHUB_RUN_ID"
        producerRunAttempt="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required for GitHub production artifact materialization}"
        producerJob=production-build-artifacts
    else
        producerWorkflow="${FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW:?FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW is required for local production artifact materialization}"
        producerRunId="${FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID:?FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID is required for local production artifact materialization}"
        producerRunAttempt="${FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT:?FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT is required for local production artifact materialization}"
        producerJob="${FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB:?FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB is required for local production artifact materialization}"
    fi
    local -a materializeArgs=(
        materialize
        --root "$ROOT_DIR"
        --artifact-root "$artifactRoot"
        --destination-root "$ROOT_DIR"
        --expected-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required for CI artifact materialization}"
        --expected-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required for CI artifact materialization}"
        --expected-workflow "$producerWorkflow"
        --expected-run-id "$producerRunId"
        --expected-run-attempt "$producerRunAttempt"
        --expected-job "$producerJob"
        --expected-receipt-digest "${FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST:?FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST is required}"
        --consumer-run-id "${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required for CI artifact consumer leases}"
        --consumer-id "$NS_SLUG"
        --evidence "${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/jobs/ci-build-materialization-${NS_SLUG}.json"
    )
    local domain
    for domain in "${domains[@]}"; do
        case "$domain" in
            backend-runtime)
                # The backend serves as a runtime consumer: public AEDS/cache
                # artifacts are written below its content root. Keep the CI
                # artifact immutable and provide a copy-up writable layer for
                # the run-bound process instead of symlinking into the sealed
                # producer payload.
                materializeArgs+=(--map "backend-runtime:copy-before-write=$(RepositoryRelativePath "$(dirname "${FSUSBLOG_BACKEND_SERVER_DLL:?FSUSBLOG_BACKEND_SERVER_DLL is required}")")")
                ;;
            test-runtime)
                materializeArgs+=(--map "test-runtime=$(RepositoryRelativePath "${FSUSBLOG_BACKEND_TEST_BIN_DIR:?FSUSBLOG_BACKEND_TEST_BIN_DIR is required}")")
                ;;
            frontend-dist)
                materializeArgs+=(--map "frontend-dist=$(RepositoryRelativePath "${FSUSBLOG_FRONTEND_DIST_ROOT:?FSUSBLOG_FRONTEND_DIST_ROOT is required}")")
                materializeArgs+=(--map "frontend-dist:copy-before-write=$(RepositoryRelativePath "$SERVER_WWWROOT_DIR")")
                ;;
            ssr-runtime)
                materializeArgs+=(--map "ssr-runtime=$(RepositoryRelativePath "${PUBLIC_AOT_SSR_CLIENT_ROOT:?PUBLIC_AOT_SSR_CLIENT_ROOT is required for ssr-runtime materialization}")")
                ;;
            wasm)
                materializeArgs+=(--map "wasm=$(RepositoryRelativePath "${FSUSBLOG_FRONTEND_WASM_ROOT:?FSUSBLOG_FRONTEND_WASM_ROOT is required}")")
                ;;
            generated-contracts)
                materializeArgs+=(--map "generated-contracts=$(RepositoryRelativePath "${FSUSBLOG_GENERATED_OUTPUT_ROOT:?FSUSBLOG_GENERATED_OUTPUT_ROOT is required}")/ci-contracts")
                ;;
            *)
                Log "immutable CI production receipt has unsupported domain: $domain"
                return 1
                ;;
        esac
    done
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/production-build-artifacts-cli.mjs" "${materializeArgs[@]}" >/dev/null
    FSUSBLOG_RUNTIME_NO_BUILD=1
    FSUSBLOG_RUNTIME_CONFIGURATION=Release
    if [[ -z "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
        PUBLIC_AOT_SSR_WORKER_SCRIPT='./dist/server/server-public-ssr.bundle.mjs'
    fi
    export FSUSBLOG_RUNTIME_NO_BUILD FSUSBLOG_RUNTIME_CONFIGURATION PUBLIC_AOT_SSR_WORKER_SCRIPT
    FSUSBLOG_CI_PRODUCTION_DOMAINS="$(
        IFS=,
        printf '%s' "${domains[*]}"
    )"
    export FSUSBLOG_CI_PRODUCTION_DOMAINS
    Log "materialized verified immutable CI production domains into run-bound build root: $FSUSBLOG_CI_PRODUCTION_DOMAINS"
}

MaterializeCiProductionBuild
if [[ -n "${FSUSBLOG_FRONTEND_DIST_ROOT:-}" &&
    -f "$FSUSBLOG_FRONTEND_DIST_ROOT/server/server-public-ssr.bundle.mjs" &&
    -f "$FSUSBLOG_FRONTEND_DIST_ROOT/server/public-ssr.mjs" &&
    ! -f "${PUBLIC_AOT_SSR_CLIENT_ROOT:-/nonexistent}/server/server-public-ssr.bundle.mjs" ]]; then
    PUBLIC_AOT_SSR_CLIENT_ROOT="${PUBLIC_AOT_SSR_CLIENT_ROOT:-$(dirname "$FSUSBLOG_FRONTEND_DIST_ROOT")/ssr-runtime}"
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docker/ssr-runtime-closure.mjs" materialize \
        --client-root "$CLIENT_DIR" \
        --dist "$FSUSBLOG_FRONTEND_DIST_ROOT" \
        --inventory "$ROOT_DIR/config/build/ssr-runtime-inputs.json" \
        --output "$PUBLIC_AOT_SSR_CLIENT_ROOT"
    PUBLIC_AOT_SSR_WORKER_SCRIPT='./server/server-public-ssr.bundle.mjs'
fi
if [[ -n "$PUBLIC_AOT_SSR_CLIENT_ROOT" &&
    -f "$PUBLIC_AOT_SSR_CLIENT_ROOT/server/server-public-ssr.bundle.mjs" &&
    -f "$PUBLIC_AOT_SSR_CLIENT_ROOT/server/public-ssr.mjs" ]]; then
    PUBLIC_AOT_SSR_WORKER_SCRIPT='./server/server-public-ssr.bundle.mjs'
fi
WriteEnvFile

CiProductionHasDomain() {
    local expected="$1"
    if [[ -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
        return 0
    fi
    [[ ",${FSUSBLOG_CI_PRODUCTION_DOMAINS:-}," == *",${expected},"* ]]
}

EXECUTION_STARTED_AT_MS="$(NowMonotonicMs)"
DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS=240000
PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS=1800000
ResolveExecutionBudgetMs() {
    local inherited="${FSUSBLOG_STEP_DEADLINE_MS:-${FSUSBLOG_BUNDLE_DEADLINE_MS:-}}"
    if [[ "${FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE:-0}" == "1" ]]; then
        printf '%s\n' "$PUBLIC_PREVIEW_CAPTURE_EXECUTION_BUDGET_CAP_MS"
        return 0
    fi
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        if [[ -z "$inherited" ]]; then
            printf '%s\n' "$DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS"
            return 0
        fi
        awk -v value="$inherited" -v cap="$DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS" '
      BEGIN {
        if (value !~ /^[0-9]+([.][0-9]+)?$/ || value <= 0) exit 1
        rounded = int(value + 0.999999)
        printf "%.0f\n", rounded < cap ? rounded : cap
      }
    ' || {
            printf '[acceptance:bootstrap] dedicated execution deadline must be a finite positive number\n' >&2
            return 1
        }
        return 0
    fi
    if [[ -n "$inherited" ]]; then
        awk -v value="$inherited" 'BEGIN { if (value !~ /^[0-9]+([.][0-9]+)?$/ || value <= 0) exit 1; printf "%.0f\n", int(value + 0.999999) }' ||
            {
                printf '[acceptance:bootstrap] step/bundle execution deadline must be a finite positive number\n' >&2
                return 1
            }
        return
    fi

    (
        cd "$ROOT_DIR"
        "${FSUSBLOG_NODE:-node}" --input-type=module -e '
      import fs from "node:fs";
      import os from "node:os";
      import { parseMatrix } from "./tools/test-matrix/parse-matrix.mjs";
      const matrix = parseMatrix(fs.readFileSync("tests/matrix.yml", "utf8"));
      const profile = matrix.localProfiles?.production;
      const runtime = profile?.bundles?.find((entry) => entry.id === "runtime-browser");
      if (!Number.isFinite(profile?.budgetMs) || !runtime) throw new Error("production runtime budget is unavailable");
      const cpu = os.availableParallelism?.() ?? os.cpus().length;
      const freeMemoryGiB = os.freemem() / (1024 ** 3);
      const scale = Math.max(1, runtime.cpuWeight / cpu, runtime.memoryWeight / freeMemoryGiB, runtime.minCpuUnits / cpu);
      process.stdout.write(String(Math.ceil(profile.budgetMs * scale)));
    '
    )
}

EXECUTION_BUDGET_MS="$(ResolveExecutionBudgetMs)"
EXECUTION_DEADLINE_AT_MS=$((EXECUTION_STARTED_AT_MS + EXECUTION_BUDGET_MS))
READINESS_PHASES_REMAINING=1
READINESS_DEADLINE_AT_MS="$EXECUTION_DEADLINE_AT_MS"

AllocateReadinessDeadline() {
    local label="$1"
    local now remaining phaseBudget
    now="$(NowMonotonicMs)"
    remaining=$((EXECUTION_DEADLINE_AT_MS - now))
    if ((remaining <= 0)); then
        Log "$label has no remaining execution deadline"
        return 1
    fi
    if ((READINESS_PHASES_REMAINING < 1)); then
        READINESS_PHASES_REMAINING=1
    fi
    phaseBudget=$(((remaining + READINESS_PHASES_REMAINING - 1) / READINESS_PHASES_REMAINING))
    READINESS_DEADLINE_AT_MS=$((now + phaseBudget))
    READINESS_PHASES_REMAINING=$((READINESS_PHASES_REMAINING - 1))
    Log "$label readiness budget=${phaseBudget}ms remaining-execution=${remaining}ms"
}

ResolveBootstrapParallelWorkers() {
    local jobCount="$1"
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        printf '1\n'
        return 0
    fi
    FSUSBLOG_COMMAND_MANIFEST_WORKERS="$jobCount" \
        "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const {
  resolveManifestLiveCapacity
} = await import(pathToFileURL(process.argv[2]).href)
const jobCount = Number.parseInt(process.env.FSUSBLOG_COMMAND_MANIFEST_WORKERS ?? '', 10)
const capacity = resolveManifestLiveCapacity({ env: process.env, workload: 'scheduler-admitted' })
process.stdout.write(String(Math.max(1, Math.min(jobCount, capacity.maxParallel))))
NODE
}

ResolveBootstrapChildEnvironment() {
    local workers="$1"
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        printf '%s\n' \
            'FSUSBLOG_COMMAND_MANIFEST_WORKERS=1' \
            'FSUSBLOG_NODE_TEST_CONCURRENCY=1'
        return 0
    fi
    FSUSBLOG_BOOTSTRAP_WORKERS="$workers" \
        "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.env.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL) {
  const { readDataScaleBaselineContainerControls } = await import(pathToFileURL(
    new URL('./data-scale-runtime-caller.mjs', pathToFileURL(process.argv[2])).pathname
  ).href)
  const controls = await readDataScaleBaselineContainerControls({
    repositoryRoot: fileURLToPath(new URL('../../', pathToFileURL(process.argv[2]))),
    environment: process.env
  })
  const role = controls.roles.postgres
  for (const [key, value] of Object.entries({
    FSUSBLOG_DOCKER_CPU_UNITS: role.cpuUnits,
    FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: role.memoryHighBytes,
    FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: role.memoryMaxBytes,
    FSUSBLOG_DOCKER_PIDS_MAX: role.pidsMax
  })) process.stdout.write(`${key}=${value}\n`)
  process.exit(0)
}

const {
  readManifestSchedulerResourceGrant,
  resolveManifestChildEnvironment
} = await import(pathToFileURL(process.argv[2]).href)
const workers = Number.parseInt(process.env.FSUSBLOG_BOOTSTRAP_WORKERS ?? '', 10)
const liveGrant = readManifestSchedulerResourceGrant({ env: process.env })
const env = liveGrant
  ? {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: String(liveGrant.cpuUnits),
      FSUSBLOG_STEP_MEMORY_GIB: String(liveGrant.memoryGiB)
    }
  : process.env
const child = resolveManifestChildEnvironment({
  env,
  workers,
  concurrent: workers > 1
})
const bytesPerGiB = 1024 ** 3
const positiveNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const machineCpu = os.availableParallelism?.() ?? os.cpus().length
const childCpu = positiveNumber(child.FSUSBLOG_STEP_CPU_BUDGET, 1)
const dockerCpu = Math.max(0.001, Math.floor(childCpu * 1000) / 1000)
const childMemoryHigh = Math.max(1, Math.floor(
  positiveNumber(child.FSUSBLOG_STEP_MEMORY_GIB, 1) * bytesPerGiB
))
const parentCpu = positiveNumber(env.FSUSBLOG_STEP_CPU_BUDGET, machineCpu)
const parentMemoryHigh = Math.max(1, Math.floor(positiveNumber(
  env.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES,
  positiveNumber(env.FSUSBLOG_STEP_MEMORY_GIB, os.freemem() / bytesPerGiB) * bytesPerGiB
)))
const defaultHeadroom = Math.max(
  64 * 1024 ** 2,
  Math.floor(parentMemoryHigh / Math.sqrt(Math.max(1, machineCpu * 16)))
)
const parentMemoryMax = Math.max(parentMemoryHigh, Math.floor(positiveNumber(
  env.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES,
  parentMemoryHigh + defaultHeadroom
)))
const parentPids = Math.max(1, Math.floor(positiveNumber(
  env.FSUSBLOG_DOCKER_PIDS_MAX,
  Math.max(64, Math.ceil(parentCpu * 128))
)))
child.FSUSBLOG_DOCKER_CPU_UNITS = String(dockerCpu)
child.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES = String(childMemoryHigh)
child.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES = String(Math.max(
  childMemoryHigh,
  childMemoryHigh + Math.floor((parentMemoryMax - parentMemoryHigh) / workers)
))
child.FSUSBLOG_DOCKER_PIDS_MAX = String(Math.max(1, Math.floor(parentPids / workers)))
for (const key of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY',
  'FSUSBLOG_DOCKER_CPU_UNITS',
  'FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES',
  'FSUSBLOG_DOCKER_MEMORY_MAX_BYTES',
  'FSUSBLOG_DOCKER_PIDS_MAX'
]) {
  if (child[key] !== undefined) process.stdout.write(`${key}=${child[key]}\n`)
}
NODE
}

CleanupBootstrapParallelChildren() {
    local statusDir="$1"
    shift
    local childPid
    for childPid in "$@"; do
        [[ -n "$childPid" ]] || continue
        kill "$childPid" >/dev/null 2>&1 || true
        wait "$childPid" >/dev/null 2>&1 || true
    done
    rm -rf "$statusDir"
}

CleanupBootstrapParallelSignal() {
    CleanupBootstrapParallelChildren "$@"
    exit 130
}

CleanupBootstrapParallelReturn() {
    local returnStatus="$1"
    shift
    CleanupBootstrapParallelChildren "$@"
    trap - RETURN INT TERM
    return "$returnStatus"
}

RunBootstrapParallel() {
    local group="$1"
    local readinessDeadline="$2"
    shift 2
    if (($# == 0 || $# % 2 != 0)); then
        Log "$group requires label/function pairs"
        return 2
    fi

    local total=$(($# / 2))
    local workerCap
    workerCap="$(ResolveBootstrapParallelWorkers "$total")"
    local statusDir
    statusDir="$TMP_DIR/parallel-$(printf '%s' "$group" | tr -cs 'A-Za-z0-9_.-' '-')-$$-$RANDOM"
    local -a labels=()
    local -a commands=()
    local -a statusFiles=()
    local -a childPids=()
    local -a observed=()
    mkdir -p "$statusDir"
    trap 'CleanupBootstrapParallelSignal "$statusDir" "${childPids[@]:-}"' INT TERM
    trap 'CleanupBootstrapParallelReturn "$?" "$statusDir" "${childPids[@]:-}"' RETURN

    while (($# > 0)); do
        local label="$1"
        local command="$2"
        shift 2
        if ! declare -F "$command" >/dev/null; then
            rm -rf "$statusDir"
            Log "$group job $label references unknown function $command"
            return 2
        fi
        labels+=("$label")
        commands+=("$command")
        statusFiles+=("$statusDir/${#labels[@]}.status")
    done

    Log "$group start jobs=$total workers=$workerCap"
    local next=0
    local active=0
    local completed=0
    while ((next < total || active > 0)); do
        local nextWorkerCap
        nextWorkerCap="$(ResolveBootstrapParallelWorkers "$total")"
        if [[ "$nextWorkerCap" != "$workerCap" ]]; then
            Log "$group capacity update workers=$workerCap->$nextWorkerCap active=$active"
            workerCap="$nextWorkerCap"
        fi
        local waveChildEnvFile=''
        local waveChildEnvStatus=0
        if ((next < total && active < workerCap)); then
            waveChildEnvFile="$statusDir/wave-$next-$workerCap.env"
            if ResolveBootstrapChildEnvironment "$workerCap" >"$waveChildEnvFile"; then
                :
            else
                waveChildEnvStatus=$?
            fi
        fi
        while ((next < total && active < workerCap)); do
            local index="$next"
            if ((waveChildEnvStatus == 0)); then
                (
                    set +e
                    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
                        unset FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE
                        unset FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE
                        unset FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX
                    fi
                    while IFS='=' read -r key value; do
                        [[ -n "$key" ]] && export "$key=$value"
                    done <"$waveChildEnvFile"
                    ("${commands[$index]}" "$readinessDeadline")
                    local childStatus=$?
                    local pendingStatus="${statusFiles[$index]}.pending-$BASHPID"
                    printf '%s\n' "$childStatus" >"$pendingStatus"
                    mv "$pendingStatus" "${statusFiles[$index]}"
                    exit 0
                ) &
                childPids[index]="$!"
            else
                Log "$group job ${labels[$index]} could not resolve its child resource grant"
                printf '%s\n' "$waveChildEnvStatus" >"${statusFiles[$index]}"
                childPids[index]=''
            fi
            observed[index]=0
            next=$((next + 1))
            active=$((active + 1))
        done
        local progressed=0
        local index
        for ((index = 0; index < next; index += 1)); do
            if [[ "${observed[$index]:-0}" == "1" || ! -f "${statusFiles[$index]}" ]]; then
                continue
            fi
            if [[ -n "${childPids[$index]:-}" ]]; then
                wait "${childPids[$index]}" >/dev/null 2>&1 || true
            fi
            observed[index]=1
            active=$((active - 1))
            completed=$((completed + 1))
            progressed=1
        done
        if ((completed < total && progressed == 0)); then
            SleepWithinDeadline "$readinessDeadline" 100 || true
        fi
    done

    local -a failures=()
    local index
    for ((index = 0; index < total; index += 1)); do
        local childStatus
        if [[ -f "${statusFiles[$index]}" ]]; then
            read -r childStatus <"${statusFiles[$index]}"
        else
            childStatus=125
        fi
        if [[ "$childStatus" != "0" ]]; then
            failures+=("${labels[$index]} (exit ${childStatus})")
        fi
    done
    rm -rf "$statusDir"
    trap - RETURN INT TERM

    if ((${#failures[@]} > 0)); then
        printf '[acceptance:bootstrap] %s failed in %d independent job(s):\n' "$group" "${#failures[@]}" >&2
        printf '  - %s\n' "${failures[@]}" >&2
        return 1
    fi
    Log "$group ready"
}

ReadPidFile() {
    local pidFile="$1"
    if [[ -f "$pidFile" ]]; then
        cat "$pidFile" 2>/dev/null || true
    fi
}

RuntimeProcessRole() {
    case "$(basename "$1")" in
        backend.pid) printf 'backend\n' ;;
        dev-server.pid) printf 'debug-frontend\n' ;;
        preview.pid) printf 'release-preview\n' ;;
        *) return 1 ;;
    esac
}

RuntimeIdentityFile() {
    local pidFile="$1"
    printf '%s.identity.json\n' "${pidFile%.pid}"
}

WriteRuntimePidFile() {
    local pidFile="$1"
    local pid="$2"
    local pending="${pidFile}.pending-$$-${RANDOM}"
    (
        umask 077
        printf '%s\n' "$pid" >"$pending"
    )
    chmod 0600 "$pending"
    mv -f "$pending" "$pidFile"
    chmod 0600 "$pidFile"
}

WriteRuntimeProcessIdentity() {
    local pidFile="$1"
    local pid="$2"
    local role="$3"
    local readinessDeadlineAtMs="${4:-$EXECUTION_DEADLINE_AT_MS}"
    local identityFile
    identityFile="$(RuntimeIdentityFile "$pidFile")"
    FSUSBLOG_RUNTIME_IDENTITY_PID="$pid" \
        FSUSBLOG_RUNTIME_IDENTITY_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
        FSUSBLOG_RUNTIME_IDENTITY_NAMESPACE="$NS_SLUG" \
        FSUSBLOG_RUNTIME_IDENTITY_ROLE="$role" \
        FSUSBLOG_RUNTIME_IDENTITY_DEDICATED="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
        FSUSBLOG_RUNTIME_IDENTITY_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
        FSUSBLOG_RUNTIME_IDENTITY_SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-}" \
        FSUSBLOG_RUNTIME_IDENTITY_SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" \
        FSUSBLOG_RUNTIME_IDENTITY_FILE="$identityFile" \
        FSUSBLOG_RUNTIME_IDENTITY_DEADLINE_AT_MS="$readinessDeadlineAtMs" \
        FSUSBLOG_RUNTIME_SNAPSHOT_SCRIPT="$ROOT_DIR/tools/test/darwin-process-snapshot.py" \
        "${FSUSBLOG_NODE:-node}" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const pid = Number.parseInt(process.env.FSUSBLOG_RUNTIME_IDENTITY_PID ?? '', 10)
const runId = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_RUN_ID ?? '').trim()
const namespace = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_NAMESPACE ?? '').trim()
const role = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_ROLE ?? '').trim()
const dedicated = process.env.FSUSBLOG_RUNTIME_IDENTITY_DEDICATED === '1'
const preparationId = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_PREPARATION_ID ?? '').trim()
const sourceCommit = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_SOURCE_COMMIT ?? '').trim()
const sourceFingerprint = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_SOURCE_FINGERPRINT ?? '').trim()
const file = path.resolve(process.env.FSUSBLOG_RUNTIME_IDENTITY_FILE ?? '')
const inheritedDeadlineAtMs = Number.parseInt(
  process.env.FSUSBLOG_RUNTIME_IDENTITY_DEADLINE_AT_MS ?? '',
  10
)
if (!Number.isInteger(pid) || pid <= 1 || !runId || !namespace || !role || !file
  || (dedicated && !preparationId)
  || (dedicated && (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(sourceFingerprint)))
  || !Number.isInteger(inheritedDeadlineAtMs)) {
  throw new Error('runtime process identity input is incomplete')
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
const monotonicNowMs = () => Number(process.hrtime.bigint() / 1_000_000n)
const deadlineAtMs = Math.min(inheritedDeadlineAtMs, monotonicNowMs() + 10_000)
let observed = null
let lastReason = 'procfs identity unavailable'
function readProcess() {
  if (process.platform !== 'darwin') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return {
      processGroupId: Number.parseInt(tail[2] ?? '', 10),
      sessionId: Number.parseInt(tail[3] ?? '', 10),
      startTimeTicks: tail[19] ?? '',
      environment: Object.fromEntries(
        fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const separator = entry.indexOf('=')
            return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)]
          })
      )
    }
  }
  return JSON.parse(execFileSync('/usr/bin/python3', [process.env.FSUSBLOG_RUNTIME_SNAPSHOT_SCRIPT, String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }))
}
while (monotonicNowMs() <= deadlineAtMs) {
  try {
    const { processGroupId, sessionId, startTimeTicks, environment } = readProcess()
    if (processGroupId === pid
      && sessionId === pid
      && /^\d+$/u.test(startTimeTicks)
      && environment.FSUSBLOG_TEST_RUN_ID === runId
      && environment.FSUSBLOG_TEST_NAMESPACE === namespace
      && environment.FSUSBLOG_RUNTIME_ROLE === role
      && (!dedicated || (
        environment.FSUSBLOG_TEST_SOURCE_COMMIT === sourceCommit
        && environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT === sourceFingerprint
      ))
      && (!dedicated || (
        environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
        && environment.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === preparationId
      ))) {
      observed = { processGroupId, startTimeTicks }
      break
    }
    lastReason = `pgrp=${processGroupId} session=${sessionId} role=${environment.FSUSBLOG_RUNTIME_ROLE ?? ''}`
  } catch (error) {
    if (error.code === 'ENOENT' || (process.platform === 'darwin' && error.status !== undefined)) {
      lastReason = 'process identity changed before it stabilized'
    } else {
      throw error
    }
  }
  const remainingMs = deadlineAtMs - monotonicNowMs()
  if (remainingMs > 0) Atomics.wait(waitBuffer, 0, 0, Math.min(25, remainingMs))
}
if (observed === null) {
  throw new Error(`runtime process identity did not stabilize: ${lastReason}`)
}
const pending = `${file}.pending-${process.pid}`
fs.writeFileSync(pending, `${JSON.stringify({
  schema: 'fsusblog.local-runtime-process-identity.v1',
  pid,
  processGroupId: observed.processGroupId,
  startTimeTicks: observed.startTimeTicks,
  runId,
  namespace,
  role,
  preparationId,
  sourceState: {
    commit: sourceCommit,
    worktreeFingerprint: sourceFingerprint
  },
  createdAt: new Date().toISOString()
}, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(pending, 0o600)
fs.renameSync(pending, file)
fs.chmodSync(file, 0o600)
NODE
}

SleepWithinDeadline() {
    local deadlineAtMs="$1"
    local pollIntervalMs="$2"
    local now remaining sleepMs
    now="$(NowMonotonicMs)"
    remaining=$((deadlineAtMs - now))
    if ((remaining <= 0)); then
        return 1
    fi
    sleepMs="$pollIntervalMs"
    if ((sleepMs > remaining)); then
        sleepMs="$remaining"
    fi
    sleep "$(printf '%d.%03d' $((sleepMs / 1000)) $((sleepMs % 1000)))"
}

KillPidIfRunning() {
    local pid="$1"
    local terminationDeadlineAtMs="${2:-$EXECUTION_DEADLINE_AT_MS}"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
        while kill -0 "$pid" >/dev/null 2>&1; do
            if ! SleepWithinDeadline "$terminationDeadlineAtMs" 500; then
                break
            fi
        done
        if kill -0 "$pid" >/dev/null 2>&1; then
            kill -9 "$pid" >/dev/null 2>&1 || true
        fi
    fi
}

FindPortPid() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltnp "( sport = :${port} )" 2>/dev/null | awk -F'pid=' 'NR>1 {split($2, a, /[,)]/); if (a[1] != "") {print a[1]; exit}}'
        return
    fi
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1
}

PortIsListening() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -H -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR == 1 { found = 1 } END { exit found ? 0 : 1 }'
        return
    fi
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1
}

DedicatedRuntimeProcessBindingMatches() {
    local pidFile="$1"
    local role="$2"
    local observedPid="$3"
    local identityFile
    identityFile="$(RuntimeIdentityFile "$pidFile")"

    FSUSBLOG_RUNTIME_BINDING_PID_FILE="$pidFile" \
        FSUSBLOG_RUNTIME_BINDING_IDENTITY_FILE="$identityFile" \
        FSUSBLOG_RUNTIME_BINDING_OBSERVED_PID="$observedPid" \
        FSUSBLOG_RUNTIME_BINDING_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
        FSUSBLOG_RUNTIME_BINDING_NAMESPACE="$NS_SLUG" \
        FSUSBLOG_RUNTIME_BINDING_ROLE="$role" \
        FSUSBLOG_RUNTIME_BINDING_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
        FSUSBLOG_RUNTIME_SNAPSHOT_SCRIPT="$ROOT_DIR/tools/test/darwin-process-snapshot.py" \
        "${FSUSBLOG_NODE:-node}" <<'NODE'
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const pidFile = process.env.FSUSBLOG_RUNTIME_BINDING_PID_FILE ?? ''
const identityFile = process.env.FSUSBLOG_RUNTIME_BINDING_IDENTITY_FILE ?? ''
const observedPid = Number.parseInt(process.env.FSUSBLOG_RUNTIME_BINDING_OBSERVED_PID ?? '', 10)
const expected = {
  runId: String(process.env.FSUSBLOG_RUNTIME_BINDING_RUN_ID ?? '').trim(),
  namespace: String(process.env.FSUSBLOG_RUNTIME_BINDING_NAMESPACE ?? '').trim(),
  role: String(process.env.FSUSBLOG_RUNTIME_BINDING_ROLE ?? '').trim(),
  preparationId: String(process.env.FSUSBLOG_RUNTIME_BINDING_PREPARATION_ID ?? '').trim()
}

function readPrivateFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()
      || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || stat.size > 64 * 1024) {
      throw new Error('runtime identity file is not private')
    }
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function readProcess(pid) {
  if (process.platform === 'darwin') {
    return JSON.parse(execFileSync('/usr/bin/python3', [process.env.FSUSBLOG_RUNTIME_SNAPSHOT_SCRIPT, String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }))
  }
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
  const environment = Object.fromEntries(
    fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=')
        return separator < 1
          ? [entry, '']
          : [entry.slice(0, separator), entry.slice(separator + 1)]
      })
  )
  return {
    processGroupId: Number.parseInt(tail[2] ?? '', 10),
    sessionId: Number.parseInt(tail[3] ?? '', 10),
    startTimeTicks: tail[19] ?? '',
    environment
  }
}

function environmentMatches(environment) {
  return environment.FSUSBLOG_TEST_RUN_ID === expected.runId
    && environment.FSUSBLOG_TEST_NAMESPACE === expected.namespace
    && environment.FSUSBLOG_RUNTIME_ROLE === expected.role
    && environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
    && environment.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === expected.preparationId
}

try {
  if (!pidFile || !identityFile || !Number.isInteger(observedPid) || observedPid <= 1
    || !expected.runId || !expected.namespace || !expected.role || !expected.preparationId) {
    throw new Error('dedicated runtime binding input is incomplete or not private')
  }
  const managedPidText = readPrivateFile(pidFile).trim()
  if (!/^\d+$/u.test(managedPidText)) throw new Error('managed pid is invalid')
  const managedPid = Number.parseInt(managedPidText, 10)
  const identity = JSON.parse(readPrivateFile(identityFile))
  if (identity.schema !== 'fsusblog.local-runtime-process-identity.v1'
    || identity.pid !== managedPid
    || identity.processGroupId !== managedPid
    || !/^\d+$/u.test(String(identity.startTimeTicks ?? ''))
    || identity.runId !== expected.runId
    || identity.namespace !== expected.namespace
    || identity.role !== expected.role
    || identity.preparationId !== expected.preparationId) {
    throw new Error('dedicated runtime identity sidecar does not match')
  }

  const managed = readProcess(managedPid)
  if (managed.processGroupId !== managedPid
    || managed.sessionId !== managedPid
    || managed.startTimeTicks !== String(identity.startTimeTicks)
    || !environmentMatches(managed.environment)) {
    throw new Error('dedicated runtime owner process does not match')
  }

  const observed = observedPid === managedPid ? managed : readProcess(observedPid)
  if (observed.processGroupId !== managedPid
    || observed.sessionId !== managedPid
    || !environmentMatches(observed.environment)) {
    throw new Error('port listener is outside the dedicated runtime process group')
  }
} catch {
  process.exitCode = 1
}
NODE
}

AdmitDedicatedRuntimePort() {
    local role="$1"
    local label="$2"
    local pidFile="$3"
    local port="$4"
    local reachable="${5:-0}"
    if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
        local priorPid
        priorPid="$(ReadPidFile "$pidFile")"
        if PortIsListening "$port" || [[ "$reachable" == "1" ]] ||
            { [[ -n "$priorPid" ]] && kill -0 "$priorPid" >/dev/null 2>&1; }; then
            if ! PortLeaseCli verify-readiness --manifest "$PORT_LEASE_MANIFEST_FILE" \
                --run-id "${FSUSBLOG_TEST_RUN_ID:?Fresh readiness requires current run}" \
                --namespace "$FSUSBLOG_TEST_NAMESPACE" >/dev/null; then
                Log "$label lacks exact current-run readiness authority; refusing reuse or termination"
                return 1
            fi
        fi
    fi
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
        return 0
    fi
    if [[ -z "${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" ]]; then
        Log "$label dedicated runtime preparation identity is missing; refusing runtime admission"
        return 1
    fi

    local managedPid observedPid listening=0
    managedPid="$(ReadPidFile "$pidFile")"
    if PortIsListening "$port"; then
        listening=1
    fi
    observedPid="$(FindPortPid "$port")"

    if [[ -n "$managedPid" && ! "$managedPid" =~ ^[0-9]+$ ]]; then
        Log "$label dedicated runtime pid sidecar is malformed; refusing runtime admission"
        return 1
    fi
    if [[ -n "$managedPid" ]] && kill -0 "$managedPid" >/dev/null 2>&1 &&
        ! DedicatedRuntimeProcessBindingMatches "$pidFile" "$role" "$managedPid"; then
        Log "$label pid $managedPid is not owned by this dedicated preparation; refusing reuse or termination"
        return 1
    fi
    if [[ -n "$observedPid" ]] &&
        ! DedicatedRuntimeProcessBindingMatches "$pidFile" "$role" "$observedPid"; then
        Log "$label port $port listener pid $observedPid is not owned by this dedicated preparation; refusing reuse or termination"
        return 1
    fi
    if ((listening == 1)) && [[ -z "$observedPid" ]]; then
        Log "$label port $port is listening without an inspectable owned pid; refusing runtime admission"
        return 1
    fi
    if [[ "$reachable" == "1" && ("$listening" != "1" || -z "$observedPid") ]]; then
        Log "$label is reachable without an inspectable owned listener sidecar; refusing reuse"
        return 1
    fi
}

RuntimeProcessGroupExists() {
    local processGroupId="$1"
    kill -0 -- "-$processGroupId" >/dev/null 2>&1
}

SignalRuntimeProcessGroup() {
    local signal="$1"
    local processGroupId="$2"
    kill "-$signal" -- "-$processGroupId" >/dev/null 2>&1
}

TerminateDedicatedRuntimeProcessGroup() {
    local role="$1"
    local pidFile="$2"
    local observedPid="$3"
    local terminationDeadlineAtMs="$4"
    local processGroupId
    processGroupId="$(ReadPidFile "$pidFile")"
    if ! DedicatedRuntimeProcessBindingMatches "$pidFile" "$role" "$observedPid"; then
        return 1
    fi
    if ! RuntimeProcessGroupExists "$processGroupId"; then
        return 0
    fi
    if ! SignalRuntimeProcessGroup TERM "$processGroupId"; then
        Log "$role dedicated runtime process group $processGroupId refused SIGTERM"
        return 1
    fi
    while RuntimeProcessGroupExists "$processGroupId"; do
        if ! SleepWithinDeadline "$terminationDeadlineAtMs" 250; then
            break
        fi
    done
    if ! RuntimeProcessGroupExists "$processGroupId"; then
        return 0
    fi
    if ! DedicatedRuntimeProcessBindingMatches "$pidFile" "$role" "$processGroupId"; then
        Log "$role dedicated runtime identity changed before SIGKILL; refusing further termination"
        return 1
    fi
    SignalRuntimeProcessGroup KILL "$processGroupId" || return 1
    ! RuntimeProcessGroupExists "$processGroupId"
}

KillRuntimePidIfOwned() {
    local role="$1"
    local pidFile="$2"
    local pid="$3"
    local terminationDeadlineAtMs="${4:-$EXECUTION_DEADLINE_AT_MS}"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
    fi
    if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
        PortLeaseCli verify-readiness --manifest "$PORT_LEASE_MANIFEST_FILE" \
            --run-id "${FSUSBLOG_TEST_RUN_ID:?Fresh readiness requires current run}" \
            --namespace "$FSUSBLOG_TEST_NAMESPACE" >/dev/null || {
            Log "$role has no current-run readiness authority; refusing termination"
            return 1
        }
    fi
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
        KillPidIfRunning "$pid" "$terminationDeadlineAtMs"
        return
    fi
    if ! TerminateDedicatedRuntimeProcessGroup \
        "$role" "$pidFile" "$pid" "$terminationDeadlineAtMs"; then
        Log "$role pid $pid is not safely bound to this dedicated preparation; refusing termination"
        return 1
    fi
}

AssertDedicatedRuntimePortAvailable() {
    local label="$1"
    local port="$2"
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
        return 0
    fi
    if PortIsListening "$port"; then
        local pid
        pid="$(FindPortPid "$port")"
        Log "$label port $port was claimed before managed spawn (pid ${pid:-uninspectable}); refusing to race or terminate it"
        return 1
    fi
}

WaitForPortRelease() {
    local port="$1"
    local releaseDeadlineAtMs="${2:-$EXECUTION_DEADLINE_AT_MS}"
    local pid
    while true; do
        if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
            if ! PortIsListening "$port"; then
                return 0
            fi
        else
            pid="$(FindPortPid "$port")"
            if [[ -z "$pid" ]]; then
                return 0
            fi
        fi
        if ! SleepWithinDeadline "$releaseDeadlineAtMs" 250; then
            break
        fi
    done

    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        if PortIsListening "$port"; then
            pid="$(FindPortPid "$port")"
            Log "dedicated runtime port $port is still held by pid ${pid:-uninspectable}; refusing blind termination"
            return 1
        fi
        return 0
    fi
    pid="$(FindPortPid "$port")"
    if [[ -n "$pid" ]]; then
        KillPidIfRunning "$pid" "$releaseDeadlineAtMs"
    fi
}

ProbeUrl() {
    local url="$1"
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

ProbeBinaryUrl() {
    local url="$1"
    local -a probeArgs=(--binary-url "$url")
    if [[ -n "${2:-}" ]]; then
        probeArgs+=(--managed-pid "$2")
    fi
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/probe-release-reliability-runtime-smoke.mjs" \
        "${probeArgs[@]}" >/dev/null 2>&1
}

ProbeNotificationDrillUrl() {
    curl -fsS --max-time 5 \
        -X POST \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H "X-Fsus-Notification-Drill-Secret: ${NOTIFICATION_DRILL_SECRET}" \
        --data '{"drillId":"bootstrap-probe","count":1,"payloadBytes":0,"routeKey":"content-feed"}' \
        "$DEBUG_BACKEND_URL/_fsus/testing/notification-stream/publish" >/dev/null 2>&1
}

CanReuseProcesses() {
    [[ "${FORCE_BOOTSTRAP:-0}" != "1" ]]
}

HashReleaseInputs() {
    (
        cd "$ROOT_DIR"
        {
            {
                printf '%s\0' \
                    src/frontend/package.json \
                    src/frontend/package-lock.json \
                    src/frontend/vite.config.ts \
                    src/frontend/tsconfig.json \
                    src/frontend/index.html
                find src/frontend/src src/frontend/public src/frontend/scripts src/frontend/wasm tools/frontend -type f -print0 2>/dev/null || true
            } | sort -z | xargs -0 sha256sum 2>/dev/null
            printf '%s\n' \
                "VITE_API_BASE_URL=$DEBUG_BACKEND_URL" \
                "FSUSBLOG_VUE_HYDRATION_DETAILS=${FSUSBLOG_VUE_HYDRATION_DETAILS:-}" \
                "FSUSBLOG_PUBLIC_SSR_BUILD=${FSUSBLOG_PUBLIC_SSR_BUILD:-}" \
                "FSUSBLOG_USE_LOCAL_FSUSUI=${FSUSBLOG_USE_LOCAL_FSUSUI:-}" \
                "FSUSBLOG_LOCAL_FSUSUI_ROOT=${FSUSBLOG_LOCAL_FSUSUI_ROOT:-}"
        } | sha256sum | awk '{print $1}'
    )
}

HashBackendInputs() {
    local workerPath=""
    local bundlePath=""
    if [[ -n "$PUBLIC_AOT_SSR_CLIENT_ROOT" && -n "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
        workerPath="$PUBLIC_AOT_SSR_CLIENT_ROOT/${PUBLIC_AOT_SSR_WORKER_SCRIPT#./}"
        bundlePath="$PUBLIC_AOT_SSR_CLIENT_ROOT/server/public-ssr.mjs"
    fi

    {
        printf '%s\n' \
            "source=${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" \
            "commit=${FSUSBLOG_TEST_SOURCE_COMMIT:-}" \
            "configuration=${FSUSBLOG_RUNTIME_CONFIGURATION:-}" \
            "noBuild=${FSUSBLOG_RUNTIME_NO_BUILD:-0}" \
            "webRoot=${ASPNETCORE_WEBROOT:-$SERVER_WWWROOT_DIR}" \
            "ssrClientRoot=$PUBLIC_AOT_SSR_CLIENT_ROOT" \
            "ssrWorkerScript=$PUBLIC_AOT_SSR_WORKER_SCRIPT"

        if [[ -z "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" ]]; then
            (
                cd "$ROOT_DIR"
                {
                    for file in Directory.Build.props Directory.Packages.props Directory.Build.targets; do
                        if [[ -f "$file" ]]; then
                            printf '%s\0' "$file"
                        fi
                    done
                    find src/backend src/shared src/core -type f \
                        \( -name '*.cs' -o -name '*.csproj' -o -name '*.props' -o -name '*.targets' -o -name '*.json' \) \
                        -print0 2>/dev/null || true
                } | sort -z | xargs -0 sha256sum 2>/dev/null
            )
        fi

        for file in "${FSUSBLOG_BACKEND_SERVER_DLL:-}" "$workerPath" "$bundlePath"; do
            if [[ -n "$file" && -f "$file" ]]; then
                sha256sum "$file"
            elif [[ -n "$file" ]]; then
                printf 'missing %s\n' "$file"
            fi
        done
    } | sha256sum | awk '{print $1}'
}

WaitForUrl() {
    local label="$1"
    local url="$2"
    local deadlineAtMs="$3"

    while (($(NowMonotonicMs) < deadlineAtMs)); do
        if ProbeUrl "$url"; then
            return 0
        fi
        sleep 1
    done

    Log "$label did not become ready at $url"
    return 1
}

WaitForBinaryUrl() {
    local label="$1"
    local url="$2"
    local deadlineAtMs="$3"

    while (($(NowMonotonicMs) < deadlineAtMs)); do
        if ProbeBinaryUrl "$url"; then
            return 0
        fi
        sleep 1
    done

    Log "$label did not become ready at $url"
    return 1
}

WaitForManagedBinaryUrl() {
    local label="$1"
    local url="$2"
    local deadlineAtMs="$3"
    local pid="$4"
    local logFile="$5"

    while (($(NowMonotonicMs) < deadlineAtMs)); do
        if ProbeBinaryUrl "$url" "$pid"; then
            return 0
        fi
        if ! kill -0 "$pid" >/dev/null 2>&1; then
            Log "$label process exited before becoming ready at $url"
            tail -20 "$logFile" >&2 || true
            return 1
        fi
        if ! SleepWithinDeadline "$deadlineAtMs" 250; then
            break
        fi
    done

    Log "$label did not become ready at $url"
    return 1
}

DOCKER_RESOURCE_ARGS=()
BuildDockerResourceArgs() {
    local cpu="${FSUSBLOG_DOCKER_CPU_UNITS:-}"
    local memoryHigh="${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES:-}"
    local memoryMax="${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES:-}"
    local pidsMax="${FSUSBLOG_DOCKER_PIDS_MAX:-}"
    local runIdentity="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}"
    local bundleIdentity="${FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone}"
    local stepIdentity="${FSUSBLOG_STEP_ID:-bootstrap}"
    local preparationIdentity="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}"
    DOCKER_RESOURCE_ARGS=(
        --label "io.fsusblog.test.run-id=$runIdentity"
        --label "io.fsusblog.test.bundle-id=$bundleIdentity"
        --label "io.fsusblog.test.step-id=$stepIdentity"
        --label "io.fsusblog.test.namespace=$NS_SLUG"
        --label "io.fsusblog.test.repository-root-digest=$FSUSBLOG_REPOSITORY_ROOT_DIGEST"
    )
    if [[ -n "$preparationIdentity" ]]; then
        DOCKER_RESOURCE_ARGS+=(--label "io.fsusblog.test.preparation-id=$preparationIdentity")
    fi
    if [[ -z "$cpu$memoryHigh$memoryMax$pidsMax" ]]; then
        return 0
    fi
    if [[ ! "$cpu" =~ ^[0-9]+([.][0-9]+)?$ || ! "$memoryHigh" =~ ^[0-9]+$ ||
        ! "$memoryMax" =~ ^[0-9]+$ || ! "$pidsMax" =~ ^[0-9]+$ ]]; then
        Log 'Docker resource enforcement requires positive CPU, memory high/max, and pids values'
        return 1
    fi
    if [[ "$cpu" =~ ^0+([.]0+)?$ ]] || ((memoryHigh <= 0 || memoryMax < memoryHigh || pidsMax <= 0)); then
        Log 'Docker resource enforcement grant is outside its valid CPU, memory, or pids envelope'
        return 1
    fi
    DOCKER_RESOURCE_ARGS+=(
        --cpus "$cpu"
        --memory-reservation "$memoryHigh"
        --memory "$memoryMax"
        --pids-limit "$pidsMax"
    )
    DOCKER_RESOURCE_ARGS+=(
        --label "io.fsusblog.test.cpu-units=$cpu"
        --label "io.fsusblog.test.memory-high-bytes=$memoryHigh"
        --label "io.fsusblog.test.memory-max-bytes=$memoryMax"
        --label "io.fsusblog.test.pids-max=$pidsMax"
    )
}

UpdateExistingContainerResources() {
    local container="$1"
    local cpu="${FSUSBLOG_DOCKER_CPU_UNITS:-}"
    local memoryHigh="${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES:-}"
    local memoryMax="${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES:-}"
    local pidsMax="${FSUSBLOG_DOCKER_PIDS_MAX:-}"
    BuildDockerResourceArgs
    if [[ -z "$cpu$memoryHigh$memoryMax$pidsMax" ]]; then
        return 0
    fi
    docker update \
        --cpus "${FSUSBLOG_DOCKER_CPU_UNITS}" \
        --memory-reservation "${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES}" \
        --memory "${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES}" \
        --pids-limit "${FSUSBLOG_DOCKER_PIDS_MAX}" \
        "$container" >/dev/null
}

ContainerResourceBindingMatches() {
    local container="$1"
    if [[ -z "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
        [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]
        return
    fi
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" &&
        (-z "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" || -z "${FSUSBLOG_STEP_ID:-}") ]]; then
        return 1
    fi
    local bundleIdentity="${FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone}"
    local stepIdentity="${FSUSBLOG_STEP_ID:-bootstrap}"
    local preparationIdentity="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}"
    local binding
    binding="$(docker inspect --format '{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.bundle-id"}}|{{index .Config.Labels "io.fsusblog.test.step-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}|{{with index .Config.Labels "io.fsusblog.test.preparation-id"}}{{.}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$binding" == "${FSUSBLOG_TEST_RUN_ID}|${bundleIdentity}|${stepIdentity}|${NS_SLUG}|${preparationIdentity}" ]]
}

AssertDedicatedContainerBinding() {
    local container="$1"
    local service="$2"
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
        return 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$container" &&
        ! ContainerResourceBindingMatches "$container"; then
        Log "refusing to reuse, remove, or recreate $service container with mismatched dedicated-runtime ownership: $container"
        return 1
    fi
}

RequireLocalPinnedImage() {
    local service="$1"
    local imageReference="$2"
    if [[ ! "$imageReference" =~ @sha256:[a-f0-9]{64}$ ]]; then
        Log "$service image reference is not pinned by digest: $imageReference"
        return 1
    fi
    if ! docker image inspect "$imageReference" >/dev/null 2>&1; then
        Log "$service pinned image is absent locally; correctness bootstrap forbids test-time pulls: $imageReference"
        return 1
    fi
}

ContainerImageBindingMatches() {
    local container="$1"
    local expectedReference="$2"
    local configuredReference runningImage expectedImage
    configuredReference="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
    runningImage="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
    expectedImage="$(docker image inspect --format '{{.Id}}' "$expectedReference" 2>/dev/null || true)"
    [[ -n "$expectedImage" && "$configuredReference" == "$expectedReference" &&
        "$runningImage" == "$expectedImage" ]]
}

EnsurePostgres() {
    local readinessDeadline="${1:-}"
    if [[ -z "$readinessDeadline" ]]; then
        AllocateReadinessDeadline 'postgres'
        readinessDeadline="$READINESS_DEADLINE_AT_MS"
    fi
    AssertDedicatedContainerBinding "$POSTGRES_CONTAINER" postgres || return 1
    RequireLocalPinnedImage postgres "$POSTGRES_IMAGE_REFERENCE" || return 1
    ReleasePortLeaseBeforeBind postgres 'PostgreSQL host mapping'
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1 &&
        ContainerImageBindingMatches "$POSTGRES_CONTAINER" "$POSTGRES_IMAGE_REFERENCE" &&
        ContainerResourceBindingMatches "$POSTGRES_CONTAINER"; then
        Log 'postgres already ready'
        CompletePortLeaseHandoff postgres 'PostgreSQL host mapping' "container:$(docker inspect --format '{{.Id}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
        return
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER" &&
        ContainerImageBindingMatches "$POSTGRES_CONTAINER" "$POSTGRES_IMAGE_REFERENCE" &&
        ContainerResourceBindingMatches "$POSTGRES_CONTAINER"; then
        Log 'starting existing postgres container'
        UpdateExistingContainerResources "$POSTGRES_CONTAINER"
        docker start "$POSTGRES_CONTAINER" >/dev/null
    else
        if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER"; then
            if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
                Log "refusing to remove or recreate postgres container during dedicated runtime: $POSTGRES_CONTAINER"
                return 1
            fi
            Log 'recreating postgres container with current run/bundle/step resource identity'
            docker rm -f -v "$POSTGRES_CONTAINER" >/dev/null
        fi
        Log 'creating postgres container'
        BuildDockerResourceArgs
        docker run -d \
            "${DOCKER_RESOURCE_ARGS[@]}" \
            --name "$POSTGRES_CONTAINER" \
            -e POSTGRES_USER=fsusblog \
            -e POSTGRES_PASSWORD=fsusblog_dev \
            -e POSTGRES_DB=fsusblog \
            -p "127.0.0.1:${POSTGRES_PORT}:5432" \
            "$POSTGRES_IMAGE_REFERENCE" >/dev/null
    fi

    while (($(NowMonotonicMs) < readinessDeadline)); do
        if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
            CompletePortLeaseHandoff postgres 'PostgreSQL host mapping' "container:$(docker inspect --format '{{.Id}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)"
            return
        fi
        sleep 1
    done

    Log 'postgres failed to become ready'
    FailPortLeaseHandoff postgres 'PostgreSQL host mapping' 'postgres-not-ready'
    exit 1
}

EnsureRedis() {
    local readinessDeadline="${1:-}"
    if [[ -z "$readinessDeadline" ]]; then
        AllocateReadinessDeadline 'redis'
        readinessDeadline="$READINESS_DEADLINE_AT_MS"
    fi
    AssertDedicatedContainerBinding "$REDIS_CONTAINER" redis || return 1
    RequireLocalPinnedImage redis "$REDIS_IMAGE_REFERENCE" || return 1
    ReleasePortLeaseBeforeBind redis 'Redis host mapping'
    if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1 &&
        ContainerImageBindingMatches "$REDIS_CONTAINER" "$REDIS_IMAGE_REFERENCE" &&
        ContainerResourceBindingMatches "$REDIS_CONTAINER"; then
        Log 'redis already ready'
        CompletePortLeaseHandoff redis 'Redis host mapping' "container:$(docker inspect --format '{{.Id}}' "$REDIS_CONTAINER" 2>/dev/null || true)"
        return
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER" &&
        ContainerImageBindingMatches "$REDIS_CONTAINER" "$REDIS_IMAGE_REFERENCE" &&
        ContainerResourceBindingMatches "$REDIS_CONTAINER"; then
        Log 'starting existing redis container'
        UpdateExistingContainerResources "$REDIS_CONTAINER"
        docker start "$REDIS_CONTAINER" >/dev/null
    else
        if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
            if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
                Log "refusing to remove or recreate redis container during dedicated runtime: $REDIS_CONTAINER"
                return 1
            fi
            Log 'recreating redis container with current run/bundle/step resource identity'
            docker rm -f -v "$REDIS_CONTAINER" >/dev/null
        fi
        Log 'creating redis container'
        BuildDockerResourceArgs
        docker run -d "${DOCKER_RESOURCE_ARGS[@]}" --name "$REDIS_CONTAINER" -p "127.0.0.1:${REDIS_PORT}:6379" "$REDIS_IMAGE_REFERENCE" >/dev/null
    fi

    while (($(NowMonotonicMs) < readinessDeadline)); do
        if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
            CompletePortLeaseHandoff redis 'Redis host mapping' "container:$(docker inspect --format '{{.Id}}' "$REDIS_CONTAINER" 2>/dev/null || true)"
            return
        fi
        sleep 1
    done

    Log 'redis failed to become ready'
    FailPortLeaseHandoff redis 'Redis host mapping' 'redis-not-ready'
    exit 1
}

RefreshFixtureServiceGeneration() {
    local postgresIdentity redisIdentity
    postgresIdentity="$(docker inspect --format '{{.Id}}|{{.Created}}' "$POSTGRES_CONTAINER")"
    redisIdentity="$(docker inspect --format '{{.Id}}|{{.Created}}' "$REDIS_CONTAINER")"
    FSUSBLOG_FIXTURE_SERVICE_GENERATION="$(printf '%s\n%s\n' "$postgresIdentity" "$redisIdentity" | sha256sum | awk '{print $1}')"
    export FSUSBLOG_FIXTURE_SERVICE_GENERATION
    WriteEnvFile
}

WriteExecutionServiceEnvelope() {
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/execution-envelope-services.mjs" \
        --producer-id "${CURRENT_TIER:-bootstrap}" \
        --run-id "${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required for service envelope admission}" \
        --postgres-container "$POSTGRES_CONTAINER" \
        --redis-container "$REDIS_CONTAINER" \
        --output "$EXECUTION_SERVICE_ENVELOPE_FILE"
}

ResolveFixtureProfilePlan() {
    local mode="${1:-full}"
    FIXTURE_PROFILE_PLAN_FILE="$FIXTURE_DIR/planned-profile.json"
    FIXTURE_RECEIPT_FILE="$FIXTURE_DIR/fixture-receipt.json"
    ENVIRONMENT_READY_RECEIPT_FILE="$FIXTURE_DIR/environment-ready.json"

    if [[ "$mode" == "prepare-env-only" || "$mode" == "services-only" ]]; then
        # Port/env materialization and service containers do not mutate business fixtures.
        if [[ -z "${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:-}" ]]; then
            FIXTURE_PROFILE_ID="none"
            FIXTURE_PROFILE_SOURCE="matrix"
            FIXTURE_MUTATION_POLICY="zero-mutation"
            return
        fi
    fi

    local profileSource="${FSUSBLOG_FIXTURE_PROFILE_SOURCE:-matrix}"
    local profileId="${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:-}"
    local freeOverride
    freeOverride="$(printf '%s' "${FSUSBLOG_FIXTURE_PROFILE:-}" | tr -d '[:space:]')"
    if [[ -n "$freeOverride" ]]; then
        Log 'correctness fixture profile cannot be overridden by FSUSBLOG_FIXTURE_PROFILE'
        exit 1
    fi
    if [[ -z "$profileId" ]]; then
        Log 'sealed fixture profile is required before schema/service/runtime mutation'
        exit 1
    fi
    if [[ "$profileSource" != "matrix" && "$profileSource" != "dev-cli" ]]; then
        Log "fixture profile source must be matrix or dev-cli, got ${profileSource}"
        exit 1
    fi

    local -a resolveArgs=(
        resolve
        --profile "$profileId"
        --source "$profileSource"
        --out "$FIXTURE_PROFILE_PLAN_FILE"
        --kind planned-profile
    )
    if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
        resolveArgs+=(--execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
    fi
    if [[ "$profileSource" == "matrix" ]]; then
        resolveArgs+=(
            --sealed-profile-id "${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID}"
            --sealed-catalog-digest "${FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST:?sealed fixtureCatalogDigest is required}"
            --sealed-capability-digest "${FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST:?sealed expandedCapabilityDigest is required}"
        )
        if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
            resolveArgs+=(--sealed-execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
        fi
    fi

    local planJson
    if ! planJson="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" "${resolveArgs[@]}")"; then
        Log 'fixture profile resolve/validate failed before mutation'
        exit 1
    fi

    FIXTURE_PROFILE_ID="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.profileId)})')"
    FIXTURE_PROFILE_SOURCE="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.profileSource)})')"
    FIXTURE_CATALOG_DIGEST="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.catalogDigest)})')"
    FIXTURE_CAPABILITY_DIGEST="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.expandedCapabilityDigest)})')"
    FIXTURE_MUTATION_POLICY="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.mutationPolicy)})')"
    FIXTURE_CAPABILITY_IDS="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write((p.capabilities||[]).join(","))})')"
    FIXTURE_PRODUCER_IDS="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write((p.producers||[]).join(","))})')"
    printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.requiresAuthFixtures?"1":"0")})' >/dev/null
    FIXTURE_REQUIRES_PUBLIC="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.requiresPublicFixtures?"1":"0")})')"
    FIXTURE_REQUIRES_DEMO="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.requiresDemoSeed?"1":"0")})')"
    FIXTURE_REQUIRES_LOCAL_AUTH="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(p.requiresLocalAuthBypass?"1":"0")})')"
    if [[ "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" == "runtime-cache-hot-featured-frame" ]]; then
        # resolve above has independently checked all six declaration fields and both seals.
        FIXTURE_REQUIRES_LOCAL_AUTH=1
    fi
    FIXTURE_REQUIRES_ZK_ANONYMOUS="$(printf '%s' "$planJson" | "${FSUSBLOG_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write((p.producers||[]).includes("comment-moderation")?"1":"0")})')"
    FIXTURE_REQUIRES_ANTI_SPAM_MODEL="$FIXTURE_REQUIRES_ZK_ANONYMOUS"

    Log "planned fixture profile=${FIXTURE_PROFILE_ID} source=${FIXTURE_PROFILE_SOURCE} catalogDigest=${FIXTURE_CATALOG_DIGEST} mutationPolicy=${FIXTURE_MUTATION_POLICY}"
    Log "capabilities=${FIXTURE_CAPABILITY_IDS:-<none>} producers=${FIXTURE_PRODUCER_IDS:-<none>}"
    Log "planned-profile receipt: ${FIXTURE_PROFILE_PLAN_FILE}"
}

InvokeFixtureOrchestrator() {
    # Unique FixtureOrchestrator entry (#1709 + #1710 FixtureReceipt).
    # Comment correctness and none publish FixtureReceipt v2; unrelated incomplete
    # profiles remain explicit prepared-only evidence.
    local invocationRoot="$FIXTURE_DIR"
    local artifactDirectory=""
    if [[ "$FIXTURE_PROFILE_SOURCE" == "matrix" && -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" &&
        ("$FIXTURE_PROFILE_ID" == "public-content-lifecycle" || "$FIXTURE_PROFILE_ID" == "runtime-cache-pagination") &&
        "$FIXTURE_PRODUCER_IDS" == "public-content" ]]; then
        # Persist this invocation for exact cleanup; never overwrite a prior success marker.
        invocationRoot="$(
            umask 077
            mktemp -d "$FIXTURE_DIR/runtime-cache-invocation.XXXXXXXX"
        )"
        artifactDirectory="$invocationRoot/artifacts"
        FIXTURE_RECEIPT_FILE="$invocationRoot/fixture-receipt.json"
        PUBLIC_ID_PROJECTION_FILE="$invocationRoot/public-content-projection.json"
        FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR="$invocationRoot/runtime-cache-inputs/${FSUSBLOG_TEST_RUN_ID:?}"
        export FSUSBLOG_FIXTURE_ROOT="$invocationRoot"
    fi
    local orchestratorPlan="$invocationRoot/orchestrator-plan.json"
    local prepareStateFile="$invocationRoot/prepare-state.json"
    local requestVerified=0
    local -a runArgs=(
        "$ROOT_DIR/tools/test-fixtures/cli.mjs" run
        --profile "$FIXTURE_PROFILE_ID"
        --source "$FIXTURE_PROFILE_SOURCE"
        --plan-out "$orchestratorPlan"
        --prepare-state "$prepareStateFile"
        --private-carrier-dir "$invocationRoot/auth-private-carriers"
        --namespace "${FSUSBLOG_TEST_NAMESPACE:-}"
        --run-id "${FSUSBLOG_TEST_RUN_ID:-}"
        --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?fixture orchestrator source commit is required}"
        --source-fingerprint "sha256:${FSUSBLOG_TEST_SOURCE_FINGERPRINT#sha256:}"
        --service-generation "sha256:${FSUSBLOG_FIXTURE_SERVICE_GENERATION:?fixture service generation is required}"
        --base-url "$DEBUG_BACKEND_URL"
        --debug-backend-url "$DEBUG_BACKEND_URL"
        --frontend-url "$DEBUG_FRONTEND_URL"
        --pg-container "$POSTGRES_CONTAINER"
        --redis-container "$REDIS_CONTAINER"
    )
    if [[ -n "$artifactDirectory" ]]; then
        runArgs+=(--artifact-dir "$artifactDirectory"
            --artifact-consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID")
    fi
    if [[ -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" ]]; then
        runArgs+=(--runtime-cache-consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID"
            --runtime-cache-input-dir "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR"
            --public-projection "$PUBLIC_ID_PROJECTION_FILE")
    fi
    # FixtureReceipt is the sole authority. Comment correctness consumers require
    # the fully verified producer receipt; unrelated incomplete profiles remain prepared-only.
    if [[ ",${FIXTURE_PRODUCER_IDS}," == *",account-messaging,"* || ",${FIXTURE_PRODUCER_IDS}," == *",security-state,"* ]]; then
        # Complete-profile runtime qualification is unavailable from these owners.
        runArgs+=(--skip-verify)
    elif [[ "$FIXTURE_PROFILE_ID" == "none" || "$FIXTURE_PROFILE_ID" == "auth-basic" || "$FIXTURE_PROFILE_ID" == "public-content-lifecycle" || "$FIXTURE_PROFILE_ID" == "runtime-cache-pagination" || ",${FIXTURE_PRODUCER_IDS}," == *",comment-moderation,"* ]]; then
        runArgs+=(--fixture-receipt "$FIXTURE_RECEIPT_FILE")
        requestVerified=1
    else
        runArgs+=(--skip-verify)
    fi
    if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
        runArgs+=(--execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
    fi
    if [[ "$FIXTURE_PROFILE_SOURCE" == "matrix" ]]; then
        runArgs+=(
            --sealed-profile-id "${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:?sealed fixtureProfileId is required}"
            --sealed-catalog-digest "${FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST:?sealed fixtureCatalogDigest is required}"
            --sealed-capability-digest "${FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST:?sealed expandedCapabilityDigest is required}"
        )
        if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
            runArgs+=(--sealed-execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
        fi
    fi
    if [[ "$FIXTURE_REQUIRES_DEMO" == "1" ]]; then
        Log 'development-demo producer is owned by tools/dev/start.sh; acceptance bootstrap refuses demo-public'
        exit 1
    fi
    Log "invoking unique fixture orchestrator profile=${FIXTURE_PROFILE_ID} producers=${FIXTURE_PRODUCER_IDS:-<none>}"
    if [[ -n "$artifactDirectory" ]]; then
        Log "owned fixture recovery state: ${prepareStateFile}"
    fi
    (
        export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
        export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
        export FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL"
        export FSUSBLOG_DEBUG_FRONTEND_URL="$DEBUG_FRONTEND_URL"
        export FSUSBLOG_PG_CONTAINER="$POSTGRES_CONTAINER"
        export FSUSBLOG_REDIS_CONTAINER="$REDIS_CONTAINER"
        export FSUSBLOG_REDIS_CONTAINER_NAME="$REDIS_CONTAINER"
        if [[ -n "${FSUSBLOG_TEMPORAL_CONTEXT_FILE:-}" ]]; then
            unset FSUSBLOG_TEMPORAL_CONTEXT_JSON
        fi
        export Jwt__KeyVersion="$JWT_KEY_VERSION"
        export Jwt__SecretKey="$JWT_SECRET"
        export Jwt__Issuer="$JWT_ISSUER"
        export Jwt__Audience="$JWT_AUDIENCE"
        export Jwt__AccessTokenExpiresMinutes="$JWT_ACCESS_TOKEN_EXPIRES_MINUTES"
        export Jwt__RotationWindowDays="$JWT_ROTATION_WINDOW_DAYS"
        export AnonymousCredentialIssuer__SubjectHashPepper="$ANONYMOUS_SUBJECT_HASH_PEPPER"
        FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET" \
            FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET" \
            "${FSUSBLOG_NODE:-node}" "${runArgs[@]}"
    ) || {
        Log 'fixture orchestrator prepare failed'
        exit 1
    }
    if [[ "$FIXTURE_REQUIRES_PUBLIC" == "1" ]]; then
        if [[ "$requestVerified" == "1" && -f "$FIXTURE_RECEIPT_FILE" ]]; then
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" \
                project-verified --receipt "$FIXTURE_RECEIPT_FILE" \
                --out "$PUBLIC_ID_PROJECTION_FILE" >/dev/null
            Log "verified public fixture navigation projection: ${PUBLIC_ID_PROJECTION_FILE}"
        else
            Log "public projection blocked: profile ${FIXTURE_PROFILE_ID} has no independently verified receipt"
        fi
    fi
    if [[ "$requestVerified" == "1" && -f "$FIXTURE_RECEIPT_FILE" ]]; then
        FIXTURE_RECEIPT_DIGEST="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" receipt-digest --file "$FIXTURE_RECEIPT_FILE")"
        FIXTURE_RECEIPT_TERMINAL_STATUS="verified"
        Log "fixture receipt (verified): ${FIXTURE_RECEIPT_FILE} digest=${FIXTURE_RECEIPT_DIGEST}"
        if [[ "$FIXTURE_PROFILE_SOURCE" == "matrix" && ("$FIXTURE_PROFILE_ID" == "public-content-lifecycle" || "$FIXTURE_PROFILE_ID" == "runtime-cache-pagination") ]]; then
            FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR="$invocationRoot/runtime-cache-inputs/${FSUSBLOG_TEST_RUN_ID:?}"
            export FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR
            local -a prerequisiteArgs=()
            if [[ -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" &&
                "${FSUSBLOG_SEALED_FIXTURE_PREREQUISITES:-[]}" != "[]" ]]; then
                prerequisiteArgs+=(--prerequisite-inputs "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR/prerequisite-inputs.json")
            fi
            if [[ -n "$artifactDirectory" ]]; then
                "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" \
                    project-runtime-cache-input --receipt "$FIXTURE_RECEIPT_FILE" \
                    --prepare-state "$prepareStateFile" --public-projection "$PUBLIC_ID_PROJECTION_FILE" \
                    --consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID" \
                    --out "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR/$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID.json" \
                    "${prerequisiteArgs[@]}"
            else
                "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" \
                    project-runtime-cache-profile-inputs --receipt "$FIXTURE_RECEIPT_FILE" \
                    --prepare-state "$prepareStateFile" --public-projection "$PUBLIC_ID_PROJECTION_FILE" \
                    --out-dir "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR" "${prerequisiteArgs[@]}"
            fi
        fi
    else
        # Honest partial land: prepare-state exists; FixtureReceipt verified deferred to producers (#1712+).
        FIXTURE_RECEIPT_DIGEST=""
        FIXTURE_RECEIPT_TERMINAL_STATUS="prepared-unverified"
        Log "fixture prepare-state: ${prepareStateFile} (FixtureReceipt verified deferred; profile=${FIXTURE_PROFILE_ID})"
    fi
    WriteEnvFile
}

EnsureFixtureTemporalContext() {
    if [[ -n "${FSUSBLOG_TEMPORAL_CONTEXT_JSON:-}" ]]; then
        return
    fi
    if [[ -z "${FSUSBLOG_TEMPORAL_CONTEXT_FILE:-}" ]]; then
        local temporalContextFile="$FIXTURE_DIR/temporal-context.json"
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-temporal-context.mjs" \
            --producer auth-session \
            --business-epoch "${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:?fixture business epoch is required}" \
            --output "$temporalContextFile" >/dev/null
        FSUSBLOG_TEMPORAL_CONTEXT_FILE="$temporalContextFile"
        export FSUSBLOG_TEMPORAL_CONTEXT_FILE
    fi
    FSUSBLOG_TEMPORAL_CONTEXT_JSON="$("${FSUSBLOG_NODE:-node}" -e \
        'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' \
        "$FSUSBLOG_TEMPORAL_CONTEXT_FILE")"
    export FSUSBLOG_TEMPORAL_CONTEXT_JSON
    WriteEnvFile
}

ConfigureLocalPublicContentFixture() {
    if [[ "$FIXTURE_REQUIRES_PUBLIC" != "1" ]]; then
        unset FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET || true
        unset fsus__allowLocalPublicContentFixture || true
        unset fsus__localPublicContentFixtureSecret || true
        return
    fi

    export FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"
    export fsus__allowLocalPublicContentFixture=true
    export fsus__localPublicContentFixtureSecret="$LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET"
}

ConfigureLocalAuthFixture() {
    if [[ "$FIXTURE_REQUIRES_LOCAL_AUTH" != "1" ]]; then
        unset FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET || true
        unset fsus__allowLocalAuthFixture || true
        unset fsus__localAuthFixtureSecret || true
        return
    fi

    export FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET="$LOCAL_AUTH_FIXTURE_SECRET"
    export fsus__allowLocalAuthFixture=true
    export fsus__localAuthFixtureSecret="$LOCAL_AUTH_FIXTURE_SECRET"
}

ConfigureAccountProfilePreferenceFixture() {
    if [[ ",${FIXTURE_PRODUCER_IDS}," != *",account-profile-preferences,"* ]]; then
        unset FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET || true
        unset fsus__allowAccountProfilePreferenceFixture || true
        unset fsus__accountProfilePreferenceFixtureSecret || true
        return
    fi

    export FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET="$ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET"
    export fsus__allowAccountProfilePreferenceFixture=true
    export fsus__accountProfilePreferenceFixtureSecret="$ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET"
}

PublishEnvironmentReadyReceipt() {
    # environment-ready is runtime topology readiness, not fixture completeness.
    # Completeness requires FixtureReceipt terminalStatus=verified (#1710).
    if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
        PortLeaseCli verify-readiness --manifest "$PORT_LEASE_MANIFEST_FILE" \
            --run-id "${FSUSBLOG_TEST_RUN_ID:?Fresh readiness requires current run}" \
            --namespace "$FSUSBLOG_TEST_NAMESPACE" >/dev/null || return 1
    fi
    local -a readyArgs=(
        write-receipt
        --plan "$FIXTURE_PROFILE_PLAN_FILE"
        --out "$ENVIRONMENT_READY_RECEIPT_FILE"
        --kind environment-ready
        --admission "${FSUSBLOG_CURRENT_SCHEMA_RUNTIME_TOPOLOGY_ADMISSION_RECEIPT:?current schema runtime topology admission is required}"
        --receipt-root "$TMP_DIR"
        --run-id "${FSUSBLOG_TEST_RUN_ID:?environment-ready current schema run id is required}"
        --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?environment-ready current schema source commit is required}"
        --assembly "${CURRENT_SCHEMA_CANDIDATE_ASSEMBLY:?current schema candidate assembly is required}"
        --service-catalog "$ROOT_DIR/config/testing/test-execution-service-catalog.json"
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE"
        --profile-plan "$FIXTURE_PROFILE_PLAN_FILE"
        --runtime-topology-input "$RUNTIME_TOPOLOGY_INPUT_FILE"
        --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE"
    )
    if [[ "${FIXTURE_RECEIPT_TERMINAL_STATUS:-}" == "verified" && -n "${FIXTURE_RECEIPT_FILE:-}" && -f "${FIXTURE_RECEIPT_FILE:-}" ]]; then
        readyArgs+=(--fixture-receipt "$FIXTURE_RECEIPT_FILE")
    fi
    if [[ -n "${FIXTURE_RECEIPT_TERMINAL_STATUS:-}" ]]; then
        readyArgs+=(--fixture-receipt-terminal-status "$FIXTURE_RECEIPT_TERMINAL_STATUS")
    fi
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" "${readyArgs[@]}" >/dev/null
    Log "environment-ready receipt: ${ENVIRONMENT_READY_RECEIPT_FILE} fixtureTerminal=${FIXTURE_RECEIPT_TERMINAL_STATUS:-unknown}"
}

WriteRuntimeTopologyInput() {
    RUNTIME_TOPOLOGY_INPUT_FILE="$TMP_DIR/runtime-topology-input.json"
    # The runtime topology verifier requires a sha256:-prefixed fingerprint,
    # while the runtime process identities keep the raw snapshot digest; the
    # same source env feeds both, so normalize here like serviceGeneration.
    local sourceFingerprint="${FSUSBLOG_TEST_SOURCE_FINGERPRINT#sha256:}"
    jq -n \
        --arg namespace "$FSUSBLOG_TEST_NAMESPACE" \
        --arg backend "$DEBUG_BACKEND_URL" \
        --arg frontend "$DEBUG_FRONTEND_URL" \
        --arg preview "$RELEASE_PREVIEW_URL" \
        --arg postgres "$POSTGRES_CONTAINER" \
        --arg redis "$REDIS_CONTAINER" \
        --arg profileId "$FIXTURE_PROFILE_ID" \
        --arg profileSource "$FIXTURE_PROFILE_SOURCE" \
        --arg catalogDigest "$FIXTURE_CATALOG_DIGEST" \
        --arg capabilityDigest "$FIXTURE_CAPABILITY_DIGEST" \
        --arg capabilityIds "$FIXTURE_CAPABILITY_IDS" \
        --arg producerIds "$FIXTURE_PRODUCER_IDS" \
        --arg mutationPolicy "$FIXTURE_MUTATION_POLICY" \
        --arg executionRunId "${FSUSBLOG_TEST_RUN_ID:?fixture execution run id is required}" \
        --arg sourceCommit "${FSUSBLOG_TEST_SOURCE_COMMIT:?fixture source commit is required}" \
        --arg sourceFingerprint "sha256:${sourceFingerprint:?fixture source fingerprint is required}" \
        --arg serviceGeneration "sha256:${FSUSBLOG_FIXTURE_SERVICE_GENERATION:?fixture service generation is required}" \
        --arg environmentReadyPath "$ENVIRONMENT_READY_RECEIPT_FILE" \
        '{
            namespace: $namespace,
            backendUrl: $backend,
            frontendUrl: $frontend,
            previewUrl: $preview,
            containers: {postgres: $postgres, redis: $redis},
            environmentReadyReceiptPath: $environmentReadyPath,
            fixtureExecutionIdentity: {
                runId: $executionRunId,
                namespace: $namespace,
                source: {
                    commit: $sourceCommit,
                    worktreeFingerprint: $sourceFingerprint
                },
                serviceGeneration: $serviceGeneration
            },
            fixtureProfile: {
                profileId: $profileId,
                profileSource: $profileSource,
                catalogDigest: $catalogDigest,
                expandedCapabilityDigest: $capabilityDigest,
                capabilityIds: (if $capabilityIds == "" then [] else ($capabilityIds | split(",")) end),
                producerIds: (if $producerIds == "" then [] else ($producerIds | split(",")) end),
                mutationPolicy: $mutationPolicy
            }
        }' >"$RUNTIME_TOPOLOGY_INPUT_FILE"
}

MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED=0

ConfigureManagedBackendRuntimeReader() {
    local runtimeConfiguration="${FSUSBLOG_RUNTIME_CONFIGURATION:-}"
    local requestedNoBuild="${FSUSBLOG_RUNTIME_NO_BUILD:-0}"

    if [[ -z "$runtimeConfiguration" ]]; then
        if [[ "$requestedNoBuild" == "1" ]]; then
            runtimeConfiguration="Release"
        else
            runtimeConfiguration="Debug"
        fi
    fi
    case "$runtimeConfiguration" in
        Debug)
            MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED=1
            ;;
        Release)
            if [[ "$requestedNoBuild" != "1" ]]; then
                Log 'managed Release backend requires a prebuilt runtime and FSUSBLOG_RUNTIME_NO_BUILD=1'
                return 2
            fi
            ;;
        *)
            Log 'FSUSBLOG_RUNTIME_CONFIGURATION must be Debug or Release'
            return 2
            ;;
    esac

    # Runtime processes are readers. Debug is produced once through the same
    # run-once key as backend test consumers; Release must arrive prebuilt.
    FSUSBLOG_RUNTIME_CONFIGURATION="$runtimeConfiguration"
    FSUSBLOG_RUNTIME_NO_BUILD=1
    export FSUSBLOG_RUNTIME_CONFIGURATION FSUSBLOG_RUNTIME_NO_BUILD
    WriteEnvFile
}

EnsureManagedBackendSharedDebugBuild() {
    if [[ "$MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED" != "1" ]]; then
        return
    fi
    Log 'preparing managed Debug backend through the shared backend build producer'
    local laneSupport="$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"
    (
        source "$laneSupport"
        FsusBlogCommitSha="${FSUSBLOG_TEST_SOURCE_COMMIT:?backend build source commit is required}" \
            FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug \
            EnsureBackendFilteredBuild
    )
}

CurrentSchemaRunDigest() {
    local runId="$1"
    {
        if command -v sha256sum >/dev/null 2>&1; then
            printf '%s' "$runId" | sha256sum | awk '{print $1}'
        else
            printf '%s' "$runId" | shasum -a 256 | awk '{print $1}'
        fi
    }
}

# GNU realpath -e and BSD realpath disagree on flags; node's fs.realpath is the
# portable canonical path and fails when a path component is missing.
CanonicalRealPath() {
    "${FSUSBLOG_NODE:-node}" -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$1"
}

ResolveCurrentSchemaCandidateAssembly() {
    local runtimeConfiguration="${1:?current schema runtime configuration is required}"
    local buildRoot="${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}"
    local runId="${FSUSBLOG_TEST_RUN_ID:?current schema candidate run id is required}"
    local candidateAssembly physicalAssembly physicalBuildRoot
    CURRENT_SCHEMA_CANDIDATE_ASSEMBLY=""
    [[ -n "$buildRoot" && "$buildRoot" == /* && ! -L "$buildRoot" ]] || {
        Log 'current schema production build root must be an absolute non-symlink path'
        return 2
    }
    physicalBuildRoot="$(CanonicalRealPath "$buildRoot")" || {
        Log 'current schema production build root physical path is unavailable'
        return 2
    }
    if [[ "$physicalBuildRoot" != "$buildRoot" ||
        "$buildRoot" == "$ROOT_DIR" ||
        "$buildRoot" != "$ROOT_DIR/"* ]]; then
        Log 'current schema production build root is not a canonical repository consumer path'
        return 2
    fi
    candidateAssembly="$buildRoot/dotnet/FsusBlog.Server/bin/$runtimeConfiguration/net10.0/FsusBlog.Server.dll"
    if [[ "${FSUSBLOG_BACKEND_SERVER_DLL:-}" != "$candidateAssembly" ]]; then
        Log 'current schema candidate assembly does not match the canonical production build layout'
        return 2
    fi
    if [[ "$candidateAssembly" != /* || ! -f "$candidateAssembly" || -L "$candidateAssembly" ]]; then
        Log 'current schema candidate assembly is missing or not a regular file'
        return 2
    fi
    physicalAssembly="$(CanonicalRealPath "$candidateAssembly")" || {
        Log 'current schema candidate assembly physical path is unavailable'
        return 2
    }
    if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
        local materializationEvidence
        materializationEvidence="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/jobs/ci-build-materialization-${NS_SLUG}.json"
        if ! "${FSUSBLOG_NODE:-node}" --input-type=module - \
            "$ROOT_DIR" \
            "$FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT" \
            "$materializationEvidence" \
            "$runId" \
            "$NS_SLUG" \
            "$candidateAssembly" \
            "${FSUSBLOG_TEST_SOURCE_COMMIT:?current schema candidate source commit is required}" \
            "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?current schema candidate source fingerprint is required}" \
            "${FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST:?current schema candidate receipt digest is required}" <<'NODE'; then
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, artifactRoot, evidenceFile, runId, consumerId, candidate, sourceCommit, sourceFingerprint, receiptDigest] = process.argv.slice(2);
const { verifyProductionBuildConsumerMaterialization } = await import(pathToFileURL(
    path.join(root, 'tools/ci/production-build-artifacts.mjs')
).href);
verifyProductionBuildConsumerMaterialization({
    artifactRoot,
    evidenceFile,
    destinationRoot: root,
    runId,
    consumerId,
    mappings: [{
        name: 'backend-runtime',
        destination: path.relative(root, path.dirname(candidate)).replaceAll(path.sep, '/'),
        writable: true
    }],
    requiredCandidateFiles: [{
        domain: 'backend-runtime',
        artifact: 'FsusBlog.Server.dll',
        candidate: path.relative(root, candidate).replaceAll(path.sep, '/')
    }],
    verification: {
        expectedSourceState: { commit: sourceCommit, worktreeFingerprint: sourceFingerprint },
        expectedReceiptDigest: receiptDigest,
        repairReadOnlySeal: false
    }
});
NODE
            Log 'current schema CI candidate is not bound to the current verified consumer materialization'
            return 2
        fi
    else
        if ! "${FSUSBLOG_NODE:-node}" --input-type=module - \
            "$ROOT_DIR" "$runId" "$buildRoot" "$candidateAssembly" <<'NODE'; then
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, runId, buildRoot, candidateAssembly] = process.argv.slice(2);
const { productionBuildEnvironmentAssignments } = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/production-build-layout.mjs')
).href);
const environment = Object.fromEntries(productionBuildEnvironmentAssignments({ root, runId }));
if (environment.FSUSBLOG_PRODUCTION_BUILD_ROOT !== buildRoot
    || environment.FSUSBLOG_BACKEND_SERVER_DLL !== candidateAssembly)
{
    throw new Error('candidate layout does not match the current production build run');
}
NODE
            Log 'current schema candidate does not match the current production build run'
            return 2
        fi
        if [[ "$physicalAssembly" != "$candidateAssembly" ]]; then
            Log 'current schema candidate assembly path is not canonical'
            return 2
        fi
    fi
    CURRENT_SCHEMA_CANDIDATE_ASSEMBLY="$candidateAssembly"
}

MaterializeCurrentSchemaForTestRuntime() {
    local runId="${FSUSBLOG_TEST_RUN_ID:?current schema materializer run id is required}"
    local sourceCommit="${FSUSBLOG_TEST_SOURCE_COMMIT:?current schema materializer source commit is required}"
    local runDigest
    runDigest="$(CurrentSchemaRunDigest "$runId")"
    local receiptFile="$TMP_DIR/current-schema-test-materialization-${runDigest}.json"
    local runtimeReadyFile="$TMP_DIR/current-schema-runtime-ready-${runDigest}.json"
    local runtimeTopologyAdmissionFile="$TMP_DIR/current-schema-runtime-topology-admission-${runDigest}.json"
    local serviceCatalogFile="$ROOT_DIR/config/testing/test-execution-service-catalog.json"
    local runtimeConfiguration="${FSUSBLOG_RUNTIME_CONFIGURATION:-Release}"
    case "$runtimeConfiguration" in
        Debug | Release) ;;
        *)
            Log 'current schema materializer requires Debug or Release runtime configuration'
            return 2
            ;;
    esac
    ResolveCurrentSchemaCandidateAssembly "$runtimeConfiguration"
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/execution-envelope-services.mjs" \
        --verify-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --service-catalog "$serviceCatalogFile"
    Log 'materializing canonical current schema before runtime application activation'
    ASPNETCORE_ENVIRONMENT=Test \
        FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION=1 \
        FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT="$TMP_DIR" \
        ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        ./tools/build-with-data-env.sh dotnet "$CURRENT_SCHEMA_CANDIDATE_ASSEMBLY" \
        materialize-current-schema-test \
        --run-id "$runId" \
        --source-commit "$sourceCommit" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --service-catalog "$serviceCatalogFile"
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/verify-current-schema-test-materialization-receipt.mjs" \
        --receipt-root "$TMP_DIR" \
        --run-id "$runId" \
        --source-commit "$sourceCommit" \
        --assembly "$CURRENT_SCHEMA_CANDIDATE_ASSEMBLY" \
        --service-catalog "$serviceCatalogFile" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE"
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" \
        write-current-schema-runtime-topology-admission \
        --admission "$runtimeTopologyAdmissionFile" \
        --receipt-root "$TMP_DIR" \
        --run-id "$runId" \
        --source-commit "$sourceCommit" \
        --assembly "$CURRENT_SCHEMA_CANDIDATE_ASSEMBLY" \
        --service-catalog "$serviceCatalogFile" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --profile-plan "$FIXTURE_PROFILE_PLAN_FILE" \
        --runtime-topology-input "$RUNTIME_TOPOLOGY_INPUT_FILE" \
        --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE" >/dev/null
    export FSUSBLOG_CURRENT_SCHEMA_TEST_RUNTIME_READY_RECEIPT="$runtimeReadyFile"
    export FSUSBLOG_CURRENT_SCHEMA_RUNTIME_TOPOLOGY_ADMISSION_RECEIPT="$runtimeTopologyAdmissionFile"
    Log "current schema materialization receipt: $receiptFile runtimeReady=$runtimeReadyFile runtimeTopologyAdmission=$runtimeTopologyAdmissionFile"
}

RequireCurrentSchemaRuntimeReady() {
    local runId="${FSUSBLOG_TEST_RUN_ID:?current schema runtime-ready run id is required}"
    local sourceCommit="${FSUSBLOG_TEST_SOURCE_COMMIT:?current schema runtime-ready source commit is required}"
    local runtimeConfiguration="${FSUSBLOG_RUNTIME_CONFIGURATION:-Release}"
    local serviceCatalogFile="$ROOT_DIR/config/testing/test-execution-service-catalog.json"
    local expectedRuntimeReadyFile
    expectedRuntimeReadyFile="$TMP_DIR/current-schema-runtime-ready-$(CurrentSchemaRunDigest "$runId").json"
    local expectedAdmissionFile
    expectedAdmissionFile="$TMP_DIR/current-schema-runtime-topology-admission-$(CurrentSchemaRunDigest "$runId").json"
    if [[ "${FSUSBLOG_CURRENT_SCHEMA_TEST_RUNTIME_READY_RECEIPT:-}" != "$expectedRuntimeReadyFile" ]]; then
        Log 'current schema runtime-ready receipt path is missing or not the canonical run-derived path'
        return 2
    fi
    if [[ "${FSUSBLOG_CURRENT_SCHEMA_RUNTIME_TOPOLOGY_ADMISSION_RECEIPT:-}" != "$expectedAdmissionFile" ]]; then
        Log 'current schema runtime topology admission path is missing or not the canonical run-derived path'
        return 2
    fi
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" \
        verify-current-schema-runtime-topology-admission \
        --admission "$expectedAdmissionFile" \
        --receipt-root "$TMP_DIR" \
        --run-id "$runId" \
        --source-commit "$sourceCommit" \
        --assembly "${CURRENT_SCHEMA_CANDIDATE_ASSEMBLY:?current schema candidate assembly is required}" \
        --service-catalog "$serviceCatalogFile" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --profile-plan "$FIXTURE_PROFILE_PLAN_FILE" \
        --runtime-topology-input "$RUNTIME_TOPOLOGY_INPUT_FILE" \
        --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE" >/dev/null
    Log "current schema runtime topology admission reverified: $expectedAdmissionFile"
}

EnsureAntiSpamModelRuntime() {
    # Materialize the local-acceptance portable anti-spam runtime package so the
    # comment-moderation producer can score the spam matrix role end to end.
    local targetDir="$1"
    rm -rf "$targetDir"
    mkdir -p "$targetDir"
    "${FSUSBLOG_NODE:-node}" - "$targetDir" <<'FSUSBLOG_ANTI_SPAM_MODEL'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dir = process.argv[2];
const writeJson = (name, value) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
writeJson("runtime_config.json", {
    schema: "fsus.antispammodel.runtime-config.v1",
    runtime_format: "fsus-antispam-portable-runtime-v1",
    contract_version: "fsusblog-antispam-signal-v1",
    model_profile: "fsus-antispammodel-local-acceptance",
    locale: "zh-CN",
});
writeJson("model_state.json", {
    schema: "fsus.antispammodel.model-state.v1",
    bias: 0,
});
writeJson("weights.int8.json", {
    schema: "fsus.antispammodel.weights-int8.v1",
    tokens: [
        { token: "spam", category: "spam_repeat", weight: 92, reason: "spam_repeat" },
    ],
});
writeJson("threshold_policy.json", {
    schema: "fsus.antispammodel.threshold-policy.v1",
    profiles: {
        default: { suspicious: 0.4, risky: 0.7, blocked_candidate: 0.95 },
    },
});
fs.writeFileSync(
    path.join(dir, "test_vectors.jsonl"),
    JSON.stringify({
        text: "fixture spam sample",
        threshold_profile: "default",
        expected_label: "risky",
        expected_primary_reason: "spam_repeat",
    }) + "\n",
);
const artifacts = {};
for (const name of [
    "runtime_config.json",
    "model_state.json",
    "weights.int8.json",
    "threshold_policy.json",
    "test_vectors.jsonl",
]) {
    artifacts[name] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dir, name)))
        .digest("hex");
}
writeJson("manifest.json", {
    schema: "fsus.antispammodel.portable-runtime.manifest.v1",
    runtime_format: "fsus-antispam-portable-runtime-v1",
    model_id: "fsus-antispammodel",
    model_profile: "fsus-antispammodel-local-acceptance",
    source: "mainline-release/local-acceptance",
    channel: "stable",
    artifacts,
    provenance: { build_id: "local-acceptance", format_owner: "FsusAntiSpamModel" },
});
FSUSBLOG_ANTI_SPAM_MODEL
    if [[ ! -f "$targetDir/manifest.json" ]]; then
        Log "failed to materialize the local-acceptance anti-spam model runtime package"
        return 1
    fi
}

EnsureBackend() {
    local pidFile="$TMP_DIR/backend.pid"
    local logFile="$TMP_DIR/backend.log"
    local fingerprintFile="$TMP_DIR/backend-inputs.sha"
    local managedPid
    local existingPid
    local nextFingerprint
    local currentFingerprint=""
    local backendReachable=0
    local readinessDeadline="${1:-}"
    if [[ -z "$readinessDeadline" ]]; then
        AllocateReadinessDeadline 'debug backend'
        readinessDeadline="$READINESS_DEADLINE_AT_MS"
    fi
    if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" != "1" ]]; then
        Log 'managed backend startup is read-only and requires FSUSBLOG_RUNTIME_NO_BUILD=1'
        return 2
    fi
    local runtimeConfiguration="${FSUSBLOG_RUNTIME_CONFIGURATION:-Release}"
    case "$runtimeConfiguration" in
        Debug | Release) ;;
        *)
            Log 'FSUSBLOG_RUNTIME_CONFIGURATION must be Debug or Release'
            return 2
            ;;
    esac
    local runtimeArgs="-c $runtimeConfiguration --no-build --no-restore"

    managedPid="$(ReadPidFile "$pidFile")"
    existingPid="$(FindPortPid "$DEBUG_BACKEND_PORT")"
    if ProbeBinaryUrl "$DEBUG_BACKEND_URL/api/binary/system/seo"; then
        backendReachable=1
    fi
    AdmitDedicatedRuntimePort \
        backend 'debug backend' "$pidFile" "$DEBUG_BACKEND_PORT" "$backendReachable" || return 1
    nextFingerprint="$(HashBackendInputs)"
    if [[ -f "$fingerprintFile" ]]; then
        currentFingerprint="$(cat "$fingerprintFile" 2>/dev/null || true)"
    fi

    if CanReuseProcesses &&
        [[ "$currentFingerprint" == "$nextFingerprint" ]] &&
        [[ "$backendReachable" == "1" ]] &&
        ProbeBinaryUrl "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" &&
        ProbeNotificationDrillUrl; then
        Log 'debug backend already healthy; reusing existing process'
        CompletePortLeaseHandoff debug-backend 'debug backend HTTP' "pid:$(FindPortPid "$DEBUG_BACKEND_PORT" || true)"
        return
    fi

    rm -f "$fingerprintFile"

    if [[ -n "$managedPid" ]] && kill -0 "$managedPid" >/dev/null 2>&1; then
        Log "restarting managed backend process on ${DEBUG_BACKEND_PORT} (pid ${managedPid})"
    elif [[ -n "$existingPid" ]]; then
        Log "restarting unmanaged backend process on ${DEBUG_BACKEND_PORT} (pid ${existingPid})"
    fi

    existingPid="$(FindPortPid "$DEBUG_BACKEND_PORT")"
    KillRuntimePidIfOwned backend "$pidFile" "$existingPid" "$readinessDeadline" || return 1
    KillRuntimePidIfOwned backend "$pidFile" "$managedPid" "$readinessDeadline" || return 1
    WaitForPortRelease "$DEBUG_BACKEND_PORT" "$readinessDeadline" || return 1

    Log "starting managed ${runtimeConfiguration,,} backend"
    ReleasePortLeaseBeforeBind debug-backend 'debug backend HTTP'
    local -x Testing__EnforceProductionCsp=true
    local -x PublicAot__SsrClientRoot="$PUBLIC_AOT_SSR_CLIENT_ROOT"
    local backendLaunchCommand="dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile $runtimeArgs"
    local backendContentRoot=""
    local backendWebRootExport=""
    local runtimeTopologyExport=""
    local runtimeTopologyKey
    for runtimeTopologyKey in \
        RuntimeMode__Mode \
        RuntimeMode__StaticRoles__0 \
        Runtime__Mode \
        Runtime__StaticRoles__0 \
        Runtime__DistributedInvalidation__Topology__SubscriberNodeIds__0 \
        Runtime__DistributedInvalidation__Topology__SubscriberNodeIds__1; do
        if [[ -v "$runtimeTopologyKey" ]]; then
            runtimeTopologyExport+=" ${runtimeTopologyKey}=$(printf '%q' "${!runtimeTopologyKey}")"
        fi
    done
    if [[ -n "${FSUSBLOG_BACKEND_SERVER_DLL:-}" && -f "$FSUSBLOG_BACKEND_SERVER_DLL" ]]; then
        backendLaunchCommand="dotnet $(printf '%q' "$FSUSBLOG_BACKEND_SERVER_DLL")"
        backendContentRoot="$(dirname "$FSUSBLOG_BACKEND_SERVER_DLL")"
        backendWebRootExport="ASPNETCORE_WEBROOT=$(printf '%q' "$(FrontendDistDir)")"
    else
        backendContentRoot="$ROOT_DIR/src/backend"
    fi
    AssertDedicatedRuntimePortAvailable 'debug backend' "$DEBUG_BACKEND_PORT" || return 1
    local zkAnonymousCommentsEnabled=false
    if [[ "$FIXTURE_REQUIRES_ZK_ANONYMOUS" == "1" ]]; then
        zkAnonymousCommentsEnabled=true
    fi
    local antiSpamModelRuntimePath=""
    if [[ "$FIXTURE_REQUIRES_ANTI_SPAM_MODEL" == "1" ]]; then
        antiSpamModelRuntimePath="$TEST_DATA_ROOT/anti-spam-model-runtime"
        EnsureAntiSpamModelRuntime "$antiSpamModelRuntimePath" || return 1
    fi
    FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
        FSUSBLOG_TEST_NAMESPACE="$NS_SLUG" \
        FSUSBLOG_RUNTIME_ROLE=backend \
        FSUSBLOG_RUNTIME_CONFIGURATION="$runtimeConfiguration" \
        FSUSBLOG_RUNTIME_NO_BUILD=1 \
        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
        nohup "${FSUSBLOG_PYTHON:-python3}" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bash -lc "cd $(printf '%q' "$ROOT_DIR") && export FSUSBLOG_DATA_ROOT=$(printf '%q' "$TEST_DATA_ROOT") FSUSBLOG_RELEASE_DERIVED_ROOT=$(printf '%q' "${FSUSBLOG_RELEASE_DERIVED_ROOT:-}") FSUSBLOG_RELEASE_ID=$(printf '%q' "${FSUSBLOG_RELEASE_ID:-}") ConnectionStrings__DefaultConnection=$(printf '%q' "$POSTGRES_CONNECTION") ConnectionStrings__Redis=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__Configuration=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__InstanceName=$(printf '%q' "FsusBlog_${NS_SLUG}_") FSUSBLOG_NOTIFICATION_DRILL_SECRET=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") NotificationStream__DrillSecret=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") Jwt__KeyVersion=$(printf '%q' "$JWT_KEY_VERSION") Jwt__SecretKey=$(printf '%q' "$JWT_SECRET") Jwt__Issuer=$(printf '%q' "$JWT_ISSUER") Jwt__Audience=$(printf '%q' "$JWT_AUDIENCE") Jwt__AccessTokenExpiresMinutes=$(printf '%q' "$JWT_ACCESS_TOKEN_EXPIRES_MINUTES") Security__Pow__SigningKey=$(printf '%q' "$POW_SIGNING_KEY") Security__Pow__BaseDifficulty=$(printf '%q' "$POW_BASE_DIFFICULTY") Security__Pow__MaxDifficulty=$(printf '%q' "$POW_MAX_DIFFICULTY") Security__PerceptionSealedToken__CurrentKeyVersion=dev Security__PerceptionSealedToken__Keys__dev=$(printf '%q' "$PERCEPTION_SEALED_TOKEN_KEY") Security__RecoveryKeyPepper=$(printf '%q' "$RECOVERY_KEY_PEPPER") MfaChallenge__TicketSigningKey=$(printf '%q' "$MFA_TICKET_SIGNING_KEY") HumanReadProof__SigningKey=$(printf '%q' "$HUMAN_READ_PROOF_SIGNING_KEY") HumanReadProof__Dedup__CurrentKey=$(printf '%q' "$HUMAN_READ_PROOF_DEDUP_KEY") ReadAnalyticsPrivacy__NoiseKey=$(printf '%q' "$READ_ANALYTICS_NOISE_KEY") VisitLog__IpPseudonymization__CurrentEpoch=$(printf '%q' "$VISIT_LOG_IP_KEY_EPOCH") VisitLog__IpPseudonymization__CurrentKey=$(printf '%q' "$VISIT_LOG_IP_KEY") Moderation__Pepper=$(printf '%q' "$MODERATION_PEPPER") Moderation__RegionPolicy__IpHashKey=$(printf '%q' "$MODERATION_REGION_IP_HASH_KEY") Moderation__AntiSpamModel__RuntimePath=$(printf '%q' "$antiSpamModelRuntimePath") Moderation__AntiSpamModel__RequireSignature=false Subscription__EmailHashPepper=$(printf '%q' "$SUBSCRIPTION_EMAIL_HASH_PEPPER") AnonymousCredentialIssuer__IssuerPublicKeyId=local-acceptance-issuer AnonymousCredentialIssuer__SubjectHashPepper=$(printf '%q' "$ANONYMOUS_SUBJECT_HASH_PEPPER") AnonymousCredentialRoot__AttestationKey=$(printf '%q' "$ANONYMOUS_ROOT_ATTESTATION_KEY") AnonymousCredentialRoot__AttestationKeyId=local-acceptance-root AnonymousIdentity__NullifierPepper=$(printf '%q' "$ANONYMOUS_NULLIFIER_PEPPER") AnonymousIdentity__ZkAnonymousCommentsEnabled=$(printf '%q' "$zkAnonymousCommentsEnabled") FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$(printf '%q' "$ANONYMOUS_IDENTITY_MODE") Security__RiskControl__PublicReadChallenge__Enabled=$(printf '%q' "$RISK_PUBLIC_READ_CHALLENGE_ENABLED") RateLimiting__PublicReadPermitLimit=$(printf '%q' "$PUBLIC_READ_PERMIT_LIMIT") RateLimiting__PublicReadQueueLimit=$(printf '%q' "$PUBLIC_READ_QUEUE_LIMIT") NotificationStream__MaxConnectionsPerAccount=$(printf '%q' "$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT") PublicAot__BackfillConcurrency=$(printf '%q' "$PUBLIC_AOT_BACKFILL_CONCURRENCY") PublicAot__SsrWorkerCount=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_COUNT") PublicAot__SsrWorkerScript=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_SCRIPT") ActiveReleaseFence__AllowSyntheticLocalFence=true RuntimeTuning__ThreadPool__Enabled=true RuntimeTuning__ThreadPool__MinThreadsPerCpu=$(printf '%q' "$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU")$runtimeTopologyExport ASPNETCORE_URLS=http://127.0.0.1:${DEBUG_BACKEND_PORT} ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_CONTENTROOT=$(printf '%q' "$backendContentRoot") $backendWebRootExport CORS_ALLOWED_HOSTS=$(printf '%q' "$CORS_ALLOWED_HOSTS_VALUE") AuthCookies__AllowInsecureTransportCookies=true && exec ./tools/build-with-data-env.sh $backendLaunchCommand" >"$logFile" 2>&1 </dev/null &
    local startedPid=$!
    WriteRuntimePidFile "$pidFile" "$startedPid"
    if ! WriteRuntimeProcessIdentity "$pidFile" "$startedPid" backend "$readinessDeadline"; then
        FailPortLeaseHandoff debug-backend 'debug backend HTTP' 'runtime-identity-failed'
        KillRuntimePidIfOwned backend "$pidFile" "$startedPid" "$readinessDeadline" || true
        rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
        return 1
    fi

    if ! WaitForManagedBinaryUrl 'debug backend' "$DEBUG_BACKEND_URL/api/binary/system/seo" "$readinessDeadline" "$startedPid" "$logFile"; then
        FailPortLeaseHandoff debug-backend 'debug backend HTTP' 'backend-not-ready'
        if KillRuntimePidIfOwned backend "$pidFile" "$startedPid" "$readinessDeadline"; then
            rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
        fi
        return 1
    fi
    if ! WaitForManagedBinaryUrl 'pow challenge' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" "$readinessDeadline" "$startedPid" "$logFile"; then
        FailPortLeaseHandoff debug-backend 'debug backend HTTP' 'pow-challenge-not-ready'
        if KillRuntimePidIfOwned backend "$pidFile" "$startedPid" "$readinessDeadline"; then
            rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
        fi
        return 1
    fi
    if ! AdmitDedicatedRuntimePort backend 'debug backend' "$pidFile" "$DEBUG_BACKEND_PORT" 1; then
        FailPortLeaseHandoff debug-backend 'debug backend HTTP' 'runtime-admission-failed'
        if KillRuntimePidIfOwned backend "$pidFile" "$startedPid" "$readinessDeadline"; then
            rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
        fi
        return 1
    fi
    CompletePortLeaseHandoff debug-backend 'debug backend HTTP' "pid:$(FindPortPid "$DEBUG_BACKEND_PORT" || true)"
    printf '%s\n' "$nextFingerprint" >"$fingerprintFile"
}

StartBackgroundIfNeeded() {
    local label="$1"
    local url="$2"
    local port="$3"
    local pidFile="$4"
    local logFile="$5"
    local readinessDeadline="$6"
    shift 6
    local -a cmd=("$@")
    local escapedCmd=""
    local escapedClientDir=""
    local role
    local reachable=0

    role="$(RuntimeProcessRole "$pidFile")" || return 2

    printf -v escapedCmd '%q ' "${cmd[@]}"
    printf -v escapedClientDir '%q' "$CLIENT_DIR"

    if ProbeUrl "$url"; then
        reachable=1
    fi
    AdmitDedicatedRuntimePort "$role" "$label" "$pidFile" "$port" "$reachable" || return 1
    if [[ "$reachable" == "1" ]]; then
        Log "$label already reachable"
        CompletePortLeaseHandoff "$role" "$label" "pid:$(FindPortPid "$port" || true)"
        return
    fi

    if [[ -f "$pidFile" ]]; then
        local pid
        pid="$(cat "$pidFile" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
            Log "$label process already running with pid $pid"
            if ! WaitForUrl "$label" "$url" "$readinessDeadline"; then
                return 1
            fi
            AdmitDedicatedRuntimePort "$role" "$label" "$pidFile" "$port" 1
            CompletePortLeaseHandoff "$role" "$label" "pid:$(FindPortPid "$port" || true)"
            return
        fi
    fi

    AssertDedicatedRuntimePortAvailable "$label" "$port" || return 1
    ReleasePortLeaseBeforeBind "$role" "$label"
    Log "starting $label"
    FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
        FSUSBLOG_TEST_NAMESPACE="$NS_SLUG" \
        FSUSBLOG_RUNTIME_ROLE="$role" \
        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
        nohup "${FSUSBLOG_PYTHON:-python3}" -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bash -lc "cd ${escapedClientDir} && exec ${escapedCmd}" >"$logFile" 2>&1 </dev/null &
    local startedPid=$!
    WriteRuntimePidFile "$pidFile" "$startedPid"
    if ! WriteRuntimeProcessIdentity "$pidFile" "$startedPid" "$role" "$readinessDeadline"; then
        FailPortLeaseHandoff "$role" "$label" 'runtime-identity-failed'
        KillRuntimePidIfOwned "$role" "$pidFile" "$startedPid" "$readinessDeadline" || true
        rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
        return 1
    fi

    while (($(NowMonotonicMs) < readinessDeadline)); do
        if ProbeUrl "$url"; then
            if AdmitDedicatedRuntimePort "$role" "$label" "$pidFile" "$port" 1; then
                CompletePortLeaseHandoff "$role" "$label" "pid:$(FindPortPid "$port" || true)"
                return 0
            fi
            FailPortLeaseHandoff "$role" "$label" 'runtime-admission-failed'
            if KillRuntimePidIfOwned "$role" "$pidFile" "$startedPid" "$readinessDeadline"; then
                rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
            fi
            return 1
        fi
        if ! kill -0 "$startedPid" >/dev/null 2>&1; then
            Log "$label process exited before becoming ready at $url"
            tail -20 "$logFile" >&2 || true
            rm -f "$pidFile" "$(RuntimeIdentityFile "$pidFile")"
            return 1
        fi
        sleep 1
    done

    Log "$label did not become ready at $url"
    FailPortLeaseHandoff "$role" "$label" 'runtime-not-ready'
    return 1
}

EnsureDebugFrontend() {
    local pidFile="$TMP_DIR/dev-server.pid"
    local managedPid
    local existingPid
    local debugReachable=0
    local readinessDeadline="${1:-}"
    if [[ -z "$readinessDeadline" ]]; then
        AllocateReadinessDeadline 'debug frontend'
        readinessDeadline="$READINESS_DEADLINE_AT_MS"
    fi
    managedPid="$(ReadPidFile "$pidFile")"
    existingPid="$(FindPortPid "$DEBUG_FRONTEND_PORT")"
    if ProbeUrl "$DEBUG_FRONTEND_URL/"; then
        debugReachable=1
    fi
    AdmitDedicatedRuntimePort \
        debug-frontend 'debug frontend' "$pidFile" "$DEBUG_FRONTEND_PORT" "$debugReachable" || return 1
    if CanReuseProcesses && [[ "$debugReachable" == "1" ]]; then
        Log 'debug frontend already healthy; reusing existing process'
        CompletePortLeaseHandoff debug-frontend 'debug frontend HTTP' "pid:$(FindPortPid "$DEBUG_FRONTEND_PORT" || true)"
        return
    fi

    existingPid="$(FindPortPid "$DEBUG_FRONTEND_PORT")"
    KillRuntimePidIfOwned debug-frontend "$pidFile" "$existingPid" "$readinessDeadline" || return 1
    KillRuntimePidIfOwned debug-frontend "$pidFile" "$managedPid" "$readinessDeadline" || return 1
    WaitForPortRelease "$DEBUG_FRONTEND_PORT" "$readinessDeadline" || return 1
    if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
        StartBackgroundIfNeeded \
            'debug frontend from immutable production dist' \
            "$DEBUG_FRONTEND_URL/" \
            "$DEBUG_FRONTEND_PORT" \
            "$pidFile" \
            "$TMP_DIR/dev-server.log" \
            "$readinessDeadline" \
            env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite preview --host 127.0.0.1 --port "$DEBUG_FRONTEND_PORT" --strictPort --outDir "$(FrontendDistDir)"
    else
        StartBackgroundIfNeeded \
            'debug frontend' \
            "$DEBUG_FRONTEND_URL/" \
            "$DEBUG_FRONTEND_PORT" \
            "$pidFile" \
            "$TMP_DIR/dev-server.log" \
            "$readinessDeadline" \
            env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite --host 127.0.0.1 --port "$DEBUG_FRONTEND_PORT" --strictPort
    fi
}

PrepareReleasePreviewBundle() {
    local fingerprintFile="$TMP_DIR/release-inputs.sha"
    local nextFingerprint
    local currentFingerprint=""
    local runBoundBuild="false"
    local laneSupport="$ROOT_DIR/tools/test/lanes/_lane-collect-support.sh"

    if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
        runBoundBuild="true"
        Log 'using receipt-verified CI frontend dist; local production readiness marker is not required'
    elif [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" &&
        -f "$ROOT_DIR/.tmp/test-runs/$FSUSBLOG_TEST_RUN_ID/frontend-build-ready.json" ]]; then
        FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
            FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
            FSUSBLOG_TEST_SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:?frontend build source commit is required}" \
            FSUSBLOG_TEST_SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?frontend build source fingerprint is required}" \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" validate-build
        runBoundBuild="true"
        rm -f "$ROOT_DIR/.tmp/test-runs/$FSUSBLOG_TEST_RUN_ID/release-preview-ready.json"
    fi

    nextFingerprint="$(HashReleaseInputs)"
    if [[ -f "$fingerprintFile" ]]; then
        currentFingerprint="$(cat "$fingerprintFile" 2>/dev/null || true)"
    fi

    if [[ "$currentFingerprint" == "$nextFingerprint" ]] &&
        [[ -f "$(FrontendDistDir)/index.html" ]] &&
        [[ -f "$SERVER_WWWROOT_DIR/index.html" ]]; then
        Log 'release preview bundle already prepared with matching fingerprint'
        return
    fi

    if [[ "$runBoundBuild" == "true" ]]; then
        if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
            Log 'reusing receipt-verified immutable CI frontend release bundle'
        else
            Log 'reusing digest-verified frontend release bundle produced by this build-static scheduler run'
        fi
    else
        Log 'building release preview bundle through the shared frontend run-once key'
        (
            export VITE_API_BASE_URL="$DEBUG_BACKEND_URL"
            export FSUSBLOG_TEST_NAMESPACE
            source "$laneSupport"
            EnsureWasmReceiptOnce
            RunFrontendFastBuildGroup
        )
    fi
    nextFingerprint="$(HashReleaseInputs)"
    printf '%s\n' "$nextFingerprint" >"$fingerprintFile"
}

EnsureReleasePreview() {
    local pidFile="$TMP_DIR/preview.pid"
    local fingerprintFile="$TMP_DIR/release-inputs.sha"
    local managedPid
    local existingPid
    local nextFingerprint
    local currentFingerprint=""
    local runBoundBuild="false"
    local releaseReachable=0
    local readinessDeadline="${1:-}"
    if [[ -z "$readinessDeadline" ]]; then
        AllocateReadinessDeadline 'release preview'
        readinessDeadline="$READINESS_DEADLINE_AT_MS"
    fi
    local releasePreviewProbeUrl="${RELEASE_PREVIEW_URL}/?fsus-preview-proof=bootstrap"
    if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ||
        -n "${FSUSBLOG_TEST_RUN_ID:-}" &&
        -f "$ROOT_DIR/.tmp/test-runs/$FSUSBLOG_TEST_RUN_ID/frontend-build-ready.json" ]]; then
        runBoundBuild="true"
    fi
    nextFingerprint="$(HashReleaseInputs)"
    if [[ -f "$fingerprintFile" ]]; then
        currentFingerprint="$(cat "$fingerprintFile" 2>/dev/null || true)"
    fi
    if [[ "$currentFingerprint" != "$nextFingerprint" ||
        ! -f "$(FrontendDistDir)/index.html" ||
        ! -f "$SERVER_WWWROOT_DIR/index.html" ]]; then
        Log 'release preview bundle is not prepared for the current source fingerprint'
        return 1
    fi
    managedPid="$(ReadPidFile "$pidFile")"
    existingPid="$(FindPortPid "$RELEASE_PREVIEW_PORT")"
    if ProbeUrl "$releasePreviewProbeUrl"; then
        releaseReachable=1
    fi
    AdmitDedicatedRuntimePort \
        release-preview 'release preview' "$pidFile" "$RELEASE_PREVIEW_PORT" "$releaseReachable" || return 1
    if CanReuseProcesses && [[ "$releaseReachable" == "1" ]]; then
        Log 'release preview already healthy with prepared bundle; reusing existing process'
        CompletePortLeaseHandoff release-preview 'release preview/backend HTTP' "pid:$(FindPortPid "$RELEASE_PREVIEW_PORT" || true)"
        if [[ "$runBoundBuild" == "true" && -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
            WaitForBinaryUrl 'release preview namespace API' "$RELEASE_PREVIEW_URL/api/binary/system/seo" "$readinessDeadline"
            FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
                FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
                FSUSBLOG_TEST_SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:?frontend build source commit is required}" \
                FSUSBLOG_TEST_SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?frontend build source fingerprint is required}" \
                FSUSBLOG_TEST_NAMESPACE="$FSUSBLOG_TEST_NAMESPACE" \
                FSUSBLOG_RELEASE_PREVIEW_URL="$RELEASE_PREVIEW_URL" \
                FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL" \
                "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" publish-ready
        fi
        return
    fi

    managedPid="$(ReadPidFile "$pidFile")"
    existingPid="$(FindPortPid "$RELEASE_PREVIEW_PORT")"
    KillRuntimePidIfOwned release-preview "$pidFile" "$existingPid" "$readinessDeadline" || return 1
    KillRuntimePidIfOwned release-preview "$pidFile" "$managedPid" "$readinessDeadline" || return 1
    WaitForPortRelease "$RELEASE_PREVIEW_PORT" "$readinessDeadline" || return 1

    StartBackgroundIfNeeded \
        'release preview' \
        "$releasePreviewProbeUrl" \
        "$RELEASE_PREVIEW_PORT" \
        "$pidFile" \
        "$TMP_DIR/preview.log" \
        "$readinessDeadline" \
        env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" VITE_PUBLIC_SHELL_PROXY=1 \
        npm exec -- vite preview --host 127.0.0.1 --port "$RELEASE_PREVIEW_PORT" --strictPort --outDir "$(FrontendDistDir)"

    if [[ "$runBoundBuild" == "true" && -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
        WaitForBinaryUrl 'release preview namespace API' "$RELEASE_PREVIEW_URL/api/binary/system/seo" "$readinessDeadline"
        FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
            FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
            FSUSBLOG_TEST_SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:?frontend build source commit is required}" \
            FSUSBLOG_TEST_SOURCE_FINGERPRINT="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?frontend build source fingerprint is required}" \
            FSUSBLOG_TEST_NAMESPACE="$FSUSBLOG_TEST_NAMESPACE" \
            FSUSBLOG_RELEASE_PREVIEW_URL="$RELEASE_PREVIEW_URL" \
            FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL" \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" publish-ready
    fi
}

CurrentPowDifficulty() {
    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" "${FSUSBLOG_NODE:-node}" --input-type=module -e "import { fetchChallenge } from './tests/frontend/support/auth-helpers.mjs'; const challenge = await fetchChallenge(5000); console.log(challenge.difficulty ?? challenge.Difficulty ?? 999);"
    )
}

WaitForPowReady() {
    local maxDifficulty="$POW_READY_MAX_DIFFICULTY"
    local difficulty=""

    while (($(NowMonotonicMs) < EXECUTION_DEADLINE_AT_MS)); do
        difficulty="$(CurrentPowDifficulty 2>/dev/null || true)"
        if [[ "$difficulty" =~ ^[0-9]+$ ]] && ((difficulty <= maxDifficulty)); then
            Log "pow difficulty ready: ${difficulty}"
            return 0
        fi

        sleep 1
    done

    Log "pow difficulty did not settle below ${maxDifficulty}; last=${difficulty:-unknown}"
    return 1
}

Main() {
    if [[ "${1:-}" == "--prepare-env-only" ]]; then
        ResolveFixtureProfilePlan prepare-env-only
        printf '[acceptance:bootstrap] prepared namespace environment: %s\n' "$ENV_FILE"
        return
    fi
    command -v docker >/dev/null 2>&1 || {
        Log 'docker is required'
        exit 1
    }
    if [[ "${1:-}" == "--services-only" ]]; then
        ResolveFixtureProfilePlan services-only
        READINESS_PHASES_REMAINING=1
    else
        # Order: resolve/validate profile → planned receipt → schema/services/runtime → orchestrator → receipts.
        ResolveFixtureProfilePlan full
        ConfigureLocalPublicContentFixture
        ConfigureLocalAuthFixture
        ConfigureAccountProfilePreferenceFixture
        READINESS_PHASES_REMAINING=3
        ConfigureManagedBackendRuntimeReader
    fi
    mkdir -p "$SERVER_WWWROOT_DIR"
    AllocateReadinessDeadline 'database services'
    if [[ "${1:-}" == "--services-only" ]]; then
        RunBootstrapParallel 'database services' "$READINESS_DEADLINE_AT_MS" \
            postgres EnsurePostgres \
            redis EnsureRedis
    else
        RunBootstrapParallel 'database services and backend producer' "$READINESS_DEADLINE_AT_MS" \
            postgres EnsurePostgres \
            redis EnsureRedis \
            backend-debug-build EnsureManagedBackendSharedDebugBuild
    fi
    RefreshFixtureServiceGeneration
    WriteExecutionServiceEnvelope
    if [[ "${1:-}" == "--services-only" ]]; then
        Log 'postgres and redis ready'
        return
    fi
    WriteRuntimeTopologyInput
    MaterializeCurrentSchemaForTestRuntime
    RequireCurrentSchemaRuntimeReady
    if CiProductionHasDomain frontend-dist; then
        AllocateReadinessDeadline 'release bundle preparation'
        PrepareReleasePreviewBundle "$READINESS_DEADLINE_AT_MS"
    fi
    if [[ -z "${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-}" ]]; then
        FSUSBLOG_TEST_BUSINESS_EPOCH_UTC="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
        export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC
        Log "materialized local fixture business epoch before runtime activation: $FSUSBLOG_TEST_BUSINESS_EPOCH_UTC"
    fi
    EnsureFixtureTemporalContext
    AllocateReadinessDeadline 'runtime applications'
    local -a runtimeApplications=(debug-backend EnsureBackend)
    if CiProductionHasDomain frontend-dist; then
        runtimeApplications+=(release-preview EnsureReleasePreview debug-frontend EnsureDebugFrontend)
    fi
    RunBootstrapParallel 'runtime applications' "$READINESS_DEADLINE_AT_MS" "${runtimeApplications[@]}"
    WaitForPowReady
    InvokeFixtureOrchestrator
    if CiProductionHasDomain frontend-dist; then
        # Process startup already proved the immutable frontend entry. Before
        # publishing runtime readiness, require the ordinary proxied route so
        # public SSR/AOT warmup cannot be hidden by the static bootstrap proof.
        WaitForUrl \
            'release preview public home after fixture orchestration' \
            "${RELEASE_PREVIEW_URL}/" \
            "$EXECUTION_DEADLINE_AT_MS"
    fi
    RequireCurrentSchemaRuntimeReady
    PublishEnvironmentReadyReceipt
    # The pre-runtime admission already SHA-binds this immutable topology input;
    # the terminal writer must consume the same bytes after runtime activation.
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" \
        write-acceptance-runtime-topology \
        --input "$RUNTIME_TOPOLOGY_INPUT_FILE" \
        --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE" \
        --out "$FIXTURE_DIR/runtime-topology.json" \
        --admission "$FSUSBLOG_CURRENT_SCHEMA_RUNTIME_TOPOLOGY_ADMISSION_RECEIPT" \
        --receipt-root "$TMP_DIR" \
        --run-id "$FSUSBLOG_TEST_RUN_ID" \
        --source-commit "$FSUSBLOG_TEST_SOURCE_COMMIT" \
        --assembly "${CURRENT_SCHEMA_CANDIDATE_ASSEMBLY:?current schema candidate assembly is required}" \
        --service-catalog "$ROOT_DIR/config/testing/test-execution-service-catalog.json" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --profile-plan "$FIXTURE_PROFILE_PLAN_FILE" \
        --runtime-topology-input "$RUNTIME_TOPOLOGY_INPUT_FILE" >/dev/null
    ConnectionStrings__DefaultConnection="${POSTGRES_CONNECTION};Search Path=public" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/testing/fixture-catalog.mjs" \
        verify-current-schema-terminal-dag \
        --admission "$FSUSBLOG_CURRENT_SCHEMA_RUNTIME_TOPOLOGY_ADMISSION_RECEIPT" \
        --environment-ready "$ENVIRONMENT_READY_RECEIPT_FILE" \
        --runtime-topology "$FIXTURE_DIR/runtime-topology.json" \
        --receipt-root "$TMP_DIR" \
        --run-id "$FSUSBLOG_TEST_RUN_ID" \
        --source-commit "$FSUSBLOG_TEST_SOURCE_COMMIT" \
        --assembly "${CURRENT_SCHEMA_CANDIDATE_ASSEMBLY:?current schema candidate assembly is required}" \
        --service-catalog "$ROOT_DIR/config/testing/test-execution-service-catalog.json" \
        --service-envelope "$EXECUTION_SERVICE_ENVELOPE_FILE" \
        --profile-plan "$FIXTURE_PROFILE_PLAN_FILE" \
        --runtime-topology-input "$RUNTIME_TOPOLOGY_INPUT_FILE" >/dev/null
    PublishRuntimeObserverAuthority ready
    # Remove retired URL/container-only completeness manifest if present from older runs.
    rm -f "$FIXTURE_DIR/manifest.json"
    WaitForBinaryUrl 'seo probe' "$DEBUG_BACKEND_URL/api/binary/system/seo" "$EXECUTION_DEADLINE_AT_MS"
    WaitForBinaryUrl 'pow challenge probe' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" "$EXECUTION_DEADLINE_AT_MS"
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" &&
        -n "${FSUSBLOG_TEST_RUN_ID:-}" &&
        -n "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" ]]; then
        FSUSBLOG_RESIDENT_BACKEND_PID="$(FindPortPid "$DEBUG_BACKEND_PORT")" \
        FSUSBLOG_RESIDENT_FRONTEND_PID="$(FindPortPid "$DEBUG_FRONTEND_PORT")" \
        FSUSBLOG_RESIDENT_PREVIEW_PID="$(FindPortPid "$RELEASE_PREVIEW_PORT")" \
        FSUSBLOG_POSTGRES_CONTAINER_NAME="$POSTGRES_CONTAINER" \
        FSUSBLOG_REDIS_CONTAINER_NAME="$REDIS_CONTAINER" \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-matrix/resident-resource-leases-cli.mjs" publish
    fi
    Log "acceptance environment ready profile=${FIXTURE_PROFILE_ID} source=${FIXTURE_PROFILE_SOURCE} mutationPolicy=${FIXTURE_MUTATION_POLICY} catalogDigest=${FIXTURE_CATALOG_DIGEST} fixtureReceiptDigest=${FIXTURE_RECEIPT_DIGEST}"
}

if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}" != "1" ]]; then
    Main "$@"
fi

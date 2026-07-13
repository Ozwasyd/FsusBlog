#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_WWWROOT_DIR="$ROOT_DIR/src/backend/wwwroot"
FSUSBLOG_TEST_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}"
NS_SLUG="$(printf '%s' "$FSUSBLOG_TEST_NAMESPACE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-' | sed -E 's/^-+|-+$//g')"
[[ -n "$NS_SLUG" && "$NS_SLUG" != "." && "$NS_SLUG" != ".." ]] || NS_SLUG="local"
FSUSBLOG_TEST_NAMESPACE="$NS_SLUG"
TMP_DIR="$ROOT_DIR/.tmp/acceptance/$NS_SLUG"
ENV_DIR="$ROOT_DIR/.tmp/env"
FIXTURE_DIR="$ROOT_DIR/.tmp/fixtures/$NS_SLUG"
mkdir -p "$TMP_DIR"
mkdir -p "$ENV_DIR" "$FIXTURE_DIR"

find_free_port() {
  local start="${1:-20000}"
  local end="${2:-55000}"
  local port
  for port in $(shuf -i "${start}-${end}" -n 200); do
    if ! ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q ":${port}"; then
      printf '%s\n' "$port"
      return 0
    fi
  done
  return 1
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
    esac
  done < "$ENV_FILE"
fi

POSTGRES_PORT="${FSUSBLOG_POSTGRES_PORT:-$(find_free_port 20000 21999)}"
REDIS_PORT="${FSUSBLOG_REDIS_PORT:-$(find_free_port 22000 23999)}"
DEBUG_BACKEND_PORT="${FSUSBLOG_DEBUG_BACKEND_PORT:-$(find_free_port 24000 25999)}"
DEBUG_FRONTEND_PORT="${FSUSBLOG_DEBUG_FRONTEND_PORT:-$(find_free_port 26000 27999)}"
RELEASE_PREVIEW_PORT="${FSUSBLOG_RELEASE_PREVIEW_PORT:-$(find_free_port 28000 29999)}"

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:${DEBUG_FRONTEND_PORT}}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:${DEBUG_BACKEND_PORT}}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:${RELEASE_PREVIEW_PORT}}"
CORS_ALLOWED_HOSTS_VALUE="${CORS_ALLOWED_HOSTS:-${DEBUG_FRONTEND_URL},${RELEASE_PREVIEW_URL},http://localhost:${DEBUG_FRONTEND_PORT},http://localhost:${RELEASE_PREVIEW_PORT}}"
POSTGRES_CONTAINER="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-fsusblog-test-postgres-$NS_SLUG}"
REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER_NAME:-fsusblog-test-redis-$NS_SLUG}"
if [[ ! "$POSTGRES_CONTAINER" =~ ^fsusblog-(dev|test|ci)([-_.A-Za-z0-9]*)$ ]]; then
  POSTGRES_CONTAINER="fsusblog-test-postgres-$NS_SLUG"
fi
if [[ ! "$REDIS_CONTAINER" =~ ^fsusblog-(dev|test|ci)([-_.A-Za-z0-9]*)$ ]]; then
  REDIS_CONTAINER="fsusblog-test-redis-$NS_SLUG"
fi
TEST_DATA_ROOT="${FSUSBLOG_DATA_ROOT:-$ROOT_DIR/.tmp/data/$NS_SLUG}"
POSTGRES_CONNECTION="Host=127.0.0.1;Port=${POSTGRES_PORT};Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true"
REDIS_CONNECTION="127.0.0.1:${REDIS_PORT}"
NOTIFICATION_DRILL_SECRET="${FSUSBLOG_NOTIFICATION_DRILL_SECRET:-fsus-notification-drill-$NS_SLUG}"
JWT_SECRET="${FSUSBLOG_TEST_JWT_SECRET:-fsusblog-local-acceptance-jwt-secret-${NS_SLUG}-change-me}"
JWT_ISSUER="${FSUSBLOG_TEST_JWT_ISSUER:-FsusBlogServer}"
JWT_AUDIENCE="${FSUSBLOG_TEST_JWT_AUDIENCE:-FsusBlogClient}"
JWT_ACCESS_TOKEN_EXPIRES_MINUTES="${FSUSBLOG_TEST_JWT_ACCESS_TOKEN_EXPIRES_MINUTES:-1440}"
POW_SIGNING_KEY="${FSUSBLOG_TEST_POW_SIGNING_KEY:-fsusblog-local-acceptance-pow-signing-key-${NS_SLUG}}"
POW_BASE_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_BASE_DIFFICULTY:-8}"
POW_MAX_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY:-8}"
CAPTCHA_SIGNING_KEY="${FSUSBLOG_TEST_CAPTCHA_SIGNING_KEY:-fsusblog-local-acceptance-captcha-signing-key-${NS_SLUG}}"
RECOVERY_KEY_PEPPER="${FSUSBLOG_TEST_RECOVERY_KEY_PEPPER:-fsusblog-local-acceptance-recovery-key-pepper-${NS_SLUG}}"
MFA_TICKET_SIGNING_KEY="${FSUSBLOG_TEST_MFA_TICKET_SIGNING_KEY:-fsusblog-local-acceptance-mfa-ticket-signing-key-${NS_SLUG}}"
VISIT_LOG_IP_HASH_PEPPER="${FSUSBLOG_TEST_VISIT_LOG_IP_HASH_PEPPER:-fsusblog-local-acceptance-visit-log-ip-hash-pepper-${NS_SLUG}}"
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
ACCEPTANCE_LOG_MAX_KIB="${FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB:-262144}"
if [[ ! "$ACCEPTANCE_LOG_MAX_KIB" =~ ^[0-9]+$ ]] || (( ACCEPTANCE_LOG_MAX_KIB < 1024 )); then
  printf '[acceptance:bootstrap] FSUSBLOG_ACCEPTANCE_LOG_MAX_KIB must be an integer >= 1024\n' >&2
  exit 1
fi
ulimit -f "$ACCEPTANCE_LOG_MAX_KIB"
PERCEPTION_SEALED_TOKEN_KEY="${FSUSBLOG_TEST_PERCEPTION_SEALED_TOKEN_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}"
FORCE_BOOTSTRAP="${FSUSBLOG_FORCE_BOOTSTRAP:-${CI:+1}}"
RESET_SECURITY_TEST_STATE="${FSUSBLOG_RESET_SECURITY_TEST_STATE:-1}"
POW_READY_MAX_DIFFICULTY="${POW_MAX_DIFFICULTY}"
PUBLIC_AOT_BACKFILL_CONCURRENCY="${FSUSBLOG_PUBLIC_AOT_BACKFILL_CONCURRENCY:-$(
  "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-public-aot-concurrency.mjs"
)}"
PUBLIC_AOT_SSR_WORKER_COUNT="${FSUSBLOG_PUBLIC_AOT_SSR_WORKER_COUNT:-$PUBLIC_AOT_BACKFILL_CONCURRENCY}"
PUBLIC_AOT_SSR_WORKER_SCRIPT="${FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT:-}"
RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU="${FSUSBLOG_RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU:-$(
  "${FSUSBLOG_NODE:-node}" --input-type=module -e '
    import fs from "node:fs";
    import os from "node:os";
    const policy = fs.readFileSync("tests/perf/perf-policy.yml", "utf8");
    const burst = policy.match(/(?:^|\n)  burst:\n([\s\S]*?)(?=\n  \S|$)/u)?.[1] ?? "";
    const concurrency = Number(burst.match(/^    concurrency:\s*(\d+)\s*$/mu)?.[1]);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("burst concurrency is unavailable");
    const cpu = os.availableParallelism?.() ?? os.cpus().length;
    process.stdout.write(String(Math.max(1, Math.ceil(concurrency / cpu))));
  '
)}"
if [[ ! "$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU" =~ ^[1-9][0-9]*$ ]]; then
  printf '[acceptance:bootstrap] FSUSBLOG_RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU must be a positive integer\n' >&2
  exit 1
fi
if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" == "1" && -z "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
  PUBLIC_AOT_SSR_WORKER_SCRIPT='./dist/server/server-public-ssr.bundle.mjs'
fi

write_env_file() {
  cat > "$ENV_FILE" <<EOF
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
FSUSBLOG_NOTIFICATION_DRILL_SECRET=$NOTIFICATION_DRILL_SECRET
FSUSBLOG_DATA_ROOT=$TEST_DATA_ROOT
FSUSBLOG_FIXTURE_SERVICE_GENERATION=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-uninitialized}
FSUSBLOG_RUNTIME_CONFIGURATION=${FSUSBLOG_RUNTIME_CONFIGURATION:-}
FSUSBLOG_RUNTIME_NO_BUILD=${FSUSBLOG_RUNTIME_NO_BUILD:-0}
ConnectionStrings__DefaultConnection=$POSTGRES_CONNECTION
ConnectionStrings__Redis=$REDIS_CONNECTION
RedisOptions__Configuration=$REDIS_CONNECTION
RedisOptions__InstanceName=FsusBlog_${NS_SLUG}_
NotificationStream__DrillSecret=$NOTIFICATION_DRILL_SECRET
Jwt__SecretKey=$JWT_SECRET
Jwt__Issuer=$JWT_ISSUER
Jwt__Audience=$JWT_AUDIENCE
Jwt__AccessTokenExpiresMinutes=$JWT_ACCESS_TOKEN_EXPIRES_MINUTES
Security__Pow__SigningKey=$POW_SIGNING_KEY
Security__Pow__BaseDifficulty=$POW_BASE_DIFFICULTY
Security__Pow__MaxDifficulty=$POW_MAX_DIFFICULTY
Security__CaptchaV1__SigningKey=$CAPTCHA_SIGNING_KEY
Security__PerceptionSealedToken__CurrentKeyVersion=dev
Security__PerceptionSealedToken__Keys__dev=$PERCEPTION_SEALED_TOKEN_KEY
Security__RecoveryKeyPepper=$RECOVERY_KEY_PEPPER
MfaChallenge__TicketSigningKey=$MFA_TICKET_SIGNING_KEY
VisitLog__IpHashPepper=$VISIT_LOG_IP_HASH_PEPPER
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
PublicAot__SsrWorkerScript=$PUBLIC_AOT_SSR_WORKER_SCRIPT
RuntimeTuning__ThreadPool__Enabled=true
RuntimeTuning__ThreadPool__MinThreadsPerCpu=$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU
ASPNETCORE_URLS=http://127.0.0.1:$DEBUG_BACKEND_PORT
ASPNETCORE_ENVIRONMENT=Development
CORS_ALLOWED_HOSTS=$CORS_ALLOWED_HOSTS_VALUE
AuthCookies__AllowInsecureTransportCookies=true
EOF
}

write_env_file

log() {
  printf '[acceptance:bootstrap] %s\n' "$1"
}

EXECUTION_STARTED_AT_MS="$(date +%s%3N)"
resolve_execution_budget_ms() {
  local inherited="${FSUSBLOG_STEP_DEADLINE_MS:-${FSUSBLOG_BUNDLE_DEADLINE_MS:-}}"
  if [[ -n "$inherited" ]]; then
    awk -v value="$inherited" 'BEGIN { if (value !~ /^[0-9]+([.][0-9]+)?$/ || value <= 0) exit 1; printf "%.0f\n", int(value + 0.999999) }' \
      || { printf '[acceptance:bootstrap] step/bundle execution deadline must be a finite positive number\n' >&2; return 1; }
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

EXECUTION_BUDGET_MS="$(resolve_execution_budget_ms)"
EXECUTION_DEADLINE_AT_MS=$((EXECUTION_STARTED_AT_MS + EXECUTION_BUDGET_MS))
READINESS_PHASES_REMAINING=1
READINESS_DEADLINE_AT_MS="$EXECUTION_DEADLINE_AT_MS"

allocate_readiness_deadline() {
  local label="$1"
  local now remaining phase_budget
  now="$(date +%s%3N)"
  remaining=$((EXECUTION_DEADLINE_AT_MS - now))
  if (( remaining <= 0 )); then
    log "$label has no remaining execution deadline"
    return 1
  fi
  if (( READINESS_PHASES_REMAINING < 1 )); then
    READINESS_PHASES_REMAINING=1
  fi
  phase_budget=$(((remaining + READINESS_PHASES_REMAINING - 1) / READINESS_PHASES_REMAINING))
  READINESS_DEADLINE_AT_MS=$((now + phase_budget))
  READINESS_PHASES_REMAINING=$((READINESS_PHASES_REMAINING - 1))
  log "$label readiness budget=${phase_budget}ms remaining-execution=${remaining}ms"
}

resolve_bootstrap_parallel_workers() {
  local job_count="$1"
  FSUSBLOG_COMMAND_MANIFEST_WORKERS="$job_count" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const {
  readManifestSchedulerResourceGrant,
  resolveManifestWorkers
} = await import(pathToFileURL(process.argv[2]).href)
const baseWorkers = resolveManifestWorkers({ env: process.env })
const liveGrant = readManifestSchedulerResourceGrant({ env: process.env })
const jobCount = Number.parseInt(process.env.FSUSBLOG_COMMAND_MANIFEST_WORKERS ?? '', 10)
const liveWorkers = liveGrant ? Math.floor(liveGrant.cpuUnits) : baseWorkers
process.stdout.write(String(Math.max(1, Math.min(jobCount, Math.max(baseWorkers, liveWorkers)))))
NODE
}

resolve_bootstrap_child_environment() {
  local workers="$1"
  FSUSBLOG_BOOTSTRAP_WORKERS="$workers" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

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
for (const key of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY'
]) {
  if (child[key] !== undefined) process.stdout.write(`${key}=${child[key]}\n`)
}
NODE
}

run_bootstrap_parallel() {
  local group="$1"
  local readiness_deadline="$2"
  shift 2
  if (( $# == 0 || $# % 2 != 0 )); then
    log "$group requires label/function pairs"
    return 2
  fi

  local total=$(( $# / 2 ))
  local worker_cap
  worker_cap="$(resolve_bootstrap_parallel_workers "$total")"
  local status_dir="$TMP_DIR/parallel-$(printf '%s' "$group" | tr -cs 'A-Za-z0-9_.-' '-')-$$-$RANDOM"
  local -a labels=()
  local -a commands=()
  local -a status_files=()
  local -a child_pids=()
  local -a observed=()
  mkdir -p "$status_dir"

  while (( $# > 0 )); do
    local label="$1"
    local command="$2"
    shift 2
    if ! declare -F "$command" >/dev/null; then
      rm -rf "$status_dir"
      log "$group job $label references unknown function $command"
      return 2
    fi
    labels+=("$label")
    commands+=("$command")
    status_files+=("$status_dir/${#labels[@]}.status")
  done

  log "$group start jobs=$total workers=$worker_cap"
  local next=0
  local active=0
  local completed=0
  while (( next < total || active > 0 )); do
    local next_worker_cap
    next_worker_cap="$(resolve_bootstrap_parallel_workers "$total")"
    if [[ "$next_worker_cap" != "$worker_cap" ]]; then
      log "$group capacity update workers=$worker_cap->$next_worker_cap active=$active"
      worker_cap="$next_worker_cap"
    fi
    while (( next < total && active < worker_cap )); do
      local index="$next"
      local child_env_file="$status_dir/$index.env"
      resolve_bootstrap_child_environment "$worker_cap" > "$child_env_file"
      (
        set +e
        while IFS='=' read -r key value; do
          [[ -n "$key" ]] && export "$key=$value"
        done < "$child_env_file"
        ( "${commands[$index]}" "$readiness_deadline" )
        local child_status=$?
        local pending_status="${status_files[$index]}.pending-$BASHPID"
        printf '%s\n' "$child_status" > "$pending_status"
        mv "$pending_status" "${status_files[$index]}"
        exit 0
      ) &
      child_pids[$index]="$!"
      observed[$index]=0
      next=$((next + 1))
      active=$((active + 1))
    done
    local progressed=0
    local index
    for ((index = 0; index < next; index += 1)); do
      if [[ "${observed[$index]:-0}" == "1" || ! -f "${status_files[$index]}" ]]; then
        continue
      fi
      wait "${child_pids[$index]}" >/dev/null 2>&1 || true
      observed[$index]=1
      active=$((active - 1))
      completed=$((completed + 1))
      progressed=1
    done
    if (( completed < total && progressed == 0 )); then
      sleep_within_deadline "$readiness_deadline" 100 || true
    fi
  done

  local -a failures=()
  local index
  for ((index = 0; index < total; index += 1)); do
    local child_status
    if [[ -f "${status_files[$index]}" ]]; then
      read -r child_status < "${status_files[$index]}"
    else
      child_status=125
    fi
    if [[ "$child_status" != "0" ]]; then
      failures+=("${labels[$index]} (exit ${child_status})")
    fi
  done
  rm -rf "$status_dir"

  if (( ${#failures[@]} > 0 )); then
    printf '[acceptance:bootstrap] %s failed in %d independent job(s):\n' "$group" "${#failures[@]}" >&2
    printf '  - %s\n' "${failures[@]}" >&2
    return 1
  fi
  log "$group ready"
}

read_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    cat "$pid_file" 2>/dev/null || true
  fi
}

sleep_within_deadline() {
  local deadline_at_ms="$1"
  local poll_interval_ms="$2"
  local now remaining sleep_ms
  now="$(date +%s%3N)"
  remaining=$((deadline_at_ms - now))
  if (( remaining <= 0 )); then
    return 1
  fi
  sleep_ms="$poll_interval_ms"
  if (( sleep_ms > remaining )); then
    sleep_ms="$remaining"
  fi
  sleep "$(printf '%d.%03d' $((sleep_ms / 1000)) $((sleep_ms % 1000)))"
}

kill_pid_if_running() {
  local pid="$1"
  local termination_deadline_at_ms="${2:-$EXECUTION_DEADLINE_AT_MS}"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    while kill -0 "$pid" >/dev/null 2>&1; do
      if ! sleep_within_deadline "$termination_deadline_at_ms" 500; then
        break
      fi
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
}

find_port_pid() {
  local port="$1"
  ss -ltnp "( sport = :${port} )" 2>/dev/null | awk -F'pid=' 'NR>1 {split($2, a, /[,)]/); if (a[1] != "") {print a[1]; exit}}'
}

wait_for_port_release() {
  local port="$1"
  local release_deadline_at_ms="${2:-$EXECUTION_DEADLINE_AT_MS}"
  local pid
  while true; do
    pid="$(find_port_pid "$port")"
    if [[ -z "$pid" ]]; then
      return 0
    fi
    if ! sleep_within_deadline "$release_deadline_at_ms" 250; then
      break
    fi
  done

  pid="$(find_port_pid "$port")"
  if [[ -n "$pid" ]]; then
    kill_pid_if_running "$pid" "$release_deadline_at_ms"
  fi
}

probe_url() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

probe_binary_url() {
  local url="$1"
  curl -fsS --max-time 5 -H 'Accept: application/octet-stream' "$url" >/dev/null 2>&1
}

probe_notification_drill_url() {
  curl -fsS --max-time 5 \
    -X POST \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H "X-Fsus-Notification-Drill-Secret: ${NOTIFICATION_DRILL_SECRET}" \
    --data '{"drillId":"bootstrap-probe","count":1,"payloadBytes":0,"routeKey":"content-feed"}' \
    "$DEBUG_BACKEND_URL/_fsus/testing/notification-stream/publish" >/dev/null 2>&1
}

can_reuse_processes() {
  [[ "${FORCE_BOOTSTRAP:-0}" != "1" ]]
}

hash_release_inputs() {
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

wait_for_url() {
  local label="$1"
  local url="$2"
  local deadline_at_ms="$3"

  while (( $(date +%s%3N) < deadline_at_ms )); do
    if probe_url "$url"; then
      return 0
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

wait_for_binary_url() {
  local label="$1"
  local url="$2"
  local deadline_at_ms="$3"

  while (( $(date +%s%3N) < deadline_at_ms )); do
    if probe_binary_url "$url"; then
      return 0
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

wait_for_managed_binary_url() {
  local label="$1"
  local url="$2"
  local deadline_at_ms="$3"
  local pid="$4"
  local log_file="$5"

  while (( $(date +%s%3N) < deadline_at_ms )); do
    if probe_binary_url "$url"; then
      return 0
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      log "$label process exited before becoming ready at $url"
      tail -20 "$log_file" >&2 || true
      return 1
    fi
    if ! sleep_within_deadline "$deadline_at_ms" 250; then
      break
    fi
  done

  log "$label did not become ready at $url"
  return 1
}

ensure_postgres() {
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'postgres'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    log 'postgres already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER"; then
    log 'starting existing postgres container'
    docker start "$POSTGRES_CONTAINER" >/dev/null
  else
    log 'creating postgres container'
    docker run -d \
      --name "$POSTGRES_CONTAINER" \
      -e POSTGRES_USER=fsusblog \
      -e POSTGRES_PASSWORD=fsusblog_dev \
      -e POSTGRES_DB=fsusblog \
      -p "127.0.0.1:${POSTGRES_PORT}:5432" \
      postgres:16-alpine >/dev/null
  fi

  while (( $(date +%s%3N) < readiness_deadline )); do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'postgres failed to become ready'
  exit 1
}

ensure_redis() {
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'redis'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
    log 'redis already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    log 'starting existing redis container'
    docker start "$REDIS_CONTAINER" >/dev/null
  else
    log 'creating redis container'
    docker run -d --name "$REDIS_CONTAINER" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
  fi

  while (( $(date +%s%3N) < readiness_deadline )); do
    if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'redis failed to become ready'
  exit 1
}

refresh_fixture_service_generation() {
  local postgres_identity redis_identity
  postgres_identity="$(docker inspect --format '{{.Id}}|{{.Created}}' "$POSTGRES_CONTAINER")"
  redis_identity="$(docker inspect --format '{{.Id}}|{{.Created}}' "$REDIS_CONTAINER")"
  FSUSBLOG_FIXTURE_SERVICE_GENERATION="$(printf '%s\n%s\n' "$postgres_identity" "$redis_identity" | sha256sum | awk '{print $1}')"
  export FSUSBLOG_FIXTURE_SERVICE_GENERATION
  write_env_file
}

reset_security_test_state() {
  if [[ "$RESET_SECURITY_TEST_STATE" == "0" ]]; then
    return
  fi

  local deleted
  local risk_deleted
  risk_deleted="$(docker exec "$POSTGRES_CONTAINER" psql -U fsusblog -d fsusblog -Atqc "WITH deleted AS (DELETE FROM security_risk_event WHERE expires_at_utc > (now() AT TIME ZONE 'utc') RETURNING 1) SELECT count(*) FROM deleted;" 2>/dev/null || true)"
  risk_deleted="${risk_deleted:-0}"
  if [[ "$risk_deleted" =~ ^[0-9]+$ ]] && (( risk_deleted > 0 )); then
    log "reset active persisted security risk events: ${risk_deleted}"
    FORCE_BOOTSTRAP=1
  fi

  deleted="$(docker exec "$REDIS_CONTAINER" sh -c "{ redis-cli --scan --pattern '*${NS_SLUG}*fsus:sec:pow-risk:*'; redis-cli --scan --pattern 'fsus:sec:pow-risk:*'; } | sort -u | xargs -r redis-cli DEL" 2>/dev/null || true)"
  deleted="${deleted:-0}"
  if [[ "$deleted" =~ ^[0-9]+$ ]] && (( deleted > 0 )); then
    log "reset local security PoW risk keys: ${deleted}"
    FORCE_BOOTSTRAP=1
  fi
}

ensure_backend() {
  local pid_file="$TMP_DIR/backend.pid"
  local log_file="$TMP_DIR/backend.log"
  local managed_pid
  local existing_pid
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'debug backend'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"

  if can_reuse_processes && probe_binary_url "$DEBUG_BACKEND_URL/api/binary/system/seo" && probe_binary_url "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" && probe_notification_drill_url; then
    log 'debug backend already healthy; reusing existing process'
    return
  fi

  if [[ -n "$managed_pid" ]] && kill -0 "$managed_pid" >/dev/null 2>&1; then
    log "restarting managed backend process on ${DEBUG_BACKEND_PORT} (pid ${managed_pid})"
    kill_pid_if_running "$managed_pid" "$readiness_deadline"
  elif [[ -n "$existing_pid" ]]; then
    log "restarting unmanaged backend process on ${DEBUG_BACKEND_PORT} (pid ${existing_pid})"
  fi

  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"
  kill_pid_if_running "$existing_pid" "$readiness_deadline"
  kill_pid_if_running "$managed_pid" "$readiness_deadline"
  wait_for_port_release "$DEBUG_BACKEND_PORT" "$readiness_deadline"

  local runtime_args=""
  local runtime_configuration="${FSUSBLOG_RUNTIME_CONFIGURATION:-}"
  if [[ -z "$runtime_configuration" ]]; then
    if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" == "1" ]]; then
      runtime_configuration="Release"
    else
      runtime_configuration="Debug"
    fi
  fi
  case "$runtime_configuration" in
    Debug|Release) ;;
    *)
      log 'FSUSBLOG_RUNTIME_CONFIGURATION must be Debug or Release'
      return 2
      ;;
  esac
  if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" == "1" ]]; then
    runtime_args="-c $runtime_configuration --no-build --no-restore"
  fi
  log "starting managed ${runtime_configuration,,} backend"
  nohup setsid bash -lc "cd $(printf '%q' "$ROOT_DIR") && export FSUSBLOG_DATA_ROOT=$(printf '%q' "$TEST_DATA_ROOT") ConnectionStrings__DefaultConnection=$(printf '%q' "$POSTGRES_CONNECTION") ConnectionStrings__Redis=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__Configuration=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__InstanceName=$(printf '%q' "FsusBlog_${NS_SLUG}_") FSUSBLOG_NOTIFICATION_DRILL_SECRET=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") NotificationStream__DrillSecret=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") Jwt__SecretKey=$(printf '%q' "$JWT_SECRET") Jwt__Issuer=$(printf '%q' "$JWT_ISSUER") Jwt__Audience=$(printf '%q' "$JWT_AUDIENCE") Jwt__AccessTokenExpiresMinutes=$(printf '%q' "$JWT_ACCESS_TOKEN_EXPIRES_MINUTES") Security__Pow__SigningKey=$(printf '%q' "$POW_SIGNING_KEY") Security__Pow__BaseDifficulty=$(printf '%q' "$POW_BASE_DIFFICULTY") Security__Pow__MaxDifficulty=$(printf '%q' "$POW_MAX_DIFFICULTY") Security__CaptchaV1__SigningKey=$(printf '%q' "$CAPTCHA_SIGNING_KEY") Security__PerceptionSealedToken__CurrentKeyVersion=dev Security__PerceptionSealedToken__Keys__dev=$(printf '%q' "$PERCEPTION_SEALED_TOKEN_KEY") Security__RecoveryKeyPepper=$(printf '%q' "$RECOVERY_KEY_PEPPER") MfaChallenge__TicketSigningKey=$(printf '%q' "$MFA_TICKET_SIGNING_KEY") VisitLog__IpHashPepper=$(printf '%q' "$VISIT_LOG_IP_HASH_PEPPER") Moderation__Pepper=$(printf '%q' "$MODERATION_PEPPER") Moderation__RegionPolicy__IpHashKey=$(printf '%q' "$MODERATION_REGION_IP_HASH_KEY") Subscription__EmailHashPepper=$(printf '%q' "$SUBSCRIPTION_EMAIL_HASH_PEPPER") AnonymousCredentialIssuer__IssuerPublicKeyId=local-acceptance-issuer AnonymousCredentialIssuer__SubjectHashPepper=$(printf '%q' "$ANONYMOUS_SUBJECT_HASH_PEPPER") AnonymousCredentialRoot__AttestationKey=$(printf '%q' "$ANONYMOUS_ROOT_ATTESTATION_KEY") AnonymousCredentialRoot__AttestationKeyId=local-acceptance-root AnonymousIdentity__NullifierPepper=$(printf '%q' "$ANONYMOUS_NULLIFIER_PEPPER") FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$(printf '%q' "$ANONYMOUS_IDENTITY_MODE") Security__RiskControl__PublicReadChallenge__Enabled=$(printf '%q' "$RISK_PUBLIC_READ_CHALLENGE_ENABLED") RateLimiting__PublicReadPermitLimit=$(printf '%q' "$PUBLIC_READ_PERMIT_LIMIT") RateLimiting__PublicReadQueueLimit=$(printf '%q' "$PUBLIC_READ_QUEUE_LIMIT") NotificationStream__MaxConnectionsPerAccount=$(printf '%q' "$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT") PublicAot__BackfillConcurrency=$(printf '%q' "$PUBLIC_AOT_BACKFILL_CONCURRENCY") PublicAot__SsrWorkerCount=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_COUNT") PublicAot__SsrWorkerScript=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_SCRIPT") RuntimeTuning__ThreadPool__Enabled=true RuntimeTuning__ThreadPool__MinThreadsPerCpu=$(printf '%q' "$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU") ASPNETCORE_URLS=http://127.0.0.1:${DEBUG_BACKEND_PORT} ASPNETCORE_ENVIRONMENT=Development CORS_ALLOWED_HOSTS=$(printf '%q' "$CORS_ALLOWED_HOSTS_VALUE") AuthCookies__AllowInsecureTransportCookies=true && exec ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile $runtime_args" >"$log_file" 2>&1 < /dev/null &
  local started_pid=$!
  echo "$started_pid" >"$pid_file"

  if ! wait_for_managed_binary_url 'debug backend' "$DEBUG_BACKEND_URL/api/binary/system/seo" "$readiness_deadline" "$started_pid" "$log_file"; then
    kill_pid_if_running "$started_pid" "$readiness_deadline"
    rm -f "$pid_file"
    return 1
  fi
  if ! wait_for_managed_binary_url 'pow challenge' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" "$readiness_deadline" "$started_pid" "$log_file"; then
    kill_pid_if_running "$started_pid" "$readiness_deadline"
    rm -f "$pid_file"
    return 1
  fi
}

start_background_if_needed() {
  local label="$1"
  local url="$2"
  local pid_file="$3"
  local log_file="$4"
  local readiness_deadline="$5"
  shift 5
  local -a cmd=("$@")
  local escaped_cmd=""
  local escaped_client_dir=""

  printf -v escaped_cmd '%q ' "${cmd[@]}"
  printf -v escaped_client_dir '%q' "$CLIENT_DIR"

  if probe_url "$url"; then
    log "$label already reachable"
    return
  fi

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "$label process already running with pid $pid"
      wait_for_url "$label" "$url" "$readiness_deadline"
      return
    fi
  fi

  log "starting $label"
  nohup setsid bash -lc "cd ${escaped_client_dir} && exec ${escaped_cmd}" >"$log_file" 2>&1 < /dev/null &
  local started_pid=$!
  echo "$started_pid" >"$pid_file"

  while (( $(date +%s%3N) < readiness_deadline )); do
    if probe_url "$url"; then
      return 0
    fi
    if ! kill -0 "$started_pid" >/dev/null 2>&1; then
      log "$label process exited before becoming ready at $url"
      tail -20 "$log_file" >&2 || true
      return 1
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

ensure_debug_frontend() {
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'debug frontend'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  if can_reuse_processes && probe_url "$DEBUG_FRONTEND_URL/"; then
    log 'debug frontend already healthy; reusing existing process'
    return
  fi

  kill_pid_if_running "$(read_pid_file "$TMP_DIR/dev-server.pid")" "$readiness_deadline"
  kill_pid_if_running "$(find_port_pid "$DEBUG_FRONTEND_PORT")" "$readiness_deadline"
  start_background_if_needed \
    'debug frontend' \
    "$DEBUG_FRONTEND_URL/" \
    "$TMP_DIR/dev-server.pid" \
    "$TMP_DIR/dev-server.log" \
    "$readiness_deadline" \
    env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite --host 127.0.0.1 --port "$DEBUG_FRONTEND_PORT" --strictPort
}

ensure_release_preview() {
  local fingerprint_file="$TMP_DIR/release-inputs.sha"
  local next_fingerprint
  local current_fingerprint=""
  local run_bound_build="false"
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'release preview'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi

  if [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
    FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
      FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
      "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" validate-build
    run_bound_build="true"
    rm -f "$ROOT_DIR/.tmp/test-runs/$FSUSBLOG_TEST_RUN_ID/release-preview-ready.json"
  fi

  next_fingerprint="$(hash_release_inputs)"
  if [[ -f "$fingerprint_file" ]]; then
    current_fingerprint="$(cat "$fingerprint_file" 2>/dev/null || true)"
  fi

  if can_reuse_processes \
    && [[ "$current_fingerprint" == "$next_fingerprint" ]] \
    && [[ -f "$CLIENT_DIR/dist/index.html" ]] \
    && [[ -f "$SERVER_WWWROOT_DIR/index.html" ]] \
    && probe_url "$RELEASE_PREVIEW_URL/"; then
    log 'release preview already healthy with matching fingerprint; reusing existing process'
    if [[ "$run_bound_build" == "true" ]]; then
      wait_for_binary_url 'release preview namespace API' "$RELEASE_PREVIEW_URL/api/binary/system/seo" "$readiness_deadline"
      FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
        FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
        FSUSBLOG_TEST_NAMESPACE="$FSUSBLOG_TEST_NAMESPACE" \
        FSUSBLOG_RELEASE_PREVIEW_URL="$RELEASE_PREVIEW_URL" \
        FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" publish-ready
    fi
    return
  fi

  if [[ "$run_bound_build" == "true" ]]; then
    log 'reusing digest-verified frontend release bundle produced by this build-static scheduler run'
  else
    log 'building release preview bundle through the shared frontend run-once key'
    (
      export VITE_API_BASE_URL="$DEBUG_BACKEND_URL"
      export FSUSBLOG_TEST_NAMESPACE
      source "$ROOT_DIR/tools/test/lanes/_legacy.sh"
      ensure_wasm_once
      run_frontend_fast_build_group
    )
  fi
  printf '%s\n' "$next_fingerprint" >"$fingerprint_file"

  kill_pid_if_running "$(read_pid_file "$TMP_DIR/preview.pid")" "$readiness_deadline"
  kill_pid_if_running "$(find_port_pid "$RELEASE_PREVIEW_PORT")" "$readiness_deadline"

  start_background_if_needed \
    'release preview' \
    "$RELEASE_PREVIEW_URL/" \
    "$TMP_DIR/preview.pid" \
    "$TMP_DIR/preview.log" \
    "$readiness_deadline" \
    env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite preview --host 127.0.0.1 --port "$RELEASE_PREVIEW_PORT" --strictPort

  if [[ "$run_bound_build" == "true" ]]; then
    wait_for_binary_url 'release preview namespace API' "$RELEASE_PREVIEW_URL/api/binary/system/seo" "$readiness_deadline"
    FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR" \
      FSUSBLOG_TEST_RUN_ID="$FSUSBLOG_TEST_RUN_ID" \
      FSUSBLOG_TEST_NAMESPACE="$FSUSBLOG_TEST_NAMESPACE" \
      FSUSBLOG_RELEASE_PREVIEW_URL="$RELEASE_PREVIEW_URL" \
      FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL" \
      "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ux/release-preview-readiness.mjs" publish-ready
  fi
}

refresh_acceptance_cache_after_fixtures() {
  if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
    docker exec "$REDIS_CONTAINER" redis-cli FLUSHDB >/dev/null
    log 'refreshed acceptance redis cache after fixture seeding'
  fi
}

prepare_fixtures() {
  log 'preparing auth users and playwright fixtures'
  (
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_DEBUG_BACKEND_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_DEBUG_FRONTEND_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_PG_CONTAINER="$POSTGRES_CONTAINER"
    export FSUSBLOG_REDIS_CONTAINER="$REDIS_CONTAINER"
    export FSUSBLOG_REDIS_CONTAINER_NAME="$REDIS_CONTAINER"
    export Jwt__SecretKey="$JWT_SECRET"
    export Jwt__Issuer="$JWT_ISSUER"
    export Jwt__Audience="$JWT_AUDIENCE"
    export Jwt__AccessTokenExpiresMinutes="$JWT_ACCESS_TOKEN_EXPIRES_MINUTES"
    export AnonymousCredentialIssuer__SubjectHashPepper="$ANONYMOUS_SUBJECT_HASH_PEPPER"
    # Use the same namespaced run-once keys as every downstream runtime lane.
    source "$ROOT_DIR/tools/test/lanes/_legacy.sh"
    # Auth identities and public article/taxonomy fixtures have disjoint
    # run-once keys, output contracts and database rows. Seed them together
    # after backend readiness, then flush Redis only after both writes settle.
    local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
    local -x FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted
    run_parallel "bootstrap-runtime-fixtures" \
      "auth-fixtures::prepare_auth_fixtures_once" \
      "public-fixtures::prepare_public_fixtures_once"
    refresh_acceptance_cache_after_fixtures
  )
}

current_pow_difficulty() {
  (
    cd "$ROOT_DIR"
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" "${FSUSBLOG_NODE:-node}" --input-type=module -e "import { fetchChallenge } from './tests/frontend/support/auth-helpers.mjs'; const challenge = await fetchChallenge(5000); console.log(challenge.difficulty ?? challenge.Difficulty ?? 999);"
  )
}

wait_for_pow_ready() {
  local max_difficulty="$POW_READY_MAX_DIFFICULTY"
  local difficulty=""

  while (( $(date +%s%3N) < EXECUTION_DEADLINE_AT_MS )); do
    difficulty="$(current_pow_difficulty 2>/dev/null || true)"
    if [[ "$difficulty" =~ ^[0-9]+$ ]] && (( difficulty <= max_difficulty )); then
      log "pow difficulty ready: ${difficulty}"
      return 0
    fi

    sleep 1
  done

  log "pow difficulty did not settle below ${max_difficulty}; last=${difficulty:-unknown}"
  return 1
}

main() {
  if [[ "${1:-}" == "--prepare-env-only" ]]; then
    printf '[acceptance:bootstrap] prepared namespace environment: %s\n' "$ENV_FILE"
    return
  fi
  command -v docker >/dev/null 2>&1 || { log 'docker is required'; exit 1; }
  if [[ "${1:-}" == "--services-only" ]]; then
    READINESS_PHASES_REMAINING=1
  else
    READINESS_PHASES_REMAINING=2
  fi
  mkdir -p "$SERVER_WWWROOT_DIR"
  allocate_readiness_deadline 'database services'
  run_bootstrap_parallel 'database services' "$READINESS_DEADLINE_AT_MS" \
    postgres ensure_postgres \
    redis ensure_redis
  refresh_fixture_service_generation
  if [[ "${1:-}" == "--services-only" ]]; then
    log 'postgres and redis ready'
    return
  fi
  reset_security_test_state
  allocate_readiness_deadline 'runtime applications'
  run_bootstrap_parallel 'runtime applications' "$READINESS_DEADLINE_AT_MS" \
    debug-backend ensure_backend \
    release-preview ensure_release_preview \
    debug-frontend ensure_debug_frontend
  wait_for_pow_ready
  prepare_fixtures
  jq -n \
    --arg namespace "$FSUSBLOG_TEST_NAMESPACE" \
    --arg backend "$DEBUG_BACKEND_URL" \
    --arg frontend "$DEBUG_FRONTEND_URL" \
    --arg preview "$RELEASE_PREVIEW_URL" \
    --arg postgres "$POSTGRES_CONTAINER" \
    --arg redis "$REDIS_CONTAINER" \
    '{namespace: $namespace, backendUrl: $backend, frontendUrl: $frontend, previewUrl: $preview, containers: {postgres: $postgres, redis: $redis}, generatedAt: now | todate}' \
    > "$FIXTURE_DIR/manifest.json"
  wait_for_binary_url 'seo probe' "$DEBUG_BACKEND_URL/api/binary/system/seo" "$EXECUTION_DEADLINE_AT_MS"
  wait_for_binary_url 'pow challenge probe' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" "$EXECUTION_DEADLINE_AT_MS"
  log 'acceptance environment ready'
}

if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi

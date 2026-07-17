#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_WWWROOT_DIR="${FSUSBLOG_BACKEND_WEBROOT:-$ROOT_DIR/src/backend/wwwroot}"
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
JWT_KEY_VERSION="${FSUSBLOG_TEST_JWT_KEY_VERSION:-acceptance-v1}"
JWT_ISSUER="${FSUSBLOG_TEST_JWT_ISSUER:-FsusBlogServer}"
JWT_AUDIENCE="${FSUSBLOG_TEST_JWT_AUDIENCE:-FsusBlogClient}"
JWT_ACCESS_TOKEN_EXPIRES_MINUTES="${FSUSBLOG_TEST_JWT_ACCESS_TOKEN_EXPIRES_MINUTES:-1440}"
JWT_ROTATION_WINDOW_DAYS="${FSUSBLOG_TEST_JWT_ROTATION_WINDOW_DAYS:-30}"
POW_SIGNING_KEY="${FSUSBLOG_TEST_POW_SIGNING_KEY:-fsusblog-local-acceptance-pow-signing-key-${NS_SLUG}}"
POW_BASE_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_BASE_DIFFICULTY:-8}"
POW_MAX_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY:-8}"
CAPTCHA_SIGNING_KEY="${FSUSBLOG_TEST_CAPTCHA_SIGNING_KEY:-fsusblog-local-acceptance-captcha-signing-key-${NS_SLUG}}"
RECOVERY_KEY_PEPPER="${FSUSBLOG_TEST_RECOVERY_KEY_PEPPER:-fsusblog-local-acceptance-recovery-key-pepper-${NS_SLUG}}"
MFA_TICKET_SIGNING_KEY="${FSUSBLOG_TEST_MFA_TICKET_SIGNING_KEY:-fsusblog-local-acceptance-mfa-ticket-signing-key-${NS_SLUG}}"
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
      const policy = fs.readFileSync("tests/perf/perf-policy.yml", "utf8");
      const burst = policy.match(/(?:^|\n)  burst:\n([\s\S]*?)(?=\n  \S|$)/u)?.[1] ?? "";
      const concurrency = Number(burst.match(/^    concurrency:\s*(\d+)\s*$/mu)?.[1]);
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
FSUSBLOG_TEST_RUN_ID=${FSUSBLOG_TEST_RUN_ID:-}
FSUSBLOG_PHYSICAL_BUNDLE_ID=${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}
FSUSBLOG_STEP_ID=${FSUSBLOG_STEP_ID:-}
FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}
FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID=${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}
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
Security__CaptchaV1__SigningKey=$CAPTCHA_SIGNING_KEY
Security__PerceptionSealedToken__CurrentKeyVersion=dev
Security__PerceptionSealedToken__Keys__dev=$PERCEPTION_SEALED_TOKEN_KEY
Security__RecoveryKeyPepper=$RECOVERY_KEY_PEPPER
MfaChallenge__TicketSigningKey=$MFA_TICKET_SIGNING_KEY
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
}

log() {
  printf '[acceptance:bootstrap] %s\n' "$1"
}

repository_relative_path() {
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

materialize_ci_production_build() {
  local artifact_root="${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}"
  if [[ -z "$artifact_root" ]]; then
    return
  fi
  local receipt_file="$artifact_root/receipt.json"
  if [[ ! -f "$receipt_file" ]]; then
    log "immutable CI production receipt is missing: $receipt_file"
    return 1
  fi
  local -a domains=()
  mapfile -t domains < <("${FSUSBLOG_NODE:-node}" - "$receipt_file" <<'NODE'
const fs = require('node:fs')
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!Array.isArray(receipt.domains) || receipt.domains.length === 0) throw new Error('CI production receipt has no domains')
for (const domain of receipt.domains) process.stdout.write(`${domain.name}\n`)
NODE
  )
  local -a materialize_args=(
    materialize
    --root "$ROOT_DIR"
    --artifact-root "$artifact_root"
    --destination-root "$ROOT_DIR"
    --expected-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required for CI artifact materialization}"
    --expected-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required for CI artifact materialization}"
    --expected-run-id "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required for CI artifact materialization}"
    --expected-job production-build-artifacts
    --expected-receipt-digest "${FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST:?FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST is required}"
    --evidence "$ROOT_DIR/.tmp/release-evidence/jobs/ci-build-materialization-${NS_SLUG}.json"
  )
  local domain
  for domain in "${domains[@]}"; do
    case "$domain" in
      backend-runtime)
        materialize_args+=(--map "backend-runtime=$(repository_relative_path "$(dirname "${FSUSBLOG_BACKEND_SERVER_DLL:?FSUSBLOG_BACKEND_SERVER_DLL is required}")")")
        ;;
      test-runtime)
        materialize_args+=(--map "test-runtime=$(repository_relative_path "${FSUSBLOG_BACKEND_TEST_BIN_DIR:?FSUSBLOG_BACKEND_TEST_BIN_DIR is required}")")
        ;;
      frontend-dist)
        materialize_args+=(--map "frontend-dist=$(repository_relative_path "${FSUSBLOG_FRONTEND_DIST_ROOT:?FSUSBLOG_FRONTEND_DIST_ROOT is required}")")
        materialize_args+=(--map "frontend-dist=$(repository_relative_path "$SERVER_WWWROOT_DIR")")
        ;;
      wasm)
        materialize_args+=(--map "wasm=$(repository_relative_path "${FSUSBLOG_FRONTEND_WASM_ROOT:?FSUSBLOG_FRONTEND_WASM_ROOT is required}")")
        ;;
      generated-contracts)
        materialize_args+=(--map "generated-contracts=$(repository_relative_path "${FSUSBLOG_GENERATED_OUTPUT_ROOT:?FSUSBLOG_GENERATED_OUTPUT_ROOT is required}")/ci-contracts")
        ;;
      *)
        log "immutable CI production receipt has unsupported domain: $domain"
        return 1
        ;;
    esac
  done
  "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/production-build-artifacts-cli.mjs" "${materialize_args[@]}" >/dev/null
  FSUSBLOG_RUNTIME_NO_BUILD=1
  FSUSBLOG_RUNTIME_CONFIGURATION=Release
  if [[ -z "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
    PUBLIC_AOT_SSR_WORKER_SCRIPT='./dist/server/server-public-ssr.bundle.mjs'
  fi
  export FSUSBLOG_RUNTIME_NO_BUILD FSUSBLOG_RUNTIME_CONFIGURATION PUBLIC_AOT_SSR_WORKER_SCRIPT
  FSUSBLOG_CI_PRODUCTION_DOMAINS="$(IFS=,; printf '%s' "${domains[*]}")"
  export FSUSBLOG_CI_PRODUCTION_DOMAINS
  log "materialized verified immutable CI production domains into run-bound build root: $FSUSBLOG_CI_PRODUCTION_DOMAINS"
}

materialize_ci_production_build
if [[ -z "$PUBLIC_AOT_SSR_CLIENT_ROOT" \
    && -n "${FSUSBLOG_FRONTEND_DIST_ROOT:-}" \
    && -f "$FSUSBLOG_FRONTEND_DIST_ROOT/server/server-public-ssr.bundle.mjs" \
    && -f "$FSUSBLOG_FRONTEND_DIST_ROOT/server/public-ssr.mjs" ]]; then
  PUBLIC_AOT_SSR_CLIENT_ROOT="$FSUSBLOG_FRONTEND_DIST_ROOT"
  PUBLIC_AOT_SSR_WORKER_SCRIPT='./server/server-public-ssr.bundle.mjs'
fi
write_env_file

ci_production_has_domain() {
  local expected="$1"
  if [[ -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
    return 0
  fi
  [[ ",${FSUSBLOG_CI_PRODUCTION_DOMAINS:-}," == *",${expected},"* ]]
}

EXECUTION_STARTED_AT_MS="$(date +%s%3N)"
DEDICATED_RUNTIME_EXECUTION_BUDGET_CAP_MS=240000
resolve_execution_budget_ms() {
  local inherited="${FSUSBLOG_STEP_DEADLINE_MS:-${FSUSBLOG_BUNDLE_DEADLINE_MS:-}}"
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
    ' || { printf '[acceptance:bootstrap] dedicated execution deadline must be a finite positive number\n' >&2; return 1; }
    return 0
  fi
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
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
    printf '1\n'
    return 0
  fi
  FSUSBLOG_COMMAND_MANIFEST_WORKERS="$job_count" \
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

resolve_bootstrap_child_environment() {
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
const bytesPerGiB = 1024 ** 3
const positiveNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const machineCpu = os.availableParallelism?.() ?? os.cpus().length
const childCpu = positiveNumber(child.FSUSBLOG_STEP_CPU_BUDGET, 1)
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
child.FSUSBLOG_DOCKER_CPU_UNITS = child.FSUSBLOG_STEP_CPU_BUDGET
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
    local wave_child_env_file=''
    local wave_child_env_status=0
    if (( next < total && active < worker_cap )); then
      wave_child_env_file="$status_dir/wave-$next-$worker_cap.env"
      if resolve_bootstrap_child_environment "$worker_cap" > "$wave_child_env_file"; then
        :
      else
        wave_child_env_status=$?
      fi
    fi
    while (( next < total && active < worker_cap )); do
      local index="$next"
      if (( wave_child_env_status == 0 )); then
        (
          set +e
          if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
            unset FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE
            unset FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE
            unset FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX
          fi
          while IFS='=' read -r key value; do
            [[ -n "$key" ]] && export "$key=$value"
          done < "$wave_child_env_file"
          ( "${commands[$index]}" "$readiness_deadline" )
          local child_status=$?
          local pending_status="${status_files[$index]}.pending-$BASHPID"
          printf '%s\n' "$child_status" > "$pending_status"
          mv "$pending_status" "${status_files[$index]}"
          exit 0
        ) &
        child_pids[$index]="$!"
      else
        log "$group job ${labels[$index]} could not resolve its child resource grant"
        printf '%s\n' "$wave_child_env_status" > "${status_files[$index]}"
        child_pids[$index]=''
      fi
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
      if [[ -n "${child_pids[$index]:-}" ]]; then
        wait "${child_pids[$index]}" >/dev/null 2>&1 || true
      fi
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

runtime_process_role() {
  case "$(basename "$1")" in
    backend.pid) printf 'backend\n' ;;
    dev-server.pid) printf 'debug-frontend\n' ;;
    preview.pid) printf 'release-preview\n' ;;
    *) return 1 ;;
  esac
}

runtime_identity_file() {
  local pid_file="$1"
  printf '%s.identity.json\n' "${pid_file%.pid}"
}

write_runtime_pid_file() {
  local pid_file="$1"
  local pid="$2"
  local pending="${pid_file}.pending-$$-${RANDOM}"
  (umask 077; printf '%s\n' "$pid" > "$pending")
  chmod 0600 "$pending"
  mv -fT -- "$pending" "$pid_file"
  chmod 0600 "$pid_file"
}

write_runtime_process_identity() {
  local pid_file="$1"
  local pid="$2"
  local role="$3"
  local readiness_deadline_at_ms="${4:-$EXECUTION_DEADLINE_AT_MS}"
  local identity_file
  identity_file="$(runtime_identity_file "$pid_file")"
  FSUSBLOG_RUNTIME_IDENTITY_PID="$pid" \
    FSUSBLOG_RUNTIME_IDENTITY_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
    FSUSBLOG_RUNTIME_IDENTITY_NAMESPACE="$NS_SLUG" \
    FSUSBLOG_RUNTIME_IDENTITY_ROLE="$role" \
    FSUSBLOG_RUNTIME_IDENTITY_DEDICATED="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
    FSUSBLOG_RUNTIME_IDENTITY_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
    FSUSBLOG_RUNTIME_IDENTITY_FILE="$identity_file" \
    FSUSBLOG_RUNTIME_IDENTITY_DEADLINE_AT_MS="$readiness_deadline_at_ms" \
    "${FSUSBLOG_NODE:-node}" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const pid = Number.parseInt(process.env.FSUSBLOG_RUNTIME_IDENTITY_PID ?? '', 10)
const runId = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_RUN_ID ?? '').trim()
const namespace = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_NAMESPACE ?? '').trim()
const role = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_ROLE ?? '').trim()
const dedicated = process.env.FSUSBLOG_RUNTIME_IDENTITY_DEDICATED === '1'
const preparationId = String(process.env.FSUSBLOG_RUNTIME_IDENTITY_PREPARATION_ID ?? '').trim()
const file = path.resolve(process.env.FSUSBLOG_RUNTIME_IDENTITY_FILE ?? '')
const inheritedDeadlineAtMs = Number.parseInt(
  process.env.FSUSBLOG_RUNTIME_IDENTITY_DEADLINE_AT_MS ?? '',
  10
)
if (!Number.isInteger(pid) || pid <= 1 || !runId || !namespace || !role || !file
  || (dedicated && !preparationId)
  || !Number.isInteger(inheritedDeadlineAtMs)) {
  throw new Error('runtime process identity input is incomplete')
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
const deadlineAtMs = Math.min(inheritedDeadlineAtMs, Date.now() + 2_000)
let observed = null
let lastReason = 'procfs identity unavailable'
while (Date.now() <= deadlineAtMs) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    const processGroupId = Number.parseInt(tail[2] ?? '', 10)
    const sessionId = Number.parseInt(tail[3] ?? '', 10)
    const startTimeTicks = tail[19] ?? ''
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
    if (processGroupId === pid
      && sessionId === pid
      && /^\d+$/u.test(startTimeTicks)
      && environment.FSUSBLOG_TEST_RUN_ID === runId
      && environment.FSUSBLOG_TEST_NAMESPACE === namespace
      && environment.FSUSBLOG_RUNTIME_ROLE === role
      && (!dedicated || (
        environment.FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME === '1'
        && environment.FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID === preparationId
      ))) {
      observed = { processGroupId, startTimeTicks }
      break
    }
    lastReason = `pgrp=${processGroupId} session=${sessionId} role=${environment.FSUSBLOG_RUNTIME_ROLE ?? ''}`
  } catch (error) {
    if (error.code === 'ENOENT') {
      lastReason = 'process exited before identity stabilized'
    } else {
      throw error
    }
  }
  const remainingMs = deadlineAtMs - Date.now()
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
  createdAt: new Date().toISOString()
}, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(pending, 0o600)
fs.renameSync(pending, file)
fs.chmodSync(file, 0o600)
NODE
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

port_is_listening() {
  local port="$1"
  ss -H -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR == 1 { found = 1 } END { exit found ? 0 : 1 }'
}

dedicated_runtime_process_binding_matches() {
  local pid_file="$1"
  local role="$2"
  local observed_pid="$3"
  local identity_file
  identity_file="$(runtime_identity_file "$pid_file")"

  FSUSBLOG_RUNTIME_BINDING_PID_FILE="$pid_file" \
    FSUSBLOG_RUNTIME_BINDING_IDENTITY_FILE="$identity_file" \
    FSUSBLOG_RUNTIME_BINDING_OBSERVED_PID="$observed_pid" \
    FSUSBLOG_RUNTIME_BINDING_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
    FSUSBLOG_RUNTIME_BINDING_NAMESPACE="$NS_SLUG" \
    FSUSBLOG_RUNTIME_BINDING_ROLE="$role" \
    FSUSBLOG_RUNTIME_BINDING_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
    "${FSUSBLOG_NODE:-node}" <<'NODE'
const fs = require('node:fs')

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

admit_dedicated_runtime_port() {
  local role="$1"
  local label="$2"
  local pid_file="$3"
  local port="$4"
  local reachable="${5:-0}"
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
    return 0
  fi
  if [[ -z "${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" ]]; then
    log "$label dedicated runtime preparation identity is missing; refusing runtime admission"
    return 1
  fi

  local managed_pid observed_pid listening=0
  managed_pid="$(read_pid_file "$pid_file")"
  if port_is_listening "$port"; then
    listening=1
  fi
  observed_pid="$(find_port_pid "$port")"

  if [[ -n "$managed_pid" && ! "$managed_pid" =~ ^[0-9]+$ ]]; then
    log "$label dedicated runtime pid sidecar is malformed; refusing runtime admission"
    return 1
  fi
  if [[ -n "$managed_pid" ]] && kill -0 "$managed_pid" >/dev/null 2>&1 \
      && ! dedicated_runtime_process_binding_matches "$pid_file" "$role" "$managed_pid"; then
    log "$label pid $managed_pid is not owned by this dedicated preparation; refusing reuse or termination"
    return 1
  fi
  if [[ -n "$observed_pid" ]] \
      && ! dedicated_runtime_process_binding_matches "$pid_file" "$role" "$observed_pid"; then
    log "$label port $port listener pid $observed_pid is not owned by this dedicated preparation; refusing reuse or termination"
    return 1
  fi
  if (( listening == 1 )) && [[ -z "$observed_pid" ]]; then
    log "$label port $port is listening without an inspectable owned pid; refusing runtime admission"
    return 1
  fi
  if [[ "$reachable" == "1" && ( "$listening" != "1" || -z "$observed_pid" ) ]]; then
    log "$label is reachable without an inspectable owned listener sidecar; refusing reuse"
    return 1
  fi
}

runtime_process_group_exists() {
  local process_group_id="$1"
  kill -0 -- "-$process_group_id" >/dev/null 2>&1
}

signal_runtime_process_group() {
  local signal="$1"
  local process_group_id="$2"
  kill "-$signal" -- "-$process_group_id" >/dev/null 2>&1
}

terminate_dedicated_runtime_process_group() {
  local role="$1"
  local pid_file="$2"
  local observed_pid="$3"
  local termination_deadline_at_ms="$4"
  local process_group_id
  process_group_id="$(read_pid_file "$pid_file")"
  if ! dedicated_runtime_process_binding_matches "$pid_file" "$role" "$observed_pid"; then
    return 1
  fi
  if ! runtime_process_group_exists "$process_group_id"; then
    return 0
  fi
  if ! signal_runtime_process_group TERM "$process_group_id"; then
    log "$role dedicated runtime process group $process_group_id refused SIGTERM"
    return 1
  fi
  while runtime_process_group_exists "$process_group_id"; do
    if ! sleep_within_deadline "$termination_deadline_at_ms" 250; then
      break
    fi
  done
  if ! runtime_process_group_exists "$process_group_id"; then
    return 0
  fi
  if ! dedicated_runtime_process_binding_matches "$pid_file" "$role" "$process_group_id"; then
    log "$role dedicated runtime identity changed before SIGKILL; refusing further termination"
    return 1
  fi
  signal_runtime_process_group KILL "$process_group_id" || return 1
  ! runtime_process_group_exists "$process_group_id"
}

kill_runtime_pid_if_owned() {
  local role="$1"
  local pid_file="$2"
  local pid="$3"
  local termination_deadline_at_ms="${4:-$EXECUTION_DEADLINE_AT_MS}"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
    kill_pid_if_running "$pid" "$termination_deadline_at_ms"
    return
  fi
  if ! terminate_dedicated_runtime_process_group \
      "$role" "$pid_file" "$pid" "$termination_deadline_at_ms"; then
    log "$role pid $pid is not safely bound to this dedicated preparation; refusing termination"
    return 1
  fi
}

assert_dedicated_runtime_port_available() {
  local label="$1"
  local port="$2"
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
    return 0
  fi
  if port_is_listening "$port"; then
    local pid
    pid="$(find_port_pid "$port")"
    log "$label port $port was claimed before managed spawn (pid ${pid:-uninspectable}); refusing to race or terminate it"
    return 1
  fi
}

wait_for_port_release() {
  local port="$1"
  local release_deadline_at_ms="${2:-$EXECUTION_DEADLINE_AT_MS}"
  local pid
  while true; do
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
      if ! port_is_listening "$port"; then
        return 0
      fi
    else
      pid="$(find_port_pid "$port")"
      if [[ -z "$pid" ]]; then
        return 0
      fi
    fi
    if ! sleep_within_deadline "$release_deadline_at_ms" 250; then
      break
    fi
  done

  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
    if port_is_listening "$port"; then
      pid="$(find_port_pid "$port")"
      log "dedicated runtime port $port is still held by pid ${pid:-uninspectable}; refusing blind termination"
      return 1
    fi
    return 0
  fi
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

hash_backend_inputs() {
  local worker_path=""
  local bundle_path=""
  if [[ -n "$PUBLIC_AOT_SSR_CLIENT_ROOT" && -n "$PUBLIC_AOT_SSR_WORKER_SCRIPT" ]]; then
    worker_path="$PUBLIC_AOT_SSR_CLIENT_ROOT/${PUBLIC_AOT_SSR_WORKER_SCRIPT#./}"
    bundle_path="$PUBLIC_AOT_SSR_CLIENT_ROOT/server/public-ssr.mjs"
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
          for file in Directory.Build.props Directory.Build.targets; do
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

    for file in "${FSUSBLOG_BACKEND_SERVER_DLL:-}" "$worker_path" "$bundle_path"; do
      if [[ -n "$file" && -f "$file" ]]; then
        sha256sum "$file"
      elif [[ -n "$file" ]]; then
        printf 'missing %s\n' "$file"
      fi
    done
  } | sha256sum | awk '{print $1}'
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

DOCKER_RESOURCE_ARGS=()
build_docker_resource_args() {
  local cpu="${FSUSBLOG_DOCKER_CPU_UNITS:-}"
  local memory_high="${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES:-}"
  local memory_max="${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES:-}"
  local pids_max="${FSUSBLOG_DOCKER_PIDS_MAX:-}"
  local run_identity="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}"
  local bundle_identity="${FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone}"
  local step_identity="${FSUSBLOG_STEP_ID:-bootstrap}"
  local preparation_identity="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}"
  DOCKER_RESOURCE_ARGS=(
    --label "io.fsusblog.test.run-id=$run_identity"
    --label "io.fsusblog.test.bundle-id=$bundle_identity"
    --label "io.fsusblog.test.step-id=$step_identity"
    --label "io.fsusblog.test.namespace=$NS_SLUG"
  )
  if [[ -n "$preparation_identity" ]]; then
    DOCKER_RESOURCE_ARGS+=(--label "io.fsusblog.test.preparation-id=$preparation_identity")
  fi
  if [[ -z "$cpu$memory_high$memory_max$pids_max" ]]; then
    return 0
  fi
  if [[ ! "$cpu" =~ ^[0-9]+([.][0-9]+)?$ || ! "$memory_high" =~ ^[0-9]+$ \
      || ! "$memory_max" =~ ^[0-9]+$ || ! "$pids_max" =~ ^[0-9]+$ ]]; then
    log 'Docker resource enforcement requires positive CPU, memory high/max, and pids values'
    return 1
  fi
  if [[ "$cpu" =~ ^0+([.]0+)?$ ]] || (( memory_high <= 0 || memory_max < memory_high || pids_max <= 0 )); then
    log 'Docker resource enforcement grant is outside its valid CPU, memory, or pids envelope'
    return 1
  fi
  DOCKER_RESOURCE_ARGS+=(
    --cpus "$cpu"
    --memory-reservation "$memory_high"
    --memory "$memory_max"
    --pids-limit "$pids_max"
  )
  DOCKER_RESOURCE_ARGS+=(
    --label "io.fsusblog.test.cpu-units=$cpu"
    --label "io.fsusblog.test.memory-high-bytes=$memory_high"
    --label "io.fsusblog.test.memory-max-bytes=$memory_max"
    --label "io.fsusblog.test.pids-max=$pids_max"
  )
}

update_existing_container_resources() {
  local container="$1"
  local cpu="${FSUSBLOG_DOCKER_CPU_UNITS:-}"
  local memory_high="${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES:-}"
  local memory_max="${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES:-}"
  local pids_max="${FSUSBLOG_DOCKER_PIDS_MAX:-}"
  build_docker_resource_args
  if [[ -z "$cpu$memory_high$memory_max$pids_max" ]]; then
    return 0
  fi
  docker update \
    --cpus "${FSUSBLOG_DOCKER_CPU_UNITS}" \
    --memory-reservation "${FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES}" \
    --memory "${FSUSBLOG_DOCKER_MEMORY_MAX_BYTES}" \
    --pids-limit "${FSUSBLOG_DOCKER_PIDS_MAX}" \
    "$container" >/dev/null
}

container_resource_binding_matches() {
  local container="$1"
  if [[ -z "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
    [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]
    return
  fi
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" \
      && ( -z "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" || -z "${FSUSBLOG_STEP_ID:-}" ) ]]; then
    return 1
  fi
  local bundle_identity="${FSUSBLOG_PHYSICAL_BUNDLE_ID:-standalone}"
  local step_identity="${FSUSBLOG_STEP_ID:-bootstrap}"
  local preparation_identity="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}"
  local binding
  binding="$(docker inspect --format '{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.bundle-id"}}|{{index .Config.Labels "io.fsusblog.test.step-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}|{{with index .Config.Labels "io.fsusblog.test.preparation-id"}}{{.}}{{end}}' "$container" 2>/dev/null || true)"
  [[ "$binding" == "${FSUSBLOG_TEST_RUN_ID}|${bundle_identity}|${step_identity}|${NS_SLUG}|${preparation_identity}" ]]
}

assert_dedicated_container_binding() {
  local container="$1"
  local service="$2"
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" ]]; then
    return 0
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$container" \
      && ! container_resource_binding_matches "$container"; then
    log "refusing to reuse, remove, or recreate $service container with mismatched dedicated-runtime ownership: $container"
    return 1
  fi
}

ensure_postgres() {
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'postgres'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  assert_dedicated_container_binding "$POSTGRES_CONTAINER" postgres || return 1
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1 \
      && container_resource_binding_matches "$POSTGRES_CONTAINER"; then
    log 'postgres already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER" \
      && container_resource_binding_matches "$POSTGRES_CONTAINER"; then
    log 'starting existing postgres container'
    update_existing_container_resources "$POSTGRES_CONTAINER"
    docker start "$POSTGRES_CONTAINER" >/dev/null
  else
    if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER"; then
      if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        log "refusing to remove or recreate postgres container during dedicated runtime: $POSTGRES_CONTAINER"
        return 1
      fi
      log 'recreating postgres container with current run/bundle/step resource identity'
      docker rm -f -v "$POSTGRES_CONTAINER" >/dev/null
    fi
    log 'creating postgres container'
    build_docker_resource_args
    docker run -d \
      "${DOCKER_RESOURCE_ARGS[@]}" \
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
  assert_dedicated_container_binding "$REDIS_CONTAINER" redis || return 1
  if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1 \
      && container_resource_binding_matches "$REDIS_CONTAINER"; then
    log 'redis already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER" \
      && container_resource_binding_matches "$REDIS_CONTAINER"; then
    log 'starting existing redis container'
    update_existing_container_resources "$REDIS_CONTAINER"
    docker start "$REDIS_CONTAINER" >/dev/null
  else
    if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
      if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
        log "refusing to remove or recreate redis container during dedicated runtime: $REDIS_CONTAINER"
        return 1
      fi
      log 'recreating redis container with current run/bundle/step resource identity'
      docker rm -f -v "$REDIS_CONTAINER" >/dev/null
    fi
    log 'creating redis container'
    build_docker_resource_args
    docker run -d "${DOCKER_RESOURCE_ARGS[@]}" --name "$REDIS_CONTAINER" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
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

MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED=0

configure_managed_backend_runtime_reader() {
  local runtime_configuration="${FSUSBLOG_RUNTIME_CONFIGURATION:-}"
  local requested_no_build="${FSUSBLOG_RUNTIME_NO_BUILD:-0}"

  if [[ -z "$runtime_configuration" ]]; then
    if [[ "$requested_no_build" == "1" ]]; then
      runtime_configuration="Release"
    else
      runtime_configuration="Debug"
    fi
  fi
  case "$runtime_configuration" in
    Debug)
      MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED=1
      ;;
    Release)
      if [[ "$requested_no_build" != "1" ]]; then
        log 'managed Release backend requires a prebuilt runtime and FSUSBLOG_RUNTIME_NO_BUILD=1'
        return 2
      fi
      ;;
    *)
      log 'FSUSBLOG_RUNTIME_CONFIGURATION must be Debug or Release'
      return 2
      ;;
  esac

  # Runtime processes are readers. Debug is produced once through the same
  # run-once key as backend test consumers; Release must arrive prebuilt.
  FSUSBLOG_RUNTIME_CONFIGURATION="$runtime_configuration"
  FSUSBLOG_RUNTIME_NO_BUILD=1
  export FSUSBLOG_RUNTIME_CONFIGURATION FSUSBLOG_RUNTIME_NO_BUILD
  write_env_file
}

ensure_managed_backend_shared_debug_build() {
  if [[ "$MANAGED_BACKEND_SHARED_DEBUG_BUILD_REQUIRED" != "1" ]]; then
    return
  fi
  log 'preparing managed Debug backend through the shared backend build producer'
  (
    source "$ROOT_DIR/tools/test/lanes/_legacy.sh"
    FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug ensure_backend_filtered_build
  )
}

ensure_backend() {
  local pid_file="$TMP_DIR/backend.pid"
  local log_file="$TMP_DIR/backend.log"
  local fingerprint_file="$TMP_DIR/backend-inputs.sha"
  local managed_pid
  local existing_pid
  local next_fingerprint
  local current_fingerprint=""
  local backend_reachable=0
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'debug backend'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" != "1" ]]; then
    log 'managed backend startup is read-only and requires FSUSBLOG_RUNTIME_NO_BUILD=1'
    return 2
  fi
  local runtime_configuration="${FSUSBLOG_RUNTIME_CONFIGURATION:-Release}"
  case "$runtime_configuration" in
    Debug|Release) ;;
    *)
      log 'FSUSBLOG_RUNTIME_CONFIGURATION must be Debug or Release'
      return 2
      ;;
  esac
  local runtime_args="-c $runtime_configuration --no-build --no-restore"

  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"
  if probe_binary_url "$DEBUG_BACKEND_URL/api/binary/system/seo"; then
    backend_reachable=1
  fi
  admit_dedicated_runtime_port \
    backend 'debug backend' "$pid_file" "$DEBUG_BACKEND_PORT" "$backend_reachable" || return 1
  next_fingerprint="$(hash_backend_inputs)"
  if [[ -f "$fingerprint_file" ]]; then
    current_fingerprint="$(cat "$fingerprint_file" 2>/dev/null || true)"
  fi

  if can_reuse_processes \
      && [[ "$current_fingerprint" == "$next_fingerprint" ]] \
      && [[ "$backend_reachable" == "1" ]] \
      && probe_binary_url "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" \
      && probe_notification_drill_url; then
    log 'debug backend already healthy; reusing existing process'
    return
  fi

  rm -f "$fingerprint_file"

  if [[ -n "$managed_pid" ]] && kill -0 "$managed_pid" >/dev/null 2>&1; then
    log "restarting managed backend process on ${DEBUG_BACKEND_PORT} (pid ${managed_pid})"
  elif [[ -n "$existing_pid" ]]; then
    log "restarting unmanaged backend process on ${DEBUG_BACKEND_PORT} (pid ${existing_pid})"
  fi

  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"
  kill_runtime_pid_if_owned backend "$pid_file" "$existing_pid" "$readiness_deadline" || return 1
  kill_runtime_pid_if_owned backend "$pid_file" "$managed_pid" "$readiness_deadline" || return 1
  wait_for_port_release "$DEBUG_BACKEND_PORT" "$readiness_deadline" || return 1

  log "starting managed ${runtime_configuration,,} backend"
  local -x Testing__EnforceProductionCsp=true
  local -x PublicAot__SsrClientRoot="$PUBLIC_AOT_SSR_CLIENT_ROOT"
  assert_dedicated_runtime_port_available 'debug backend' "$DEBUG_BACKEND_PORT" || return 1
  FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
    FSUSBLOG_TEST_NAMESPACE="$NS_SLUG" \
    FSUSBLOG_RUNTIME_ROLE=backend \
    FSUSBLOG_RUNTIME_CONFIGURATION="$runtime_configuration" \
    FSUSBLOG_RUNTIME_NO_BUILD=1 \
    FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
    FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
    nohup setsid bash -lc "cd $(printf '%q' "$ROOT_DIR") && export FSUSBLOG_DATA_ROOT=$(printf '%q' "$TEST_DATA_ROOT") ConnectionStrings__DefaultConnection=$(printf '%q' "$POSTGRES_CONNECTION") ConnectionStrings__Redis=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__Configuration=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__InstanceName=$(printf '%q' "FsusBlog_${NS_SLUG}_") FSUSBLOG_NOTIFICATION_DRILL_SECRET=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") NotificationStream__DrillSecret=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") Jwt__KeyVersion=$(printf '%q' "$JWT_KEY_VERSION") Jwt__SecretKey=$(printf '%q' "$JWT_SECRET") Jwt__Issuer=$(printf '%q' "$JWT_ISSUER") Jwt__Audience=$(printf '%q' "$JWT_AUDIENCE") Jwt__AccessTokenExpiresMinutes=$(printf '%q' "$JWT_ACCESS_TOKEN_EXPIRES_MINUTES") Security__Pow__SigningKey=$(printf '%q' "$POW_SIGNING_KEY") Security__Pow__BaseDifficulty=$(printf '%q' "$POW_BASE_DIFFICULTY") Security__Pow__MaxDifficulty=$(printf '%q' "$POW_MAX_DIFFICULTY") Security__CaptchaV1__SigningKey=$(printf '%q' "$CAPTCHA_SIGNING_KEY") Security__PerceptionSealedToken__CurrentKeyVersion=dev Security__PerceptionSealedToken__Keys__dev=$(printf '%q' "$PERCEPTION_SEALED_TOKEN_KEY") Security__RecoveryKeyPepper=$(printf '%q' "$RECOVERY_KEY_PEPPER") MfaChallenge__TicketSigningKey=$(printf '%q' "$MFA_TICKET_SIGNING_KEY") VisitLog__IpPseudonymization__CurrentEpoch=$(printf '%q' "$VISIT_LOG_IP_KEY_EPOCH") VisitLog__IpPseudonymization__CurrentKey=$(printf '%q' "$VISIT_LOG_IP_KEY") Moderation__Pepper=$(printf '%q' "$MODERATION_PEPPER") Moderation__RegionPolicy__IpHashKey=$(printf '%q' "$MODERATION_REGION_IP_HASH_KEY") Subscription__EmailHashPepper=$(printf '%q' "$SUBSCRIPTION_EMAIL_HASH_PEPPER") AnonymousCredentialIssuer__IssuerPublicKeyId=local-acceptance-issuer AnonymousCredentialIssuer__SubjectHashPepper=$(printf '%q' "$ANONYMOUS_SUBJECT_HASH_PEPPER") AnonymousCredentialRoot__AttestationKey=$(printf '%q' "$ANONYMOUS_ROOT_ATTESTATION_KEY") AnonymousCredentialRoot__AttestationKeyId=local-acceptance-root AnonymousIdentity__NullifierPepper=$(printf '%q' "$ANONYMOUS_NULLIFIER_PEPPER") FSUSBLOG_ANONYMOUS_IDENTITY_MODE=$(printf '%q' "$ANONYMOUS_IDENTITY_MODE") Security__RiskControl__PublicReadChallenge__Enabled=$(printf '%q' "$RISK_PUBLIC_READ_CHALLENGE_ENABLED") RateLimiting__PublicReadPermitLimit=$(printf '%q' "$PUBLIC_READ_PERMIT_LIMIT") RateLimiting__PublicReadQueueLimit=$(printf '%q' "$PUBLIC_READ_QUEUE_LIMIT") NotificationStream__MaxConnectionsPerAccount=$(printf '%q' "$NOTIFICATION_STREAM_MAX_CONNECTIONS_PER_ACCOUNT") PublicAot__BackfillConcurrency=$(printf '%q' "$PUBLIC_AOT_BACKFILL_CONCURRENCY") PublicAot__SsrWorkerCount=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_COUNT") PublicAot__SsrWorkerScript=$(printf '%q' "$PUBLIC_AOT_SSR_WORKER_SCRIPT") ActiveReleaseFence__AllowSyntheticLocalFence=true RuntimeTuning__ThreadPool__Enabled=true RuntimeTuning__ThreadPool__MinThreadsPerCpu=$(printf '%q' "$RUNTIME_THREADPOOL_MIN_THREADS_PER_CPU") ASPNETCORE_URLS=http://127.0.0.1:${DEBUG_BACKEND_PORT} ASPNETCORE_ENVIRONMENT=Development CORS_ALLOWED_HOSTS=$(printf '%q' "$CORS_ALLOWED_HOSTS_VALUE") AuthCookies__AllowInsecureTransportCookies=true && exec ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile $runtime_args" >"$log_file" 2>&1 < /dev/null &
  local started_pid=$!
  write_runtime_pid_file "$pid_file" "$started_pid"
  if ! write_runtime_process_identity "$pid_file" "$started_pid" backend "$readiness_deadline"; then
    kill_pid_if_running "$started_pid" "$readiness_deadline"
    rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
    return 1
  fi

  if ! wait_for_managed_binary_url 'debug backend' "$DEBUG_BACKEND_URL/api/binary/system/seo" "$readiness_deadline" "$started_pid" "$log_file"; then
    if kill_runtime_pid_if_owned backend "$pid_file" "$started_pid" "$readiness_deadline"; then
      rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
    fi
    return 1
  fi
  if ! wait_for_managed_binary_url 'pow challenge' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" "$readiness_deadline" "$started_pid" "$log_file"; then
    if kill_runtime_pid_if_owned backend "$pid_file" "$started_pid" "$readiness_deadline"; then
      rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
    fi
    return 1
  fi
  if ! admit_dedicated_runtime_port backend 'debug backend' "$pid_file" "$DEBUG_BACKEND_PORT" 1; then
    if kill_runtime_pid_if_owned backend "$pid_file" "$started_pid" "$readiness_deadline"; then
      rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
    fi
    return 1
  fi
  printf '%s\n' "$next_fingerprint" > "$fingerprint_file"
}

start_background_if_needed() {
  local label="$1"
  local url="$2"
  local port="$3"
  local pid_file="$4"
  local log_file="$5"
  local readiness_deadline="$6"
  shift 6
  local -a cmd=("$@")
  local escaped_cmd=""
  local escaped_client_dir=""
  local role
  local reachable=0

  role="$(runtime_process_role "$pid_file")" || return 2

  printf -v escaped_cmd '%q ' "${cmd[@]}"
  printf -v escaped_client_dir '%q' "$CLIENT_DIR"

  if probe_url "$url"; then
    reachable=1
  fi
  admit_dedicated_runtime_port "$role" "$label" "$pid_file" "$port" "$reachable" || return 1
  if [[ "$reachable" == "1" ]]; then
    log "$label already reachable"
    return
  fi

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "$label process already running with pid $pid"
      if ! wait_for_url "$label" "$url" "$readiness_deadline"; then
        return 1
      fi
      admit_dedicated_runtime_port "$role" "$label" "$pid_file" "$port" 1
      return
    fi
  fi

  assert_dedicated_runtime_port_available "$label" "$port" || return 1
  log "starting $label"
  FSUSBLOG_TEST_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-direct-$NS_SLUG}" \
    FSUSBLOG_TEST_NAMESPACE="$NS_SLUG" \
    FSUSBLOG_RUNTIME_ROLE="$role" \
    FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME="${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" \
    FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="${FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:-}" \
    nohup setsid bash -lc "cd ${escaped_client_dir} && exec ${escaped_cmd}" >"$log_file" 2>&1 < /dev/null &
  local started_pid=$!
  write_runtime_pid_file "$pid_file" "$started_pid"
  if ! write_runtime_process_identity "$pid_file" "$started_pid" "$role" "$readiness_deadline"; then
    kill_pid_if_running "$started_pid" "$readiness_deadline"
    rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
    return 1
  fi

  while (( $(date +%s%3N) < readiness_deadline )); do
    if probe_url "$url"; then
      if admit_dedicated_runtime_port "$role" "$label" "$pid_file" "$port" 1; then
        return 0
      fi
      if kill_runtime_pid_if_owned "$role" "$pid_file" "$started_pid" "$readiness_deadline"; then
        rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
      fi
      return 1
    fi
    if ! kill -0 "$started_pid" >/dev/null 2>&1; then
      log "$label process exited before becoming ready at $url"
      tail -20 "$log_file" >&2 || true
      rm -f "$pid_file" "$(runtime_identity_file "$pid_file")"
      return 1
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

ensure_debug_frontend() {
  local pid_file="$TMP_DIR/dev-server.pid"
  local managed_pid
  local existing_pid
  local debug_reachable=0
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'debug frontend'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$DEBUG_FRONTEND_PORT")"
  if probe_url "$DEBUG_FRONTEND_URL/"; then
    debug_reachable=1
  fi
  admit_dedicated_runtime_port \
    debug-frontend 'debug frontend' "$pid_file" "$DEBUG_FRONTEND_PORT" "$debug_reachable" || return 1
  if can_reuse_processes && [[ "$debug_reachable" == "1" ]]; then
    log 'debug frontend already healthy; reusing existing process'
    return
  fi

  existing_pid="$(find_port_pid "$DEBUG_FRONTEND_PORT")"
  kill_runtime_pid_if_owned debug-frontend "$pid_file" "$existing_pid" "$readiness_deadline" || return 1
  kill_runtime_pid_if_owned debug-frontend "$pid_file" "$managed_pid" "$readiness_deadline" || return 1
  wait_for_port_release "$DEBUG_FRONTEND_PORT" "$readiness_deadline" || return 1
  if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
    start_background_if_needed \
      'debug frontend from immutable production dist' \
      "$DEBUG_FRONTEND_URL/" \
      "$DEBUG_FRONTEND_PORT" \
      "$pid_file" \
      "$TMP_DIR/dev-server.log" \
      "$readiness_deadline" \
      env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite preview --host 127.0.0.1 --port "$DEBUG_FRONTEND_PORT" --strictPort
  else
    start_background_if_needed \
      'debug frontend' \
      "$DEBUG_FRONTEND_URL/" \
      "$DEBUG_FRONTEND_PORT" \
      "$pid_file" \
      "$TMP_DIR/dev-server.log" \
      "$readiness_deadline" \
      env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite --host 127.0.0.1 --port "$DEBUG_FRONTEND_PORT" --strictPort
  fi
}

ensure_release_preview() {
  local pid_file="$TMP_DIR/preview.pid"
  local fingerprint_file="$TMP_DIR/release-inputs.sha"
  local managed_pid
  local existing_pid
  local next_fingerprint
  local current_fingerprint=""
  local run_bound_build="false"
  local release_reachable=0
  local readiness_deadline="${1:-}"
  if [[ -z "$readiness_deadline" ]]; then
    allocate_readiness_deadline 'release preview'
    readiness_deadline="$READINESS_DEADLINE_AT_MS"
  fi
  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$RELEASE_PREVIEW_PORT")"
  if probe_url "$RELEASE_PREVIEW_URL/"; then
    release_reachable=1
  fi
  admit_dedicated_runtime_port \
    release-preview 'release preview' "$pid_file" "$RELEASE_PREVIEW_PORT" "$release_reachable" || return 1

  if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
    run_bound_build="true"
    log 'using receipt-verified CI frontend dist; local production readiness marker is not required'
  elif [[ -n "${FSUSBLOG_TEST_RUN_ID:-}" \
      && -f "$ROOT_DIR/.tmp/test-runs/$FSUSBLOG_TEST_RUN_ID/frontend-build-ready.json" ]]; then
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
    && [[ "$release_reachable" == "1" ]]; then
    log 'release preview already healthy with matching fingerprint; reusing existing process'
    if [[ "$run_bound_build" == "true" && -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
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
    if [[ -n "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
      log 'reusing receipt-verified immutable CI frontend release bundle'
    else
      log 'reusing digest-verified frontend release bundle produced by this build-static scheduler run'
    fi
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

  release_reachable=0
  if probe_url "$RELEASE_PREVIEW_URL/"; then
    release_reachable=1
  fi
  admit_dedicated_runtime_port \
    release-preview 'release preview' "$pid_file" "$RELEASE_PREVIEW_PORT" "$release_reachable" || return 1
  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$RELEASE_PREVIEW_PORT")"
  kill_runtime_pid_if_owned release-preview "$pid_file" "$existing_pid" "$readiness_deadline" || return 1
  kill_runtime_pid_if_owned release-preview "$pid_file" "$managed_pid" "$readiness_deadline" || return 1
  wait_for_port_release "$RELEASE_PREVIEW_PORT" "$readiness_deadline" || return 1

  start_background_if_needed \
    'release preview' \
    "$RELEASE_PREVIEW_URL/" \
    "$RELEASE_PREVIEW_PORT" \
    "$pid_file" \
    "$TMP_DIR/preview.log" \
    "$readiness_deadline" \
    env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" VITE_PUBLIC_SHELL_PROXY=1 \
      npm exec -- vite preview --host 127.0.0.1 --port "$RELEASE_PREVIEW_PORT" --strictPort

  if [[ "$run_bound_build" == "true" && -z "${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-}" ]]; then
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
    export Jwt__KeyVersion="$JWT_KEY_VERSION"
    export Jwt__SecretKey="$JWT_SECRET"
    export Jwt__Issuer="$JWT_ISSUER"
    export Jwt__Audience="$JWT_AUDIENCE"
    export Jwt__AccessTokenExpiresMinutes="$JWT_ACCESS_TOKEN_EXPIRES_MINUTES"
    export Jwt__RotationWindowDays="$JWT_ROTATION_WINDOW_DAYS"
    export AnonymousCredentialIssuer__SubjectHashPepper="$ANONYMOUS_SUBJECT_HASH_PEPPER"
    # Use the same namespaced run-once keys as every downstream runtime lane.
    source "$ROOT_DIR/tools/test/lanes/_legacy.sh"
    # Auth identities and public article/taxonomy fixtures have disjoint
    # run-once keys, output contracts and database rows. Seed them together
    # after backend readiness, then flush Redis only after both writes settle.
    if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" == "1" ]]; then
      prepare_auth_fixtures_once
      prepare_public_fixtures_once
    else
      local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
      local -x FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted
      run_parallel "bootstrap-runtime-fixtures" \
        "auth-fixtures::prepare_auth_fixtures_once" \
        "public-fixtures::prepare_public_fixtures_once"
    fi
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
    configure_managed_backend_runtime_reader
  fi
  mkdir -p "$SERVER_WWWROOT_DIR"
  allocate_readiness_deadline 'database services'
  if [[ "${1:-}" == "--services-only" ]]; then
    run_bootstrap_parallel 'database services' "$READINESS_DEADLINE_AT_MS" \
      postgres ensure_postgres \
      redis ensure_redis
  else
    run_bootstrap_parallel 'database services and backend producer' "$READINESS_DEADLINE_AT_MS" \
      postgres ensure_postgres \
      redis ensure_redis \
      backend-debug-build ensure_managed_backend_shared_debug_build
  fi
  refresh_fixture_service_generation
  if [[ "${1:-}" == "--services-only" ]]; then
    log 'postgres and redis ready'
    return
  fi
  reset_security_test_state
  allocate_readiness_deadline 'runtime applications'
  local -a runtime_applications=(debug-backend ensure_backend)
  if ci_production_has_domain frontend-dist; then
    runtime_applications+=(release-preview ensure_release_preview debug-frontend ensure_debug_frontend)
  fi
  run_bootstrap_parallel 'runtime applications' "$READINESS_DEADLINE_AT_MS" "${runtime_applications[@]}"
  wait_for_pow_ready
  prepare_fixtures
  if ci_production_has_domain frontend-dist; then
    wait_for_url \
      'release preview public home after fixture seeding' \
      "$RELEASE_PREVIEW_URL/" \
      "$EXECUTION_DEADLINE_AT_MS"
  fi
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
  if [[ "${FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0}" != "1" \
      && -n "${FSUSBLOG_TEST_RUN_ID:-}" \
      && -n "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" ]]; then
    FSUSBLOG_RESIDENT_BACKEND_PID="$(find_port_pid "$DEBUG_BACKEND_PORT")" \
      FSUSBLOG_RESIDENT_FRONTEND_PID="$(find_port_pid "$DEBUG_FRONTEND_PORT")" \
      FSUSBLOG_RESIDENT_PREVIEW_PID="$(find_port_pid "$RELEASE_PREVIEW_PORT")" \
      FSUSBLOG_POSTGRES_CONTAINER_NAME="$POSTGRES_CONTAINER" \
      FSUSBLOG_REDIS_CONTAINER_NAME="$REDIS_CONTAINER" \
      "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-matrix/resident-resource-leases-cli.mjs" publish
  fi
  log 'acceptance environment ready'
}

if [[ "${FSUSBLOG_BOOTSTRAP_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi

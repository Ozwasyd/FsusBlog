#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
BACKEND_TRX_DIR="${FSUSBLOG_BACKEND_TRX_DIR:-$ROOT_DIR/.tmp/test-results/backend}"
GATE_LOG_DIR="${FSUSBLOG_GATE_LOG_DIR:-$ROOT_DIR/.tmp/gate-logs}"
FRONTEND_FAST_GROUP_TIMINGS_JSONL="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSONL:-}"
FRONTEND_FAST_GROUP_TIMINGS_JSON="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSON:-}"

FAST_HTTP_TIMEOUT_MS="${FSUSBLOG_FAST_HTTP_TIMEOUT_MS:-15000}"
INTEGRATION_HTTP_TIMEOUT_MS="${FSUSBLOG_INTEGRATION_HTTP_TIMEOUT_MS:-15000}"
RELEASE_HTTP_TIMEOUT_MS="${FSUSBLOG_RELEASE_HTTP_TIMEOUT_MS:-15000}"
ACCEPTANCE_HTTP_TIMEOUT_MS="${FSUSBLOG_ACCEPTANCE_HTTP_TIMEOUT_MS:-15000}"
VISUAL_HTTP_TIMEOUT_MS="${FSUSBLOG_VISUAL_HTTP_TIMEOUT_MS:-15000}"
SECURITY_HTTP_TIMEOUT_MS="${FSUSBLOG_SECURITY_HTTP_TIMEOUT_MS:-15000}"
RESILIENCE_HTTP_TIMEOUT_MS="${FSUSBLOG_RESILIENCE_HTTP_TIMEOUT_MS:-15000}"
LOAD_HTTP_TIMEOUT_MS="${FSUSBLOG_LOAD_HTTP_TIMEOUT_MS:-10000}"
POW_READY_MAX_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY:-20}"

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:3000}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:7568}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"
DOTNET_BUILD_SHARED_ARGS=(/p:UseSharedCompilation=true /p:NuGetAudit=false)
DOTNET_BUILD_PARALLEL_ARGS=()
BACKEND_ORDINARY_TEST_FILTER="${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-Category!=Integration&Category!=ApiIntegration&Category!=Concurrency&Category!=Performance&Category!=Property&Category!=GoldenContract&Category!=SecurityStateMachine}"

default_playwright_workers() {
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '1'
  else
    node "$ROOT_DIR/tools/test/resolve-playwright-workers.mjs" default
  fi
}

configure_playwright_workers() {
  local profile="$1"
  local env_name="$2"
  local current="${!env_name-}"

  if [[ -z "$current" ]]; then
    current="$(node "$ROOT_DIR/tools/test/resolve-playwright-workers.mjs" "$profile")"
    export "$env_name=$current"
  fi

  log "playwright workers: profile=$profile $env_name=$current"
}

record_visual_gate_skip() {
  local reason="${FSUSBLOG_VISUAL_SKIP_REASON:-}"
  local approver="${FSUSBLOG_VISUAL_SKIP_APPROVER:-}"
  local impact="${FSUSBLOG_VISUAL_SKIP_IMPACT:-}"
  local rerun_url="${FSUSBLOG_VISUAL_SKIP_RERUN_URL:-}"
  local out_file="$GATE_LOG_DIR/visual-gate-skip.json"

  if [[ -z "$reason" || -z "$approver" || -z "$impact" || -z "$rerun_url" ]]; then
    fail "FSUSBLOG_SKIP_VISUAL_GATE=1 requires FSUSBLOG_VISUAL_SKIP_REASON, FSUSBLOG_VISUAL_SKIP_APPROVER, FSUSBLOG_VISUAL_SKIP_IMPACT and FSUSBLOG_VISUAL_SKIP_RERUN_URL"
  fi

  mkdir -p "$GATE_LOG_DIR"
  node - "$out_file" <<'NODE'
const fs = require('node:fs');
const outFile = process.argv[2];
const rerunUrl = process.env.FSUSBLOG_VISUAL_SKIP_RERUN_URL || '';
if (!/^https?:\/\/\S+$/.test(rerunUrl)) {
  console.error('[test:production] FSUSBLOG_VISUAL_SKIP_RERUN_URL must be an absolute http(s) URL');
  process.exit(1);
}

const evidence = {
  status: 'visual-gate-skipped',
  generatedAt: new Date().toISOString(),
  reason: process.env.FSUSBLOG_VISUAL_SKIP_REASON,
  approver: process.env.FSUSBLOG_VISUAL_SKIP_APPROVER,
  impact: process.env.FSUSBLOG_VISUAL_SKIP_IMPACT,
  rerunUrl
};
fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
  log "tier=visual | skip evidence: $out_file"
}

write_visual_playwright_skip_evidence() {
  local group="$1"
  local output_dir="$CLIENT_DIR/test-results/playwright/visual-$group"
  local output_file="$output_dir/skip.json"
  mkdir -p "$output_dir"
  node - "$output_file" "$group" <<'NODE'
const fs = require('node:fs')
const outputFile = process.argv[2]
const group = process.argv[3]
fs.writeFileSync(outputFile, `${JSON.stringify({
  schema: 'fsusblog.playwright.visual-skip.v1',
  status: 'skipped',
  group,
  reason: process.env.FSUSBLOG_VISUAL_SKIP_REASON,
  approver: process.env.FSUSBLOG_VISUAL_SKIP_APPROVER,
  impact: process.env.FSUSBLOG_VISUAL_SKIP_IMPACT,
  rerunUrl: process.env.FSUSBLOG_VISUAL_SKIP_RERUN_URL,
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

print_artifact_hint() {
  printf '[test:%s] diagnostics: .tmp/acceptance/*.log and src/frontend/test-results/playwright are preserved when present\n' "${CURRENT_TIER:-unknown}" >&2
}

on_error() {
  local status=$?
  printf '[test:%s] failed in stage: %s (exit %s)\n' "${CURRENT_TIER:-unknown}" "${CURRENT_STAGE:-unknown}" "$status" >&2
  print_artifact_hint
  exit "$status"
}

trap on_error ERR

log() {
  printf '[test:%s] %s\n' "${CURRENT_TIER:-unknown}" "$1"
}

fail() {
  printf '[test:%s] error: %s\n' "${CURRENT_TIER:-unknown}" "$1" >&2
  print_artifact_hint
  exit 1
}

configure_dotnet_build_parallelism() {
  local raw="${FSUSBLOG_DOTNET_BUILD_PARALLELISM:-dynamic}"
  raw="${raw//[[:space:]]/}"
  local normalized="${raw,,}"
  local mode
  local msbuild_arg

  case "$normalized" in
    ""|dynamic)
      mode="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-dotnet-build-parallelism.mjs")"
      msbuild_arg="/m:$mode"
      ;;
    safe|single|1)
      mode="safe"
      msbuild_arg="/m:1"
      ;;
    auto)
      mode="auto"
      msbuild_arg="/m"
      ;;
    *)
      if [[ "$normalized" =~ ^[0-9]+$ ]] && (( 10#$normalized > 1 )); then
        mode="$((10#$normalized))"
        msbuild_arg="/m:$mode"
      else
        fail "FSUSBLOG_DOTNET_BUILD_PARALLELISM must be dynamic, safe, 1, auto, or an integer greater than 1 (got '$raw')"
      fi
      ;;
  esac

  DOTNET_BUILD_PARALLEL_ARGS=("$msbuild_arg" "${DOTNET_BUILD_SHARED_ARGS[@]}")
  log "dotnet-build parallelism=$mode arg=$msbuild_arg"
}

namespace_slug() {
  local slug
  slug="$(printf '%s' "${1:-local}" | tr -c 'A-Za-z0-9_.-' '-')"
  if [[ -z "$slug" || "$slug" == "." || "$slug" == ".." ]]; then
    slug='local'
  fi
  printf '%s' "$slug"
}

require_bootstrapped_namespace() {
  local namespace="${FSUSBLOG_TEST_NAMESPACE:-local}"
  local slug
  slug="$(namespace_slug "$namespace")"
  local env_file="$ROOT_DIR/.tmp/env/$slug.env"

  if [[ ! -f "$env_file" ]]; then
    fail "bootstrap env missing for namespace '$namespace' ($env_file); run bootstrap in the same FSUSBLOG_TEST_NAMESPACE"
  fi

  local recorded_namespace
  recorded_namespace="$(awk -F= '$1 == "FSUSBLOG_TEST_NAMESPACE" {print $2; exit}' "$env_file")"
  local recorded_slug
  recorded_slug="$(namespace_slug "$recorded_namespace")"

  if [[ -z "$recorded_namespace" || "$recorded_slug" != "$slug" ]]; then
    fail "bootstrap namespace mismatch: current='$namespace' env_file='$recorded_namespace' ($env_file)"
  fi

  local key value
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$value"
    fi
  done < "$env_file"

  DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-$DEBUG_FRONTEND_URL}"
  DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-$DEBUG_BACKEND_URL}"
  RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-$RELEASE_PREVIEW_URL}"
  export FSUSBLOG_PG_CONTAINER="${FSUSBLOG_PG_CONTAINER:-${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}}"
  export FSUSBLOG_REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER:-${FSUSBLOG_REDIS_CONTAINER_NAME:-}}"
}

configure_playwright_shard() {
  local lane="$1"
  local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
  local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

  if [[ -z "$index" && -z "$total" ]]; then
    export PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/$lane}"
    log "playwright unsharded output=$PLAYWRIGHT_OUTPUT_DIR"
    return
  fi
  if [[ ! "$index" =~ ^[0-9]+$ || ! "$total" =~ ^[0-9]+$ ]]; then
    fail "invalid Playwright shard: index='${index:-}' total='${total:-}'"
  fi
  if (( index < 1 || total < 1 || index > total )); then
    fail "invalid Playwright shard: index='$index' total='$total'"
  fi

  export FSUSBLOG_PLAYWRIGHT_SHARD_ARG="--shard=${index}/${total}"
  export PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/$lane/shard-${index}-of-${total}}"
  log "playwright shard: ${index}/${total} output=$PLAYWRIGHT_OUTPUT_DIR"
}

configure_vitest_shard() {
  local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
  local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

  if [[ -z "$index" && -z "$total" ]]; then
    return
  fi
  if [[ ! "$index" =~ ^[0-9]+$ || ! "$total" =~ ^[0-9]+$ ]]; then
    fail "invalid Vitest shard: index='${index:-}' total='${total:-}'"
  fi
  if (( index < 1 || total < 1 || index > total )); then
    fail "invalid Vitest shard: index='$index' total='$total'"
  fi

  export FSUSBLOG_VITEST_SHARD_ARG="--shard=${index}/${total}"
  log "vitest shard: ${index}/${total}"
}

run() {
  CURRENT_STAGE="$*"
  log "run: $*"
  "$@"
}

run_in_client() {
  CURRENT_STAGE="(cd src/frontend && $*)"
  log "run: (cd src/frontend && $*)"
  (
    cd "$CLIENT_DIR"
    "$@"
  )
}

test_input_fingerprint() {
  "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-once.mjs" fingerprint --root "$ROOT_DIR" "$@"
}

run_once_command() {
  local key="$1"
  local fingerprint="$2"
  local cwd="$3"
  local required_output="$4"
  shift 4
  local -a args=(
    run
    --root "$ROOT_DIR/.tmp/run-once"
    --namespace "${FSUSBLOG_TEST_NAMESPACE:-local}"
    --key "$key"
    --fingerprint "$fingerprint"
    --cwd "$cwd"
  )
  if [[ -n "$required_output" && "$required_output" != "-" ]]; then
    local output
    while IFS= read -r output; do
      [[ -n "$output" ]] && args+=(--require-output "$output")
    done < <(printf '%s\n' "$required_output" | tr '|' '\n')
  fi
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-once.mjs" "${args[@]}" -- "$@"
}

fixture_root_path() {
  "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/frontend/support/fixture-paths.mjs"
}

ensure_wasm_once() {
  local fingerprint wasm_output
  wasm_output="${FSUSBLOG_FRONTEND_WASM_ROOT:-public/wasm}"
  fingerprint="$(test_input_fingerprint \
    --path src/frontend/wasm \
    --path tools/frontend/ensure-wasm.mjs \
    --path tools/frontend/install-wasm-codec-deps.sh \
    --path tools/test/legacy-test.sh \
    --value ensure-wasm-v1)"
  run_once_command \
    ensure-wasm \
    "$fingerprint" \
    "$CLIENT_DIR" \
    "$wasm_output" \
    npm run ensure:wasm
}

prepare_auth_fixtures_once() {
  local fingerprint fixture_root
  fixture_root="$(fixture_root_path)"
  fingerprint="$(test_input_fingerprint \
    --path tests/frontend/fixtures/prepare-auth-smoke-users.mjs \
    --path tests/frontend/support/session-fixtures.mjs \
    --path tests/frontend/support/fixture-paths.mjs \
    --path tests/frontend/support/test-session.mjs \
    --path tools/test/legacy-test.sh \
    --value auth-fixtures-v2 \
    --value "namespace=${FSUSBLOG_TEST_NAMESPACE:-local}" \
    --value "session-prefix=${FSUSBLOG_TEST_SESSION_PREFIX:-pw}" \
    --value "service-generation=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-unbootstrapped}" \
    --secret-env FSUSBLOG_BASE_URL \
    --secret-env FSUSBLOG_DEBUG_BACKEND_URL \
    --secret-env FSUSBLOG_PG_CONTAINER \
    --secret-env FSUSBLOG_PG_USER \
    --secret-env FSUSBLOG_PG_DB \
    --secret-env FSUSBLOG_REDIS_CONTAINER \
    --secret-env FSUSBLOG_REDIS_CONTAINER_NAME \
    --secret-env FSUSBLOG_USER_USERNAME \
    --secret-env FSUSBLOG_ADMIN_USERNAME \
    --secret-env FSUSBLOG_DEVICE_FP \
    --secret-env Jwt__SecretKey \
    --secret-env JWT_SECRET \
    --secret-env FSUSBLOG_JWT_SECRET \
    --secret-env FSUSBLOG_TEST_SESSION_SECRET \
    --secret-env Jwt__Issuer \
    --secret-env FSUSBLOG_JWT_ISSUER \
    --secret-env Jwt__Audience \
    --secret-env FSUSBLOG_JWT_AUDIENCE \
    --secret-env AnonymousCredentialIssuer__SubjectHashPepper \
    --secret-env FSUSBLOG_DEV_ANONYMOUS_SUBJECT_HASH_PEPPER \
    --secret-env FSUSBLOG_PERSIST_AUTH_FIXTURES \
    --secret-env FSUSBLOG_RESET_ANONYMOUS_ISSUANCE_FIXTURE \
    --secret-env Jwt__AccessTokenExpiresMinutes \
    --secret-env FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES \
    --secret-env FSUSBLOG_TEST_SESSION \
    --secret-env FSUSBLOG_TEST_SESSION_ISOLATION \
    --secret-env TEST_PARALLEL_INDEX \
    --secret-env TEST_WORKER_INDEX)"
  run_once_command \
    auth-fixtures \
    "$fingerprint" \
    "$CLIENT_DIR" \
    "$fixture_root/auth" \
    npm run prepare:binary-smoke:auth-users
}

prepare_public_fixtures_once() {
  local fingerprint fixture_root
  fixture_root="$(fixture_root_path)"
  fingerprint="$(test_input_fingerprint \
    --path tests/frontend/fixtures/discover-playwright-fixtures.mjs \
    --path tests/frontend/support/aeds-envelope.mjs \
    --path tests/frontend/support/fixture-paths.mjs \
    --path tools/test/legacy-test.sh \
    --value "${FSUSBLOG_TEST_NAMESPACE:-local}" \
    --value "service-generation=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-unbootstrapped}" \
    --value "${FSUSBLOG_BASE_URL:-$DEBUG_BACKEND_URL}" \
    --value "${FSUSBLOG_PG_CONTAINER:-}" \
    --value "${FSUSBLOG_REDIS_CONTAINER:-}")"
  run_once_command \
    public-fixtures \
    "$fingerprint" \
    "$CLIENT_DIR" \
    "$fixture_root/public.aeds" \
    npm run prepare:playwright:fixtures
}

prepare_session_fixtures_once() {
  local fingerprint fixture_root workers
  fixture_root="$(fixture_root_path)"
  workers="${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(default_playwright_workers)}"
  fingerprint="$(test_input_fingerprint \
    --path tests/frontend/fixtures/prepare-playwright-sessions.mjs \
    --path tests/frontend/support/session-fixtures.mjs \
    --path tests/frontend/support/fixture-paths.mjs \
    --path tests/frontend/support/test-session.mjs \
    --path tools/test/legacy-test.sh \
    --value "namespace=${FSUSBLOG_TEST_NAMESPACE:-local}" \
    --value "session-prefix=${FSUSBLOG_TEST_SESSION_PREFIX:-pw}" \
    --value "service-generation=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-unbootstrapped}" \
    --value "playwright-workers=$workers" \
    --secret-env Jwt__SecretKey \
    --secret-env FSUSBLOG_TEST_SESSION_SECRET \
    --secret-env AnonymousCredentialIssuer__SubjectHashPepper)"
  run_once_command \
    session-fixtures \
    "$fingerprint" \
    "$CLIENT_DIR" \
    "$fixture_root/sessions" \
    env FSUSBLOG_PLAYWRIGHT_WORKERS="$workers" npm run prepare:playwright:sessions -- --workers "$workers"
}

prepare_runtime_fixtures_once() {
  prepare_auth_fixtures_once
  prepare_public_fixtures_once
  if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
    prepare_session_fixtures_once
  fi
}

run_vitest_script() {
  local script="$1"
  if [[ -n "${FSUSBLOG_VITEST_SHARD_ARG:-}" ]]; then
    run_in_client npm run "$script" -- "$FSUSBLOG_VITEST_SHARD_ARG"
  else
    run_in_client npm run "$script"
  fi
}

run_vitest_script_unsharded() {
  local script="$1"
  run_in_client npm run "$script"
}

configure_visual_playwright_lane() {
  local lane="$1"
  local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
  local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

  if [[ -z "$index" && -z "$total" ]]; then
    unset FSUSBLOG_PLAYWRIGHT_SHARD_ARG
    export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$lane"
    return
  fi

  export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$lane/shard-${index}-of-${total}"
  configure_playwright_shard "$lane"
}

write_visual_group_summary() {
  local group="$1"
  local status="$2"
  local duration_ms="$3"
  local output_dir="${PLAYWRIGHT_OUTPUT_DIR:-}"
  local shard_arg="${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-}"
  local out_file="$ROOT_DIR/.tmp/visual/$group/summary.json"

  mkdir -p "$(dirname "$out_file")"
  node - "$out_file" "$group" "$status" "$duration_ms" "$output_dir" "$shard_arg" <<'NODE'
const fs = require('node:fs')
const outFile = process.argv[2]
const group = process.argv[3]
const status = process.argv[4]
const durationMs = Number(process.argv[5]) || 0
const outputDir = process.argv[6] || null
const shardArg = process.argv[7] || null

fs.writeFileSync(outFile, `${JSON.stringify({
  schema: 'fsusblog.visual.screenshot-group.v1',
  group,
  status,
  durationMs,
  outputDir,
  shardArg,
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

run_visual_group_check() {
  local group="$1"
  shift
  local started_ms
  started_ms="$(date +%s%3N)"
  log "visual screenshot group start: $group"

  set +e
  run_in_client "$@"
  local status=$?
  set -e

  local finished_ms duration_ms state
  finished_ms="$(date +%s%3N)"
  duration_ms=$((finished_ms - started_ms))
  if (( status == 0 )); then
    state="success"
  else
    state="failure"
  fi
  write_visual_group_summary "$group" "$state" "$duration_ms"

  if (( status != 0 )); then
    fail "visual screenshot group failed: $group (exit $status)"
  fi
  log "visual screenshot group done: $group (${duration_ms}ms)"
}

prepare_frontend_fast_group_timings() {
  local timing_scope
  timing_scope="${FSUSBLOG_FRONTEND_FAST_TIMING_SCOPE:-${CURRENT_TIER:-frontend-fast}}"
  timing_scope="$(printf '%s' "$timing_scope" | tr -cs 'A-Za-z0-9_.-' '-' | sed -E 's/^-+|-+$//g')"
  [[ -n "$timing_scope" && "$timing_scope" != "." && "$timing_scope" != ".." ]] || timing_scope="frontend-fast"
  FRONTEND_FAST_GROUP_TIMINGS_JSONL="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSONL:-$ROOT_DIR/.tmp/frontend/timings/$timing_scope.jsonl}"
  FRONTEND_FAST_GROUP_TIMINGS_JSON="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSON:-$ROOT_DIR/.tmp/frontend/timings/$timing_scope.json}"
  mkdir -p "$(dirname "$FRONTEND_FAST_GROUP_TIMINGS_JSONL")"
  : > "$FRONTEND_FAST_GROUP_TIMINGS_JSONL"
  rm -f "$FRONTEND_FAST_GROUP_TIMINGS_JSON"
}

record_frontend_fast_group_timing() {
  local group="$1"
  local status="$2"
  local duration_ms="$3"
  printf '{"group":"%s","status":"%s","durationMs":%s}\n' "$group" "$status" "$duration_ms" >> "$FRONTEND_FAST_GROUP_TIMINGS_JSONL"
}

write_frontend_fast_group_summary() {
  [[ -f "$FRONTEND_FAST_GROUP_TIMINGS_JSONL" ]] || return 0
  node - "$FRONTEND_FAST_GROUP_TIMINGS_JSONL" "$FRONTEND_FAST_GROUP_TIMINGS_JSON" <<'NODE'
const fs = require('node:fs')
const input = process.argv[2]
const output = process.argv[3]
const groups = fs.readFileSync(input, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const groupDurationsMs = Object.fromEntries(groups.map((item) => [item.group, Number(item.durationMs) || 0]))
fs.mkdirSync(require('node:path').dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify({
  schema: 'fsusblog.frontend-fast.group-durations.v1',
  status: groups.every((item) => item.status === 'success') ? 'success' : 'failure',
  groupDurationsMs,
  groups
}, null, 2)}\n`)
NODE
}

run_frontend_fast_group() {
  local group="$1"
  shift
  local started_ms
  started_ms="$(date +%s%3N)"
  log "frontend-fast group start: $group"

  set +e
  "$@"
  local status=$?
  set -e

  local finished_ms duration_ms state
  finished_ms="$(date +%s%3N)"
  duration_ms=$((finished_ms - started_ms))
  if (( status == 0 )); then
    state="success"
  else
    state="failure"
  fi
  record_frontend_fast_group_timing "$group" "$state" "$duration_ms"

  if (( status != 0 )); then
    fail "frontend-fast group failed: $group (exit $status)"
  fi
  log "frontend-fast group done: $group (${duration_ms}ms)"
}

resolve_parallel_workers() {
  local job_count="$1"
  if [[ -z "${FSUSBLOG_STEP_CPU_BUDGET:-}" \
    && -z "${FSUSBLOG_STEP_MEMORY_GIB:-}" \
    && -z "${FSUSBLOG_BUNDLE_CPU_UNITS:-}" \
    && -z "${FSUSBLOG_BUNDLE_CPU_BUDGET:-}" \
    && -z "${FSUSBLOG_BUNDLE_MEMORY_GIB:-}" ]]; then
    printf '%s' "$job_count"
    return 0
  fi

  FSUSBLOG_COMMAND_MANIFEST_WORKERS="$job_count" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
const {
  resolveManifestLiveCapacity
} = await import(pathToFileURL(process.argv[2]).href)
const requestedWorkload = process.env.FSUSBLOG_PARALLEL_WORKLOAD
const options = {
  env: process.env,
  workload: ['orchestration', 'scheduler-admitted'].includes(requestedWorkload)
    ? requestedWorkload
    : 'cpu'
}
process.stdout.write(String(resolveManifestLiveCapacity(options).maxParallel))
NODE
}

resolve_parallel_child_environment() {
  local active_workers="$1"
  FSUSBLOG_PARALLEL_ACTIVE_WORKERS="$active_workers" \
    "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
const {
  readManifestSchedulerResourceGrant,
  resolveManifestChildEnvironment
} = await import(pathToFileURL(process.argv[2]).href)
const activeWorkers = Number.parseInt(process.env.FSUSBLOG_PARALLEL_ACTIVE_WORKERS ?? '', 10)
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
  workers: activeWorkers,
  concurrent: activeWorkers > 1
})
for (const key of [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_PARALLEL_ACTIVE_WORKERS',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY'
]) {
  if (child[key] !== undefined) process.stdout.write(`${key}=${child[key]}\n`)
}
NODE
}

run_parallel() {
  local group="$1"
  shift
  local -a specs=("$@")
  local -a pids=()
  local -a status_files=()
  local status_dir="$ROOT_DIR/.tmp/parallel-status/$(namespace_slug "$group")-$$-$RANDOM"
  local total="${#specs[@]}"
  local worker_cap
  worker_cap="$(resolve_parallel_workers "$total")"
  local grant_file="${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE:-}"
  local adaptive_parallel="${FSUSBLOG_ADAPTIVE_PARALLEL:-0}"
  if [[ -n "$grant_file" ]]; then adaptive_parallel=1; fi
  local execution_mode='fixed'
  if [[ "$adaptive_parallel" == "1" ]]; then execution_mode='live-grant'; fi
  local grant_signature=""
  if [[ "$adaptive_parallel" == "1" && -n "$grant_file" ]]; then
    grant_signature="$(stat -c '%y:%s' "$grant_file" 2>/dev/null || printf 'missing')"
  fi
  mkdir -p "$status_dir"

  CURRENT_STAGE="$group"
  log "parallel group start: $group ($total jobs, workers=$worker_cap, executionMode=$execution_mode)"

  local index
  for ((index = 0; index < total; index += 1)); do
    local spec="${specs[$index]}"
    local label="${spec%%::*}"
    local status_file="$status_dir/$index-$(namespace_slug "$label").status"
    status_files+=("$status_file")
  done

  local next=0
  local completed=0
  local active=0
  local -a observed=()
  local refresh_capacity=0
  while (( completed < total )); do
    if [[ "$adaptive_parallel" == "1" ]]; then
      local current_grant_signature="$grant_signature"
      if [[ -n "$grant_file" ]]; then
        current_grant_signature="$(stat -c '%y:%s' "$grant_file" 2>/dev/null || printf 'missing')"
      fi
      if (( refresh_capacity == 1 )) || [[ "$current_grant_signature" != "$grant_signature" ]]; then
        local previous_worker_cap="$worker_cap"
        worker_cap="$(resolve_parallel_workers "$total")"
        grant_signature="$current_grant_signature"
        refresh_capacity=0
        if [[ "$worker_cap" != "$previous_worker_cap" ]]; then
          log "parallel group capacity update: $group (workers=$previous_worker_cap->$worker_cap active=$active)"
        fi
      fi
    fi
    local child_environment=""
    if (( next < total && active < worker_cap )); then
      local planned_active=$((active + total - next))
      if (( planned_active > worker_cap )); then planned_active="$worker_cap"; fi
      child_environment="$(resolve_parallel_child_environment "$planned_active")"
    fi
    while (( next < total && active < worker_cap )); do
      local spec="${specs[$next]}"
      local label="${spec%%::*}"
      local command="${spec#*::}"
      local status_file="${status_files[$next]}"
      (
        set +e
        while IFS='=' read -r key value; do
          [[ -n "$key" ]] && export "$key=$value"
        done <<< "$child_environment"
        CURRENT_STAGE="$group/$label"
        local child_started_ms
        child_started_ms="$(date +%s%3N)"
        log "parallel start: $label"
        eval "$command"
        local child_status=$?
        local child_finished_ms child_duration_ms
        child_finished_ms="$(date +%s%3N)"
        child_duration_ms=$((child_finished_ms - child_started_ms))
        if (( child_status == 0 )); then
          log "parallel done: $label (${child_duration_ms}ms)"
        else
          log "parallel failed: $label (exit $child_status, ${child_duration_ms}ms)"
        fi
        local pending_status="${status_file}.pending-$BASHPID"
        printf '%s\t%s\t%s\n' "$child_status" "$label" "$child_duration_ms" > "$pending_status"
        mv "$pending_status" "$status_file"
        exit "$child_status"
      ) &
      pids+=("$!")
      observed+=(0)
      next=$((next + 1))
      active=$((active + 1))
    done

    local progressed=0
    for ((index = 0; index < next; index += 1)); do
      if [[ "${observed[$index]:-0}" == "1" || ! -f "${status_files[$index]}" ]]; then
        continue
      fi
      wait "${pids[$index]}" >/dev/null 2>&1 || true
      observed[$index]=1
      completed=$((completed + 1))
      active=$((active - 1))
      progressed=1
      refresh_capacity=1
    done
    if (( completed < total && progressed == 0 )); then sleep 0.1; fi
  done
  for index in "${!pids[@]}"; do wait "${pids[$index]}" >/dev/null 2>&1 || true; done

  local -a failures=()
  for status_file in "${status_files[@]}"; do
    local child_status child_label child_duration_ms
    IFS=$'\t' read -r child_status child_label child_duration_ms < "$status_file"
    if [[ "$child_status" != "0" ]]; then
      failures+=("${child_label:-unknown}:$child_status")
    fi
  done
  rm -rf "$status_dir"

  if (( ${#failures[@]} > 0 )); then
    local failure_message="parallel group failed: $group (${failures[*]})"
    printf '[test:%s] error: %s\n' "${CURRENT_TIER:-unknown}" "$failure_message" >&2
    print_artifact_hint
    return 1
  fi

  log "parallel group done: $group"
}

probe_url() {
  local label="$1"
  local url="$2"

  if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
    return 0
  fi

  fail "$label unreachable at $url"
}

probe_binary_url() {
  local label="$1"
  local url="$2"

  if curl -fsS --max-time 5 -H 'Accept: application/octet-stream' "$url" >/dev/null 2>&1; then
    return 0
  fi

  fail "$label unreachable at $url"
}

require_debug_stack() {
  require_bootstrapped_namespace
  log "require debug services: frontend=$DEBUG_FRONTEND_URL backend=$DEBUG_BACKEND_URL"
  probe_url "debug frontend" "$DEBUG_FRONTEND_URL/"
  probe_binary_url "debug backend" "$DEBUG_BACKEND_URL/api/binary/system/seo"
}

require_release_preview() {
  require_bootstrapped_namespace
  log "require release preview: $RELEASE_PREVIEW_URL"
  probe_url "release preview" "$RELEASE_PREVIEW_URL/"
}

current_pow_difficulty() {
  (
    cd "$ROOT_DIR"
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" node --input-type=module -e "import { fetchChallenge } from './tests/frontend/support/auth-helpers.mjs'; const challenge = await fetchChallenge(5000); console.log(challenge.difficulty ?? challenge.Difficulty ?? 999);"
  )
}

wait_for_pow_ready() {
  local label="${1:-pow}"
  local max_difficulty="$POW_READY_MAX_DIFFICULTY"
  local difficulty=""

  for ((i=0; i<30; i+=1)); do
    difficulty="$(current_pow_difficulty 2>/dev/null || true)"
    if [[ "$difficulty" =~ ^[0-9]+$ ]] && (( difficulty <= max_difficulty )); then
      log "${label}: pow difficulty ready: ${difficulty}"
      return 0
    fi

    sleep 1
  done

  fail "${label}: pow difficulty did not settle below ${max_difficulty}; last=${difficulty:-unknown}"
}

reset_security_runtime_state() {
  local label="${1:-security runtime state}"
  if [[ "${FSUSBLOG_RESET_SECURITY_TEST_STATE:-1}" == "0" ]]; then
    return
  fi

  local deleted
  local redis_container="${FSUSBLOG_REDIS_CONTAINER_NAME:-fsusblog-redis}"
  local postgres_container="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-fsusblog-postgres}"
  local namespace_pattern="${FSUSBLOG_TEST_NAMESPACE:-local}"
  local risk_deleted
  risk_deleted="$(docker exec "$postgres_container" psql -U fsusblog -d fsusblog -Atqc "WITH deleted AS (DELETE FROM security_risk_event WHERE expires_at_utc > (now() AT TIME ZONE 'utc') RETURNING 1) SELECT count(*) FROM deleted;" 2>/dev/null || true)"
  risk_deleted="${risk_deleted:-0}"
  if [[ "$risk_deleted" =~ ^[0-9]+$ ]] && (( risk_deleted > 0 )); then
    log "${label}: reset active persisted security risk events: ${risk_deleted}"
  fi

  deleted="$(docker exec "$redis_container" sh -c "{ redis-cli --scan --pattern '*${namespace_pattern}*fsus:sec:pow-risk:*'; redis-cli --scan --pattern 'fsus:sec:pow-risk:*'; } | sort -u | xargs -r redis-cli DEL" 2>/dev/null || true)"
  deleted="${deleted:-0}"
  if [[ "$deleted" =~ ^[0-9]+$ ]] && (( deleted > 0 )); then
    log "${label}: reset local security PoW risk keys: ${deleted}"
  fi
  wait_for_pow_ready "$label"
}

run_tier() {
  local tier="$1"
  shift
  CURRENT_TIER="$tier"
  CURRENT_STAGE="$tier"
  "$@"
}

bootstrap_acceptance_env() {
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
  require_bootstrapped_namespace
}

run_backend_build_governance_lane() {
  run_backend_governance_checks
  ensure_backend_filtered_build
  write_backend_split_summary backend-build-governance governance-and-debug-build
}

run_backend_unit_lane() {
  if [[ "${FSUSBLOG_TEST_SELECTION:-}" == "affected" ]]; then
    log "backend-unit selection=affected"
    run "$ROOT_DIR/tools/dotnet-affected-tests.sh"
  else
    log "backend-unit selection=full reason=${FSUSBLOG_TEST_SELECTION:-unset}"
    run_backend_dotnet_filter_only "$BACKEND_ORDINARY_TEST_FILTER" backend-unit
  fi
  write_backend_split_summary backend-unit "${FSUSBLOG_TEST_SELECTION:-full}"
}

run_backend_fast_summary_lane() {
  log "backend-fast | artifact-only summary; build/governance and unit ran in dependency tiers"
  write_backend_split_summary backend-fast dependency-summary
}

run_fast_backend_lane() {
  run_backend_build_governance_lane
  run_backend_unit_lane
  run_backend_fast_summary_lane
}

configure_dotnet_test_processors() {
  export DOTNET_PROCESSOR_COUNT
  DOTNET_PROCESSOR_COUNT="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-dotnet-test-processors.mjs")"
  log "dotnet test processor count=$DOTNET_PROCESSOR_COUNT"
}

backend_test_configuration() {
  local configuration="${FSUSBLOG_BACKEND_TEST_CONFIGURATION:-Debug}"
  case "$configuration" in
    Debug|Release)
      printf '%s\n' "$configuration"
      ;;
    *)
      fail "FSUSBLOG_BACKEND_TEST_CONFIGURATION must be Debug or Release (got '$configuration')"
      ;;
  esac
}

ensure_backend_filtered_build() {
  local configuration configuration_slug test_bin_dir test_dll output_contract fingerprint_variant
  configuration="$(backend_test_configuration)"
  configuration_slug="${configuration,,}"
  if [[ -n "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" ]]; then
    test_bin_dir="$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/$configuration/net10.0"
  else
    test_bin_dir="$ROOT_DIR/tests/backend/bin/$configuration/net10.0"
  fi
  test_dll="$test_bin_dir/FsusBlog.Server.Tests.dll"
  if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" && -f "$test_dll" ]]; then
    log "reuse backend $configuration build from local physical build bundle"
    return
  fi
  local debug_output_dir="${FSUSBLOG_PRODUCTION_BUILD_ROOT:+$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0}"
  local release_output_dir="${FSUSBLOG_PRODUCTION_BUILD_ROOT:+$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Release/net10.0}"
  debug_output_dir="${debug_output_dir:-tests/backend/bin/Debug/net10.0}"
  release_output_dir="${release_output_dir:-tests/backend/bin/Release/net10.0}"
  local debug_outputs="$debug_output_dir/FsusBlog.Server.Tests.dll|$debug_output_dir/FsusBlog.Server.Tests.deps.json|$debug_output_dir/FsusBlog.Server.Tests.runtimeconfig.json"
  local release_outputs="$release_output_dir/FsusBlog.Server.Tests.dll|$release_output_dir/FsusBlog.Server.Tests.deps.json|$release_output_dir/FsusBlog.Server.Tests.runtimeconfig.json"
  if [[ "$configuration" == "Release" ]]; then
    output_contract="$release_outputs"
    fingerprint_variant='backend-filtered-release-v1'
  else
    output_contract="$debug_outputs"
    fingerprint_variant='backend-filtered-debug-v1'
  fi
  local fingerprint
  configure_dotnet_build_parallelism
  fingerprint="$(test_input_fingerprint \
    --path Directory.Build.props \
    --path FsusBlog.slnx \
    --path src/backend \
    --path src/core \
    --path src/shared \
    --path tests/backend \
    --path tools/build-with-data-env.sh \
    --path tools/test/legacy-test.sh \
    --value "$fingerprint_variant")"
  run_once_command \
    "backend-filtered-build-$configuration_slug" \
    "$fingerprint" \
    "$ROOT_DIR" \
    "$output_contract" \
    "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/FsusBlog.slnx" -c "$configuration" -warnaserror -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
}

backend_trx_file() {
  local lane
  lane="$(namespace_slug "${1:-backend}")"
  mkdir -p "$BACKEND_TRX_DIR"
  printf '%s/%s.trx' "$BACKEND_TRX_DIR" "$lane"
}

write_backend_trx_contract_dry_run() {
  local lane trx_file
  local -a lanes=("$@")
  if [[ "${#lanes[@]}" -eq 0 ]]; then
    lanes=(backend-unit backend-property coverage-backend)
  fi
  for lane in "${lanes[@]}"; do
    trx_file="$(backend_trx_file "$lane")"
    rm -f "$trx_file"
    printf '%s\n' \
      '<?xml version="1.0" encoding="utf-8"?>' \
      '<TestRun id="00000000-0000-0000-0000-000000000001" name="backend-trx-contract-dry-run">' \
      '  <Results><UnitTestResult testName="BackendTrxContractDryRun" outcome="Passed" /></Results>' \
      '  <ResultSummary outcome="Passed"><Counters total="1" executed="1" passed="1" failed="0" /></ResultSummary>' \
      '</TestRun>' > "$trx_file"
  done
  printf '{"schema":"fsusblog.backend-trx-dry-run.v1","status":"dry-run","directory":"%s","lanes":[' "$BACKEND_TRX_DIR"
  local separator=''
  for lane in "${lanes[@]}"; do
    printf '%s"%s"' "$separator" "$(namespace_slug "$lane")"
    separator=','
  done
  printf ']}\n'
}

run_backend_dotnet_filter_only() {
  local filter="$1"
  local lane="${2:-${CURRENT_TIER:-backend}}"
  local trx_file configuration
  trx_file="$(backend_trx_file "$lane")"
  configuration="$(backend_test_configuration)"
  configure_dotnet_test_processors
  ensure_backend_filtered_build
  rm -f "$trx_file"
  FSUSBLOG_BACKEND_DB_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}-${lane}-${BASHPID}" \
    run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c "$configuration" -v minimal --no-build "${DOTNET_BUILD_SHARED_ARGS[@]}" --filter "$filter" --logger "trx;LogFileName=$trx_file"
}

run_backend_dotnet_filter_with_coverage() {
  local lane="$1"
  local filter="$2"
  local results_dir="$COVERAGE_ROOT/backend/special-$lane"
  local trx_file configuration
  trx_file="$(backend_trx_file "backend-$lane")"
  configuration="$(backend_test_configuration)"
  configure_dotnet_test_processors
  ensure_backend_filtered_build
  rm -rf "$results_dir"
  rm -f "$trx_file"
  mkdir -p "$results_dir"
  FSUSBLOG_BACKEND_DB_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}-${lane}-${BASHPID}" \
    run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" \
    -c "$configuration" \
    -v minimal \
    --no-build \
    "${DOTNET_BUILD_SHARED_ARGS[@]}" \
    --filter "$filter" \
    --logger "trx;LogFileName=$trx_file" \
    "--collect:XPlat Code Coverage" \
    --results-directory "$results_dir" \
    -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json,cobertura
}

run_backend_test_governance_check_once() {
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
    --key backend-test-governance \
    --path tools/check-backend-test-governance.mjs \
    --path tests/backend \
    --path tests/matrix.yml \
    --test-id backend-test-governance \
    -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-backend-test-governance.mjs"
}

run_postgres_test_collections_check_once() {
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
    --key postgres-test-collections \
    --path tools/check-postgres-test-collections.mjs \
    --path tests/backend \
    --test-id postgres-test-collections \
    -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-postgres-test-collections.mjs"
}

run_backend_source_file_size_check_once() {
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
    --key backend-source-file-size \
    --path tools/architecture/check-backend-source-file-size.mjs \
    --path src/backend/Infrastructure/Bootstrap \
    --path src/backend/Infrastructure/PublicReadArtifacts \
    --path src/backend/Infrastructure/SchemaMigration \
    --path src/backend/Modules/Endpoints \
    --path src/backend/Services \
    --test-id backend-source-file-size \
    -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-source-file-size.mjs"
}

run_backend_governance_checks() {
  run_backend_source_file_size_check_once
  run_backend_test_governance_check_once
  run_postgres_test_collections_check_once
}

write_backend_split_summary() {
  local lane="$1"
  local selection="$2"
  local out_file="$ROOT_DIR/.tmp/$lane/summary.json"
  mkdir -p "$(dirname "$out_file")"
  node - "$out_file" "$lane" "$selection" <<'NODE'
const fs = require('node:fs')
const outFile = process.argv[2]
const lane = process.argv[3]
const selection = process.argv[4]
fs.writeFileSync(outFile, `${JSON.stringify({
  schema: 'fsusblog.backend.split-lane.v1',
  lane,
  selection,
  status: 'success',
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

run_backend_api_integration_only() {
  run_backend_dotnet_filter_with_coverage api-integration "Category=ApiIntegration"
  write_backend_split_summary backend-api-integration "Category=ApiIntegration"
}

run_backend_auth_state_machine_only() {
  run_backend_dotnet_filter_with_coverage auth-state-machine "Category=SecurityStateMachine"
  write_backend_split_summary backend-auth-state-machine "Category=SecurityStateMachine"
}

run_backend_concurrency_only() {
  run_backend_dotnet_filter_with_coverage concurrency "Category=Concurrency"
  write_backend_split_summary backend-concurrency "Category=Concurrency"
}

run_backend_property_only() {
  run_backend_dotnet_filter_with_coverage property "Category=Property"
  write_backend_split_summary backend-property "Category=Property"
}

run_backend_golden_only() {
  run_backend_dotnet_filter_with_coverage golden "Category=GoldenContract"
  write_backend_split_summary backend-golden "Category=GoldenContract"
}

run_backend_test_governance_only() {
  run_backend_governance_checks
  write_backend_split_summary backend-test-governance governance
}

run_backend_perf_only() {
  local trx_lane="${1:-backend-perf}"
  run_backend_perf_governance_only
  run_backend_perf_native_p99_only "$trx_lane"
  run_backend_perf_readiness_build_only
  write_backend_split_summary backend-perf native-p99-and-benchmark-project-release-build
}

run_backend_perf_governance_only() {
  local -a failures=()
  run_backend_test_governance_check_once || failures+=(backend-test-governance)
  run_postgres_test_collections_check_once || failures+=(postgres-test-collections)
  if (( ${#failures[@]} > 0 )); then
    printf '[test:%s] backend performance governance failures: %s\n' \
      "${CURRENT_TIER:-backend-perf}" "${failures[*]}" >&2
    return 1
  fi
}

run_backend_perf_native_p99_only() {
  local trx_lane="${1:-backend-perf}"
  FSUSBLOG_RUN_PERFORMANCE_TESTS=1 run_backend_dotnet_filter_only \
    "FullyQualifiedName=FsusBlog.Server.Tests.Unit.NativeGroth16ZkProofBackendTests.MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget" \
    "$trx_lane"
}

run_backend_perf_readiness_build_only() {
  if [[ "${FSUSBLOG_BACKEND_PERF_READINESS_MODE:-build}" == "verify-fresh" ]]; then
    run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/verify-benchmark-build-ready.mjs"
    return 0
  fi
  configure_dotnet_build_parallelism
  run "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" -c Release -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
}

run_backend_mutation_with_config() {
  local config_path="$1"
  local output_dir="$2"
  local report_name="$3"
  local working_dir="${4:-$ROOT_DIR}"
  local authority_tier="${5:-}"
  local authority_out="${6:-}"
  run dotnet tool restore
  run rm -rf "$output_dir"
  local FSUSBLOG_MUTATION_BUILD=1
  export FSUSBLOG_MUTATION_BUILD
  (
    cd "$working_dir"
    run dotnet tool run dotnet-stryker \
      --config-file "$config_path" \
      --output "$output_dir"
  )
  if [[ -n "$authority_tier" || -n "$authority_out" ]]; then
    if [[ -z "$authority_tier" || -z "$authority_out" ]]; then
      fail "Stryker authority requires both tier and output path"
    fi
    run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" \
      "$output_dir/reports/$report_name.json" \
      --config "$config_path" \
      --tier "$authority_tier" \
      --out "$authority_out"
  else
    run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" "$output_dir/reports/$report_name.json"
  fi
}

run_backend_mutation_only() {
  run_backend_mutation_with_config \
    "$ROOT_DIR/stryker-config.json" \
    "$ROOT_DIR/.tmp/mutation/backend" \
    backend-mutation
}

run_backend_mutation_critical_only() {
  run_backend_mutation_with_config \
    "$ROOT_DIR/stryker-critical-config.json" \
    "$ROOT_DIR/.tmp/mutation/backend-critical" \
    backend-mutation-critical \
    "$ROOT_DIR/src/core" \
    release-mutation-critical-slice \
    "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json"
}

run_backend_nightly_only() {
  run_backend_governance_checks
  run_backend_dotnet_filter_only "Category=Property|Category=GoldenContract|Category=Concurrency|Category=SecurityStateMachine|Category=ApiIntegration" backend-nightly-selection
  run_backend_perf_only backend-nightly-performance
  if [[ "${FSUSBLOG_RUN_BACKEND_MUTATION_FULL:-0}" == "1" ]]; then
    run_backend_mutation_only
  else
    log "skip backend mutation full run (set FSUSBLOG_RUN_BACKEND_MUTATION_FULL=1)"
  fi
  write_backend_split_summary backend-nightly exhaustive-readiness
}

run_cross_stack_static_contracts() {
  run "$ROOT_DIR/tools/contracts/export-openapi.sh"
  run_in_client npm run check:openapi-sync
  run_in_client npm run check:contract:openapi
  run_in_client npm run check:frontend-routes
  run_in_client npm run check:consumer:openapi
  run_in_client npm run check:contract:binary-matrix
  run_in_client npm run check:contract:api-parity
  run_in_client npm run check:contract:pow-parity
  run_in_client npm run check:contract:frame-schema
  run_in_client npm run check:contract:negative-matrix
  run_in_client npm run check:coherence:runtime-matrix
  run_in_client npm run check:coherence:distribution-full
  run_in_client npm run check:coherence:notification-stream-events
  run_in_client npm run check:coherence:upload-complete
  run_in_client node ../../tests/frontend/checks/runtime/auth-state-coherence.mjs
  run_in_client npm run check:coherence:sw-cache
  run_in_client npm run check:coherence:perf
  run_in_client npm run check:cross-stack-test-governance
}

run_cross_stack_runtime_contracts() {
  require_debug_stack
  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  run_in_client npm run check:auth-zero-probe
}

run_cross_stack_contract_only() {
  local phase="${1:-all}"
  case "$phase" in
    static)
      run_cross_stack_static_contracts
      ;;
    runtime)
      run_cross_stack_runtime_contracts
      ;;
    all)
      run_cross_stack_static_contracts
      run_cross_stack_runtime_contracts
      ;;
    *)
      fail "cross-stack-contract phase must be static, runtime, or all (got '$phase')"
      ;;
  esac
}

run_frontend_fast_build_group() {
  local fingerprint
  local -a fingerprint_args=(
    --path src/frontend/index.html
    --path src/frontend/package.json
    --path src/frontend/package-lock.json
    --path src/frontend/public
    --path src/frontend/vite.config.ts
    --path src/frontend/scripts
    --path src/frontend/src
    --path tools/frontend
    --path tools/test/legacy-test.sh
    --value frontend-release-build-v2
  )
  local key value tsconfig
  for tsconfig in "$CLIENT_DIR"/tsconfig*.json; do
    [[ -f "$tsconfig" ]] || continue
    fingerprint_args+=(--path "${tsconfig#"$ROOT_DIR/"}")
  done
  while IFS='=' read -r key value; do
    fingerprint_args+=(--value "$key=$value")
  done < <(env | LC_ALL=C sort | awk -F= '$1 ~ /^VITE_/ {print}')
  for key in \
    FSUSBLOG_VUE_HYDRATION_DETAILS \
    FSUSBLOG_PUBLIC_SSR_BUILD \
    FSUSBLOG_USE_LOCAL_FSUSUI \
    FSUSBLOG_LOCAL_FSUSUI_ROOT; do
    fingerprint_args+=(--value "$key=${!key:-}")
  done
  fingerprint="$(test_input_fingerprint "${fingerprint_args[@]}")"
  local frontend_dist_output backend_webroot_output
  frontend_dist_output="${FSUSBLOG_FRONTEND_DIST_ROOT:-dist}"
  backend_webroot_output="${FSUSBLOG_BACKEND_WEBROOT:-../backend/wwwroot}"
  run_once_command \
    frontend-release-build \
    "$fingerprint" \
    "$CLIENT_DIR" \
    "$frontend_dist_output|$backend_webroot_output" \
    env FSUSBLOG_SKIP_ENSURE_WASM=1 FSUSBLOG_VALIDATE_GENERATED_ONLY=1 FSUSBLOG_VITE_WARN_AS_ERROR=1 npm run build:release
}

write_frontend_split_summary() {
  local lane="$1"
  local out_file="$ROOT_DIR/.tmp/frontend/${lane}.json"
  mkdir -p "$(dirname "$out_file")"
  node - "$out_file" "$lane" <<'NODE'
const fs = require('node:fs')
const outFile = process.argv[2]
const lane = process.argv[3]

fs.writeFileSync(outFile, `${JSON.stringify({
  schema: 'fsusblog.frontend-fast.split-lane.v1',
  lane,
  status: 'success',
  schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID || null,
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

write_runtime_lane_summary() {
  local lane="$1"
  local out_file="$ROOT_DIR/.tmp/runtime/$lane.json"
  mkdir -p "$(dirname "$out_file")"
  node - "$out_file" "$lane" <<'NODE'
const fs = require('node:fs')
const outFile = process.argv[2]
const lane = process.argv[3]
fs.writeFileSync(outFile, `${JSON.stringify({
  schema: 'fsusblog.runtime-lane.v1',
  lane,
  status: 'success',
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

run_frontend_fast_build_lane() {
  ensure_wasm_once
  prepare_frontend_fast_group_timings
  run_frontend_fast_group build run_frontend_fast_build_group
  write_frontend_fast_group_summary
  write_frontend_split_summary frontend-build
}

run_frontend_fast_tests_group_body() {
  if node -e "const pkg=require(process.argv[1]); process.exit(pkg.scripts && pkg.scripts['test:unit:fast'] ? 0 : 1)" "$CLIENT_DIR/package.json"; then
    run_vitest_script test:unit:fast
  fi

}

run_frontend_fast_tests_group() {
  run_frontend_fast_group tests run_frontend_fast_tests_group_body
}

run_frontend_unit_shard_lane() {
  configure_vitest_shard
  prepare_frontend_fast_group_timings
  run_frontend_fast_tests_group
  write_frontend_fast_group_summary
  write_frontend_split_summary frontend-unit-shard
}

run_frontend_property_model_perf_group_body() {
  run_vitest_script_unsharded test:property
  run_vitest_script_unsharded check:frontend-state-machines
  run_vitest_script_unsharded check:frontend-perf-regression
}

run_frontend_property_model_perf_lane() {
  prepare_frontend_fast_group_timings
  run_frontend_fast_group property-model-perf run_frontend_property_model_perf_group_body
  write_frontend_fast_group_summary
  write_frontend_split_summary frontend-property-model-perf
}

run_frontend_fast_runtime_contracts_group_body() {
  run_in_client "${FSUSBLOG_NODE:-node}" \
    ../../tools/test/run-command-manifest.mjs \
    ../../tests/frontend/checks/runtime/manifest.json
}

run_frontend_fast_runtime_contracts_group() {
  run_frontend_fast_group runtime-contracts run_frontend_fast_runtime_contracts_group_body
}

run_frontend_runtime_contracts_lane() {
  ensure_wasm_once
  prepare_frontend_fast_group_timings
  run_frontend_fast_runtime_contracts_group
  write_frontend_fast_group_summary
  write_frontend_split_summary frontend-runtime-contracts
}

run_frontend_fast_static_governance_group_body() {
  run_in_client "${FSUSBLOG_NODE:-node}" \
    ../../tools/test/run-command-manifest.mjs \
    ../../tests/frontend/checks/static/manifest.json
}

run_frontend_fast_static_governance_group() {
  run_frontend_fast_group static-governance run_frontend_fast_static_governance_group_body
}

run_frontend_static_governance_lane() {
  prepare_frontend_fast_group_timings
  run_frontend_fast_static_governance_group
  write_frontend_fast_group_summary
  write_frontend_split_summary frontend-static-governance
}

run_frontend_fast_summary_lane() {
  log "frontend-fast-summary | artifact-only aggregate tier; CI summary validates child job evidence"
  write_frontend_split_summary frontend-fast-summary
}

run_fast_frontend_lane() {
  run_frontend_fast_build_lane
  run_frontend_unit_shard_lane
  run_frontend_property_model_perf_lane
  run_frontend_runtime_contracts_lane
  run_frontend_static_governance_lane
  run_frontend_fast_summary_lane
}

run_fast_only() {
  log "tier=fast | no running services required"
  ensure_wasm_once
  # The frontend release build syncs hashed assets into the selected backend webroot.
  # Keep it ahead of the .NET StaticWebAssets pass so the manifest and files
  # are read from one coherent generation instead of racing on deleted chunks.
  run_fast_frontend_lane
  run_fast_backend_lane
}

run_fast() {
  run_tier "fast" run_fast_only
}

run_integration_only() {
  log "tier=integration | debug runtime validation, requires frontend=3000 backend=5000"
  if [[ "${FSUSBLOG_SKIP_BACKEND_INTEGRATION_TESTS:-0}" != "1" ]]; then
    run_backend_dotnet_filter_only "Category=Integration" integration
  fi
  require_debug_stack

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$INTEGRATION_HTTP_TIMEOUT_MS"

  prepare_runtime_fixtures_once

  local -a integration_failures=()
  run_integration_stage() {
    local label="$1"
    shift
    set +e
    ( "$@" )
    local status=$?
    set -e
    if (( status != 0 )); then
      integration_failures+=("$label:$status")
      log "integration stage failed, continuing: $label (exit $status)"
    fi
  }

  run_integration_client_check() {
    run_in_client npm run "$1"
  }

  # These checks only read the already-prepared runtime fixtures (the session
  # smoke mutates only its own user sessions). They are subprocess/HTTP wait
  # heavy, so two children can share one admitted CPU while the live scheduler
  # grant remains the authoritative memory and CPU envelope.
  run_integration_parallel_checks() {
    local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
    local -x FSUSBLOG_PARALLEL_WORKLOAD=orchestration
    run_parallel "integration-runtime-checks" \
      "pow-runtime::run_integration_client_check check:pow-runtime" \
      "search-runtime::run_integration_client_check check:search-runtime" \
      "auth-session::run_integration_client_check check:auth-session-smoke" \
      "api-contracts::run_integration_client_check check:api-contracts" \
      "binary-contract-smoke::run_integration_client_check check:binary-contract-smoke" \
      "binary-smoke::run_integration_client_check check:binary-smoke" \
      "notification-stream-runtime::run_integration_client_check check:notification-stream-runtime" \
      "notification-stream-live::run_integration_client_check check:notification-stream-live" \
      "sw-search-runtime::run_integration_client_check check:sw-search-runtime"
  }

  run_integration_stage "runtime-parallel" run_integration_parallel_checks
  # Keep authenticated admin/session work and distribution mutation out of the
  # shared read pool so parallel execution cannot change their observable state.
  run_integration_stage "binary-smoke-auth" run_in_client npm run check:binary-smoke:auth
  run_integration_stage "distribution-version-coherence" run_in_client npm run check:distribution-version-coherence

  unset -f run_integration_stage run_integration_client_check run_integration_parallel_checks
  if (( ${#integration_failures[@]} > 0 )); then
    fail "integration runtime failures (${integration_failures[*]})"
  fi
  write_runtime_lane_summary integration
}

run_integration() {
  run_tier "integration" run_integration_only
}

run_ci() {
  log "tier=ci | fast + integration"
  run_tier "fast" run_fast_only
  run_tier "integration" run_integration_only
}

run_coverage_backend_only() {
  log "tier=coverage-backend | server xUnit coverage collection"
  run bash "$ROOT_DIR/tools/coverage/collect-backend-coverage.sh"
}

run_coverage_frontend_only() {
  log "tier=coverage-frontend | frontend vitest coverage collection"
  run bash "$ROOT_DIR/tools/coverage/collect-frontend-coverage.sh"
}

run_coverage_backend() {
  run_tier "coverage-backend" run_coverage_backend_only
}

run_coverage_frontend() {
  run_tier "coverage-frontend" run_coverage_frontend_only
}

run_coverage_merge_only() {
  log "tier=coverage-merge | merge available coverage artifacts"
  run bash "$ROOT_DIR/tools/coverage/merge-coverage.sh"
}

run_coverage_merge() {
  run_tier "coverage-merge" run_coverage_merge_only
}

run_coverage_threshold_only() {
  log "tier=coverage-threshold | enforce merged coverage thresholds"
  run env \
    FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/merged/Summary.json" \
    bash "$ROOT_DIR/tools/coverage/check-scope-snapshot.sh"
  run env \
    FSUSBLOG_COVERAGE_THRESHOLD_LABEL=merged \
    FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/merged/Summary.json" \
    FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_COVERAGE_LINE_THRESHOLD:-35}" \
    FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_COVERAGE_BRANCH_THRESHOLD:-20}" \
    FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_COVERAGE_METHOD_THRESHOLD:-30}" \
    bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
  run env \
    FSUSBLOG_COVERAGE_THRESHOLD_LABEL=backend \
    FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/backend-merged/Summary.json" \
    FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD:-75}" \
    FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD:-55}" \
    FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_METHOD_THRESHOLD:-95}" \
    bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
  run env \
    FSUSBLOG_COVERAGE_THRESHOLD_LABEL=frontend \
    FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/frontend/Summary.json" \
    FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-35}" \
    FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-20}" \
    FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-30}" \
    bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
}

run_coverage_threshold() {
  run_tier "coverage-threshold" run_coverage_threshold_only
}

run_coverage_gate_only() {
  log "tier=coverage-gate | collect + merge + enforce thresholds"
  run_coverage_backend_only
  run_coverage_frontend_only
  run_coverage_merge_only
  run_coverage_threshold_only
}

run_coverage_gate() {
  run_tier "coverage-gate" run_coverage_gate_only
}

run_release_public_hydration_prepare_only() {
  log "tier=release-public-hydration | settle AOT hydration writes before release preview readers"
  require_release_preview

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"

  run_in_client npm run check:public-hydration-rebuild
  # Public AOT warmup/backfill is a backend operation; Vite preview only serves static release assets.
  run_in_client env \
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" \
    FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL" \
    FSUSBLOG_PUBLIC_AOT_WAIT_MS=120000 \
    npm run rebuild:public-hydration
}

run_release_only() {
  log "tier=release | requires release preview=8080"
  require_release_preview

  if [[ "${FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG:-0}" != "1" ]]; then
    run_release_public_hydration_prepare_only
  else
    log "reuse same-run release hydration write barrier"
  fi

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"
  run_in_client node ../../tests/frontend/checks/public/aot-regression.mjs
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client npm run check:search-runtime
  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_BACKEND_URL"
  run_in_client npm run check:public-hydration
  run_in_client node ../../tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs
  run_in_client node ../../tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs
  run_in_client node ../../tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs
  run_in_client node ../../tests/frontend/checks/public/check-public-dom-diff-hydration.mjs
  run_in_client env FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS=1 \
    node ../../tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs --lane release
  run_in_client npm run check:public-seo-smoke
  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client npm run check:pwa-offline-smoke
}

run_release() {
  run_tier "release" run_release_only
}

run_acceptance_only() {
  log "tier=acceptance | full Playwright acceptance e2e, requires frontend=3000 backend=5000 preview=8080"
  configure_playwright_shard acceptance
  export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
  configure_playwright_workers acceptance-spa-routes FSUSBLOG_SPA_ROUTES_WORKERS
  configure_playwright_workers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre acceptance"

  if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
    FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_SPA_ROUTES_WORKERS" prepare_session_fixtures_once
    export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
  fi

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
  run_in_client env FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1 npm run check:acceptance:public

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
  run_in_client npm run check:spa:routes
  run_in_client npm run check:acceptance:auth
  reset_security_runtime_state "pre console acceptance"
  run_in_client npm run check:acceptance:console
}

run_acceptance() {
  log "tier=acceptance | bootstrap + fast + integration + release + full acceptance e2e"
  bootstrap_acceptance_env
  run_tier "fast" run_fast_only
  run_tier "integration" run_integration_only
  run_tier "release" run_release_only
  run_tier "acceptance" run_acceptance_only
}

run_visual_only() {
  log "tier=visual | dark/mobile visual gates"
  run_visual_public_only
  run_visual_console_only
}

run_visual_public_only() {
  log "tier=visual-public | public screenshot checks"
  configure_visual_playwright_lane visual-public
  configure_playwright_workers visual-public FSUSBLOG_VISUAL_PUBLIC_WORKERS
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre visual public"

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
  run_visual_group_check public npm run check:visual:public
}

run_visual_console_only() {
  log "tier=visual-console | console screenshot checks"
  configure_visual_playwright_lane visual-console
  configure_playwright_workers visual-console FSUSBLOG_CONSOLE_VISUAL_WORKERS
  export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre visual console"

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
  if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
    FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_CONSOLE_VISUAL_WORKERS" prepare_session_fixtures_once
    export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
  fi
  run_visual_group_check console npm run check:visual:console
}

run_visual() {
  log "tier=visual | bootstrap + dark/mobile visual gates"
  bootstrap_acceptance_env
  run_tier "visual" run_visual_only
}

run_security_static_only() {
  log "tier=security-static | matrices/supply-chain/network/SBOM policy gates"
  local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
  local -x FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted
  run_parallel "security-static" \
    "network-baseline::\"$ROOT_DIR/tools/security/check-production-network-baseline.sh\"" \
    "supply-chain::\"$ROOT_DIR/tools/security/check-supply-chain-audit.sh\"" \
    "security-matrices::\"$ROOT_DIR/tools/security/check-security-matrices.mjs\"" \
    "zap-warn-policy::\"$ROOT_DIR/tools/security/check-zap-warn-policy.mjs\"" \
    "sbom::\"$ROOT_DIR/tools/security/generate-sbom.sh\""
}

run_security_runtime_core_only() {
  log "tier=security-runtime-core | auth/mfa/passkey/pow/permission/a11y gates"
  local -a security_failures=()
  run_security_stage() {
    local label="$1"
    shift
    set +e
    ( "$@" )
    local status=$?
    set -e
    if (( status != 0 )); then
      security_failures+=("$label:$status")
      log "security stage failed, continuing: $label (exit $status)"
    fi
  }

  run_security_isolated_client_check() {
    local suffix="security-$(namespace_slug "$1")"
    shift
    (
      export FSUSBLOG_USER_USERNAME="${FSUSBLOG_USER_USERNAME:-binaryuser}-$suffix"
      export FSUSBLOG_ADMIN_USERNAME="${FSUSBLOG_ADMIN_USERNAME:-binaryadmin}-$suffix"
      export FSUSBLOG_DEVICE_FP="${FSUSBLOG_DEVICE_FP:-binary-smoke-node}-$suffix"
      run_in_client "$@"
    )
  }

  check_security_firewall_evidence() {
    run "$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh" "$FSUSBLOG_FIREWALL_POLICY_EVIDENCE"
  }

  check_external_production_exposure() {
    local -a failures=()
    run "$ROOT_DIR/tools/security/check-production-exposure-live.sh" || failures+=(live-check)
    if [[ -n "${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-}" ]]; then
      run "$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh" "$FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE" \
        || failures+=(evidence-verify)
    fi
    if (( ${#failures[@]} > 0 )); then
      printf '[test:%s] production exposure failures: %s\n' \
        "${CURRENT_TIER:-security}" "${failures[*]}" >&2
      return 1
    fi
  }

  # This prerequisite loads the namespaced bootstrap environment into the
  # current shell; it cannot run inside run_security_stage's isolation subshell.
  require_debug_stack
  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$SECURITY_HTTP_TIMEOUT_MS"
  run_security_stage "prepare-runtime-fixtures" prepare_runtime_fixtures_once
  run_security_stage "reset-pre-parallel" reset_security_runtime_state "pre security parallel checks"

  local -a security_runtime_jobs=(
    "api-contracts::run_in_client npm run check:api-contracts"
    "auth-session::run_security_isolated_client_check auth-session npm run check:auth-session-smoke"
    "auth-mfa::run_security_isolated_client_check auth-mfa npm run check:security:auth-mfa"
    "auth-passkey::run_security_isolated_client_check auth-passkey npm run check:security:auth-passkey"
    "headers-cors::run_in_client npm run check:security:headers-cors"
    "notification-stream-binary::run_in_client npm run check:security:notification-stream-binary"
  )
  if [[ "${FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG:-0}" != "1" ]]; then
    security_runtime_jobs+=("local-runtime-exposure::run \"$ROOT_DIR/tools/security/check-local-runtime-exposure.mjs\"")
  fi
  if [[ -n "${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-}" ]]; then
    security_runtime_jobs+=("firewall-evidence::check_security_firewall_evidence")
  fi
  if [[ "${FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE:-0}" == "1" ]]; then
    security_runtime_jobs+=("external-production-exposure::check_external_production_exposure")
  fi
  run_security_runtime_pool() {
    local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
    local -x FSUSBLOG_PARALLEL_WORKLOAD=cpu
    run_parallel "security-runtime-core" "${security_runtime_jobs[@]}"
  }
  run_security_stage "security-runtime-parallel" run_security_runtime_pool
  # Permission and a11y each drive a real Chromium renderer. Sharing their
  # parent grant made either page crash under full-machine load, so keep the
  # non-browser checks parallel above and collect these two failures in order.
  run_security_stage "security-runtime-permissions" \
    run_security_isolated_client_check permissions npm run check:security:permissions
  run_security_stage "security-runtime-a11y" \
    run_security_isolated_client_check a11y npm run check:a11y:smoke

  run_security_stage "reset-pre-attack" reset_security_runtime_state "pre attack matrix"
  run_security_stage "attack-matrix" run_in_client npm run check:security:attack-matrix
  run_security_stage "reset-post-attack" reset_security_runtime_state "post attack matrix"
  if [[ "${FSUSBLOG_SKIP_ZAP:-0}" != "1" ]]; then
    run_security_stage "dast" run_in_client npm run check:security:dast
  fi
  run_security_stage "reset-post-gate" reset_security_runtime_state "post security gate"
  unset -f run_security_stage run_security_isolated_client_check run_security_runtime_pool \
    check_security_firewall_evidence check_external_production_exposure
  if (( ${#security_failures[@]} > 0 )); then
    fail "security runtime failures (${security_failures[*]})"
  fi
}

run_security_only() {
  log "tier=security | complete static + runtime security gate"
  run_parallel "security-phases" \
    "security-static::run_security_static_only" \
    "security-runtime-core::run_security_runtime_core_only"
}

run_security() {
  log "tier=security | bootstrap + auth/mfa/passkey/pow/permission/a11y gates"
  bootstrap_acceptance_env
  run_tier "security" run_security_only
}

run_resilience_only() {
  log "tier=resilience | runtime/upload/search/notification-stream/binary resilience"
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre resilience"

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RESILIENCE_HTTP_TIMEOUT_MS"

  prepare_runtime_fixtures_once
  run_in_client npm run check:aot-cache-resilience
  run_in_client npm run check:resilience:runtime
  run_in_client npm run check:resilience:upload
  run_in_client npm run check:notification-stream-runtime
  run_in_client npm run check:search-runtime
  run_in_client npm run check:binary-smoke
  run_in_client npm run check:binary-contract-smoke
  write_runtime_lane_summary resilience
}

run_resilience() {
  log "tier=resilience | bootstrap + runtime/upload/search/notification-stream/binary resilience"
  bootstrap_acceptance_env
  run_tier "resilience" run_resilience_only
}

run_load_only() {
  log "tier=load | lightweight public/api and notification stream concurrency checks"
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre load"

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$LOAD_HTTP_TIMEOUT_MS"

  prepare_runtime_fixtures_once
  run_in_client npm run check:load:public-api
  reset_security_runtime_state "pre notification stream pressure"
  run_in_client npm run check:load:notification-stream-pressure
}

run_load() {
  log "tier=load | bootstrap + lightweight public/api and notification stream concurrency checks"
  bootstrap_acceptance_env
  run_tier "load" run_load_only
}

run_production() {
  log "tier=production | full industrial release gate with one post-fast runtime bootstrap"

  run_tier "fast" run_fast_only

  CURRENT_TIER="production"
  export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
  export FSUSBLOG_PLAYWRIGHT_WORKERS="${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(default_playwright_workers)}"
  # Fast rebuilds backend StaticWebAssets and frontend release assets. Force the
  # shared runtime to restart once here so the remaining gates validate the
  # just-built code and asset generation instead of a previously healthy stack.
  local previous_force_bootstrap="${FSUSBLOG_FORCE_BOOTSTRAP-}"
  export FSUSBLOG_FORCE_BOOTSTRAP=1
  bootstrap_acceptance_env
  if [[ -n "$previous_force_bootstrap" ]]; then
    export FSUSBLOG_FORCE_BOOTSTRAP="$previous_force_bootstrap"
  else
    unset FSUSBLOG_FORCE_BOOTSTRAP
  fi
  export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1

  run_tier "release" run_release_only

  export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/integration'
  run_tier "integration" run_integration_only
  export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/security'
  run_tier "security" run_security_only

  export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/acceptance'
  run_tier "acceptance" run_acceptance_only
  if [[ "${FSUSBLOG_ENABLE_CROSS_BROWSER:-0}" == "1" ]]; then
    local previous_playwright_browsers="${FSUSBLOG_PLAYWRIGHT_BROWSERS-}"
    local previous_playwright_base_url="${PLAYWRIGHT_BASE_URL-}"
    export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/cross-browser'
    export FSUSBLOG_PLAYWRIGHT_BROWSERS="${FSUSBLOG_PLAYWRIGHT_BROWSERS:-chromium,firefox,webkit}"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    run_in_client npm run check:cross-browser:smoke
    if [[ -n "$previous_playwright_browsers" ]]; then
      export FSUSBLOG_PLAYWRIGHT_BROWSERS="$previous_playwright_browsers"
    else
      unset FSUSBLOG_PLAYWRIGHT_BROWSERS
    fi
    if [[ -n "$previous_playwright_base_url" ]]; then
      export PLAYWRIGHT_BASE_URL="$previous_playwright_base_url"
    else
      unset PLAYWRIGHT_BASE_URL
    fi
  fi
  if [[ "${FSUSBLOG_SKIP_VISUAL_GATE:-0}" == "1" ]]; then
    record_visual_gate_skip
    log "tier=visual | skipped by FSUSBLOG_SKIP_VISUAL_GATE=1"
  else
    export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/visual'
    run_tier "visual" run_visual_only
  fi
  export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/resilience'
  run_tier "resilience" run_resilience_only

  run_tier "load" run_load_only
  run "$ROOT_DIR/tools/operations/collect-release-evidence.sh"
  run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs"
}

usage() {
  cat <<'EOF'
Usage: ./tools/test.sh <fast|integration|ci|coverage|coverage-backend|coverage-frontend|coverage-merge|coverage-threshold|coverage-gate|release|acceptance|visual|security|security-static-phase|security-runtime-core|resilience|load|production|backend-api-integration|backend-auth-state-machine|backend-concurrency|backend-property|backend-golden|backend-test-governance|backend-perf|backend-mutation|backend-mutation-critical|backend-nightly|cross-stack-contract|backend-trx-contract-dry-run>

Tiers:
  fast         Static and local-only validation; no running services required.
  integration  Debug runtime validation; requires frontend=3000 and backend=5000.
  ci           Standard gate; runs fast + integration.
  coverage-backend  Collect server-side xUnit coverage artifacts into .tmp/coverage.
  coverage-frontend Collect frontend Vitest coverage artifacts into .tmp/coverage.
  coverage-merge    Merge available coverage artifacts under .tmp/coverage into one summary.
  coverage-threshold Enforce merged + backend-only coverage thresholds (defaults: line/branch/method 100%).
  coverage-gate     One-shot coverage gate: backend + frontend + merge + threshold.
  coverage          Alias for coverage-gate.
  release      Release preview validation; requires preview at 8080.
  acceptance   Full acceptance gate; bootstraps env and runs fast + integration + release + full Playwright acceptance.
  visual       Visual gate; bootstraps env and runs dark/mobile layout + screenshot baselines on public + console routes.
  security     Auth/session/MFA/permission/a11y security gate.
  security-static-phase  Bootstrap-free security matrices, supply-chain, network and SBOM phase.
  security-runtime-core  Runtime-only auth/session/MFA/permission/a11y/attack phase; requires bootstrapped services.
  resilience   Runtime/upload/search resilience gate.
  load         Lightweight public/API concurrency gate.
  production   Industrial release gate; runs fast, bootstraps once, then runs integration + release + acceptance + visual + security + resilience + load. Set FSUSBLOG_SKIP_VISUAL_GATE=1 only with FSUSBLOG_VISUAL_SKIP_REASON, FSUSBLOG_VISUAL_SKIP_APPROVER, FSUSBLOG_VISUAL_SKIP_IMPACT and FSUSBLOG_VISUAL_SKIP_RERUN_URL.
  backend-api-integration       Backend endpoint/API matrix contract tier.
  backend-auth-state-machine    Backend auth/MFA/PoW/session state-machine tier.
  backend-concurrency           Backend deterministic race/idempotency tier.
  backend-property              Backend property-based protocol/cache/upload tier.
  backend-golden                Backend AEDS/POD golden catalog tier.
  backend-test-governance       Backend traceability/profile/static governance tier.
  backend-perf                  Backend BenchmarkDotNet build/readiness tier.
  backend-mutation              Backend Stryker.NET mutation tier.
  backend-mutation-critical     Release-critical AEDS/JWT/cache/binary/notification Stryker slice.
  backend-nightly               Backend exhaustive nightly readiness tier. Set FSUSBLOG_RUN_BACKEND_MUTATION_FULL=1 to include full mutation.
  cross-stack-contract          Frontend/backend binary contract, API parity, schema sync, negative and coherence governance tier.
EOF
}

main() {
  local tier="${1:-}"
  case "$tier" in
    fast)
      CURRENT_TIER="fast"
      run_fast
      ;;
    integration)
      CURRENT_TIER="integration"
      run_integration
      ;;
    ci)
      CURRENT_TIER="ci"
      run_ci
      ;;
    coverage-backend)
      CURRENT_TIER="coverage-backend"
      run_coverage_backend
      ;;
    coverage-frontend)
      CURRENT_TIER="coverage-frontend"
      run_coverage_frontend
      ;;
    coverage-merge)
      CURRENT_TIER="coverage-merge"
      run_coverage_merge
      ;;
    coverage-threshold)
      CURRENT_TIER="coverage-threshold"
      run_coverage_threshold
      ;;
    coverage|coverage-gate)
      CURRENT_TIER="coverage-gate"
      run_coverage_gate
      ;;
    release)
      CURRENT_TIER="release"
      run_release
      ;;
    acceptance)
      CURRENT_TIER="acceptance"
      run_acceptance
      ;;
    visual)
      CURRENT_TIER="visual"
      run_visual
      ;;
    security)
      CURRENT_TIER="security"
      run_security
      ;;
    security-static-phase)
      CURRENT_TIER="security"
      run_tier "security" run_security_static_only
      ;;
    security-runtime-core)
      CURRENT_TIER="security"
      run_tier "security" run_security_runtime_core_only
      ;;
    resilience)
      CURRENT_TIER="resilience"
      run_resilience
      ;;
    load)
      CURRENT_TIER="load"
      run_load
      ;;
    production)
      CURRENT_TIER="production"
      run_production
      ;;
    backend-api-integration)
      CURRENT_TIER="backend-api-integration"
      run_tier "backend-api-integration" run_backend_api_integration_only
      ;;
    backend-auth-state-machine)
      CURRENT_TIER="backend-auth-state-machine"
      run_tier "backend-auth-state-machine" run_backend_auth_state_machine_only
      ;;
    backend-concurrency)
      CURRENT_TIER="backend-concurrency"
      run_tier "backend-concurrency" run_backend_concurrency_only
      ;;
    backend-property)
      CURRENT_TIER="backend-property"
      run_tier "backend-property" run_backend_property_only
      ;;
    backend-golden)
      CURRENT_TIER="backend-golden"
      run_tier "backend-golden" run_backend_golden_only
      ;;
    backend-test-governance)
      CURRENT_TIER="backend-test-governance"
      run_tier "backend-test-governance" run_backend_test_governance_only
      ;;
    backend-perf)
      CURRENT_TIER="backend-perf"
      run_tier "backend-perf" run_backend_perf_only
      ;;
    backend-mutation)
      CURRENT_TIER="backend-mutation"
      run_tier "backend-mutation" run_backend_mutation_only
      ;;
    backend-mutation-critical)
      CURRENT_TIER="backend-mutation-critical"
      run_tier "backend-mutation-critical" run_backend_mutation_critical_only
      ;;
    backend-nightly)
      CURRENT_TIER="backend-nightly"
      run_tier "backend-nightly" run_backend_nightly_only
      ;;
    cross-stack-contract)
      CURRENT_TIER="cross-stack-contract"
      run_tier "cross-stack-contract" run_cross_stack_contract_only "${2:-all}"
      ;;
    backend-trx-contract-dry-run)
      CURRENT_TIER="backend-trx-contract-dry-run"
      shift
      write_backend_trx_contract_dry_run "$@"
      ;;
    -h|--help|help|'')
      usage
      ;;
    *)
      usage
      fail "unknown tier: $tier"
      ;;
  esac
}

if [[ "${FSUSBLOG_TEST_LEGACY_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi

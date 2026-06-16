#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
GATE_LOG_DIR="${FSUSBLOG_GATE_LOG_DIR:-$ROOT_DIR/.tmp/gate-logs}"
FRONTEND_FAST_GROUP_TIMINGS_JSONL="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSONL:-$ROOT_DIR/.tmp/frontend/frontend-fast-groups.jsonl}"
FRONTEND_FAST_GROUP_TIMINGS_JSON="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSON:-$ROOT_DIR/.tmp/frontend/frontend-fast-groups.json}"

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
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:5000}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"
DOTNET_BUILD_SHARED_ARGS=(/p:UseSharedCompilation=true /p:NuGetAudit=false)
DOTNET_BUILD_PARALLEL_ARGS=()

default_playwright_workers() {
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '1'
  else
    printf '4'
  fi
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
  local raw="${FSUSBLOG_DOTNET_BUILD_PARALLELISM:-safe}"
  raw="${raw//[[:space:]]/}"
  local normalized="${raw,,}"
  local mode
  local msbuild_arg

  case "$normalized" in
    ""|safe|single|1)
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
        fail "FSUSBLOG_DOTNET_BUILD_PARALLELISM must be safe, 1, auto, or an integer greater than 1 (got '$raw')"
      fi
      ;;
  esac

  DOTNET_BUILD_PARALLEL_ARGS=("$msbuild_arg" "${DOTNET_BUILD_SHARED_ARGS[@]}")
  log "dotnet-build parallelism=$mode arg=$msbuild_arg"
}

namespace_slug() {
  printf '%s' "${1:-local}" | tr -c 'A-Za-z0-9_.-' '-'
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
}

configure_playwright_shard() {
  local lane="$1"
  local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
  local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

  if [[ -z "$index" && -z "$total" ]]; then
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

run_vitest_script() {
  local script="$1"
  if [[ -n "${FSUSBLOG_VITEST_SHARD_ARG:-}" ]]; then
    run_in_client npm run "$script" -- "$FSUSBLOG_VITEST_SHARD_ARG"
  else
    run_in_client npm run "$script"
  fi
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

run_parallel() {
  local group="$1"
  shift
  local -a pids=()
  local -a status_files=()
  local status_dir="$ROOT_DIR/.tmp/parallel-status/$(namespace_slug "$group")-$$-$RANDOM"
  mkdir -p "$status_dir"

  CURRENT_STAGE="$group"
  log "parallel group start: $group ($# jobs)"

  for spec in "$@"; do
    local label="${spec%%::*}"
    local command="${spec#*::}"
    local status_file="$status_dir/$(namespace_slug "$label").status"
    (
      set +e
      CURRENT_STAGE="$group/$label"
      log "parallel start: $label"
      eval "$command"
      local child_status=$?
      if (( child_status == 0 )); then
        log "parallel done: $label"
      else
        log "parallel failed: $label (exit $child_status)"
      fi
      printf '%s\t%s\n' "$child_status" "$label" > "$status_file"
      exit "$child_status"
    ) &
    local pid="$!"
    pids+=("$pid")
    status_files+=("$status_file")
  done

  local completed=0
  while (( completed < ${#status_files[@]} )); do
    completed=0
    for status_file in "${status_files[@]}"; do
      if [[ ! -f "$status_file" ]]; then
        continue
      fi

      completed=$((completed + 1))
      local child_status child_label
      IFS=$'\t' read -r child_status child_label < "$status_file"
      if [[ "$child_status" != "0" ]]; then
        for pid in "${pids[@]}"; do
          kill "$pid" >/dev/null 2>&1 || true
        done
        wait >/dev/null 2>&1 || true
        rm -rf "$status_dir"
        fail "parallel group failed: $group/${child_label:-unknown} (exit $child_status)"
      fi
    done
    sleep 0.1
  done
  wait >/dev/null 2>&1 || true
  rm -rf "$status_dir"

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
  local namespace_pattern="${FSUSBLOG_TEST_NAMESPACE:-local}"
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

run_fast_backend_lane() {
  run "$ROOT_DIR/tools/check-backend-test-governance.mjs"
  configure_dotnet_build_parallelism
  run "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/FsusBlog.slnx" -c Debug -warnaserror -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
  if [[ "${FSUSBLOG_TEST_SELECTION:-}" == "affected" ]]; then
    log "backend-fast selection=affected"
    run "$ROOT_DIR/tools/dotnet-affected-tests.sh"
  else
    log "backend-fast selection=full reason=${FSUSBLOG_TEST_SELECTION:-unset}"
    run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --no-build --filter "Category!=Integration"
  fi
}

run_backend_dotnet_filter_only() {
  local filter="$1"
  run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --filter "$filter"
}

run_backend_api_integration_only() {
  run_backend_dotnet_filter_only "Category=ApiIntegration"
}

run_backend_auth_state_machine_only() {
  run_backend_dotnet_filter_only "Category=SecurityStateMachine"
}

run_backend_concurrency_only() {
  run_backend_dotnet_filter_only "Category=Concurrency"
}

run_backend_property_only() {
  run_backend_dotnet_filter_only "Category=Property"
}

run_backend_golden_only() {
  run_backend_dotnet_filter_only "Category=GoldenContract"
}

run_backend_test_governance_only() {
  run "$ROOT_DIR/tools/check-backend-test-governance.mjs"
}

run_backend_perf_only() {
  run "$ROOT_DIR/tools/check-backend-test-governance.mjs"
  configure_dotnet_build_parallelism
  run "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" -c Release -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
}

run_backend_mutation_only() {
  run dotnet tool restore
  run dotnet tool run dotnet-stryker --config-file "$ROOT_DIR/stryker-config.json"
}

run_backend_chaos_only() {
  run "$ROOT_DIR/tools/check-backend-test-governance.mjs"
  run_backend_dotnet_filter_only "Category=Concurrency"
}

run_backend_nightly_only() {
  run "$ROOT_DIR/tools/check-backend-test-governance.mjs"
  run_backend_dotnet_filter_only "Category=Property|Category=GoldenContract|Category=Concurrency|Category=SecurityStateMachine|Category=ApiIntegration"
  run_backend_perf_only
  if [[ "${FSUSBLOG_RUN_BACKEND_MUTATION_FULL:-0}" == "1" ]]; then
    run_backend_mutation_only
  else
    log "skip backend mutation full run (set FSUSBLOG_RUN_BACKEND_MUTATION_FULL=1)"
  fi
}

run_cross_stack_contract_only() {
  run "$ROOT_DIR/tools/contracts/export-openapi.sh"
  run_in_client npm run check:cross-stack-contract
}

run_frontend_fast_build_group() {
  run_in_client env FSUSBLOG_SKIP_ENSURE_WASM=1 FSUSBLOG_VITE_WARN_AS_ERROR=1 npm run build
}

run_frontend_fast_tests_group_body() {
  if node -e "const pkg=require(process.argv[1]); process.exit(pkg.scripts && pkg.scripts['test:unit:fast'] ? 0 : 1)" "$CLIENT_DIR/package.json"; then
    run_vitest_script test:unit:fast
  fi

  run_vitest_script test:property
  run_vitest_script check:frontend-state-machines
  run_vitest_script check:frontend-perf-regression
}

run_frontend_fast_tests_group() {
  run_frontend_fast_group tests run_frontend_fast_tests_group_body
}

run_frontend_fast_runtime_contracts_group_body() {
  run_in_client npm run check:worker-contracts
  run_in_client npm run check:a11y:deep
  run_in_client npm run check:contract:binary-matrix
  run_in_client npm run check:contract:negative-matrix
  run_in_client npm run check:coherence:runtime-matrix
  run_in_client npm run check:image-codec-wasm
  run_in_client npm run check:image-codec-wasm-runtime
}

run_frontend_fast_runtime_contracts_group() {
  run_frontend_fast_group runtime-contracts run_frontend_fast_runtime_contracts_group_body
}

run_frontend_fast_static_governance_group_body() {
  run_in_client npm run check:frontend-test-governance
  run_in_client npm run check:contract:api-parity
  run_in_client npm run check:contract:frame-schema
  run_in_client npm run check:cross-stack-test-governance
  run_in_client npm run check:modern-standards
  run_in_client npm run check:result-boundaries
  run_in_client npm run check:error-code-alignment
  run_in_client npm run check:no-runtime-message-branching
  run_in_client npm run check:security-consistency
  run_in_client npm run check:server-try-catch
  run_in_client npm run check:asset-size-budget
  run_in_client npm run check:public-private-data-leakage
  run_in_client npm run check:public-aot-contracts
  run_in_client npm run check:pwa-offline-policy
  run_in_client npm run check:views-constraints
  run "$ROOT_DIR/tools/check-public-hot-read-fastpath.sh"
  run "$ROOT_DIR/tools/check-historical-residue.sh"
  run "$ROOT_DIR/tools/check-cache-governance.sh"
  run "$ROOT_DIR/tools/check-test-hygiene.sh"
  run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test
  run "$ROOT_DIR/tools/check-test-matrix.mjs"
  run "$ROOT_DIR/tools/operations/check-slo-definition.mjs"
  run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" --self-test
  run "$ROOT_DIR/tools/operations/check-release-slo-alerts.mjs" --self-test
}

run_frontend_fast_static_governance_group() {
  run_frontend_fast_group static-governance run_frontend_fast_static_governance_group_body
}

run_fast_frontend_lane() {
  configure_vitest_shard
  prepare_frontend_fast_group_timings
  run_frontend_fast_group build run_frontend_fast_build_group
  run_parallel "frontend-fast-post-build" \
    "tests::run_frontend_fast_tests_group" \
    "runtime-contracts::run_frontend_fast_runtime_contracts_group" \
    "static-governance::run_frontend_fast_static_governance_group"
  write_frontend_fast_group_summary
}

run_fast_only() {
  log "tier=fast | no running services required"
  run_in_client npm run ensure:wasm
  # The frontend release build syncs hashed assets into src/backend/wwwroot.
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
  run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --filter "Category=Integration"
  require_debug_stack

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$INTEGRATION_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:auth-session-smoke
  run_in_client npm run check:binary-smoke
  run_in_client npm run check:binary-smoke:auth
  run_in_client npm run check:notification-stream-runtime
  run_in_client npm run check:notification-stream-live
  run_in_client npm run check:api-contracts
  run_in_client npm run check:binary-contract-smoke
  run_in_client npm run check:distribution-version-coherence
  run_in_client npm run check:sw-search-runtime
  run_in_client npm run check:search-runtime
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

run_release_only() {
  log "tier=release | requires release preview=8080"
  require_release_preview

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"

  run_in_client npm run check:public-hydration-rebuild
  # Public AOT warmup/backfill is a backend operation; Vite preview only serves static release assets.
  run_in_client env \
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" \
    FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL" \
    npm run rebuild:public-hydration
  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client node ../../tests/frontend/checks/public/aot-regression.mjs
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client npm run check:search-runtime
  run_in_client npm run check:public-hydration
  run_in_client node ../../tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs
  run_in_client node ../../tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs
  run_in_client node ../../tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs
  run_in_client npm run check:public-seo-smoke
  run_in_client npm run check:pwa-offline-smoke
}

run_release() {
  run_tier "release" run_release_only
}

run_acceptance_only() {
  log "tier=acceptance | full Playwright acceptance e2e, requires frontend=3000 backend=5000 preview=8080"
  configure_playwright_shard acceptance
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre acceptance"

  if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
    run_in_client npm run prepare:playwright:sessions
  fi

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
  run_in_client npm run check:acceptance:public

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
  require_debug_stack
  require_release_preview
  reset_security_runtime_state "pre visual console"

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
  run_visual_group_check console npm run check:visual:console
}

run_visual() {
  log "tier=visual | bootstrap + dark/mobile visual gates"
  bootstrap_acceptance_env
  run_tier "visual" run_visual_only
}

run_security_only() {
  log "tier=security | auth/mfa/passkey/pow/permission/a11y gates"
  run "$ROOT_DIR/tools/security/check-security-matrices.mjs"
  run "$ROOT_DIR/tools/security/check-zap-warn-policy.mjs"
  run "$ROOT_DIR/tools/security/generate-sbom.sh"
  run "$ROOT_DIR/tools/security/check-supply-chain-audit.sh"
  run "$ROOT_DIR/tools/security/check-production-network-baseline.sh"
  if [[ -n "${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-}" ]]; then
    run "$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh" "$FSUSBLOG_FIREWALL_POLICY_EVIDENCE"
  fi
  if [[ "${FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE:-0}" == "1" ]]; then
    run "$ROOT_DIR/tools/security/check-production-exposure-live.sh"
    if [[ -n "${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-}" ]]; then
      run "$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh" "$FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE"
    fi
  else
    log "skip production live exposure check (set FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE=1)"
  fi
  require_debug_stack

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$SECURITY_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:api-contracts
  run_in_client npm run check:auth-session-smoke
  run_in_client npm run check:security:auth-mfa
  run_in_client npm run check:security:auth-passkey
  reset_security_runtime_state "pre permission matrix"
  run_in_client npm run check:security:permissions
  run_in_client npm run check:security:headers-cors
  run_in_client npm run check:security:attack-matrix
  reset_security_runtime_state "post attack matrix"
  run_in_client npm run check:security:notification-stream-binary
  reset_security_runtime_state "pre a11y smoke"
  run_in_client npm run check:a11y:smoke
  run_in_client npm run check:security:dast
  reset_security_runtime_state "post security gate"
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

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:resilience:runtime
  run_in_client npm run check:resilience:upload
  run_in_client npm run check:notification-stream-runtime
  run_in_client npm run check:search-runtime
  run_in_client npm run check:binary-smoke
  run_in_client npm run check:binary-contract-smoke
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

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:load:public-api
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
Usage: ./tools/test.sh <fast|integration|ci|coverage|coverage-backend|coverage-frontend|coverage-merge|coverage-threshold|coverage-gate|release|acceptance|visual|security|resilience|load|production|backend-api-integration|backend-auth-state-machine|backend-concurrency|backend-property|backend-golden|backend-test-governance|backend-perf|backend-mutation|backend-chaos|backend-nightly|cross-stack-contract>

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
  backend-chaos                 Backend deterministic fault/concurrency readiness tier.
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
    backend-chaos)
      CURRENT_TIER="backend-chaos"
      run_tier "backend-chaos" run_backend_chaos_only
      ;;
    backend-nightly)
      CURRENT_TIER="backend-nightly"
      run_tier "backend-nightly" run_backend_nightly_only
      ;;
    cross-stack-contract)
      CURRENT_TIER="cross-stack-contract"
      run_tier "cross-stack-contract" run_cross_stack_contract_only
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

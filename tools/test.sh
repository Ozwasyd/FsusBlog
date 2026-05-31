#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
GATE_LOG_DIR="${FSUSBLOG_GATE_LOG_DIR:-$ROOT_DIR/.tmp/gate-logs}"

FAST_HTTP_TIMEOUT_MS="${FSUSBLOG_FAST_HTTP_TIMEOUT_MS:-15000}"
INTEGRATION_HTTP_TIMEOUT_MS="${FSUSBLOG_INTEGRATION_HTTP_TIMEOUT_MS:-15000}"
RELEASE_HTTP_TIMEOUT_MS="${FSUSBLOG_RELEASE_HTTP_TIMEOUT_MS:-15000}"
ACCEPTANCE_HTTP_TIMEOUT_MS="${FSUSBLOG_ACCEPTANCE_HTTP_TIMEOUT_MS:-15000}"
VISUAL_HTTP_TIMEOUT_MS="${FSUSBLOG_VISUAL_HTTP_TIMEOUT_MS:-15000}"
SECURITY_HTTP_TIMEOUT_MS="${FSUSBLOG_SECURITY_HTTP_TIMEOUT_MS:-15000}"
RESILIENCE_HTTP_TIMEOUT_MS="${FSUSBLOG_RESILIENCE_HTTP_TIMEOUT_MS:-15000}"
LOAD_HTTP_TIMEOUT_MS="${FSUSBLOG_LOAD_HTTP_TIMEOUT_MS:-10000}"

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:3000}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:5000}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"
DOTNET_BUILD_PARALLEL_ARGS=(/m:1 /p:UseSharedCompilation=true /p:NuGetAudit=false)

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

run_parallel() {
  local group="$1"
  shift
  local -a pids=()
  local -a labels=()

  CURRENT_STAGE="$group"
  log "parallel group start: $group ($# jobs)"

  for spec in "$@"; do
    local label="${spec%%::*}"
    local command="${spec#*::}"
    labels+=("$label")
    (
      CURRENT_STAGE="$group/$label"
      log "parallel start: $label"
      eval "$command"
      log "parallel done: $label"
    ) &
    pids+=("$!")
  done

  set +e
  local remaining="${#pids[@]}"
  local status=0
  while (( remaining > 0 )); do
    wait -n
    status=$?
    remaining=$((remaining - 1))
    if (( status != 0 )); then
      for pid in "${pids[@]}"; do
        kill "$pid" >/dev/null 2>&1 || true
      done
      wait >/dev/null 2>&1 || true
      set -e
      fail "parallel group failed: $group (exit $status)"
    fi
  done
  set -e

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
  log "require debug services: frontend=3000 backend=5000"
  probe_url "debug frontend" "$DEBUG_FRONTEND_URL/"
  probe_binary_url "debug backend" "$DEBUG_BACKEND_URL/api/binary/system/seo"
}

require_release_preview() {
  log "require release preview: 8080"
  probe_url "release preview" "$RELEASE_PREVIEW_URL/"
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
}

run_fast_backend_lane() {
  run "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/FsusBlog.slnx" -c Debug -warnaserror -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
  if [[ "${FSUSBLOG_TEST_SELECTION:-}" == "affected" ]]; then
    run "$ROOT_DIR/tools/dotnet-affected-tests.sh"
  else
    run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --no-build --filter "Category!=Integration"
  fi
}

run_fast_frontend_lane() {
  run_in_client env FSUSBLOG_SKIP_ENSURE_WASM=1 FSUSBLOG_VITE_WARN_AS_ERROR=1 npm run build
  if node -e "const pkg=require(process.argv[1]); process.exit(pkg.scripts && pkg.scripts['test:unit:fast'] ? 0 : 1)" "$CLIENT_DIR/package.json"; then
    run_in_client npm run test:unit:fast
  fi

  run_in_client npm run check:modern-standards
  run_in_client npm run check:result-boundaries
  run_in_client npm run check:error-code-alignment
  run_in_client npm run check:no-runtime-message-branching
  run_in_client npm run check:security-consistency
  run_in_client npm run check:server-try-catch
  run_in_client npm run check:asset-size-budget
  run_in_client npm run check:public-private-data-leakage
  run_in_client npm run check:pwa-offline-policy
  run_in_client npm run check:views-constraints
  run_in_client npm run check:image-codec-wasm
  run_in_client npm run check:image-codec-wasm-runtime
  run "$ROOT_DIR/tools/check-historical-residue.sh"
  run "$ROOT_DIR/tools/check-cache-governance.sh"
  run "$ROOT_DIR/tools/check-test-hygiene.sh"
  run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test
  run "$ROOT_DIR/tools/check-test-matrix.mjs"
  run "$ROOT_DIR/tools/operations/check-slo-definition.mjs"
  run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" --self-test
  run "$ROOT_DIR/tools/operations/check-release-slo-alerts.mjs" --self-test
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
  run_in_client npm run check:sse-runtime
  run_in_client npm run check:sse-live
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
    FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_COVERAGE_LINE_THRESHOLD:-100}" \
    FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_COVERAGE_BRANCH_THRESHOLD:-100}" \
    FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_COVERAGE_METHOD_THRESHOLD:-100}" \
    bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
  run env \
    FSUSBLOG_COVERAGE_THRESHOLD_LABEL=backend \
    FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/backend-merged/Summary.json" \
    FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD:-100}" \
    FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD:-100}" \
    FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_METHOD_THRESHOLD:-100}" \
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
  run_in_client npm run rebuild:public-hydration
  run_in_client node ../../tests/frontend/checks/public/aot-regression.mjs
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client npm run check:search-runtime
  run_in_client npm run check:public-hydration
  run_in_client npm run check:public-seo-smoke
  run_in_client npm run check:pwa-offline-smoke
}

run_release() {
  run_tier "release" run_release_only
}

run_acceptance_only() {
  log "tier=acceptance | full Playwright acceptance e2e, requires frontend=3000 backend=5000 preview=8080"
  require_debug_stack
  require_release_preview

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
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
  run_in_client npm run check:visual:public

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
  run_in_client npm run check:visual:console
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
  run_in_client npm run check:security:permissions
  run_in_client npm run check:security:headers-cors
  run_in_client npm run check:security:attack-matrix
  run_in_client npm run check:security:sse-binary
  run_in_client npm run check:a11y:smoke
  run_in_client npm run check:security:dast
}

run_security() {
  log "tier=security | bootstrap + auth/mfa/passkey/pow/permission/a11y gates"
  bootstrap_acceptance_env
  run_tier "security" run_security_only
}

run_resilience_only() {
  log "tier=resilience | runtime/upload/search/sse/binary resilience"
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RESILIENCE_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:resilience:runtime
  run_in_client npm run check:resilience:upload
  run_in_client npm run check:sse-runtime
  run_in_client npm run check:search-runtime
  run_in_client npm run check:binary-smoke
  run_in_client npm run check:binary-contract-smoke
}

run_resilience() {
  log "tier=resilience | bootstrap + runtime/upload/search/sse/binary resilience"
  bootstrap_acceptance_env
  run_tier "resilience" run_resilience_only
}

run_load_only() {
  log "tier=load | lightweight public/api and SSE concurrency checks"
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$LOAD_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:load:public-api
  run_in_client npm run check:load:sse-pressure
}

run_load() {
  log "tier=load | bootstrap + lightweight public/api and SSE concurrency checks"
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
    export PLAYWRIGHT_OUTPUT_DIR='test-results/playwright/cross-browser'
    export FSUSBLOG_PLAYWRIGHT_BROWSERS="${FSUSBLOG_PLAYWRIGHT_BROWSERS:-chromium,firefox,webkit}"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    run_in_client npm run check:cross-browser:smoke
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
Usage: ./tools/test.sh <fast|integration|ci|coverage|coverage-backend|coverage-frontend|coverage-merge|coverage-threshold|coverage-gate|release|acceptance|visual|security|resilience|load|production>

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
    -h|--help|help|'')
      usage
      ;;
    *)
      usage
      fail "unknown tier: $tier"
      ;;
  esac
}

main "$@"

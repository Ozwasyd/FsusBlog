#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/FsusBlog.Client"
SERVER_TEST_PROJ="$ROOT_DIR/FsusBlog.Server.Tests/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"

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

log() {
  printf '[test:%s] %s\n' "${CURRENT_TIER:-unknown}" "$1"
}

fail() {
  printf '[test:%s] error: %s\n' "${CURRENT_TIER:-unknown}" "$1" >&2
  exit 1
}

run() {
  log "run: $*"
  "$@"
}

run_in_client() {
  log "run: (cd FsusBlog.Client && $*)"
  (
    cd "$CLIENT_DIR"
    "$@"
  )
}

probe_url() {
  local label="$1"
  local url="$2"

  if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
    return 0
  fi

  fail "$label unreachable at $url"
}

require_debug_stack() {
  log "require debug services: frontend=3000 backend=5000"
  probe_url "debug frontend" "$DEBUG_FRONTEND_URL/"
  probe_url "debug backend" "$DEBUG_BACKEND_URL/api/Article?page=1&size=1"
}

require_release_preview() {
  log "require release preview: 8080"
  probe_url "release preview" "$RELEASE_PREVIEW_URL/"
}

run_fast() {
  log "tier=fast | no running services required"
  run "$BUILD_ENV_RUNNER" dotnet build "$ROOT_DIR/FsusBlog.slnx" -c Debug -warnaserror -v minimal
  run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --no-build --filter "Category!=Integration"

  run_in_client npm run ensure:wasm
  run_in_client npx vue-tsc -p tsconfig.json --noEmit
  run_in_client npm run build

  run_in_client npm run check:modern-standards
  run_in_client npm run check:result-boundaries
  run_in_client npm run check:error-code-alignment
  run_in_client npm run check:no-runtime-message-branching
  run_in_client npm run check:security-consistency
  run_in_client npm run check:server-try-catch
  run_in_client npm run check:views-constraints
  run_in_client npm run check:markdown-no-js-path
  run_in_client npm run check:markdown-wasm
  run_in_client npm run check:markdown-wasm-runtime
  run_in_client npm run check:image-codec-wasm
  run_in_client npm run check:image-codec-wasm-runtime
  run "$ROOT_DIR/tools/check-historical-residue.sh"
  run "$ROOT_DIR/tools/check-cache-governance.sh"
  run "$ROOT_DIR/tools/check-test-hygiene.sh"
}

run_integration() {
  log "tier=integration | requires debug frontend=3000 backend=5000"
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
  run_in_client npm run check:sw-search-runtime
  run_in_client npm run check:search-runtime
  run_in_client npm run check:spa:routes
}

run_ci() {
  log "tier=ci | fast + integration"
  CURRENT_TIER="fast"
  run_fast
  CURRENT_TIER="integration"
  run_integration
}

run_release() {
  log "tier=release | requires release preview=8080"
  require_release_preview

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"

  run_in_client npm run check:public-hydration-rebuild
  run_in_client npm run rebuild:public-hydration
  run_in_client node ./tests/checks/public/aot-regression.mjs
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  run_in_client npm run check:search-runtime
  run_in_client npm run check:public-hydration
  run_in_client npm run check:public-seo-smoke
}

run_acceptance() {
  log "tier=acceptance | bootstrap + fast + integration + release + full acceptance e2e"
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"

  CURRENT_TIER="fast"
  run_fast

  CURRENT_TIER="integration"
  run_integration

  CURRENT_TIER="release"
  run_release

  CURRENT_TIER="acceptance"
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
  export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
  run_in_client npm run check:acceptance:public

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
  run_in_client npm run check:acceptance:console
}

run_visual() {
  log "tier=visual | bootstrap + dark/mobile visual gates"
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
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

run_security() {
  log "tier=security | bootstrap + auth/mfa/permission/a11y gates"
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
  require_debug_stack

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$SECURITY_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:auth-session-smoke
  run_in_client npm run check:security:auth-mfa
  run_in_client npm run check:security:permissions
  run_in_client npm run check:a11y:smoke
}

run_resilience() {
  log "tier=resilience | bootstrap + runtime/upload/search resilience"
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$RESILIENCE_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:resilience:runtime
  run_in_client npm run check:markdown-extreme
  run_in_client npm run check:acceptance:markdown-extreme
  run_in_client npm run check:resilience:upload
  run_in_client npm run check:sse-runtime
  run_in_client npm run check:search-runtime
}

run_load() {
  log "tier=load | bootstrap + lightweight public/api load checks"
  run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
  require_debug_stack
  require_release_preview

  export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
  export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
  export FSUSBLOG_HTTP_TIMEOUT_MS="$LOAD_HTTP_TIMEOUT_MS"

  run_in_client npm run prepare:binary-smoke:auth-users
  run_in_client npm run prepare:playwright:fixtures
  run_in_client npm run check:load:public-api
}

run_production() {
  log "tier=production | full industrial release gate"

  CURRENT_TIER="fast"
  run_fast

  CURRENT_TIER="integration"
  run_integration

  CURRENT_TIER="release"
  run_release

  CURRENT_TIER="acceptance"
  run_acceptance

  CURRENT_TIER="visual"
  run_visual

  CURRENT_TIER="security"
  run_security

  CURRENT_TIER="resilience"
  run_resilience

  CURRENT_TIER="load"
  run_load
}

usage() {
  cat <<'EOF'
Usage: ./tools/test.sh <fast|integration|ci|release|acceptance|visual|security|resilience|load|production>

Tiers:
  fast         Static and local-only validation; no running services required.
  integration  Debug runtime validation; requires frontend=3000 and backend=5000.
  ci           Standard gate; runs fast + integration.
  release      Release preview validation; requires preview at 8080.
  acceptance   Full acceptance gate; bootstraps env and runs fast + integration + release + full Playwright acceptance.
  visual       Visual gate; bootstraps env and runs dark/mobile layout + screenshot baselines on public + console routes.
  security     Auth/session/MFA/permission/a11y security gate.
  resilience   Runtime/upload/search resilience gate.
  load         Lightweight public/API concurrency gate.
  production   Industrial release gate; runs fast + integration + release + acceptance + visual + security + resilience + load.
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

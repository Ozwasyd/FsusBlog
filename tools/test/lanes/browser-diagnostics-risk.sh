#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

PROBE="${1:-}"
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" && "${MATRIX_JOB:-}" != "browser-diagnostics" ]]; then
    fail "browser diagnostics risk probes are diagnostics-only"
fi
if [[ -z "$PROBE" ]]; then
    fail "browser diagnostics risk probe id is required"
fi

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"

load_shared_diagnostics_runtime() {
    local probe_namespace="${FSUSBLOG_TEST_NAMESPACE:-}"
    local probe_fixture_root="${FSUSBLOG_FIXTURE_ROOT:-}"
    local probe_session="${FSUSBLOG_TEST_SESSION:-}"
    local probe_session_prefix="${FSUSBLOG_TEST_SESSION_PREFIX:-}"
    local probe_playwright_session_prefix="${FSUSBLOG_PLAYWRIGHT_SESSION_PREFIX:-}"
    local probe_output_dir="${PLAYWRIGHT_OUTPUT_DIR:-}"
    local probe_diagnostic_root="${FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT:-}"
    local probe_diagnostics_output_root="${FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT:-}"
    local base_namespace="${FSUSBLOG_BROWSER_DIAGNOSTICS_BASE_NAMESPACE:-}"

    if [[ -z "$probe_namespace" || -z "$base_namespace" ]]; then
        fail "browser diagnostics requires probe and bootstrap namespace identities"
    fi

    export FSUSBLOG_TEST_NAMESPACE="$base_namespace"
    require_bootstrapped_namespace

    export FSUSBLOG_TEST_NAMESPACE="$probe_namespace"
    export FSUSBLOG_FIXTURE_ROOT="$probe_fixture_root"
    export FSUSBLOG_TEST_SESSION="$probe_session"
    export FSUSBLOG_TEST_SESSION_PREFIX="$probe_session_prefix"
    export FSUSBLOG_PLAYWRIGHT_SESSION_PREFIX="$probe_playwright_session_prefix"
    export PLAYWRIGHT_OUTPUT_DIR="$probe_output_dir"
    export FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT="$probe_diagnostic_root"
    export FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT="$probe_diagnostics_output_root"
    export FSUSBLOG_BROWSER_DIAGNOSTICS=1
    export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
    export FSUSBLOG_PLAYWRIGHT_WORKERS=1
    export FSUSBLOG_PLAYWRIGHT_RETRIES=0
    export FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-diagnostics
    export FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY=1
    export FSUSBLOG_TEST_SESSION_ISOLATION=1
    export FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS=1
    export FSUSBLOG_SPA_ROUTES_WORKERS=1

    probe_url "debug frontend" "$DEBUG_FRONTEND_URL/"
    probe_binary_url "debug backend" "$DEBUG_BACKEND_URL/api/binary/system/seo"
    probe_url "release preview" "$RELEASE_PREVIEW_URL/"
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
}

prepare_probe_fixtures() {
    prepare_runtime_fixtures_once
    export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
}

run_acceptance_probe() {
    configure_playwright_shard acceptance
    configure_playwright_workers acceptance-spa-routes FSUSBLOG_SPA_ROUTES_WORKERS
    configure_playwright_workers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS
    reset_security_runtime_state "pre diagnostic acceptance"
    prepare_probe_fixtures

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    run_in_client env FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1 npm run check:acceptance:public

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    run_in_client npm run check:spa:routes
    run_in_client npm run check:acceptance:auth
    reset_security_runtime_state "pre diagnostic console acceptance"
    run_in_client npm run check:acceptance:console
}

load_shared_diagnostics_runtime

case "$PROBE" in
    acceptance)
        run_acceptance_probe
        ;;
    release-rbac-negative)
        prepare_probe_fixtures
        reset_security_runtime_state "pre diagnostic release RBAC"
        run_in_client npm run check:security:permissions
        run_in_client npm run check:security:attack-matrix
        ;;
    release-aot-consumption)
        prepare_probe_fixtures
        export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
        run_in_client npm run check:pow-runtime
        run_in_client npm run check:public-hydration
        run_in_client npm run check:distribution-version-coherence
        ;;
    pow-runtime)
        prepare_probe_fixtures
        run_in_client npm run check:pow-runtime
        ;;
    search-runtime)
        prepare_probe_fixtures
        run_in_client npm run check:search-runtime
        ;;
    zero-auth-probe)
        prepare_probe_fixtures
        run_in_client npm run check:auth-zero-probe
        ;;
    permission-matrix)
        prepare_probe_fixtures
        reset_security_runtime_state "pre diagnostic permission matrix"
        run_in_client npm run check:security:permissions
        ;;
    *)
        fail "unknown browser diagnostics risk probe: $PROBE"
        ;;
esac

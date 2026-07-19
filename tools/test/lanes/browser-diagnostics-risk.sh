#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

PROBE="${1:-}"
if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" && "${MATRIX_JOB:-}" != "browser-diagnostics" ]]; then
    Fail "browser diagnostics risk probes are diagnostics-only"
fi
if [[ -z "$PROBE" ]]; then
    Fail "browser diagnostics risk probe id is required"
fi

export FSUSBLOG_BROWSER_DIAGNOSTICS=1
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PLAYWRIGHT_WORKERS=1
export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"

LoadSharedDiagnosticsRuntime() {
    local probeNamespace="${FSUSBLOG_TEST_NAMESPACE:-}"
    local probeFixtureRoot="${FSUSBLOG_FIXTURE_ROOT:-}"
    local probeSession="${FSUSBLOG_TEST_SESSION:-}"
    local probeSessionPrefix="${FSUSBLOG_TEST_SESSION_PREFIX:-}"
    local probePlaywrightSessionPrefix="${FSUSBLOG_PLAYWRIGHT_SESSION_PREFIX:-}"
    local probeOutputDir="${PLAYWRIGHT_OUTPUT_DIR:-}"
    local probeDiagnosticRoot="${FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT:-}"
    local probeDiagnosticsOutputRoot="${FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT:-}"
    local baseNamespace="${FSUSBLOG_BROWSER_DIAGNOSTICS_BASE_NAMESPACE:-}"

    if [[ -z "$probeNamespace" || -z "$baseNamespace" ]]; then
        Fail "browser diagnostics requires probe and bootstrap namespace identities"
    fi

    export FSUSBLOG_TEST_NAMESPACE="$baseNamespace"
    RequireBootstrappedNamespace

    export FSUSBLOG_TEST_NAMESPACE="$probeNamespace"
    export FSUSBLOG_FIXTURE_ROOT="$probeFixtureRoot"
    export FSUSBLOG_TEST_SESSION="$probeSession"
    export FSUSBLOG_TEST_SESSION_PREFIX="$probeSessionPrefix"
    export FSUSBLOG_PLAYWRIGHT_SESSION_PREFIX="$probePlaywrightSessionPrefix"
    export PLAYWRIGHT_OUTPUT_DIR="$probeOutputDir"
    export FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT="$probeDiagnosticRoot"
    export FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT="$probeDiagnosticsOutputRoot"
    export FSUSBLOG_BROWSER_DIAGNOSTICS=1
    export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
    export FSUSBLOG_PLAYWRIGHT_WORKERS=1
    export FSUSBLOG_PLAYWRIGHT_RETRIES=0
    export FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-diagnostics
    export FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY=1
    export FSUSBLOG_TEST_SESSION_ISOLATION=1
    export FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS=1
    export FSUSBLOG_SPA_ROUTES_WORKERS=1

    ProbeUrl "debug frontend" "$DEBUG_FRONTEND_URL/"
    ProbeBinaryUrl "debug backend" "$DEBUG_BACKEND_URL/api/binary/system/seo"
    ProbeUrl "release preview" "$RELEASE_PREVIEW_URL/"
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
}

PrepareProbeFixtures() {
    PrepareRuntimeFixturesOnce
    export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
}

RunAcceptanceProbe() {
    ConfigurePlaywrightShard acceptance
    ConfigurePlaywrightWorkers acceptance-spa-routes FSUSBLOG_SPA_ROUTES_WORKERS
    ConfigurePlaywrightWorkers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS
    ResetSecurityRuntimeState "pre diagnostic acceptance"
    PrepareProbeFixtures

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    RunInClient env FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1 npm run check:acceptance:public

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    RunInClient npm run check:spa:routes
    RunInClient npm run check:acceptance:auth
    ResetSecurityRuntimeState "pre diagnostic console acceptance"
    RunInClient npm run check:acceptance:console
}

LoadSharedDiagnosticsRuntime

case "$PROBE" in
    acceptance)
        RunAcceptanceProbe
        ;;
    release-rbac-negative)
        PrepareProbeFixtures
        ResetSecurityRuntimeState "pre diagnostic release RBAC"
        RunInClient npm run check:security:permissions
        RunInClient npm run check:security:attack-matrix
        ;;
    release-aot-consumption)
        PrepareProbeFixtures
        export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
        RunInClient npm run check:pow-runtime
        RunInClient npm run check:public-hydration
        RunInClient npm run check:distribution-version-coherence
        ;;
    pow-runtime)
        PrepareProbeFixtures
        RunInClient npm run check:pow-runtime
        ;;
    search-runtime)
        PrepareProbeFixtures
        RunInClient npm run check:search-runtime
        ;;
    zero-auth-probe)
        PrepareProbeFixtures
        RunInClient npm run check:auth-zero-probe
        ;;
    permission-matrix)
        PrepareProbeFixtures
        ResetSecurityRuntimeState "pre diagnostic permission matrix"
        RunInClient npm run check:security:permissions
        ;;
    *)
        Fail "unknown browser diagnostics risk probe: $PROBE"
        ;;
esac

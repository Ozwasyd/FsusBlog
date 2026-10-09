#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    printf '[test] _suite-support.sh is source-only; use ./tools/test.sh <tier>\n' >&2
    exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
MIGRATION_TEST_PROJ="$ROOT_DIR/tests/migration/FsusBlog.Migration.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
BACKEND_TRX_DIR="${FSUSBLOG_BACKEND_TRX_DIR:-$ROOT_DIR/.tmp/test-results/backend}"
TEST_RESULTS_ROOT="${FSUSBLOG_TEST_RESULTS_ROOT:-$ROOT_DIR/.tmp/test-results}"
GATE_LOG_DIR="${FSUSBLOG_GATE_LOG_DIR:-$ROOT_DIR/.tmp/gate-logs}"
FRONTEND_OUTPUT_ROOT="${FSUSBLOG_FRONTEND_OUTPUT_ROOT:-$ROOT_DIR/.tmp/frontend}"
RUNTIME_SCENARIO_OUTPUT_ROOT="${FSUSBLOG_RUNTIME_SCENARIO_OUTPUT_ROOT:-$ROOT_DIR/.tmp/runtime-scenario-host/${FSUSBLOG_TEST_RUN_ID:-local}}"
RUNTIME_OUTPUT_ROOT="${FSUSBLOG_RUNTIME_OUTPUT_ROOT:-$ROOT_DIR/.tmp/runtime}"
FRONTEND_FAST_GROUP_TIMINGS_JSONL="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSONL:-}"
FRONTEND_FAST_GROUP_TIMINGS_JSON="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSON:-}"

NowEpochMs() {
    "${FSUSBLOG_NODE:-node}" -e 'process.stdout.write(String(Date.now()))'
}

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
BACKEND_ORDINARY_TEST_FILTER="${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-Category!=Integration&Category!=ApiIntegration&Category!=Concurrency&Category!=Performance&Category!=Property&Category!=GoldenContract&Category!=SecurityStateMachine&Fixture!=LocalRedis}"

DefaultPlaywrightWorkers() {
    if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
        printf '1'
    else
        node "$ROOT_DIR/tools/test/resolve-playwright-workers.mjs" default
    fi
}

ConfigurePlaywrightWorkers() {
    local profile="$1"
    local envName="$2"
    local current="${!envName-}"

    if [[ -z "$current" ]]; then
        current="$(node "$ROOT_DIR/tools/test/resolve-playwright-workers.mjs" "$profile")"
        export "$envName=$current"
    fi

    Log "playwright workers: profile=$profile $envName=$current"
}

RecordVisualGateSkip() {
    local reason="${FSUSBLOG_VISUAL_SKIP_REASON:-}"
    local approver="${FSUSBLOG_VISUAL_SKIP_APPROVER:-}"
    local impact="${FSUSBLOG_VISUAL_SKIP_IMPACT:-}"
    local rerunUrl="${FSUSBLOG_VISUAL_SKIP_RERUN_URL:-}"
    local outFile="$GATE_LOG_DIR/visual-gate-skip.json"

    if [[ -z "$reason" || -z "$approver" || -z "$impact" || -z "$rerunUrl" ]]; then
        Fail "FSUSBLOG_SKIP_VISUAL_GATE=1 requires FSUSBLOG_VISUAL_SKIP_REASON, FSUSBLOG_VISUAL_SKIP_APPROVER, FSUSBLOG_VISUAL_SKIP_IMPACT and FSUSBLOG_VISUAL_SKIP_RERUN_URL"
    fi

    mkdir -p "$GATE_LOG_DIR"
    node - "$outFile" <<'NODE'
const fs = require('node:fs');
const outFile = process.argv[2];
const rerunUrl = process.env.FSUSBLOG_VISUAL_SKIP_RERUN_URL || '';
const diagnostic = process.env.FSUSBLOG_BROWSER_DIAGNOSTICS === '1'
  || process.env.MATRIX_JOB === 'browser-diagnostics';
if (!/^https?:\/\/\S+$/.test(rerunUrl)) {
  console.error('[test:production] FSUSBLOG_VISUAL_SKIP_RERUN_URL must be an absolute http(s) URL');
  process.exit(1);
}

const evidence = {
  schema: 'fsusblog.visual-gate-skip.v1',
  status: 'visual-gate-skipped',
  evidenceClass: diagnostic ? 'diagnostic' : 'correctness',
  affectsCorrectness: !diagnostic,
  executionBoundary: diagnostic ? 'real-browser-screenshot-diagnostics' : 'release-correctness-gate',
  generatedAt: new Date().toISOString(),
  reason: process.env.FSUSBLOG_VISUAL_SKIP_REASON,
  approver: process.env.FSUSBLOG_VISUAL_SKIP_APPROVER,
  impact: process.env.FSUSBLOG_VISUAL_SKIP_IMPACT,
  rerunUrl
};
fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
NODE
    Log "tier=visual | skip evidence: $outFile"
}

WriteVisualPlaywrightSkipEvidence() {
    local group="$1"
    local outputDir="$CLIENT_DIR/test-results/playwright/visual-$group"
    local outputFile="$outputDir/skip.json"
    mkdir -p "$outputDir"
    node - "$outputFile" "$group" <<'NODE'
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

PrintArtifactHint() {
    printf '[test:%s] diagnostics: .tmp/acceptance/*.log and src/frontend/test-results/playwright are preserved when present\n' "${CURRENT_TIER:-unknown}" >&2
}

OnError() {
    local status=$?
    printf '[test:%s] failed in stage: %s (exit %s)\n' "${CURRENT_TIER:-unknown}" "${CURRENT_STAGE:-unknown}" "$status" >&2
    PrintArtifactHint
    exit "$status"
}

trap OnError ERR

Log() {
    printf '[test:%s] %s\n' "${CURRENT_TIER:-unknown}" "$1"
}

Fail() {
    printf '[test:%s] error: %s\n' "${CURRENT_TIER:-unknown}" "$1" >&2
    PrintArtifactHint
    exit 1
}

ConfigureDotnetBuildParallelism() {
    local raw="${FSUSBLOG_DOTNET_BUILD_PARALLELISM:-dynamic}"
    raw="${raw//[[:space:]]/}"
    local normalized="${raw,,}"
    local mode
    local msbuildArg

    case "$normalized" in
        "" | dynamic)
            mode="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-dotnet-build-parallelism.mjs")" || return $?
            msbuildArg="/m:$mode"
            ;;
        safe | single | 1)
            mode="safe"
            msbuildArg="/m:1"
            ;;
        auto)
            mode="auto"
            msbuildArg="/m"
            ;;
        *)
            if [[ "$normalized" =~ ^[0-9]+$ ]] && ((10#$normalized > 1)); then
                mode="$((10#$normalized))"
                msbuildArg="/m:$mode"
            else
                Fail "FSUSBLOG_DOTNET_BUILD_PARALLELISM must be dynamic, safe, 1, auto, or an integer greater than 1 (got '$raw')"
            fi
            ;;
    esac

    DOTNET_BUILD_PARALLEL_ARGS=("$msbuildArg" "${DOTNET_BUILD_SHARED_ARGS[@]}")
    Log "dotnet-build parallelism=$mode arg=$msbuildArg"
}

NamespaceSlug() {
    local slug
    slug="$(printf '%s' "${1:-local}" | tr -c 'A-Za-z0-9_.-' '-')"
    if [[ -z "$slug" || "$slug" == "." || "$slug" == ".." ]]; then
        slug='local'
    fi
    printf '%s' "$slug"
}

RequireBootstrappedNamespace() {
    local namespace="${FSUSBLOG_TEST_NAMESPACE:-local}"
    local slug
    slug="$(NamespaceSlug "$namespace")"
    local envFile="$ROOT_DIR/.tmp/env/$slug.env"

    if [[ ! -f "$envFile" ]]; then
        Fail "bootstrap env missing for namespace '$namespace' ($envFile); run bootstrap in the same FSUSBLOG_TEST_NAMESPACE"
    fi

    local recordedNamespace
    recordedNamespace="$(awk -F= '$1 == "FSUSBLOG_TEST_NAMESPACE" {print $2; exit}' "$envFile")"
    local recordedSlug
    recordedSlug="$(NamespaceSlug "$recordedNamespace")"

    if [[ -z "$recordedNamespace" || "$recordedSlug" != "$slug" ]]; then
        Fail "bootstrap namespace mismatch: current='$namespace' env_file='$recordedNamespace' ($envFile)"
    fi

    local line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
        key="${line%%=*}"
        value="${line#*=}"
        if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
            export "$key=$value"
        fi
    done <"$envFile"

    DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-$DEBUG_FRONTEND_URL}"
    DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-$DEBUG_BACKEND_URL}"
    RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-$RELEASE_PREVIEW_URL}"
    export FSUSBLOG_PG_CONTAINER="${FSUSBLOG_PG_CONTAINER:-${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}}"
    export FSUSBLOG_REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER:-${FSUSBLOG_REDIS_CONTAINER_NAME:-}}"
}

ConfigurePlaywrightShard() {
    local lane="$1"
    local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
    local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

    if [[ -z "$index" && -z "$total" ]]; then
        export PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/$lane}"
        Log "playwright unsharded output=$PLAYWRIGHT_OUTPUT_DIR"
        return
    fi
    if [[ ! "$index" =~ ^[0-9]+$ || ! "$total" =~ ^[0-9]+$ ]]; then
        Fail "invalid Playwright shard: index='${index:-}' total='${total:-}'"
    fi
    if ((index < 1 || total < 1 || index > total)); then
        Fail "invalid Playwright shard: index='$index' total='$total'"
    fi

    export FSUSBLOG_PLAYWRIGHT_SHARD_ARG="--shard=${index}/${total}"
    export PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/$lane/shard-${index}-of-${total}}"
    Log "playwright shard: ${index}/${total} output=$PLAYWRIGHT_OUTPUT_DIR"
}

ConfigureVitestShard() {
    local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
    local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"

    if [[ -z "$index" && -z "$total" ]]; then
        return
    fi
    if [[ ! "$index" =~ ^[0-9]+$ || ! "$total" =~ ^[0-9]+$ ]]; then
        Fail "invalid Vitest shard: index='${index:-}' total='${total:-}'"
    fi
    if ((index < 1 || total < 1 || index > total)); then
        Fail "invalid Vitest shard: index='$index' total='$total'"
    fi

    export FSUSBLOG_VITEST_SHARD_ARG="--shard=${index}/${total}"
    Log "vitest shard: ${index}/${total}"
}

Run() {
    CURRENT_STAGE="$*"
    Log "run: $*"
    "$@"
}

RunInClient() {
    CURRENT_STAGE="(cd src/frontend && $*)"
    Log "run: (cd src/frontend && $*)"
    (
        cd "$CLIENT_DIR"
        "$@"
    )
}

RunInClientMeasurement() {
    local windowId="$1"
    local evidenceFile="$2"
    shift 2
    CURRENT_STAGE="measurement:${windowId} (cd src/frontend && $*)"
    Log "run: ${CURRENT_STAGE}"
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/performance-admission.mjs" \
        --window-id "$windowId" \
        --evidence "$evidenceFile" \
        -- \
        /usr/bin/env -C "$CLIENT_DIR" "$@"
}

TestInputFingerprint() {
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-once.mjs" fingerprint --root "$ROOT_DIR" "$@"
}

RunOnceCommand() {
    local key="$1"
    local fingerprint="$2"
    local cwd="$3"
    local requiredOutput="$4"
    shift 4
    local -a args=(
        run
        --root "$ROOT_DIR/.tmp/run-once"
        --namespace "${FSUSBLOG_TEST_NAMESPACE:-local}"
        --key "$key"
        --fingerprint "$fingerprint"
        --cwd "$cwd"
    )
    if [[ -n "$requiredOutput" && "$requiredOutput" != "-" ]]; then
        local output
        while IFS= read -r output; do
            [[ -n "$output" ]] && args+=(--require-output "$output")
        done < <(printf '%s\n' "$requiredOutput" | tr '|' '\n')
    fi
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-once.mjs" "${args[@]}" -- "$@"
}

FixtureRootPath() {
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/frontend/support/fixture-paths.mjs"
}

EnsureWasmReceiptOnce() {
    local fingerprint wasmOutput
    wasmOutput="${FSUSBLOG_FRONTEND_WASM_ROOT:-public/wasm}"
    fingerprint="$(TestInputFingerprint \
        --path src/frontend/wasm \
        --path tools/frontend/ensure-wasm.mjs \
        --path tools/frontend/install-wasm-codec-deps.sh \
        --path tools/test/lanes/_suite-support.sh \
        --path tools/frontend/wasm-build-receipt.mjs \
        --value ensure-wasm-receipt-v2)"
    RunOnceCommand \
        ensure-wasm-receipt \
        "$fingerprint" \
        "$CLIENT_DIR" \
        "$wasmOutput" \
        npm run ensure:wasm
}

# Session storage-state prep remains lane-local (not a catalog producer). Business
# auth/public/security producers run only through tools/test-fixtures/cli.mjs.
PrepareSessionFixturesOnce() {
    local fingerprint fixtureRoot workers
    fixtureRoot="$(FixtureRootPath)"
    workers="${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(DefaultPlaywrightWorkers)}"
    fingerprint="$(TestInputFingerprint \
        --path tests/frontend/fixtures/prepare-playwright-sessions.mjs \
        --path tests/frontend/support/session-fixtures.mjs \
        --path tests/frontend/support/fixture-paths.mjs \
        --path tests/frontend/support/test-session.mjs \
        --path tools/test/lanes/_suite-support.sh \
        --value "namespace=${FSUSBLOG_TEST_NAMESPACE:-local}" \
        --value "session-prefix=${FSUSBLOG_TEST_SESSION_PREFIX:-pw}" \
        --value "service-generation=${FSUSBLOG_FIXTURE_SERVICE_GENERATION:-unbootstrapped}" \
        --value "playwright-workers=$workers" \
        --secret-env Jwt__SecretKey \
        --secret-env FSUSBLOG_TEST_SESSION_SECRET \
        --secret-env AnonymousCredentialIssuer__SubjectHashPepper)"
    RunOnceCommand \
        session-fixtures \
        "$fingerprint" \
        "$CLIENT_DIR" \
        "$fixtureRoot/sessions" \
        env FSUSBLOG_PLAYWRIGHT_WORKERS="$workers" \
        "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/frontend/fixtures/prepare-playwright-sessions.mjs" --workers "$workers"
}

# Unique orchestrator entry for runtime lanes (#1709 + #1710 FixtureReceipt).
InvokeLaneFixtureOrchestrator() {
    local profileId="${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:-${1:-}}"
    local profileSource="${FSUSBLOG_FIXTURE_PROFILE_SOURCE:-matrix}"
    local fixtureRoot orchestratorPlan prepareState fixtureReceipt artifactDirectory=""
    if [[ -z "$profileId" ]]; then
        Fail "lane fixture orchestrator requires sealed profile id (FSUSBLOG_SEALED_FIXTURE_PROFILE_ID)"
    fi
    if [[ -z "${FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET:-}" ]]; then
        local namespaceSlug
        namespaceSlug="$(NamespaceSlug "${FSUSBLOG_TEST_NAMESPACE:-local}")"
        export FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET="fsusblog-local-public-content-fixture-secret-${namespaceSlug}-${FSUSBLOG_TEST_RUN_ID:-local}"
    fi
    fixtureRoot="$(FixtureRootPath)"
    if [[ "$profileSource" == "matrix" && -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" &&
        ("$profileId" == "public-content-lifecycle" || "$profileId" == "runtime-cache-pagination") ]]; then
        # The retained state is the cleanup authority, not a reusable success marker.
        mkdir -p "$fixtureRoot"
        fixtureRoot="$(
            umask 077
            mktemp -d "$fixtureRoot/runtime-cache-invocation.XXXXXXXX"
        )"
        artifactDirectory="$fixtureRoot/artifacts"
        export FSUSBLOG_FIXTURE_ROOT="$fixtureRoot"
        export FSUSBLOG_PUBLIC_ID_PROJECTION_FILE="$fixtureRoot/public-content-projection.json"
    fi
    orchestratorPlan="$fixtureRoot/orchestrator-plan.json"
    prepareState="$fixtureRoot/prepare-state.json"
    fixtureReceipt="$fixtureRoot/fixture-receipt.json"
    local -a runArgs=(
        "$ROOT_DIR/tools/test-fixtures/cli.mjs" run
        --profile "$profileId"
        --source "$profileSource"
        --plan-out "$orchestratorPlan"
        --prepare-state "$prepareState"
        --private-carrier-dir "$fixtureRoot/auth-private-carriers"
        --namespace "${FSUSBLOG_TEST_NAMESPACE:-}"
        --run-id "${FSUSBLOG_TEST_RUN_ID:-}"
        --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?fixture source commit is required}"
        --source-fingerprint "sha256:${FSUSBLOG_TEST_SOURCE_FINGERPRINT#sha256:}"
        --service-generation "sha256:${FSUSBLOG_FIXTURE_SERVICE_GENERATION#sha256:}"
        --base-url "${FSUSBLOG_BASE_URL:-${DEBUG_BACKEND_URL:-}}"
        --debug-backend-url "${FSUSBLOG_DEBUG_BACKEND_URL:-${DEBUG_BACKEND_URL:-}}"
        --frontend-url "${PLAYWRIGHT_BASE_URL:-${DEBUG_FRONTEND_URL:-}}"
        --pg-container "${FSUSBLOG_PG_CONTAINER:-}"
        --redis-container "${FSUSBLOG_REDIS_CONTAINER:-${FSUSBLOG_REDIS_CONTAINER_NAME:-}}"
    )
    if [[ -n "$artifactDirectory" ]]; then
        runArgs+=(--artifact-dir "$artifactDirectory"
            --artifact-consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID")
    fi
    if [[ -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" ]]; then
        runArgs+=(--runtime-cache-consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID"
            --runtime-cache-input-dir "$fixtureRoot/runtime-cache-inputs/${FSUSBLOG_TEST_RUN_ID:?}"
            --public-projection "$fixtureRoot/public-content-projection.json")
    fi
    if [[ "$profileId" == "none" || "$profileId" == "comments-moderation" || "$profileId" == "auth-basic" || "$profileId" == "public-content-lifecycle" || "$profileId" == "runtime-cache-pagination" ]]; then
        runArgs+=(--fixture-receipt "$fixtureReceipt")
    else
        # Honest partial: unrelated incomplete profiles remain prepare-state only.
        runArgs+=(--skip-verify)
    fi
    if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
        runArgs+=(--execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
    fi
    if [[ "$profileSource" == "matrix" ]]; then
        runArgs+=(
            --sealed-profile-id "${FSUSBLOG_SEALED_FIXTURE_PROFILE_ID:?}"
            --sealed-catalog-digest "${FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST:?}"
            --sealed-capability-digest "${FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST:?}"
        )
        if [[ -n "${FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS:-}" ]]; then
            runArgs+=(--sealed-execution-class "$FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS")
        fi
    fi
    Log "lane fixture orchestrator profile=${profileId} source=${profileSource}"
    if [[ -n "$artifactDirectory" ]]; then
        Log "owned fixture recovery state: ${prepareState}"
    fi
    "${FSUSBLOG_NODE:-node}" "${runArgs[@]}"
    if [[ "$profileSource" == "matrix" && ("$profileId" == "public-content-lifecycle" || "$profileId" == "runtime-cache-pagination") ]]; then
        export FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR="$fixtureRoot/runtime-cache-inputs/${FSUSBLOG_TEST_RUN_ID:?}"
        local -a prerequisiteArgs=()
        if [[ -n "${FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID:-}" &&
            "${FSUSBLOG_SEALED_FIXTURE_PREREQUISITES:-[]}" != "[]" ]]; then
            prerequisiteArgs+=(--prerequisite-inputs "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR/prerequisite-inputs.json")
        fi
        if [[ -n "$artifactDirectory" ]]; then
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" \
                project-runtime-cache-input --receipt "$fixtureReceipt" \
                --prepare-state "$prepareState" --public-projection "$fixtureRoot/public-content-projection.json" \
                --consumer-id "$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID" \
                --out "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR/$FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID.json" \
                "${prerequisiteArgs[@]}"
        else
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-fixtures/cli.mjs" \
                project-runtime-cache-profile-inputs --receipt "$fixtureReceipt" \
                --prepare-state "$prepareState" --public-projection "$fixtureRoot/public-content-projection.json" \
                --out-dir "$FSUSBLOG_RUNTIME_CACHE_FIXTURE_INPUT_DIR" "${prerequisiteArgs[@]}"
        fi
    fi
    if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
        PrepareSessionFixturesOnce
    fi
}

RunVitestScript() {
    local script="$1"
    if [[ -n "${FSUSBLOG_VITEST_SHARD_ARG:-}" ]]; then
        RunInClient npm run "$script" -- "$FSUSBLOG_VITEST_SHARD_ARG"
    else
        RunInClient npm run "$script"
    fi
}

RunVitestScriptUnsharded() {
    local script="$1"
    RunInClient npm run "$script"
}

ConfigureVisualPlaywrightLane() {
    local lane="$1"
    local index="${FSUSBLOG_TEST_SHARD_INDEX:-}"
    local total="${FSUSBLOG_TEST_SHARD_TOTAL:-}"
    local diagnosticsRoot="${FSUSBLOG_DIAGNOSTIC_ARTIFACT_ROOT:-}"

    if [[ -z "$index" && -z "$total" ]]; then
        unset FSUSBLOG_PLAYWRIGHT_SHARD_ARG
        if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" == "1" && -n "$diagnosticsRoot" ]]; then
            export PLAYWRIGHT_OUTPUT_DIR="$diagnosticsRoot/playwright/$lane"
        else
            export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$lane"
        fi
        return
    fi

    if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" == "1" && -n "$diagnosticsRoot" ]]; then
        export PLAYWRIGHT_OUTPUT_DIR="$diagnosticsRoot/playwright/$lane/shard-${index}-of-${total}"
    else
        export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$lane/shard-${index}-of-${total}"
    fi
    ConfigurePlaywrightShard "$lane"
}

WriteVisualGroupSummary() {
    local group="$1"
    local status="$2"
    local durationMs="$3"
    local outputDir="${PLAYWRIGHT_OUTPUT_DIR:-}"
    local shardArg="${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-}"
    local outFile="$ROOT_DIR/.tmp/visual/$group/summary.json"

    mkdir -p "$(dirname "$outFile")"
    node - "$outFile" "$group" "$status" "$durationMs" "$outputDir" "$shardArg" <<'NODE'
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

RunVisualGroupCheck() {
    local group="$1"
    shift
    local startedMs
    startedMs="$(NowEpochMs)"
    Log "visual screenshot group start: $group"

    set +e
    RunInClient "$@"
    local status=$?
    set -e

    local finishedMs durationMs state
    finishedMs="$(NowEpochMs)"
    durationMs=$((finishedMs - startedMs))
    if ((status == 0)); then
        state="success"
    else
        state="failure"
    fi
    WriteVisualGroupSummary "$group" "$state" "$durationMs"

    if ((status != 0)); then
        Fail "visual screenshot group failed: $group (exit $status)"
    fi
    Log "visual screenshot group done: $group (${durationMs}ms)"
}

PrepareFrontendFastGroupTimings() {
    local timingScope
    timingScope="${FSUSBLOG_FRONTEND_FAST_TIMING_SCOPE:-${CURRENT_TIER:-frontend-fast}}"
    timingScope="$(printf '%s' "$timingScope" | tr -cs 'A-Za-z0-9_.-' '-' | sed -E 's/^-+|-+$//g')"
    [[ -n "$timingScope" && "$timingScope" != "." && "$timingScope" != ".." ]] || timingScope="frontend-fast"
    FRONTEND_FAST_GROUP_TIMINGS_JSONL="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSONL:-$FRONTEND_OUTPUT_ROOT/timings/$timingScope.jsonl}"
    FRONTEND_FAST_GROUP_TIMINGS_JSON="${FSUSBLOG_FRONTEND_FAST_GROUP_TIMINGS_JSON:-$FRONTEND_OUTPUT_ROOT/timings/$timingScope.json}"
    mkdir -p "$(dirname "$FRONTEND_FAST_GROUP_TIMINGS_JSONL")"
    : >"$FRONTEND_FAST_GROUP_TIMINGS_JSONL"
    rm -f "$FRONTEND_FAST_GROUP_TIMINGS_JSON"
}

RecordFrontendFastGroupTiming() {
    local group="$1"
    local status="$2"
    local durationMs="$3"
    printf '{"group":"%s","status":"%s","durationMs":%s}\n' "$group" "$status" "$durationMs" >>"$FRONTEND_FAST_GROUP_TIMINGS_JSONL"
}

WriteFrontendFastGroupSummary() {
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

RunFrontendFastGroup() {
    local group="$1"
    shift
    local startedMs
    startedMs="$(NowEpochMs)"
    Log "frontend-fast group start: $group"

    set +e
    "$@"
    local status=$?
    set -e

    local finishedMs durationMs state
    finishedMs="$(NowEpochMs)"
    durationMs=$((finishedMs - startedMs))
    if ((status == 0)); then
        state="success"
    else
        state="failure"
    fi
    RecordFrontendFastGroupTiming "$group" "$state" "$durationMs"

    if ((status != 0)); then
        Fail "frontend-fast group failed: $group (exit $status)"
    fi
    Log "frontend-fast group done: $group (${durationMs}ms)"
}

ResolveParallelWorkers() {
    local jobCount="$1"
    if [[ -z "${FSUSBLOG_STEP_CPU_BUDGET:-}" &&
        -z "${FSUSBLOG_STEP_MEMORY_GIB:-}" &&
        -z "${FSUSBLOG_BUNDLE_CPU_UNITS:-}" &&
        -z "${FSUSBLOG_BUNDLE_CPU_BUDGET:-}" &&
        -z "${FSUSBLOG_BUNDLE_MEMORY_GIB:-}" ]]; then
        printf '%s' "$jobCount"
        return 0
    fi

    FSUSBLOG_COMMAND_MANIFEST_WORKERS="$jobCount" \
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

ResolveParallelChildEnvironment() {
    local activeWorkers="$1"
    FSUSBLOG_PARALLEL_ACTIVE_WORKERS="$activeWorkers" \
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

CleanupTestParallelChildren() {
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

CleanupTestParallelSignal() {
    CleanupTestParallelChildren "$@"
    exit 130
}

CleanupTestParallelReturn() {
    local returnStatus="$1"
    shift
    CleanupTestParallelChildren "$@"
    trap - RETURN INT TERM
    return "$returnStatus"
}

RunParallel() {
    local group="$1"
    shift
    local -a specs=("$@")
    local -a pids=()
    local -a statusFiles=()
    local statusDir
    statusDir="$ROOT_DIR/.tmp/parallel-status/$(NamespaceSlug "$group")-$$-$RANDOM"
    local total="${#specs[@]}"
    local workerCap
    workerCap="$(ResolveParallelWorkers "$total")"
    local grantFile="${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE:-}"
    local adaptiveParallel="${FSUSBLOG_ADAPTIVE_PARALLEL:-0}"
    if [[ -n "$grantFile" ]]; then adaptiveParallel=1; fi
    local executionMode='fixed'
    if [[ "$adaptiveParallel" == "1" ]]; then executionMode='live-grant'; fi
    local grantSignature=""
    if [[ "$adaptiveParallel" == "1" && -n "$grantFile" ]]; then
        grantSignature="$(stat -c '%y:%s' "$grantFile" 2>/dev/null || printf 'missing')"
    fi
    mkdir -p "$statusDir"
    trap 'CleanupTestParallelSignal "$statusDir" "${pids[@]:-}"' INT TERM
    trap 'CleanupTestParallelReturn "$?" "$statusDir" "${pids[@]:-}"' RETURN

    CURRENT_STAGE="$group"
    Log "parallel group start: $group ($total jobs, workers=$workerCap, executionMode=$executionMode)"

    local index
    for ((index = 0; index < total; index += 1)); do
        local spec="${specs[$index]}"
        local label="${spec%%::*}"
        local statusFile
        statusFile="$statusDir/$index-$(NamespaceSlug "$label").status"
        statusFiles+=("$statusFile")
    done

    local next=0
    local completed=0
    local active=0
    local -a observed=()
    local refreshCapacity=0
    while ((completed < total)); do
        if [[ "$adaptiveParallel" == "1" ]]; then
            local currentGrantSignature="$grantSignature"
            if [[ -n "$grantFile" ]]; then
                currentGrantSignature="$(stat -c '%y:%s' "$grantFile" 2>/dev/null || printf 'missing')"
            fi
            if ((refreshCapacity == 1)) || [[ "$currentGrantSignature" != "$grantSignature" ]]; then
                local previousWorkerCap="$workerCap"
                workerCap="$(ResolveParallelWorkers "$total")"
                grantSignature="$currentGrantSignature"
                refreshCapacity=0
                if [[ "$workerCap" != "$previousWorkerCap" ]]; then
                    Log "parallel group capacity update: $group (workers=$previousWorkerCap->$workerCap active=$active)"
                fi
            fi
        fi
        local childEnvironment=""
        if ((next < total && active < workerCap)); then
            local plannedActive=$((active + total - next))
            if ((plannedActive > workerCap)); then plannedActive="$workerCap"; fi
            childEnvironment="$(ResolveParallelChildEnvironment "$plannedActive")"
        fi
        while ((next < total && active < workerCap)); do
            local spec="${specs[$next]}"
            local label="${spec%%::*}"
            local command="${spec#*::}"
            local statusFile="${statusFiles[$next]}"
            (
                set +e
                while IFS='=' read -r key value; do
                    [[ -n "$key" ]] && export "$key=$value"
                done <<<"$childEnvironment"
                CURRENT_STAGE="$group/$label"
                local childStartedMs
                childStartedMs="$(NowEpochMs)"
                Log "parallel start: $label"
                eval "$command"
                local childStatus=$?
                local childFinishedMs childDurationMs
                childFinishedMs="$(NowEpochMs)"
                childDurationMs=$((childFinishedMs - childStartedMs))
                if ((childStatus == 0)); then
                    Log "parallel done: $label (${childDurationMs}ms)"
                else
                    Log "parallel failed: $label (exit $childStatus, ${childDurationMs}ms)"
                fi
                local pendingStatus="${statusFile}.pending-$BASHPID"
                printf '%s\t%s\t%s\n' "$childStatus" "$label" "$childDurationMs" >"$pendingStatus"
                mv "$pendingStatus" "$statusFile"
                exit "$childStatus"
            ) &
            pids+=("$!")
            observed+=(0)
            next=$((next + 1))
            active=$((active + 1))
        done

        local progressed=0
        for ((index = 0; index < next; index += 1)); do
            if [[ "${observed[$index]:-0}" == "1" || ! -f "${statusFiles[$index]}" ]]; then
                continue
            fi
            wait "${pids[$index]}" >/dev/null 2>&1 || true
            observed[index]=1
            completed=$((completed + 1))
            active=$((active - 1))
            progressed=1
            refreshCapacity=1
        done
        if ((completed < total && progressed == 0)); then sleep 0.1; fi
    done
    for index in "${!pids[@]}"; do wait "${pids[$index]}" >/dev/null 2>&1 || true; done

    local -a failures=()
    for statusFile in "${statusFiles[@]}"; do
        local childStatus childLabel childDurationMs
        IFS=$'\t' read -r childStatus childLabel childDurationMs <"$statusFile"
        if [[ "$childStatus" != "0" ]]; then
            failures+=("${childLabel:-unknown}:$childStatus")
        fi
    done
    rm -rf "$statusDir"
    trap - RETURN INT TERM

    if ((${#failures[@]} > 0)); then
        local failureMessage="parallel group failed: $group (${failures[*]})"
        printf '[test:%s] error: %s\n' "${CURRENT_TIER:-unknown}" "$failureMessage" >&2
        PrintArtifactHint
        return 1
    fi

    Log "parallel group done: $group"
}

RUNTIME_PROBE_TIMEOUT_SECONDS=""
RuntimeProbeTimeoutSeconds() {
    local outputName="$1"
    if [[ -z "$RUNTIME_PROBE_TIMEOUT_SECONDS" ]]; then
        RUNTIME_PROBE_TIMEOUT_SECONDS="$(
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tests/frontend/support/runtime-browser-timeout.mjs"
        )"
    fi
    if [[ ! "$RUNTIME_PROBE_TIMEOUT_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        Fail "machine-adaptive runtime probe timeout is invalid: '$RUNTIME_PROBE_TIMEOUT_SECONDS'"
    fi
    printf -v "$outputName" '%s' "$RUNTIME_PROBE_TIMEOUT_SECONDS"
}

RetryableRuntimeProbeStatus() {
    case "$1" in
        408 | 425 | 429 | 500 | 502 | 503 | 504) return 0 ;;
        *) return 1 ;;
    esac
}

ProbeHttpUntilReady() {
    local label="$1"
    local url="$2"
    local acceptHeader="${3:-}"
    local timeoutSeconds
    local timeoutMs
    local startedAtMs
    local deadlineAtMs
    local nowMs
    local remainingMs
    local attemptTimeoutSeconds
    local httpStatus
    local curlStatus
    local observation
    local observations=""
    local attempts=0
    local -a curlHeaders=()

    RuntimeProbeTimeoutSeconds timeoutSeconds
    timeoutMs="$(awk -v seconds="$timeoutSeconds" 'BEGIN { value = int(seconds * 1000); if (value < 1) value = 1; printf "%d", value }')"
    startedAtMs="$(NowEpochMs)"
    deadlineAtMs=$((startedAtMs + timeoutMs))
    if [[ -n "$acceptHeader" ]]; then
        curlHeaders=(-H "Accept: $acceptHeader")
    fi

    while true; do
        nowMs="$(NowEpochMs)"
        if ((nowMs >= deadlineAtMs)); then
            break
        fi
        remainingMs=$((deadlineAtMs - nowMs))
        attemptTimeoutSeconds="$(awk -v remaining_ms="$remainingMs" 'BEGIN { value = remaining_ms / 1000; if (value < 0.05) value = 0.05; printf "%.3f", value }')"
        attempts=$((attempts + 1))
        curlStatus=0
        if httpStatus="$(curl -sS --max-time "$attemptTimeoutSeconds" ${curlHeaders[@]+"${curlHeaders[@]}"} -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"; then
            :
        else
            curlStatus=$?
        fi

        if [[ "$httpStatus" =~ ^[0-9]{3}$ ]] && ((10#$httpStatus >= 200 && 10#$httpStatus < 400)); then
            if ((attempts > 1)); then
                Log "$label recovered at $url attempts=$attempts observed=${observations:-none}"
            fi
            return 0
        fi

        if ((curlStatus != 0)); then
            observation="curl-$curlStatus"
        elif [[ "$httpStatus" =~ ^[0-9]{3}$ ]]; then
            observation="http-$httpStatus"
        else
            observation="invalid-status"
        fi
        if [[ -z "$observations" ]]; then
            observations="$observation"
        elif [[ "$observations" != *"$observation"* ]]; then
            observations="$observations,$observation"
        fi

        if ((curlStatus == 0)) && ! RetryableRuntimeProbeStatus "$httpStatus"; then
            Fail "$label returned terminal HTTP $httpStatus at $url observed=${observations:-none}"
        fi

        nowMs="$(NowEpochMs)"
        if ((nowMs < deadlineAtMs)); then
            sleep 0.25
        fi
    done

    Fail "$label did not become ready at $url within ${timeoutSeconds}s attempts=$attempts observed=${observations:-none}"
}

ProbeUrl() {
    ProbeHttpUntilReady "$1" "$2"
}

ProbeBinaryUrl() {
    ProbeHttpUntilReady "$1" "$2" 'application/octet-stream'
}

RequireDebugStack() {
    RequireBootstrappedNamespace
    Log "require debug services: frontend=$DEBUG_FRONTEND_URL backend=$DEBUG_BACKEND_URL"
    ProbeUrl "debug frontend" "$DEBUG_FRONTEND_URL/"
    ProbeBinaryUrl "debug backend" "$DEBUG_BACKEND_URL/api/binary/system/seo"
}

RequireReleasePreview() {
    RequireBootstrappedNamespace
    Log "require release preview: $RELEASE_PREVIEW_URL"
    ProbeUrl "release preview" "$RELEASE_PREVIEW_URL/"
}

CurrentPowDifficulty() {
    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" node --input-type=module -e "import { fetchChallenge } from './tests/frontend/support/auth-helpers.mjs'; const challenge = await fetchChallenge(5000); console.log(challenge.difficulty ?? challenge.Difficulty ?? 999);"
    )
}

WaitForPowReady() {
    local label="${1:-pow}"
    local maxDifficulty="$POW_READY_MAX_DIFFICULTY"
    local difficulty=""

    for ((i = 0; i < 30; i += 1)); do
        difficulty="$(CurrentPowDifficulty 2>/dev/null || true)"
        if [[ "$difficulty" =~ ^[0-9]+$ ]] && ((difficulty <= maxDifficulty)); then
            Log "${label}: pow difficulty ready: ${difficulty}"
            return 0
        fi

        sleep 1
    done

    Fail "${label}: pow difficulty did not settle below ${maxDifficulty}; last=${difficulty:-unknown}"
}

RunTier() {
    local tier="$1"
    shift
    CURRENT_TIER="$tier"
    CURRENT_STAGE="$tier"
    "$@"
}

BootstrapAcceptanceEnv() {
    Run "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
    RequireBootstrappedNamespace
}

RunBackendBuildGovernanceLane() {
    RunBackendGovernanceChecks
    EnsureBackendFilteredBuild
    WriteBackendSplitSummary backend-build-governance governance-and-debug-build
}

BackendPlatformPlanFile() {
    local lane
    lane="$(NamespaceSlug "${1:-backend}")"
    printf '%s/.tmp/%s/platform-membership-plan.json' "$ROOT_DIR" "$lane"
}

BackendPlatformOutcomeFile() {
    local lane
    lane="$(NamespaceSlug "${1:-backend}")"
    printf '%s/.tmp/%s/platform-membership-outcome.json' "$ROOT_DIR" "$lane"
}

PrepareBackendPlatformPlan() {
    local lane="$1"
    local baseFilter="$2"
    local configuration outputDirectory testAssembly diagnosticRoot planFile runtimePlatform
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/perception-redis-producer.mjs" --ordinary-plan \
        --lane "$lane" --filter "$baseFilter" \
        --run-id "${FSUSBLOG_TEST_RUN_ID:-ordinary-$$}" \
        --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}" \
        --source-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-$(node --input-type=module -e 'const { snapshotGitWorktree } = await import(process.argv[1] + "/tools/test-matrix/scheduler.mjs"); process.stdout.write((await snapshotGitWorktree(process.argv[1])).fingerprint)' "$ROOT_DIR")}" \
        --output "$ROOT_DIR/.tmp/$lane/local-redis-membership-plan.json" || return $?
    # Conditional callers suppress Bash errexit throughout this function.
    # Propagate each preparation failure before any discovery or execution.
    configuration="$(BackendTestConfiguration)" || return $?
    EnsureBackendFilteredBuild || return $?
    outputDirectory="$(BackendTestRuntimeOutputDirectory)" || return $?
    testAssembly="$outputDirectory/FsusBlog.Server.Tests.dll"
    diagnosticRoot="$ROOT_DIR/.tmp/$lane/platform-discovery"
    planFile="$(BackendPlatformPlanFile "$lane")" || return $?
    runtimePlatform="$("${FSUSBLOG_NODE:-node}" -p 'process.platform')" || return $?
    rm -rf "$diagnosticRoot" || return $?
    rm -f "$planFile" "$(BackendPlatformOutcomeFile "$lane")" || return $?
    mkdir -p "$diagnosticRoot" || return $?
    Log "backend platform discovery: lane=$lane platform=$runtimePlatform"
    "$BUILD_ENV_RUNNER" dotnet vstest "$testAssembly" \
        --ListTests \
        "--TestCaseFilter:$baseFilter" \
        "--Diag:$diagnosticRoot/union.txt" \
        >"$diagnosticRoot/stdout.txt" || return $?
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/backend-platform-selection.mjs" plan \
        --platform "$runtimePlatform" \
        --base "$baseFilter" \
        --lane "$lane" \
        --diagnostic-root "$diagnosticRoot" \
        --source "$testAssembly" \
        --out "$planFile" || return $?
}

FinalizeBackendPlatformOutcome() {
    local lane="$1"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/backend-platform-selection.mjs" outcome \
        --plan "$(BackendPlatformPlanFile "$lane")" \
        --trx "$(BackendTrxFile "$lane")" \
        --out "$(BackendPlatformOutcomeFile "$lane")"
}

RunBoundedWarningOnlySourceMutation() (
    # Explicit development operation only; no ordinary or mutation lane invokes it.
    # Expected identity comes from the caller, separately from invocation metadata.
    local expectedCommit="${1:?expected current commit required}" expectedFingerprint="${2:?expected fingerprint required}"
    local expectedRunId="${3:?expected run ID required}" purpose="${4:?explicit purpose required}"
    local parentCommit="$expectedCommit" ownerPid="$BASHPID"
    [[ "$purpose" == development ]] || { Log 'physical helper is development-only; canonical routing is not admitted'; return 2; }
    parentCommit="${FSUSBLOG_BOUNDED_MUTATION_PARENT_COMMIT:-$expectedCommit}"
    local workRoot="${FSUSBLOG_BOUNDED_MUTATION_WORK_ROOT:-$ROOT_DIR/.tmp/bounded-warning-only-development}"
    local availableKb evidenceRoot activeGroup="" activeLauncher="" variant stage status
    local oracle='FsusBlog.Server.Tests.Unit.AdminAuditDurableAdmissionIssue2040Tests.PersistentReplayFailure_BlocksRealAdminParticipantHealthAndQualification'
    local sourcePath='src/backend/Infrastructure/Audit/AdminAuditLogChannel.cs'
    [[ "$parentCommit" =~ ^[a-f0-9]{40}$ ]] || return 2
    mkdir -p "$workRoot"
    availableKb="$(df -Pk "$workRoot" | awk 'END {print $4}')"
    # Fail before archives/builds on the near-full source volume.
    if [[ ! "$availableKb" =~ ^[0-9]+$ ]] || ((availableKb < 12582912)); then
        Log "physical warning-only mutation requires 12GiB available in $workRoot"
        return 2
    fi
    [[ "$(uname -s)" == Linux ]] || { Log 'physical mutation requires isolated Linux process/cgroup ownership'; return 2; }
    command -v setsid >/dev/null || return 2
    evidenceRoot="$(mktemp -d "$workRoot/warning-only-source-mutation.XXXXXX")"
    Log "physical warning-only evidence=$evidenceRoot parent=$parentCommit"
    trap 'if [[ -n "$activeGroup" ]]; then kill -TERM -- "-$activeGroup" 2>/dev/null || true; elif [[ -n "$activeLauncher" ]]; then kill -TERM "$activeLauncher" 2>/dev/null || true; fi; if [[ -n "$activeLauncher" ]]; then wait "$activeLauncher" 2>/dev/null || true; fi' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [[ -n "${FSUSBLOG_BOUNDED_MUTATION_PARENT_INPUTS:-}" ]]; then
        cp "${FSUSBLOG_BOUNDED_MUTATION_PARENT_INPUTS}/parent."{commit,index,tar} "$evidenceRoot/"
    else
        git -C "$ROOT_DIR" cat-file commit "$parentCommit" >"$evidenceRoot/parent.commit"
        git -C "$ROOT_DIR" ls-tree -rz "$parentCommit" >"$evidenceRoot/parent.index"
        git -C "$ROOT_DIR" archive --format=tar "$parentCommit" >"$evidenceRoot/parent.tar"
    fi
    for variant in baseline mutant; do
        mkdir "$evidenceRoot/$variant"
        tar -xf "$evidenceRoot/parent.tar" -C "$evidenceRoot/$variant"
    done
    # Only the disposable mutant is changed. The current product and oracle stay frozen.
    perl -0pi -e 's/await store\.WriteBatchAsync\(audits, cancellationToken\)\.ConfigureAwait\(false\);/cancellationToken.ThrowIfCancellationRequested();\n                _logger.LogWarning("admin-audit mutation omitted required store write. StoreType={StoreType}", store.GetType().Name);/g' \
        "$evidenceRoot/mutant/$sourcePath"
    status=0
    (cd "$evidenceRoot" && git diff --no-index --binary --full-index --no-ext-diff --no-textconv --no-renames \
        "baseline/$sourcePath" "mutant/$sourcePath") >"$evidenceRoot/mutation.patch" || status=$?
    [[ "$status" == 1 ]] || return 2
    cp /sys/fs/cgroup/cpu.max "$evidenceRoot/cpu.max"
    cp /sys/fs/cgroup/memory.max "$evidenceRoot/memory.max"
    FSUSBLOG_REPO_ROOT="$ROOT_DIR" FSUSBLOG_MUTATION_EVIDENCE_ROOT="$evidenceRoot" FSUSBLOG_MUTATION_PARENT="$parentCommit" \
        FSUSBLOG_MUTATION_PURPOSE="$purpose" FSUSBLOG_MUTATION_OWNER_PID="$ownerPid" \
        Run "${FSUSBLOG_NODE:-node}" --input-type=module - <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const root = process.env.FSUSBLOG_REPO_ROOT;
const owners = ['tools/governance/bounded-channel-contracts.mjs', 'tests/tools/bounded-channel-contracts.test.mjs',
    'tools/test/lanes/_suite-support.sh', 'tests/matrix.yml', 'docs/testing.md',
    'tests/backend/Fixtures/backend-evidence-path-authority.generated.json'];
const source = owners.map(file => ({file, digest: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`}));
fs.writeFileSync(path.join(process.env.FSUSBLOG_MUTATION_EVIDENCE_ROOT, 'invocation.json'), JSON.stringify({
    parentCommit: process.env.FSUSBLOG_MUTATION_PARENT,
    candidateCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
    candidateFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT,
    runId: process.env.FSUSBLOG_TEST_RUN_ID,
    purpose: process.env.FSUSBLOG_MUTATION_PURPOSE,
    ownerProcessId: Number(process.env.FSUSBLOG_MUTATION_OWNER_PID),
    executionOwnerSources: source
}, null, 2), {flag: 'wx'});
NODE
    local identityArgs=(--expected-current-commit "$expectedCommit" --expected-fingerprint "$expectedFingerprint"
        --expected-run-id "$expectedRunId" --purpose "$purpose")
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/bounded-channel-contracts.mjs" \
        --physical-warning-only-proof "$evidenceRoot" "$parentCommit" "${identityArgs[@]}" \
        --inputs-only --proof-output "$evidenceRoot/inputs.json" || return $?
    for variant in baseline mutant; do
        # Independent, fresh source/obj/bin/data roots; never reuse the baseline assembly.
        for stage in restore build test; do
            local args=(dotnet "$stage" tests/backend/FsusBlog.Server.Tests.csproj --disable-build-servers -m:1
                -p:BuildInParallel=false -p:UseSharedCompilation=false -p:NuGetAudit=false)
            case "$stage" in
                restore) args+=(--locked-mode --disable-parallel) ;;
                build) args+=(--no-restore -c Debug --nologo) ;;
                test) args+=(--no-build --no-restore -c Debug --nologo --filter "FullyQualifiedName=$oracle"
                    --logger "trx;LogFileName=$variant.trx" --results-directory "$evidenceRoot") ;;
            esac
            availableKb="$(df -Pk "$evidenceRoot/$variant" | awk 'END {print $4}')"
            ((availableKb >= 4194304)) || { Log 'insufficient remaining physical mutation build capacity'; return 2; }
            printf '%s\0' "${args[@]}" >"$evidenceRoot/$variant.$stage.argv"
            date -u +%s >"$evidenceRoot/$variant.$stage.start"
            local prefix="$evidenceRoot/$variant.$stage" readyFd releaseFd readyLine
            mkfifo "$prefix.ready.pipe" "$prefix.release.pipe"
            exec {readyFd}<>"$prefix.ready.pipe"
            exec {releaseFd}<>"$prefix.release.pipe"
            (
                cd "$evidenceRoot/$variant"
                exec env FSUSBLOG_DATA_ROOT="$evidenceRoot/$variant-data" FSUSBLOG_PRODUCTION_BUILD_ROOT="" \
                    MSBUILDDISABLENODEREUSE=1 DOTNET_CLI_USE_MSBUILD_SERVER=0 DOTNET_PROCESSOR_COUNT=1 \
                    setsid --wait bash -c 'prefix="$1"; shift
ps -o pid=,ppid=,pgid=,sid= -p "$BASHPID" >"$prefix.ready"
printf '"'"'ready\n'"'"' >"$prefix.ready.pipe"
# No dotnet command may start before independently validated ownership.
IFS= read -r -t 5 release <"$prefix.release.pipe" || exit 125
[[ "$release" == release ]] || exit 125
exec "$@"
' bounded-mutation-ready \
                        "$prefix" "$evidenceRoot/$variant/tools/build-with-data-env.sh" "${args[@]}"
            ) >"$evidenceRoot/$variant.$stage.log" 2>&1 &
            activeLauncher=$!
            printf '%s\n' "$activeLauncher" >"$prefix.pid"
            IFS= read -r -t 5 -u "$readyFd" readyLine || return 2
            [[ "$readyLine" == ready ]] || return 2
            ps -eo pid,ppid,pgid,sid,state,args >"$prefix.ready-processes"
            Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/bounded-channel-contracts.mjs" \
                --physical-warning-only-ready "$prefix" "$activeLauncher" "$ownerPid" \
                --proof-output "$prefix.ready-authority.json" || return $?
            activeGroup="$("${FSUSBLOG_NODE:-node}" -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).processGroup" "$prefix.ready-authority.json")"
            printf 'release\n' >&"$releaseFd"
            exec {readyFd}>&-
            exec {releaseFd}>&-
            status=0
            wait "$activeLauncher" || status=$?
            date -u +%s >"$evidenceRoot/$variant.$stage.end"
            printf '%s\n' "$status" >"$evidenceRoot/$variant.$stage.exit"
            ps -eo pid,ppid,pgid,sid,state,args >"$evidenceRoot/$variant.$stage.processes"
            if kill -0 -- "-$activeGroup" 2>/dev/null; then
                Log "owned process group $activeGroup remains; refusing mutation proof"
                return 2
            fi
            activeGroup=""
            activeLauncher=""
            if [[ "$variant" == mutant && "$stage" == test ]]; then
                [[ "$status" == 1 ]] || return 1
            else
                [[ "$status" == 0 ]] || return "$status"
            fi
        done
    done
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/bounded-channel-contracts.mjs" \
        --physical-warning-only-proof "$evidenceRoot" "$parentCommit" "${identityArgs[@]}" --proof-output "$evidenceRoot/proof.json"
)

RunBackendBoundedServerSelection() {
    local selectionFile="${FSUSBLOG_BACKEND_UNIT_SELECTION_FILE:-}"
    local selectedFilter platformFilter assemblyFile selectionPlan status=0
    local -a selectionArgs
    if [[ -z "$selectionFile" ]]; then
        Fail 'bounded-server requires FSUSBLOG_BACKEND_UNIT_SELECTION_FILE'
    fi
    selectionArgs=(--backend-unit --server-selection "$selectionFile")
    # Resolve the explicit declaration before build/discovery/test commands.
    selectedFilter="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-migration-tests.mjs" \
        "${selectionArgs[@]}" --selection-action filter)" || return $?
    Log 'backend-unit selection=bounded-server; Migration explicitly not-selected; aggregate coverage incomplete'
    PrepareBackendPlatformPlan backend-unit "$selectedFilter" || return $?
    platformFilter="$("${FSUSBLOG_NODE:-node}" -p \
        "require('$(BackendPlatformPlanFile backend-unit)').executionFilter")" || return $?
    assemblyFile="$(BackendTestRuntimeOutputDirectory)/FsusBlog.Server.Tests.dll"
    selectionPlan="$ROOT_DIR/.tmp/backend-unit/bounded-server-selection-plan.json"
    selectionArgs+=(--diagnostic-root "$ROOT_DIR/.tmp/backend-unit/platform-discovery" \
        --source "$assemblyFile" --platform-plan "$(BackendPlatformPlanFile backend-unit)" \
        --selection-plan "$selectionPlan")
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-migration-tests.mjs" \
        "${selectionArgs[@]}" --selection-action verify || return $?
    RunBackendDotnetFilterOnly "$platformFilter" backend-unit || status=$?
    FinalizeBackendPlatformOutcome backend-unit || status=$?
    if ((status != 0)); then
        return "$status"
    fi
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-migration-tests.mjs" \
        "${selectionArgs[@]}" --selection-action outcome --trx "$(BackendTrxFile backend-unit)" \
        --out "$ROOT_DIR/.tmp/backend-unit/bounded-server-selection-outcome.json" || return $?
    # No Migration receipt, aggregate summary or integrity producer is emitted.
    # A successful bounded control run cannot satisfy the whole matrix tier.
    Log 'bounded Server controls passed; backend-unit aggregate acceptance remains unrun (exit 3)'
    return 3
}

RunBackendUnitLane() {
    case "${FSUSBLOG_TEST_SELECTION:-}" in
        '' | full | affected | bounded-server) ;;
        *) Fail 'unsupported backend-unit selection; use full, affected or bounded-server' ;;
    esac
    if [[ "${FSUSBLOG_TEST_SELECTION:-}" == bounded-server ]]; then
        RunBackendBoundedServerSelection
        return $?
    fi
    if [[ -n "${FSUSBLOG_BACKEND_UNIT_SELECTION_FILE:-}" ]]; then
        Fail 'FSUSBLOG_BACKEND_UNIT_SELECTION_FILE requires explicit bounded-server mode'
    fi
    if [[ "${FSUSBLOG_TEST_SELECTION:-}" == "affected" ]]; then
        Log "backend-unit selection=affected"
        Run "$ROOT_DIR/tools/dotnet-affected-tests.sh"
    else
        local platformFilter status=0
        Log "backend-unit selection=full reason=${FSUSBLOG_TEST_SELECTION:-unset}"
        PrepareBackendPlatformPlan backend-unit "$BACKEND_ORDINARY_TEST_FILTER"
        platformFilter="$("${FSUSBLOG_NODE:-node}" -p \
            "require('$(BackendPlatformPlanFile backend-unit)').executionFilter")"
        RunBackendDotnetFilterOnly "$platformFilter" backend-unit || status=$?
        FinalizeBackendPlatformOutcome backend-unit || status=$?
        if ((status != 0)); then
            return "$status"
        fi
    fi
    Run "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$BUILD_ENV_RUNNER" "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/build-migration-tests.mjs"
    ConfigureDotnetTestProcessors
    Run "$BUILD_ENV_RUNNER" "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-migration-tests.mjs" --backend-unit
    Run "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$BUILD_ENV_RUNNER" "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/generate-migration-assembly-receipt.mjs" --write --backend-unit
    WriteBackendSplitSummary backend-unit "${FSUSBLOG_TEST_SELECTION:-full}"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-integrity-proof-evidence.mjs" \
        --catalog "$ROOT_DIR/tests/fixtures/evidence-projection/integrity-proof-verification.json" \
        --trx "$(BackendTrxFile backend-unit)" \
        --root "$ROOT_DIR" \
        --commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required}" \
        --worktree-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required}" \
        --run-id "${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required}" \
        --namespace "${FSUSBLOG_TEST_NAMESPACE:?FSUSBLOG_TEST_NAMESPACE is required}" \
        --producer-output "$TEST_RESULTS_ROOT/backend/evidence-producers/backend-unit.json" \
        --source-output "$TEST_RESULTS_ROOT/backend/integrity-proof-source.json"
}

RunDistributedContractFastOnly() {
    local filter='FullyQualifiedName~DistributedContractFastTests|FullyQualifiedName~DistributedInvalidationBusTests|FullyQualifiedName~DistributedInvalidationTargetResolverTests|FullyQualifiedName~DistributedInvalidationLocalApplierTests|FullyQualifiedName~PublicAotBackfillLeaseTests|FullyQualifiedName~ArticleMutationProjectionCheckpointTests|FullyQualifiedName~ArticleMutationOutboxFailurePropagationTests'
    FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release \
        RunBackendDotnetFilterOnly "$filter" distributed-contract-fast
    WriteBackendSplitSummary distributed-contract-fast runtime-mode-lease-checkpoint-outbox-invalidation-bus
}

RunBackendFastSummaryLane() {
    Log "backend-fast | artifact-only summary; build/governance and unit ran in dependency tiers"
    WriteBackendSplitSummary backend-fast dependency-summary
}

RunFastBackendLane() {
    RunBackendBuildGovernanceLane
    RunBackendUnitLane
    RunBackendFastSummaryLane
}

ConfigureDotnetTestProcessors() {
    export DOTNET_PROCESSOR_COUNT
    DOTNET_PROCESSOR_COUNT="$("${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/resolve-dotnet-test-processors.mjs")" || return $?
    Log "dotnet test processor count=$DOTNET_PROCESSOR_COUNT"
}

BackendTestConfiguration() {
    local configuration="${FSUSBLOG_BACKEND_TEST_CONFIGURATION:-Debug}"
    case "$configuration" in
        Debug | Release)
            printf '%s\n' "$configuration"
            ;;
        *)
            Fail "FSUSBLOG_BACKEND_TEST_CONFIGURATION must be Debug or Release (got '$configuration')"
            ;;
    esac
}

. "$ROOT_DIR/tools/test/lanes/_backend-test-runtime-support.sh"

EnsureBackendFilteredBuild() {
    local configuration configurationSlug outputContract fingerprintVariant dotnetSdkVersion buildTarget
    local debugOutputDir releaseOutputDir debugServerOutputDir
    local -a buildCommand
    configuration="$(BackendTestConfiguration)" || return $?
    CleanupBackendTestRuntimeOutput
    configurationSlug="${configuration,,}"
    debugOutputDir="${FSUSBLOG_PRODUCTION_BUILD_ROOT:+$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0}"
    releaseOutputDir="${FSUSBLOG_PRODUCTION_BUILD_ROOT:+$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/Release/net10.0}"
    debugServerOutputDir="${FSUSBLOG_PRODUCTION_BUILD_ROOT:+$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server/bin/Debug/net10.0}"
    debugOutputDir="${debugOutputDir:-tests/backend/bin/Debug/net10.0}"
    releaseOutputDir="${releaseOutputDir:-tests/backend/bin/Release/net10.0}"
    debugServerOutputDir="${debugServerOutputDir:-src/backend/bin/Debug/net10.0}"
    if [[ "$configuration" == "Release" ]]; then
        outputContract="$releaseOutputDir"
        fingerprintVariant='backend-filtered-release-v2'
        # Keep the benchmark project outside this producer: it has its own
        # run-bound Release producer and immutable measurement input.
        buildTarget="$SERVER_TEST_PROJ"
    else
        # Directory contracts cover every runtime dependency, including the
        # managed server and MCL native asset. A partially written DLL can never
        # make another local-profile consumer bypass the run-once producer.
        outputContract="$debugOutputDir|$debugServerOutputDir"
        fingerprintVariant='backend-filtered-debug-v2'
        buildTarget="$SERVER_TEST_PROJ"
    fi
    local fingerprint
    ConfigureDotnetBuildParallelism || return $?
    dotnetSdkVersion="$(dotnet --version)" || return $?
    if [[ -n "${FSUSBLOG_TEST_SOURCE_COMMIT:-}" && -n "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" ]]; then
        # The scheduler identity is computed from versioned source state and stays
        # stable while tests write ignored runtime cache/log files under src/backend.
        # Binding both values keeps dirty worktrees and distinct commits separate
        # without turning those runtime writes into duplicate build producers.
        fingerprint="$(TestInputFingerprint \
            --path Directory.Build.props \
            --path Directory.Packages.props \
            --path FsusBlog.slnx \
            --path tools/build-with-data-env.sh \
            --path tools/test/lanes/_suite-support.sh \
            --value "$fingerprintVariant" \
            --value "dotnet-sdk=$dotnetSdkVersion" \
            --value "source-commit=${FSUSBLOG_TEST_SOURCE_COMMIT}" \
            --value "source-fingerprint=${FSUSBLOG_TEST_SOURCE_FINGERPRINT}")" || return $?
    else
        # Direct lane invocation has no scheduler snapshot, so retain a complete
        # source scan as the conservative fallback.
        fingerprint="$(TestInputFingerprint \
            --path Directory.Build.props \
            --path Directory.Packages.props \
            --path FsusBlog.slnx \
            --path src/backend \
            --path src/core \
            --path src/shared \
            --path tests/backend \
            --path benchmarks/core \
            --path tools/architecture/FsusBlog.DiLifetimeAnalyzer \
            --path tools/build-with-data-env.sh \
            --path tools/test/lanes/_suite-support.sh \
            --value "$fingerprintVariant" \
            --value "dotnet-sdk=$dotnetSdkVersion")" || return $?
    fi
    buildCommand=(
        "$BUILD_ENV_RUNNER" dotnet build "$buildTarget"
        -c "$configuration" -warnaserror -v minimal "${DOTNET_BUILD_PARALLEL_ARGS[@]}"
    )
    if [[ "$configuration" == "Release" ]]; then
        # The filtered Release producer and the benchmark producer share project
        # references and one output root. Serialize their only writer sections;
        # every downstream test/benchmark remains a --no-build reader.
        buildCommand=(
            "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh"
            "${buildCommand[@]}"
        )
    fi
    RunOnceCommand \
        "backend-filtered-build-$configurationSlug" \
        "$fingerprint" \
        "$ROOT_DIR" \
        "$outputContract" \
        "${buildCommand[@]}"
}

BackendTrxFile() {
    local lane
    lane="$(NamespaceSlug "${1:-backend}")"
    mkdir -p "$BACKEND_TRX_DIR"
    printf '%s/%s.trx' "$BACKEND_TRX_DIR" "$lane"
}

WriteBackendTrxContractDryRun() {
    local lane trxFile
    local -a lanes=("$@")
    if [[ "${#lanes[@]}" -eq 0 ]]; then
        lanes=(backend-unit backend-property coverage-backend)
    fi
    for lane in "${lanes[@]}"; do
        trxFile="$(BackendTrxFile "$lane")"
        rm -f "$trxFile"
        printf '%s\n' \
            '<?xml version="1.0" encoding="utf-8"?>' \
            '<TestRun id="00000000-0000-0000-0000-000000000001" name="backend-trx-contract-dry-run">' \
            '  <Results><UnitTestResult testName="BackendTrxContractDryRun" outcome="Passed" /></Results>' \
            '  <ResultSummary outcome="Passed"><Counters total="1" executed="1" passed="1" failed="0" /></ResultSummary>' \
            '</TestRun>' >"$trxFile"
    done
    printf '{"schema":"fsusblog.backend-trx-dry-run.v1","status":"dry-run","directory":"%s","lanes":[' "$BACKEND_TRX_DIR"
    local separator=''
    for lane in "${lanes[@]}"; do
        printf '%s"%s"' "$separator" "$(NamespaceSlug "$lane")"
        separator=','
    done
    printf ']}\n'
}

RunBackendDotnetFilterOnly() {
    local filter="$1"
    local lane="${2:-${CURRENT_TIER:-backend}}"
    local trxFile configuration
    trxFile="$(BackendTrxFile "$lane")"
    configuration="$(BackendTestConfiguration)"
    ConfigureDotnetTestProcessors
    EnsureBackendFilteredBuild
    rm -f "$trxFile"
    RunBackendDotnetTest "$lane" \
        -c "$configuration" -v minimal --no-build --no-restore \
        "${DOTNET_BUILD_SHARED_ARGS[@]}" \
        --filter "$filter" \
        --logger "trx;LogFileName=$trxFile"
}

RunBackendDotnetFilterWithCoverage() {
    local lane="$1"
    local filter="$2"
    local resultsDir="$COVERAGE_ROOT/backend/special-$lane"
    local trxFile configuration
    trxFile="$(BackendTrxFile "backend-$lane")"
    configuration="$(BackendTestConfiguration)"
    ConfigureDotnetTestProcessors
    EnsureBackendFilteredBuild
    rm -rf "$resultsDir"
    rm -f "$trxFile"
    mkdir -p "$resultsDir"
    RunBackendDotnetTest "$lane" \
        -c "$configuration" \
        -v minimal \
        --no-build \
        --no-restore \
        "${DOTNET_BUILD_SHARED_ARGS[@]}" \
        --filter "$filter" \
        --logger "trx;LogFileName=$trxFile" \
        "--collect:XPlat Code Coverage" \
        --results-directory "$resultsDir" \
        -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/coverage/backend-coverage-pipeline.mjs" \
        prepare \
        --dir "$resultsDir" \
        --shard "special-$lane"
}

RunBackendTestGovernanceCheckOnce() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
        --key backend-test-governance \
        --execution-class correctness \
        --producer-id backend-test-governance \
        --path tools/check-backend-test-governance.mjs \
        --path tools/test/backend-evidence-path-authority.mjs \
        --path tests/backend \
        --path tests/matrix.yml \
        --test-id backend-test-governance \
        -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-backend-test-governance.mjs"
}

RunPostgresTestCollectionsCheckOnce() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
        --key postgres-test-collections \
        --execution-class correctness \
        --producer-id postgres-test-collections \
        --path tools/check-postgres-test-collections.mjs \
        --path tests/backend \
        --test-id postgres-test-collections \
        -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-postgres-test-collections.mjs"
}

RunBackendSourceFileSizeCheckOnce() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
        --key backend-source-file-size \
        --execution-class correctness \
        --producer-id backend-source-file-size \
        --path tools/architecture/check-backend-source-file-size.mjs \
        --path src/backend/Infrastructure/Bootstrap \
        --path src/backend/Infrastructure/PublicReadArtifacts \
        --path src/backend/Infrastructure/SchemaMigration \
        --path src/backend/Modules/Endpoints \
        --path src/backend/Services \
        --test-id backend-source-file-size \
        -- "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-source-file-size.mjs"
}

RunBackendGovernanceChecks() {
    RunBackendSourceFileSizeCheckOnce
    RunBackendTestGovernanceCheckOnce
    RunPostgresTestCollectionsCheckOnce
}

WriteBackendSplitSummary() {
    local lane="$1"
    local selection="$2"
    local outFile="$ROOT_DIR/.tmp/$lane/summary.json"
    mkdir -p "$(dirname "$outFile")"
    node --input-type=module - "$outFile" "$lane" "$selection" "$ROOT_DIR" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const outFile = process.argv[2]
const lane = process.argv[3]
const selection = process.argv[4]
const root = process.argv[5]
let migrationExecution = null
if (['backend-unit', 'backend-fast'].includes(lane)) {
  const { readMigrationExecution, readMigrationExecutionDependency } = await import(pathToFileURL(path.join(root, 'tools/test/run-migration-tests.mjs')))
  const read = lane === 'backend-fast' ? readMigrationExecutionDependency : readMigrationExecution
  const result = await read({
    root,
    producer: 'backend-unit',
    runId: process.env.FSUSBLOG_TEST_RUN_ID,
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
    sourceState: {
      commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
      worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    }
  })
  migrationExecution = {
    receiptFile: path.relative(root, result.receiptFile).replaceAll(path.sep, '/'),
    receiptDigest: result.receipt.digest,
    project: result.summary.project,
    sourceCaseIds: result.summary.sourceCaseIds,
    executedCaseIds: result.summary.executedCaseIds
  }
}
fs.writeFileSync(outFile, `${JSON.stringify({
  schema: 'fsusblog.backend.split-lane.v1',
  lane,
  selection,
  status: 'success',
  ...(migrationExecution ? { migrationExecution } : {}),
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
NODE
}

RunBackendApiIntegrationOnly() {
    RunBackendDotnetFilterWithCoverage api-integration "Category=ApiIntegration"
    WriteBackendSplitSummary backend-api-integration "Category=ApiIntegration"
}

RunBackendAuthStateMachineOnly() {
    RunBackendDotnetFilterWithCoverage auth-state-machine "Category=SecurityStateMachine"
    WriteBackendSplitSummary backend-auth-state-machine "Category=SecurityStateMachine"
}

RunBackendConcurrencyOnly() {
    RunBackendDotnetFilterWithCoverage concurrency "Category=Concurrency"
    WriteBackendSplitSummary backend-concurrency "Category=Concurrency"
}

RunBackendPropertyOnly() {
    RunBackendDotnetFilterWithCoverage property "Category=Property"
    WriteBackendSplitSummary backend-property "Category=Property"
}

RunBackendGoldenOnly() {
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/aeds-protocol-generation.test.mjs"
    RunBackendDotnetFilterWithCoverage golden "Category=GoldenContract"
    WriteBackendSplitSummary backend-golden "Category=GoldenContract"
}

RunBackendTestGovernanceOnly() {
    RunBackendGovernanceChecks
    WriteBackendSplitSummary backend-test-governance governance
}

RunBackendPerfGovernanceOnly() {
    local -a failures=()
    RunBackendTestGovernanceCheckOnce || failures+=(backend-test-governance)
    RunPostgresTestCollectionsCheckOnce || failures+=(postgres-test-collections)
    if ((${#failures[@]} > 0)); then
        printf '[test:%s] backend performance governance failures: %s\n' \
            "${CURRENT_TIER:-backend-perf}" "${failures[*]}" >&2
        return 1
    fi
}

RunBackendPerfNativeP99Only() {
    local trxLane="${1:-backend-perf}"
    local evidenceRoot="$ROOT_DIR/.tmp/backend-perf/native-p99"
    local preflightFile="$evidenceRoot/preflight.json"
    local evidenceFile="$evidenceRoot/measurement.json"
    local summaryFile="$evidenceRoot/summary.json"
    local trxFile
    local testStatus=0
    trxFile="$(BackendTrxFile "$trxLane")"

    EnsureBackendFilteredBuild
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/native-p99-producer-contract.mjs" prepare \
        --root "$ROOT_DIR" \
        --preflight "$preflightFile" \
        --evidence "$evidenceFile" \
        --summary "$summaryFile" \
        --trx "$trxFile"
    export FSUSBLOG_NATIVE_P99_EVIDENCE_PATH="$evidenceFile"
    if RunBackendDotnetFilterOnly \
        "FullyQualifiedName=FsusBlog.Server.Tests.Unit.NativeGroth16ZkProofBackendTests.MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget" \
        "$trxLane"; then
        testStatus=0
    else
        testStatus=$?
    fi
    if ! Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/native-p99-producer-contract.mjs" verify \
        --root "$ROOT_DIR" \
        --preflight "$preflightFile" \
        --evidence "$evidenceFile" \
        --summary "$summaryFile" \
        --trx "$trxFile" \
        --test-exit-code "$testStatus"; then
        return 1
    fi
    return "$testStatus"
}

RunBackendPerfReadinessBuildOnly() {
    if [[ "${FSUSBLOG_BACKEND_PERF_READINESS_MODE:-build}" == "verify-fresh" ]]; then
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/verify-benchmark-build-ready.mjs"
        return 0
    fi
    Run "$ROOT_DIR/tools/test/ensure-benchmark-release-build.sh"
}

RunBackendMutationWithConfig() {
    local configPath="$1"
    local outputDir="$2"
    local reportName="$3"
    local workingDir="${4:-$ROOT_DIR}"
    local authorityTier="${5:-}"
    local authorityOut="${6:-}"
    local authoritySourceRoot="${7:-$ROOT_DIR}"
    local strykerTraceArgs=()
    if [[ -n "$authorityTier" || -n "$authorityOut" ]]; then
        if [[ -z "$authorityTier" || -z "$authorityOut" ]]; then
            Fail "Stryker authority requires both tier and output path"
        fi
        strykerTraceArgs=(--log-to-file --verbosity trace)
    fi
    Run rm -rf "$outputDir"
    local FSUSBLOG_MUTATION_BUILD=1
    export FSUSBLOG_MUTATION_BUILD
    Run node "$ROOT_DIR/tools/mutation/stryker-tool.mjs" run \
        --working-directory "$workingDir" \
        --attestation-output "$outputDir/tool-binding.json" \
        -- --config-file "$configPath" --output "$outputDir" "${strykerTraceArgs[@]}"
    if [[ -n "$authorityTier" || -n "$authorityOut" ]]; then
        local traceLogs=()
        mapfile -t traceLogs < <(
            find "$outputDir/logs" -maxdepth 1 -type f -name 'log-*.txt' -print | sort
        )
        if [[ "${#traceLogs[@]}" -ne 1 ]]; then
            Fail "Stryker authority requires exactly one verbose trace log, found ${#traceLogs[@]}"
        fi
        Run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" \
            "$outputDir/reports/$reportName.json" \
            --config "$configPath" \
            --tier "$authorityTier" \
            --out "$authorityOut" \
            --tool-binding "$outputDir/tool-binding.json" \
            --trace-log "${traceLogs[0]}" \
            --source-root "${authoritySourceRoot#"$ROOT_DIR"/}"
        if [[ "$authorityTier" == "release-mutation-critical-slice" ]]; then
            Run node "$ROOT_DIR/tools/test/check-mutation-inventory.mjs" \
                --authority "$authorityOut"
        fi
    else
        Run node "$ROOT_DIR/tools/test/check-stryker-report.mjs" "$outputDir/reports/$reportName.json"
    fi
}

RunBackendMutationOnly() {
    RunBackendMutationWithConfig \
        "$ROOT_DIR/config/testing/mutation/default.json" \
        "$ROOT_DIR/.tmp/mutation/backend" \
        backend-mutation
}

RunBackendMutationCriticalOnly() {
    RunBackendMutationWithConfig \
        "$ROOT_DIR/config/testing/mutation/critical.json" \
        "$ROOT_DIR/.tmp/mutation/backend-critical" \
        backend-mutation-critical \
        "$ROOT_DIR/src/core" \
        release-mutation-critical-slice \
        "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        src/core
}

RunCrossStackStaticContracts() {
    RunInClient npm run check:coherence:distribution-full
    RunInClient npm run check:coherence:notification-stream-events
    RunInClient npm run check:coherence:upload-complete
    RunInClient node ../../tests/frontend/checks/runtime/auth-state-coherence.mjs
    RunInClient npm run check:coherence:sw-cache
    RunInClient npm run check:coherence:perf
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/cross-stack-receipts.mjs" owner cross-stack-static
}

RunCrossStackRuntimeContracts() {
    RequireDebugStack
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    RunInClient npm run check:auth-zero-probe
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/cross-stack-receipts.mjs" owner cross-stack-runtime
}

RunCrossStackContractOnly() {
    local phase="${1:-static}"
    case "$phase" in
        static)
            RunCrossStackStaticContracts
            ;;
        runtime)
            RunCrossStackRuntimeContracts
            ;;
        all)
            RunCrossStackStaticContracts
            RunCrossStackRuntimeContracts
            ;;
        *)
            Fail "cross-stack-contract phase must be static, runtime, or all (got '$phase')"
            ;;
    esac
}

EnsureFrontendFsusUiBaseline() {
    local useLocalFsusUi="${FSUSBLOG_USE_LOCAL_FSUSUI:-}"
    useLocalFsusUi="${useLocalFsusUi,,}"
    if [[ "$useLocalFsusUi" == "0" ]] || [[ "$useLocalFsusUi" == "false" ]]; then
        Fail "frontend test lanes require the canonical local FsusUI baseline"
    fi
    FSUSBLOG_LOCAL_FSUSUI_ROOT="$(
        "${FSUSBLOG_NODE:-node}" "$CLIENT_DIR/scripts/fsusui-root.mjs" \
            --repository-root "$ROOT_DIR"
    )"
    export FSUSBLOG_LOCAL_FSUSUI_ROOT
    Run "${FSUSBLOG_NODE:-node}" \
        "$ROOT_DIR/tests/browser-diagnostics/local-fsusui-identity.mjs" \
        --verify
}

RunFrontendFastBuildGroup() {
    local fingerprint
    local -a fingerprintArgs=(
        --path src/frontend/index.html
        --path src/frontend/package.json
        --path src/frontend/package-lock.json
        --path src/frontend/public
        --path src/frontend/vite.config.ts
        --path src/frontend/scripts
        --path src/frontend/src
        --path tools/frontend
        --path tools/test/lanes/_suite-support.sh
        --value frontend-release-build-v2
    )
    local key value tsconfig
    for tsconfig in "$CLIENT_DIR"/tsconfig*.json; do
        [[ -f "$tsconfig" ]] || continue
        fingerprintArgs+=(--path "${tsconfig#"$ROOT_DIR/"}")
    done
    while IFS='=' read -r key value; do
        fingerprintArgs+=(--value "$key=$value")
    done < <(env | LC_ALL=C sort | awk -F= '$1 ~ /^VITE_/ {print}')
    for key in \
        FSUSBLOG_VUE_HYDRATION_DETAILS \
        FSUSBLOG_PUBLIC_SSR_BUILD \
        FSUSBLOG_USE_LOCAL_FSUSUI \
        FSUSBLOG_LOCAL_FSUSUI_ROOT; do
        fingerprintArgs+=(--value "$key=${!key:-}")
    done
    fingerprint="$(TestInputFingerprint "${fingerprintArgs[@]}")"
    local frontendDistOutput backendWebrootOutput
    frontendDistOutput="${FSUSBLOG_FRONTEND_DIST_ROOT:-dist}"
    backendWebrootOutput="${FSUSBLOG_BACKEND_WEBROOT:-../backend/wwwroot}"
    RunOnceCommand \
        frontend-release-build \
        "$fingerprint" \
        "$CLIENT_DIR" \
        "$frontendDistOutput|$backendWebrootOutput" \
        env FSUSBLOG_SKIP_ENSURE_WASM=1 FSUSBLOG_VALIDATE_GENERATED_ONLY=1 FSUSBLOG_VITE_WARN_AS_ERROR=1 npm run build:release
}

WriteFrontendSplitSummary() {
    local lane="$1"
    local outFile="$FRONTEND_OUTPUT_ROOT/${lane}.json"
    mkdir -p "$(dirname "$outFile")"
    node - "$outFile" "$lane" <<'NODE'
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

WriteRuntimeLaneSummary() {
    local lane="$1"
    local outFile="$RUNTIME_OUTPUT_ROOT/$lane.json"
    mkdir -p "$(dirname "$outFile")"
    node - "$outFile" "$lane" <<'NODE'
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

RunFrontendFastBuildLane() {
    EnsureFrontendFsusUiBaseline
    EnsureWasmReceiptOnce
    PrepareFrontendFastGroupTimings
    RunFrontendFastGroup build RunFrontendFastBuildGroup
    WriteFrontendFastGroupSummary
    WriteFrontendSplitSummary frontend-build
}

RunFrontendFastTestsGroupBody() {
    if node -e "const pkg=require(process.argv[1]); process.exit(pkg.scripts && pkg.scripts['test:unit:fast'] ? 0 : 1)" "$CLIENT_DIR/package.json"; then
        RunVitestScript test:unit:fast
    fi

}

RunFrontendFastTestsGroup() {
    RunFrontendFastGroup tests RunFrontendFastTestsGroupBody
}

RunFrontendUnitShardLane() {
    EnsureFrontendFsusUiBaseline
    ConfigureVitestShard
    PrepareFrontendFastGroupTimings
    RunFrontendFastTestsGroup
    WriteFrontendFastGroupSummary
    WriteFrontendSplitSummary frontend-unit-shard
}

RunFrontendPropertyModelPerfGroupBody() {
    RunVitestScriptUnsharded test:property
    RunVitestScriptUnsharded check:frontend-state-machines
    RunInClientMeasurement frontend-perf-regression \
        "$ROOT_DIR/.tmp/frontend/frontend-perf-regression.measurement-noise.json" \
        npm run check:frontend-perf-regression
}

RunFrontendPropertyModelPerfLane() {
    EnsureFrontendFsusUiBaseline
    PrepareFrontendFastGroupTimings
    RunFrontendFastGroup property-model-perf RunFrontendPropertyModelPerfGroupBody
    WriteFrontendFastGroupSummary
    WriteFrontendSplitSummary frontend-property-model-perf
}

RunFrontendFastRuntimeContractsGroupBody() {
    RunInClient "${FSUSBLOG_NODE:-node}" \
        ../../tools/test/run-command-manifest.mjs \
        --matrix-group frontend-runtime-contracts
}

RunFrontendFastRuntimeContractsGroup() {
    RunFrontendFastGroup runtime-contracts RunFrontendFastRuntimeContractsGroupBody
}

RunFrontendRuntimeContractsLane() {
    EnsureFrontendFsusUiBaseline
    EnsureWasmReceiptOnce
    PrepareFrontendFastGroupTimings
    RunFrontendFastRuntimeContractsGroup
    WriteFrontendFastGroupSummary
    WriteFrontendSplitSummary frontend-runtime-contracts
}

RunFrontendFastStaticGovernanceGroupBody() {
    RunInClient env FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=authoritative "${FSUSBLOG_NODE:-node}" \
        ../../tools/test/run-command-manifest.mjs \
        --matrix-group frontend-static-governance
}

RunFrontendFastStaticGovernanceGroup() {
    RunFrontendFastGroup static-governance RunFrontendFastStaticGovernanceGroupBody
}

RunFrontendStaticGovernanceLane() {
    EnsureFrontendFsusUiBaseline
    PrepareFrontendFastGroupTimings
    RunFrontendFastStaticGovernanceGroup
    WriteFrontendFastGroupSummary
    WriteFrontendSplitSummary frontend-static-governance
}

RunFrontendFastSummaryLane() {
    Log "frontend-fast-summary | artifact-only aggregate tier; CI summary validates child job evidence"
    WriteFrontendSplitSummary frontend-fast-summary
}

RunFastFrontendLane() {
    RunFrontendFastBuildLane
    RunFrontendUnitShardLane
    RunFrontendPropertyModelPerfLane
    RunFrontendRuntimeContractsLane
    RunFrontendStaticGovernanceLane
    RunFrontendFastSummaryLane
}

RunFastOnly() {
    Log "tier=fast | no running services required"
    EnsureWasmReceiptOnce
    # The frontend release build syncs hashed assets into the selected backend webroot.
    # Keep it ahead of the .NET StaticWebAssets pass so the manifest and files
    # are read from one coherent generation instead of racing on deleted chunks.
    RunFastFrontendLane
    RunFastBackendLane
}

BeginLegacyRuntimeScenarioObservation() {
    local phase="$1"
    if [[ "${FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT:-}" != "before" ]]; then
        return
    fi
    if [[ -z "${FSUSBLOG_TEST_RUN_ID:-}" || -z "${FSUSBLOG_TEST_SOURCE_COMMIT:-}" ||
        -z "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" ]]; then
        Fail "runtime scenario before observation requires source and run identity"
    fi
    FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_ACTIVE=1
    FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_PHASE="$phase"
    FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_STARTED_MS="$(NowEpochMs)"
    FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_DIR="$RUNTIME_SCENARIO_OUTPUT_ROOT/$phase/before-processes"
    FSUSBLOG_RUNTIME_SCENARIO_ORIGINAL_NODE_OPTIONS="${NODE_OPTIONS:-}"
    rm -rf "$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_DIR"
    mkdir -p "$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_DIR"
    export FSUSBLOG_RUNTIME_SCENARIO_PROCESS_EVIDENCE_DIR="$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_DIR"
    export NODE_OPTIONS="${NODE_OPTIONS:-} --import=$ROOT_DIR/tools/test/runtime-scenario-process-observer.mjs"
}

EndLegacyRuntimeScenarioObservation() {
    local status="$1"
    if [[ "${FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_ACTIVE:-0}" != "1" ]]; then
        return
    fi
    if [[ -n "$FSUSBLOG_RUNTIME_SCENARIO_ORIGINAL_NODE_OPTIONS" ]]; then
        export NODE_OPTIONS="$FSUSBLOG_RUNTIME_SCENARIO_ORIGINAL_NODE_OPTIONS"
    else
        unset NODE_OPTIONS
    fi
    unset FSUSBLOG_RUNTIME_SCENARIO_PROCESS_EVIDENCE_DIR
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/aggregate-runtime-scenario-processes.mjs" \
        --phase "$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_PHASE" \
        --input "$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_DIR" \
        --output "$RUNTIME_SCENARIO_OUTPUT_ROOT/$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_PHASE/before-summary.json" \
        --status "$status" \
        --started-at-ms "$FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_STARTED_MS"
    unset FSUSBLOG_RUNTIME_SCENARIO_OBSERVATION_ACTIVE
}

RunIntegrationOnly() {
    Log "tier=integration | debug runtime validation, requires frontend=3000 backend=5000"
    if [[ "${FSUSBLOG_SKIP_BACKEND_INTEGRATION_TESTS:-0}" != "1" ]]; then
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/legacy-real-dump-contract.mjs" \
            plan --producer integration \
            --out "$ROOT_DIR/.tmp/test-results/backend/integration/legacy-real-dump-membership.json"
        RunBackendDotnetFilterOnly "Category=Integration&Fixture!=Legacy20260517RealDump" integration
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-rights-v3-integration-producer.mjs"
    fi
    RequireDebugStack

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$INTEGRATION_HTTP_TIMEOUT_MS"

    InvokeLaneFixtureOrchestrator

    local -a integrationFailures=()
    RunIntegrationStage() {
        local label="$1"
        shift
        set +e
        ("$@")
        local status=$?
        set -e
        if ((status != 0)); then
            integrationFailures+=("$label:$status")
            Log "integration stage failed, continuing: $label (exit $status)"
        fi
    }

    if [[ "${FSUSBLOG_RUNTIME_SCENARIO_HOST:-1}" == "0" ]]; then
        Log "runtime scenario host disabled; using retained per-CLI integration fallback"
        if [[ "${FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT:-}" == "before" ]]; then
            RunIntegrationStage "auth-broadcast-boundaries" RunInClient npm run check:auth-broadcast-boundaries
        fi
        BeginLegacyRuntimeScenarioObservation integration
        if [[ "${FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT:-}" == "before" ]]; then
            RunIntegrationStage "auth-session" RunInClient \
                "${FSUSBLOG_NODE:-node}" ../../tests/frontend/checks/runtime/auth-session-smoke.mjs
        else
            RunIntegrationStage "auth-session" RunInClient npm run check:auth-session-smoke
        fi
        RunIntegrationStage "api-contracts" RunInClient npm run check:api-contracts
        RunIntegrationStage "binary-contract-smoke" RunInClient npm run check:binary-contract-smoke
        RunIntegrationStage "binary-smoke" RunInClient npm run check:binary-smoke
        RunIntegrationStage "notification-stream-runtime" RunInClient npm run check:notification-stream-runtime
        RunIntegrationStage "notification-stream-live" RunInClient npm run check:notification-stream-live
        RunIntegrationStage "binary-smoke-auth" RunInClient npm run check:binary-smoke:auth
        RunIntegrationStage "distribution-version-coherence" RunInClient npm run check:distribution-version-coherence
        if ((${#integrationFailures[@]} > 0)); then
            EndLegacyRuntimeScenarioObservation failure
        else
            EndLegacyRuntimeScenarioObservation success
        fi
        RunIntegrationStage "sw-search-runtime" RunInClient npm run check:sw-search-runtime
    else
        # Keep the source-only auth broadcast assertion. Runtime probes themselves
        # share one source/run-bound Node host and its keep-alive/AEDS/helper cache.
        RunIntegrationStage "auth-broadcast-boundaries" RunInClient npm run check:auth-broadcast-boundaries
        RunIntegrationStage "runtime-resident-host" Run \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-runtime-scenario-host.mjs" \
            --phase integration
        # Search shard validation is a single-shot filesystem/HTTP scenario and
        # remains outside the resident host; it is still declared in the catalog.
        RunIntegrationStage "sw-search-runtime" Run \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-retained-runtime-scenario.mjs" \
            --scenario integration.sw-search --cwd src/frontend -- npm run check:sw-search-runtime
    fi
    Log "real-browser PoW and search probes are delegated to browser-runtime-risk-diagnostics"

    unset -f RunIntegrationStage
    if ((${#integrationFailures[@]} > 0)); then
        Fail "integration runtime failures (${integrationFailures[*]})"
    fi
    WriteRuntimeLaneSummary integration
}

RunCoverageBackendOnly() {
    Log "tier=coverage-backend | server xUnit coverage collection"
    Run bash "$ROOT_DIR/tools/coverage/collect-backend-coverage.sh"
}

RunCoverageFrontendOnly() {
    Log "tier=coverage-frontend | frontend vitest coverage collection"
    Run bash "$ROOT_DIR/tools/coverage/collect-frontend-coverage.sh"
}

RunCoverageMergeOnly() {
    Log "tier=coverage-merge | merge available coverage artifacts"
    Run bash "$ROOT_DIR/tools/coverage/merge-coverage.sh"
}

RunCoverageThresholdOnly() {
    Log "tier=coverage-threshold | enforce merged coverage thresholds"
    Run env \
        FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/merged/Summary.json" \
        bash "$ROOT_DIR/tools/coverage/check-scope-snapshot.sh"
    Run env \
        FSUSBLOG_COVERAGE_THRESHOLD_LABEL=merged \
        FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/merged/Summary.json" \
        FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_COVERAGE_LINE_THRESHOLD:-35}" \
        FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_COVERAGE_BRANCH_THRESHOLD:-20}" \
        FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_COVERAGE_METHOD_THRESHOLD:-30}" \
        bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
    Run env \
        FSUSBLOG_COVERAGE_THRESHOLD_LABEL=backend \
        FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/backend-merged/Summary.json" \
        FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD:-75}" \
        FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD:-55}" \
        FSUSBLOG_COVERAGE_METHOD_THRESHOLD="${FSUSBLOG_BACKEND_COVERAGE_METHOD_THRESHOLD:-95}" \
        bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
    Run env \
        FSUSBLOG_COVERAGE_THRESHOLD_LABEL=frontend \
        FSUSBLOG_COVERAGE_SUMMARY_FILE="$COVERAGE_ROOT/frontend/Summary.json" \
        FSUSBLOG_COVERAGE_LINE_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-35}" \
        FSUSBLOG_COVERAGE_BRANCH_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-20}" \
        FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD="${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-30}" \
        bash "$ROOT_DIR/tools/coverage/check-threshold.sh"
}

RunCoverageGateOnly() {
    Log "tier=coverage-gate | collect + merge + enforce thresholds"
    RunCoverageBackendOnly
    RunCoverageFrontendOnly
    RunCoverageMergeOnly
    RunCoverageThresholdOnly
}

RunReleasePublicHydrationPrepareOnly() {
    Log "tier=release-public-hydration | settle AOT hydration writes before release preview readers"
    RequireReleasePreview

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"

    RunInClient npm run check:public-hydration-rebuild
    # Public AOT warmup/backfill is a backend operation; Vite preview only serves static release assets.
    RunInClient env \
        FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" \
        FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL" \
        FSUSBLOG_PUBLIC_AOT_WAIT_MS=120000 \
        npm run rebuild:public-hydration
}

RunReleaseOnly() {
    Log "tier=release | requires release preview=8080"
    RequireReleasePreview

    if [[ "${FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG:-0}" != "1" ]]; then
        RunReleasePublicHydrationPrepareOnly
    else
        Log "reuse same-run release hydration write barrier"
    fi

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$RELEASE_HTTP_TIMEOUT_MS"
    RunInClient node ../../tests/frontend/checks/public/aot-regression.mjs
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$DEBUG_BACKEND_URL"
    RunInClient node ../../tests/frontend/checks/public/check-public-hydration-identity.mjs
    RunInClient node ../../tests/frontend/checks/public/public-hydration-smoke.mjs
    RunInClient node ../../tests/frontend/checks/public/check-public-clock-hydration-matrix.mjs
    RunInClient node ../../tests/frontend/checks/public/check-public-browser-env-hydration-matrix.mjs
    RunInClient node ../../tests/frontend/checks/public/check-public-payload-fixture-matrix.mjs
    RunInClient node ../../tests/frontend/checks/public/check-public-dom-diff-hydration.mjs
    RunInClient env FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS=1 \
        node ../../tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs --lane release
    RunInClient npm run check:public-seo-smoke
    Log "release browser-only hydration/search/PWA risks are delegated to browser-contract (#1147)"
}

RunAcceptanceOnly() {
    if [[ "${FSUSBLOG_BROWSER_DIAGNOSTICS:-0}" != "1" && "${MATRIX_JOB:-}" != "browser-diagnostics" ]]; then
        Fail "acceptance is diagnostics-only; use ./tools/test.sh browser-diagnostics"
    fi
    Log "tier=acceptance | nightly/manual Playwright diagnostics, requires frontend=3000 backend=5000 preview=8080"
    ConfigurePlaywrightShard acceptance
    export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
    ConfigurePlaywrightWorkers acceptance-spa-routes FSUSBLOG_SPA_ROUTES_WORKERS
    ConfigurePlaywrightWorkers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS
    RequireDebugStack
    RequireReleasePreview

    if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
        export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
        export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
        FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_SPA_ROUTES_WORKERS" PrepareSessionFixturesOnce
        export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
    fi

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
    RunInClient env FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1 npm run check:acceptance:public

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$ACCEPTANCE_HTTP_TIMEOUT_MS"
    RunInClient npm run check:spa:routes
    RunInClient npm run check:acceptance:auth
    RunInClient npm run check:acceptance:console
}

RunVisualOnly() {
    Log "tier=visual | dark/mobile visual gates"
    RunVisualPublicOnly
    RunVisualConsoleOnly
}

RunVisualPublicOnly() {
    Log "tier=visual-public | public screenshot checks"
    export FSUSBLOG_PLAYWRIGHT_CONFIG="${FSUSBLOG_PLAYWRIGHT_CONFIG:-playwright.diagnostics.config.ts}"
    export FSUSBLOG_PLAYWRIGHT_LOCALE="${FSUSBLOG_PLAYWRIGHT_LOCALE:-zh-CN}"
    export FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS="${FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS:-360000}"
    ConfigureVisualPlaywrightLane visual-public
    ConfigurePlaywrightWorkers visual-public FSUSBLOG_VISUAL_PUBLIC_WORKERS
    RequireDebugStack
    RequireReleasePreview

    export FSUSBLOG_BASE_URL="$RELEASE_PREVIEW_URL"
    export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
    RunVisualGroupCheck public npm run check:visual:public
}

RunVisualConsoleOnly() {
    Log "tier=visual-console | console screenshot checks"
    export FSUSBLOG_PLAYWRIGHT_CONFIG="${FSUSBLOG_PLAYWRIGHT_CONFIG:-playwright.diagnostics.config.ts}"
    export FSUSBLOG_PLAYWRIGHT_LOCALE="${FSUSBLOG_PLAYWRIGHT_LOCALE:-zh-CN}"
    export FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS="${FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS:-360000}"
    export FSUSBLOG_TEST_BUSINESS_EPOCH_UTC="${FSUSBLOG_TEST_BUSINESS_EPOCH_UTC:-2024-02-29T23:59:59.000Z}"
    ConfigureVisualPlaywrightLane visual-console
    ConfigurePlaywrightWorkers visual-console FSUSBLOG_CONSOLE_VISUAL_WORKERS
    export FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"
    RequireDebugStack
    RequireReleasePreview

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$VISUAL_HTTP_TIMEOUT_MS"
    if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
        FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_CONSOLE_VISUAL_WORKERS" PrepareSessionFixturesOnce
        export FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1
    fi
    RunVisualGroupCheck console npm run check:visual:console
}

RunSecurityStaticOnly() {
    Log "tier=security-static | matrices/supply-chain/network/SBOM policy gates"
    local -x FSUSBLOG_ADAPTIVE_PARALLEL=1
    local -x FSUSBLOG_PARALLEL_WORKLOAD=scheduler-admitted
    RunParallel "security-static" \
        "network-baseline::\"$ROOT_DIR/tools/security/check-production-network-baseline.sh\"" \
        "supply-chain::\"$ROOT_DIR/tools/security/check-supply-chain-audit.sh\"" \
        "security-domain::\"${FSUSBLOG_NODE:-node}\" \"$ROOT_DIR/tools/security/check-security-domain-layout.mjs\"" \
        "security-matrices::npm --prefix \"$CLIENT_DIR\" run check:security:matrices" \
        "pow-parity::RunInClient npm run check:contract:pow-parity" \
        "zap-warn-policy::\"$ROOT_DIR/tools/security/check-zap-warn-policy.mjs\"" \
        "sbom::\"$ROOT_DIR/tools/security/generate-sbom.sh\""
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/cross-stack-receipts.mjs" owner security-static
}

RunSecurityRuntimeCoreOnly() {
    Log "tier=security-runtime-core | auth/mfa/passkey/pow/permission/attack gates"
    local -a securityFailures=()
    RunSecurityStage() {
        local label="$1"
        shift
        set +e
        (
            case "${1:-}" in
                RunSecurityLegacyIsolatedClientCheck)
                    shift
                    RunSecurityLegacyIsolatedClientCheck "$@"
                    ;;
                CheckSecurityFirewallEvidence)
                    shift
                    CheckSecurityFirewallEvidence "$@"
                    ;;
                CheckExternalProductionExposure)
                    shift
                    CheckExternalProductionExposure "$@"
                    ;;
                *) "$@" ;;
            esac
        )
        local status=$?
        set -e
        if ((status != 0)); then
            securityFailures+=("$label:$status")
            Log "security stage failed, continuing: $label (exit $status)"
        fi
    }

    # Used only by the immediate no-restart fallback. The resident host derives
    # the same identity suffixes from catalog scenario IDs.
    RunSecurityLegacyIsolatedClientCheck() {
        local suffix
        suffix="security-$(NamespaceSlug "$1")"
        shift
        (
            export FSUSBLOG_USER_USERNAME="${FSUSBLOG_USER_USERNAME:-binaryuser}-$suffix"
            export FSUSBLOG_ADMIN_USERNAME="${FSUSBLOG_ADMIN_USERNAME:-binaryadmin}-$suffix"
            export FSUSBLOG_DEVICE_FP="${FSUSBLOG_DEVICE_FP:-binary-smoke-node}-$suffix"
            RunInClient "$@"
        )
    }

    # Dispatched indirectly by the securityRuntimeJobs command specifications.
    CheckSecurityFirewallEvidence() {
        Run "$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh" "$FSUSBLOG_FIREWALL_POLICY_EVIDENCE"
    }

    # Dispatched indirectly by the securityRuntimeJobs command specifications.
    CheckExternalProductionExposure() {
        local -a failures=()
        Run "$ROOT_DIR/tools/security/check-production-exposure-live.sh" || failures+=(live-check)
        if [[ -n "${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-}" ]]; then
            Run "$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh" "$FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE" ||
                failures+=(evidence-verify)
        fi
        if ((${#failures[@]} > 0)); then
            printf '[test:%s] production exposure failures: %s\n' \
                "${CURRENT_TIER:-security}" "${failures[*]}" >&2
            return 1
        fi
    }

    # This prerequisite loads the namespaced bootstrap environment into the
    # current shell; it cannot run inside RunSecurityStage's isolation subshell.
    RequireDebugStack
    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$SECURITY_HTTP_TIMEOUT_MS"
    RunSecurityStage "prepare-runtime-fixtures" InvokeLaneFixtureOrchestrator
    RunSecurityStage "auth-broadcast-boundaries" RunInClient npm run check:auth-broadcast-boundaries
    if [[ "${FSUSBLOG_RUNTIME_SCENARIO_HOST:-1}" == "0" ]]; then
        Log "runtime scenario host disabled; using retained per-CLI security fallback"
        BeginLegacyRuntimeScenarioObservation security
        RunSecurityStage "api-contracts" RunInClient npm run check:api-contracts
        RunSecurityStage "auth-session" RunSecurityLegacyIsolatedClientCheck \
            auth-session "${FSUSBLOG_NODE:-node}" \
            ../../tests/frontend/checks/runtime/auth-session-smoke.mjs
        RunSecurityStage "auth-mfa" RunSecurityLegacyIsolatedClientCheck \
            auth-mfa npm run check:security:auth-mfa
        RunSecurityStage "auth-passkey" RunSecurityLegacyIsolatedClientCheck \
            auth-passkey npm run check:security:auth-passkey
        RunSecurityStage "headers-cors" RunInClient npm run check:security:headers-cors
        RunSecurityStage "notification-stream-binary" RunInClient \
            npm run check:security:notification-stream-binary
        RunSecurityStage "attack-matrix" RunInClient npm run check:security:attack-matrix
        if ((${#securityFailures[@]} > 0)); then
            EndLegacyRuntimeScenarioObservation failure
        else
            EndLegacyRuntimeScenarioObservation success
        fi
    else
        RunSecurityStage "runtime-resident-host" Run \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-runtime-scenario-host.mjs" \
            --phase security
    fi
    if [[ "${FSUSBLOG_LOCAL_RUNTIME_EXPOSURE_IN_DAG:-0}" != "1" ]]; then
        RunSecurityStage "local-runtime-exposure" Run \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-retained-runtime-scenario.mjs" \
            --scenario security.local-runtime-exposure -- \
            "$ROOT_DIR/tools/security/check-local-runtime-exposure.mjs"
    fi
    if [[ -n "${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-}" ]]; then
        RunSecurityStage "firewall-evidence" CheckSecurityFirewallEvidence
    fi
    if [[ "${FSUSBLOG_RUN_PRODUCTION_EXPOSURE_LIVE:-0}" == "1" ]]; then
        RunSecurityStage "external-production-exposure" CheckExternalProductionExposure
    fi
    # Rendered permission and a11y behavior are browser diagnostics. Correctness
    # retains the backend/API authorization matrices and Browser Contract role flows.
    Log "real-browser permission routing is delegated to browser-runtime-risk-diagnostics"

    if [[ "${FSUSBLOG_SKIP_ZAP:-0}" != "1" ]]; then
        RunSecurityStage "dast" Run \
            "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-retained-runtime-scenario.mjs" \
            --scenario security.dast --cwd src/frontend -- npm run check:security:dast
    fi
    unset -f RunSecurityStage RunSecurityLegacyIsolatedClientCheck \
        CheckSecurityFirewallEvidence CheckExternalProductionExposure
    if ((${#securityFailures[@]} > 0)); then
        Fail "security runtime failures (${securityFailures[*]})"
    fi
}

RunSecurityOnly() {
    Log "tier=security | complete static + runtime security gate"
    RunParallel "security-phases" \
        "security-static::RunSecurityStaticOnly" \
        "security-runtime-core::RunSecurityRuntimeCoreOnly"
}

RunResilienceOnly() {
    Log "tier=resilience | runtime/upload/search/notification-stream/binary resilience"
    RequireDebugStack
    RequireReleasePreview

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$RESILIENCE_HTTP_TIMEOUT_MS"

    InvokeLaneFixtureOrchestrator
    Log "real-browser search recovery is delegated to browser-runtime-risk-diagnostics"
    if [[ "${FSUSBLOG_RUNTIME_SCENARIO_HOST:-1}" == "0" ]]; then
        Log "runtime scenario host disabled; using retained per-CLI resilience fallback"
        RunInClient npm run check:aot-cache-resilience
        BeginLegacyRuntimeScenarioObservation resilience
        RunInClient npm run check:resilience:upload
        RunInClient npm run check:notification-stream-runtime
        RunInClient npm run check:binary-smoke
        RunInClient npm run check:binary-contract-smoke
        EndLegacyRuntimeScenarioObservation success
    else
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-retained-runtime-scenario.mjs" \
            --scenario resilience.aot-cache-mutation --cwd src/frontend -- \
            npm run check:aot-cache-resilience
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-runtime-scenario-host.mjs" \
            --phase resilience
    fi
    WriteRuntimeLaneSummary resilience
}

RunLoadOnly() {
    Log "tier=load | lightweight public/api and notification stream concurrency checks"
    RequireDebugStack
    RequireReleasePreview

    export FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL"
    export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
    export FSUSBLOG_HTTP_TIMEOUT_MS="$LOAD_HTTP_TIMEOUT_MS"

    InvokeLaneFixtureOrchestrator
    RunInClientMeasurement load-public-api \
        "$ROOT_DIR/.tmp/perf/load/measurement-noise-public-api.json" \
        npm run check:load:public-api
    RunInClientMeasurement load-notification-stream-pressure \
        "$ROOT_DIR/.tmp/perf/load/measurement-noise-notification-stream.json" \
        npm run check:load:notification-stream-pressure
}

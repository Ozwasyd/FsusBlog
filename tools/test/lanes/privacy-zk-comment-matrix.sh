#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

STAGE_DIR="$ROOT_DIR/.tmp/security/privacy-zk-comment-matrix-stages"

WriteStageReceipt() {
    local stage="$1"
    local validatedBy="$2"
    mkdir -p "$STAGE_DIR"
    STAGE_NAME="$stage" STAGE_VALIDATED_BY="$validatedBy" node --input-type=module - "$STAGE_DIR/$stage.json" <<'NODE'
import fs from 'node:fs'
import process from 'node:process'

const output = process.argv[2]
const pending = `${output}.pending-${process.pid}`
fs.writeFileSync(pending, `${JSON.stringify({
  schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
  status: 'ok',
  stage: process.env.STAGE_NAME,
  validatedBy: process.env.STAGE_VALIDATED_BY,
  runId: process.env.FSUSBLOG_TEST_RUN_ID ?? process.env.FSUSBLOG_PRODUCTION_RUN_ID ?? null,
  generatedAt: new Date().toISOString()
}, null, 2)}\n`)
fs.renameSync(pending, output)
NODE
}

RequireStageReceipt() {
    local stage="$1"
    local receipt="$STAGE_DIR/$stage.json"
    [[ -s "$receipt" ]] || Fail "privacy-zk stage receipt missing: $stage"
    EXPECTED_STAGE="$stage" node --input-type=module - "$receipt" <<'NODE'
import fs from 'node:fs'
import process from 'node:process'

const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const expectedStage = process.env.EXPECTED_STAGE
const expectedRunId = process.env.FSUSBLOG_TEST_RUN_ID ?? ''
if (receipt.schema !== 'fsusblog.privacy-zk-comment-matrix-stage.v1'
    || receipt.status !== 'ok' || receipt.stage !== expectedStage) {
  throw new Error(`privacy-zk ${expectedStage} receipt is invalid`)
}
if (expectedRunId && receipt.runId !== expectedRunId) {
  throw new Error(`privacy-zk ${expectedStage} receipt run mismatch: expected ${expectedRunId}, got ${receipt.runId ?? 'missing'}`)
}
NODE
}

LocalDotnetArgs() {
    PRIVACY_DOTNET_ARGS=(-- --no-build --no-restore)
}

RunPrivacyMatrixContract() {
    node "$ROOT_DIR/tools/check-repository-source-layout.mjs"
    node "$ROOT_DIR/tools/verify-zk-privacy-matrix.mjs"
}

RunPrivacyPrebuildContract() {
    FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild || return $?
    FSUSBLOG_ZK_MCL_NO_BUILD=1 \
        npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-contract:prebuild
}

RunPrivacyPostbuildContract() {
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-contract:postbuild
}

RunPrivacyBackendFunctional() {
    ConfigureDotnetTestProcessors || return $?
    FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release EnsureBackendFilteredBuild || return $?
    LocalDotnetArgs
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-backend-functional "${PRIVACY_DOTNET_ARGS[@]}"
}

RunPrivacyBenchmark() {
    ConfigureDotnetTestProcessors || return $?
    FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release EnsureBackendFilteredBuild || return $?
    LocalDotnetArgs
    FSUSBLOG_RUN_PERFORMANCE_TESTS=1 \
        npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-benchmark "${PRIVACY_DOTNET_ARGS[@]}"
}

RunPrivacyFrontend() {
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-frontend
}

RunPrivacyProdSmoke() {
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-prod-smoke
}

RunContractPrebuildStage() {
    rm -rf "$STAGE_DIR"
    LANE_FAILURES=()
    # This stage has no dependency on generated frontend output. Starting it with
    # the frontend build moves the MCL fixture work off the build critical path.
    RunCollect privacy-matrix-contract RunPrivacyMatrixContract
    RunCollect privacy-prebuild-contract RunPrivacyPrebuildContract
    FinishCollect
    WriteStageReceipt contract-prebuild 'privacy matrix, circuit, MCL fixture and repository contract checks'
}

RunContractPostbuildStage() {
    RequireStageReceipt contract-prebuild
    LANE_FAILURES=()
    # Only the generated public/wasm prover manifest and its browser-to-MCL proof
    # path remain after frontend-build-ready.
    RunCollect privacy-postbuild-contract RunPrivacyPostbuildContract
    FinishCollect
    WriteStageReceipt contract 'generated prover manifest and browser-to-MCL contract check'
}

RunContractStage() {
    RunContractPrebuildStage
    RunContractPostbuildStage
}

RunFunctionalStage() {
    RequireStageReceipt contract
    LANE_FAILURES=()
    # These branches do not contain a benchmark. They may share the dynamically
    # granted CPU/memory budget with other non-exclusive frontend work.
    RunCollectParallel privacy-zk-functional \
        backend-functional RunPrivacyBackendFunctional \
        frontend RunPrivacyFrontend \
        prod-smoke RunPrivacyProdSmoke
    FinishCollect
    WriteStageReceipt functional 'parallel backend-functional, frontend and production-smoke checks'
}

RunProjectedFunctionalStage() {
    RequireStageReceipt contract
    RunPrivacyProdSmoke
    node "$ROOT_DIR/tools/test/lanes/project-privacy-zk-production.mjs"
}

RunBenchmarkStage() {
    RequireStageReceipt contract
    LANE_FAILURES=()
    RunCollect privacy-zk-native-p99 RunPrivacyBenchmark
    FinishCollect
    WriteStageReceipt benchmark 'ZkCommentV2CrossStackFixture native verifier P99 test'
}

FinalizePrivacyMatrix() {
    RequireStageReceipt contract
    RequireStageReceipt functional
    RequireStageReceipt benchmark
    mkdir -p "$ROOT_DIR/.tmp/security"
    cat >"$ROOT_DIR/.tmp/security/privacy-zk-comment-matrix.json" <<'JSON'
{
  "schema": "fsusblog.privacy-zk-comment-matrix.v1",
  "status": "ok",
  "source": "security/matrices/privacy-zk-comment.yml",
  "validatedBy": "contract, parallel non-benchmark functional checks, and isolated native verifier P99 benchmark stage receipts"
}
JSON
}

case "${1:-all}" in
    contract-prebuild)
        RunContractPrebuildStage
        ;;
    contract-postbuild)
        RunContractPostbuildStage
        ;;
    contract)
        RunContractStage
        ;;
    functional)
        RunFunctionalStage
        ;;
    project-functional)
        RunProjectedFunctionalStage
        ;;
    benchmark)
        RunBenchmarkStage
        ;;
    finalize)
        FinalizePrivacyMatrix
        ;;
    all)
        RunContractStage
        RunFunctionalStage
        RunBenchmarkStage
        FinalizePrivacyMatrix
        ;;
    *)
        Fail "usage: privacy-zk-comment-matrix.sh [all|contract-prebuild|contract-postbuild|contract|functional|project-functional|benchmark|finalize]"
        ;;
esac

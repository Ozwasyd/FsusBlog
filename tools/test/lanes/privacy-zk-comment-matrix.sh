#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

SECURITY_OUTPUT_ROOT="${FSUSBLOG_SECURITY_OUTPUT_ROOT:-$ROOT_DIR/.tmp/security}"
STAGE_DIR="$SECURITY_OUTPUT_ROOT/privacy-zk-comment-matrix-stages"
PREBUILD_PROJECTION="$SECURITY_OUTPUT_ROOT/privacy-zk-comment-prebuild.json"

WriteStageReceipt() {
    local stage="$1"
    local validatedBy="$2"
    mkdir -p "$STAGE_DIR"
    STAGE_NAME="$stage" STAGE_VALIDATED_BY="$validatedBy" node --input-type=module - "$STAGE_DIR/$stage.json" <<'NODE'
import fs from 'node:fs'
import process from 'node:process'

const output = process.argv[2]
const pending = `${output}.pending-${process.pid}`
const projectionPath = process.env.STAGE_PROJECTION || ''
let projection = null
let projectionDigest = null
if (projectionPath) {
  const bytes = fs.readFileSync(projectionPath)
  projection = JSON.parse(bytes.toString('utf8'))
  if (projection.schema !== 'fsusblog.privacy-zk-prebuild-projection.v1' || projection.status !== 'success') {
    throw new Error('privacy-zk prebuild projection is invalid')
  }
  projectionDigest = `sha256:${(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}`
}
fs.writeFileSync(pending, `${JSON.stringify({
  schema: 'fsusblog.privacy-zk-comment-matrix-stage.v1',
  status: 'ok',
  stage: process.env.STAGE_NAME,
  validatedBy: process.env.STAGE_VALIDATED_BY,
  runId: process.env.FSUSBLOG_TEST_RUN_ID ?? process.env.FSUSBLOG_PRODUCTION_RUN_ID ?? null,
  sourceState: {
    commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
    worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
  },
  ...(projection ? {
    assertionIds: projection.assertionIds,
    coverageIds: projection.coverageIds,
    projectionReceipt: projectionPath,
    projectionDigest
  } : {}),
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
import crypto from 'node:crypto'
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
const expectedCommit = process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? ''
const expectedFingerprint = process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? ''
if (expectedCommit && (receipt.sourceState?.commit !== expectedCommit
    || receipt.sourceState?.worktreeFingerprint !== expectedFingerprint)) {
  throw new Error(`privacy-zk ${expectedStage} receipt source mismatch`)
}
if (expectedStage === 'contract-prebuild') {
  if (!receipt.projectionReceipt || !receipt.projectionDigest || !Array.isArray(receipt.assertionIds)) {
    throw new Error('privacy-zk contract-prebuild receipt is missing projection evidence')
  }
  const bytes = fs.readFileSync(receipt.projectionReceipt)
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
  if (digest !== receipt.projectionDigest) throw new Error('privacy-zk contract-prebuild projection digest mismatch')
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
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-contract:prebuild
    node "$ROOT_DIR/tools/test/lanes/run-privacy-zk-prebuild-projection.mjs" \
        --root "$ROOT_DIR" \
        --registry tests/governance/privacy-zk-prebuild-ownership.json \
        --output "$PREBUILD_PROJECTION" \
        --commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?missing test source commit}" \
        --worktree-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?missing test source fingerprint}" \
        --run-id "${FSUSBLOG_TEST_RUN_ID:?missing test run ID}"
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

RunPrivacyFrontend() {
    node "$ROOT_DIR/tools/security/check-comment-draft-privacy.mjs"
    node --test "$ROOT_DIR/tests/security/comment-draft-privacy.test.mjs"
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-frontend
}

RunPrivacyProdSmoke() {
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-prod-smoke
}

RunContractPrebuildStage() {
    rm -rf "$STAGE_DIR"
    LANE_FAILURES=()
    # This stage has no dependency on generated frontend output.
    RunCollect privacy-matrix-contract RunPrivacyMatrixContract
    RunCollect privacy-prebuild-contract RunPrivacyPrebuildContract
    FinishCollect
    STAGE_PROJECTION="$PREBUILD_PROJECTION" \
        WriteStageReceipt contract-prebuild 'unique privacy/ZK assertions plus canonical current-run receipt projection'
}

RunContractPostbuildStage() {
    RequireStageReceipt contract-prebuild
    LANE_FAILURES=()
    # Only the generated public/wasm prover manifest remains after frontend-build-ready.
    RunCollect privacy-postbuild-contract RunPrivacyPostbuildContract
    FinishCollect
    WriteStageReceipt contract 'generated current prover manifest contract check'
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

FinalizePrivacyMatrix() {
    RequireStageReceipt contract
    RequireStageReceipt functional
    mkdir -p "$SECURITY_OUTPUT_ROOT"
    cat >"$SECURITY_OUTPUT_ROOT/privacy-zk-comment-matrix.json" <<'JSON'
{
  "schema": "fsusblog.privacy-zk-comment-matrix.v1",
  "status": "ok",
  "source": "security/matrices/privacy-zk-comment.yml",
  "validatedBy": "contract and parallel functional check stage receipts"
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
    finalize)
        FinalizePrivacyMatrix
        ;;
    all)
        RunContractStage
        RunFunctionalStage
        FinalizePrivacyMatrix
        ;;
    *)
        Fail "usage: privacy-zk-comment-matrix.sh [all|contract-prebuild|contract-postbuild|contract|functional|project-functional|finalize]"
        ;;
esac

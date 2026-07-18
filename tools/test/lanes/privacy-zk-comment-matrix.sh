#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

STAGE_DIR="$ROOT_DIR/.tmp/security/privacy-zk-comment-matrix-stages"

write_stage_receipt() {
  local stage="$1"
  local validated_by="$2"
  mkdir -p "$STAGE_DIR"
  STAGE_NAME="$stage" STAGE_VALIDATED_BY="$validated_by" node --input-type=module - "$STAGE_DIR/$stage.json" <<'NODE'
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

require_stage_receipt() {
  local stage="$1"
  local receipt="$STAGE_DIR/$stage.json"
  [[ -s "$receipt" ]] || fail "privacy-zk stage receipt missing: $stage"
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

local_dotnet_args() {
  PRIVACY_DOTNET_ARGS=(-- --no-build --no-restore)
}

run_privacy_matrix_contract() {
  node "$ROOT_DIR/tools/check-repository-source-layout.mjs"
  node "$ROOT_DIR/tools/verify-zk-privacy-matrix.mjs"
}

run_privacy_prebuild_contract() {
  FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug ensure_backend_filtered_build || return $?
  FSUSBLOG_ZK_MCL_NO_BUILD=1 \
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-contract:prebuild
}

run_privacy_postbuild_contract() {
  npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-contract:postbuild
}

run_privacy_backend_functional() {
  configure_dotnet_test_processors || return $?
  FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release ensure_backend_filtered_build || return $?
  local_dotnet_args
  npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-backend-functional "${PRIVACY_DOTNET_ARGS[@]}"
}

run_privacy_benchmark() {
  configure_dotnet_test_processors || return $?
  FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release ensure_backend_filtered_build || return $?
  local_dotnet_args
  FSUSBLOG_RUN_PERFORMANCE_TESTS=1 \
    npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-benchmark "${PRIVACY_DOTNET_ARGS[@]}"
}

run_privacy_frontend() {
  npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-frontend
}

run_privacy_prod_smoke() {
  npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-prod-smoke
}

run_contract_prebuild_stage() {
  rm -rf "$STAGE_DIR"
  LANE_FAILURES=()
  # This stage has no dependency on generated frontend output. Starting it with
  # the frontend build moves the MCL fixture work off the build critical path.
  run_collect privacy-matrix-contract run_privacy_matrix_contract
  run_collect privacy-prebuild-contract run_privacy_prebuild_contract
  finish_collect
  write_stage_receipt contract-prebuild 'privacy matrix, circuit, MCL fixture and repository contract checks'
}

run_contract_postbuild_stage() {
  require_stage_receipt contract-prebuild
  LANE_FAILURES=()
  # Only the generated public/wasm prover manifest and its browser-to-MCL proof
  # path remain after frontend-build-ready.
  run_collect privacy-postbuild-contract run_privacy_postbuild_contract
  finish_collect
  write_stage_receipt contract 'generated prover manifest and browser-to-MCL contract check'
}

run_contract_stage() {
  run_contract_prebuild_stage
  run_contract_postbuild_stage
}

run_functional_stage() {
  require_stage_receipt contract
  LANE_FAILURES=()
  # These branches do not contain a benchmark. They may share the dynamically
  # granted CPU/memory budget with other non-exclusive frontend work.
  run_collect_parallel privacy-zk-functional \
    backend-functional run_privacy_backend_functional \
    frontend run_privacy_frontend \
    prod-smoke run_privacy_prod_smoke
  finish_collect
  write_stage_receipt functional 'parallel backend-functional, frontend and production-smoke checks'
}

run_projected_functional_stage() {
  require_stage_receipt contract
  run_privacy_prod_smoke
  node "$ROOT_DIR/tools/test/lanes/project-privacy-zk-production.mjs"
}

run_benchmark_stage() {
  require_stage_receipt contract
  LANE_FAILURES=()
  run_collect privacy-zk-native-p99 run_privacy_benchmark
  finish_collect
  write_stage_receipt benchmark 'ZkCommentV2CrossStackFixture native verifier P99 test'
}

finalize_privacy_matrix() {
  require_stage_receipt contract
  require_stage_receipt functional
  require_stage_receipt benchmark
  mkdir -p "$ROOT_DIR/.tmp/security"
  cat > "$ROOT_DIR/.tmp/security/privacy-zk-comment-matrix.json" <<'JSON'
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
    run_contract_prebuild_stage
    ;;
  contract-postbuild)
    run_contract_postbuild_stage
    ;;
  contract)
    run_contract_stage
    ;;
  functional)
    run_functional_stage
    ;;
  project-functional)
    run_projected_functional_stage
    ;;
  benchmark)
    run_benchmark_stage
    ;;
  finalize)
    finalize_privacy_matrix
    ;;
  all)
    run_contract_stage
    run_functional_stage
    run_benchmark_stage
    finalize_privacy_matrix
    ;;
  *)
    fail "usage: privacy-zk-comment-matrix.sh [all|contract-prebuild|contract-postbuild|contract|functional|project-functional|benchmark|finalize]"
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

static_evidence_plan() { run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-evidence-plan; }
static_aeds_policy() { run "$ROOT_DIR/tools/check-aeds-only-policy.sh"; }
static_community_workflow() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-community-workflow.mjs"; }
static_label_governance() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-github-label-governance.mjs"; }
static_integrity_docs() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-integrity-proof-docs.mjs"; }
static_dead_code_index() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dead-code-audit-index.mjs"; }
static_background_services() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"; }
static_suite_convergence() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"; }
static_backend_governance() { run_tier "static-governance" run_backend_test_governance_only; }
static_gate_integrity() { run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test; }
static_flaky_registry() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"; }
static_matrix_contract() { run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-contract; }
static_matrix_schema() { run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-schema; }
static_retention() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-retention.mjs"; }
static_implementation_drift() { run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-doc-implementation-drift.mjs"; }
STATIC_NODE_CONTRACT_FILES=(
  "$ROOT_DIR/tests/tools/release-manifest.test.mjs"
  "$ROOT_DIR/tests/tools/runtime-publish-profile.test.mjs"
  "$ROOT_DIR/tests/tools/final-image-toolchain-pin.test.mjs"
  "$ROOT_DIR/tests/tools/deployment-slots.test.mjs"
  "$ROOT_DIR/tests/tools/gateway-switch.test.mjs"
  "$ROOT_DIR/tests/tools/dead-code-audit-index.test.mjs"
  "$ROOT_DIR/tests/tools/online-schema-migration-wrapper.test.mjs"
  "$ROOT_DIR/tests/tools/release-storage-lifecycle.test.mjs"
  "$ROOT_DIR/tests/tools/security-source-analyzer.test.mjs"
  "$ROOT_DIR/tests/tools/test-suite-convergence.test.mjs"
  "$ROOT_DIR/tests/tools/release-rollout-state.test.mjs"
  "$ROOT_DIR/tests/tools/release-worker-drill.test.mjs"
  "$ROOT_DIR/tests/tools/release-worker-reconciliation.test.mjs"
  "$ROOT_DIR/tests/tools/release-rollout-evidence.test.mjs"
  "$ROOT_DIR/tests/tools/release-rollout-bundle.test.mjs"
  "$ROOT_DIR/tests/tools/release-rollout-probes.test.mjs"
  "$ROOT_DIR/tests/tools/release-traffic-probe-session.test.mjs"
  "$ROOT_DIR/tests/tools/release-notification-probe.test.mjs"
  "$ROOT_DIR/tests/tools/release-worker-observer-service.test.mjs"
  "$ROOT_DIR/tests/tools/release-worker-normal-observer.test.mjs"
  "$ROOT_DIR/tests/tools/release-migration-qualification.test.mjs"
  "$ROOT_DIR/tests/tools/rehearsal-schema-qualification-probe.test.mjs"
  "$ROOT_DIR/tests/tools/release-asset-compatibility-probe.test.mjs"
  "$ROOT_DIR/tests/tools/performance-evidence-summary.test.mjs"
  "$ROOT_DIR/tests/tools/performance-saturation-v2.test.mjs"
)
static_node_contracts() {
  FSUSBLOG_STATIC_CONTRACT_FILES="$(printf '%s\n' "${STATIC_NODE_CONTRACT_FILES[@]}")" \
    run "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" "$ROOT_DIR/tests/tools/zero-downtime-rehearsal.test.mjs" <<'NODE'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const { runWeightedCommandManifest } = await import(pathToFileURL(process.argv[2]).href)
const zdtFile = process.argv[3]
const node = process.env.FSUSBLOG_NODE || process.execPath
const historicalDurationMs = new Map([
  ['gateway-switch.test.mjs', 36_000],
  ['deployment-slots.test.mjs', 32_000],
  ['security-source-analyzer.test.mjs', 12_000],
  ['release-traffic-probe-session.test.mjs', 8_000],
  ['release-rollout-probes.test.mjs', 4_000],
  ['release-rollout-evidence.test.mjs', 3_000]
])
const files = String(process.env.FSUSBLOG_STATIC_CONTRACT_FILES ?? '').split('\n').filter(Boolean)
const manifestEnv = { ...process.env }
// The parent shell uses this override to bound its own collect phase. This
// nested workload is process orchestration, so derive its fan-out afresh from
// the admitted STEP CPU/memory grant and orchestrationWorkersPerCpu below.
delete manifestEnv.FSUSBLOG_COMMAND_MANIFEST_WORKERS
const measuredNodeOrchestratorGiB = process.memoryUsage().rss / 1024 ** 3
const zdtShards = [
  ['all', 1_000],
  ['sigkill-resume', 16_000],
  ['explicit-rollback', 12_000],
  ['post-switch-rollback', 7_000],
  ['normal', 7_000],
  ['base', 1_000]
]
const commands = [
  ...files.map((file) => ({
    id: `contract:${file.split('/').at(-1)}`,
    access: 'read',
    command: [node, '--test', file],
    estimatedDurationMs: historicalDurationMs.get(file.split('/').at(-1)) ?? 1_000
  })),
  ...zdtShards.map(([shard, estimatedDurationMs]) => ({
    id: `zdt:${shard}`,
    access: 'read',
    command: [node, '--test', zdtFile],
    environment: { FSUSBLOG_ZDT_FIXTURE_SHARD: shard },
    // Every rehearsal shard controls real process groups and durable observer
    // state. Claim the complete live manifest grant so no sibling rehearsal
    // can kill or adopt another shard's worker process.
    concurrencyWeight: Number.MAX_SAFE_INTEGER,
    estimatedDurationMs
  }))
]
await runWeightedCommandManifest({
  schema: 'fsusblog.test-command-manifest.v1',
  lane: 'static-governance-node-contracts',
  commands
}, {
  cwd: process.cwd(),
  env: manifestEnv,
  orchestrationWorkersPerCpu: 3,
  orchestrationMemoryGiBPerWorker: measuredNodeOrchestratorGiB
})
NODE
}

# Every concurrent-phase writer owns a distinct artifact path and none reads
# Vitest's live report directory. Retention intentionally stays post-Vitest
# because it scans .tmp/test-results/vitest and must never observe partial JSON.
run_static_prechecks_phase() {
  run_collect_parallel static-governance-prechecks \
    evidence-plan static_evidence_plan \
    aeds-policy static_aeds_policy \
    community-workflow static_community_workflow \
    label-governance static_label_governance \
    integrity-docs static_integrity_docs \
    dead-code-index static_dead_code_index \
    background-services static_background_services \
    suite-convergence static_suite_convergence \
    backend-governance static_backend_governance \
    gate-integrity static_gate_integrity \
    flaky-registry static_flaky_registry \
    matrix-contract static_matrix_contract \
    matrix-schema static_matrix_schema \
    implementation-drift static_implementation_drift
}

run_static_concurrent_phase() {
  run_static_prechecks_phase
  run_static_node_contracts_phase
}

run_static_node_contracts_phase() {
  run_collect node-contracts static_node_contracts
}

run_static_post_vitest_phase() {
  run_collect retention static_retention
}

STATIC_GOVERNANCE_PHASE="${FSUSBLOG_STATIC_GOVERNANCE_PHASE:-${1:-all}}"
case "$STATIC_GOVERNANCE_PHASE" in
  concurrent-prechecks)
    run_static_prechecks_phase
    ;;
  concurrent)
    run_static_concurrent_phase
    ;;
  post-vitest)
    run_static_post_vitest_phase
    ;;
  node-contracts)
    run_static_node_contracts_phase
    ;;
  all)
    run_static_concurrent_phase
    run_static_post_vitest_phase
    ;;
  *)
    printf '[lane] unknown static governance phase: %s (expected concurrent-prechecks, concurrent, post-vitest, node-contracts, or all)\n' \
      "$STATIC_GOVERNANCE_PHASE" >&2
    exit 2
    ;;
esac
finish_collect

#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

StaticEvidencePlan() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-evidence-plan; }
StaticAedsPolicy() { Run "$ROOT_DIR/tools/check-aeds-only-policy.sh"; }
StaticCommunityWorkflow() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-community-workflow.mjs"; }
StaticProductVersionDocs() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-public-preview-docs.mjs"; }
StaticPublicPreviewScreenshots() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" check
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" sync
}
StaticLabelGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-github-label-governance.mjs"; }
StaticIntegrityDocs() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-integrity-proof-docs.mjs"; }
StaticDeadCodeIndex() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dead-code-audit-index.mjs"; }
StaticBackgroundServices() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"; }
StaticSuiteConvergence() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"; }
StaticBackendPhysicalTopology() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-physical-topology.mjs" --out "$ROOT_DIR/.tmp/release-evidence/backend-physical-topology.json"; }
StaticBrowserTestMigration() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-browser-test-migration.mjs"; }
StaticTestOrchestrator() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-orchestrator-uniqueness.mjs"; }
StaticTestLifecycle() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-lifecycle.mjs"; }
StaticBackendGovernance() { RunTier "static-governance" RunBackendTestGovernanceOnly; }
StaticGateIntegrity() { Run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test; }
StaticFlakyRegistry() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"; }
StaticMatrixContract() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-contract; }
StaticMatrixSchema() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-schema; }
StaticRetention() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-retention.mjs"; }
StaticImplementationDrift() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-doc-implementation-drift.mjs"; }
StaticAuthoritativeDevelopmentDocs() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-authoritative-development-docs.mjs"; }
StaticDocumentLifecycle() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/generate-document-lifecycle.mjs" --check; }
StaticCodeIntent() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-code-intent.mjs"; }
StaticCustomRulePlatform() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-rule-platform.mjs" --mode full; }
StaticAppsettingsAuthority() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-appsettings-authority.mjs"; }
StaticBackendConfigurationContract() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-backend-configuration-contract.mjs"; }
StaticMonolithicDistributedArchitecture() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-monolithic-distributed-architecture.mjs"; }
StaticCsharpStyle() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/dotnet/check-csharp-style.mjs" --mode full
}
STATIC_NODE_CONTRACT_FILES=(
    "$ROOT_DIR/tests/tools/release-id.test.mjs"
    "$ROOT_DIR/tests/tools/release-manifest.test.mjs"
    "$ROOT_DIR/tests/tools/schema-compatibility-coordinate.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1315-dotnet-release-metadata.test.mjs"
    "$ROOT_DIR/tests/tools/runtime-publish-profile.test.mjs"
    "$ROOT_DIR/tests/tools/final-image-toolchain-pin.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1165-wasm-artifact-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1166-zk-source-layout.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1168-zk-artifact-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1169-release-evidence-model.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1170-security-domain-layout.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1170-security-matrix-catalog.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1174-csharp-entrypoint-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1157-authoritative-development-docs.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1161-document-lifecycle.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1319-product-version-governance.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1158-csharp-style.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1155-code-intent.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1162-rule-platform.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1171-appsettings-authority.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1172-backend-configuration-contract.test.mjs"
    "$ROOT_DIR/tests/tools/configuration-layout.test.mjs"
    "$ROOT_DIR/tests/tools/operations-layout.test.mjs"
    "$ROOT_DIR/tests/tools/monolithic-distributed-architecture.test.mjs"
    "$ROOT_DIR/tests/tools/deployment-slots.test.mjs"
    "$ROOT_DIR/tests/tools/gateway-switch.test.mjs"
    "$ROOT_DIR/tests/tools/dead-code-audit-index.test.mjs"
    "$ROOT_DIR/tests/tools/online-schema-migration-wrapper.test.mjs"
    "$ROOT_DIR/tests/tools/destructive-migration-proof.test.mjs"
    "$ROOT_DIR/tests/tools/release-storage-lifecycle.test.mjs"
    "$ROOT_DIR/tests/tools/backup-envelope-contract.test.mjs"
    "$ROOT_DIR/tests/tools/security-source-analyzer.test.mjs"
    "$ROOT_DIR/tests/tools/test-suite-convergence.test.mjs"
    "$ROOT_DIR/tests/tools/backend-physical-topology.test.mjs"
    "$ROOT_DIR/tests/tools/release-rollout-state.test.mjs"
    "$ROOT_DIR/tests/tools/release-worker-drill.test.mjs"
    "$ROOT_DIR/tests/tools/release-worker-reconciliation.test.mjs"
    "$ROOT_DIR/tests/tools/release-rollout-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/public-aot-warm-evidence.test.mjs"
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
    "$ROOT_DIR/tests/tools/browser-diagnostics.test.mjs"
    "$ROOT_DIR/tests/tools/public-preview-screenshots.test.mjs"
    "$ROOT_DIR/tests/tools/zap-baseline-contract.test.mjs"
    "$ROOT_DIR/tests/tools/browser-migration-contract.test.mjs"
    "$ROOT_DIR/tests/tools/historical-topology-test-dispositions.test.mjs"
    "$ROOT_DIR/tests/tools/command-manifest-behavior.test.mjs"
    "$ROOT_DIR/tests/tools/command-manifest-test-migration.test.mjs"
    "$ROOT_DIR/tests/tools/backend-build-lock-behavior.test.mjs"
    "$ROOT_DIR/tests/tools/runtime-worker-admission.test.mjs"
    "$ROOT_DIR/tests/tools/security-worker-admission.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1151-evidence-governance.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1151-flaky-governance.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1151-receipt-aggregate.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1151-receipt-authority.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1151-receipt-schema.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1152-aeds-frame-cost-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/issue-1154-pod-binary-codec-batch-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/test-orchestrator-uniqueness.test.mjs"
    "$ROOT_DIR/tests/tools/test-lifecycle-governance.test.mjs"
    "$ROOT_DIR/tests/tools/repository-governance-authority.test.mjs"
)
StaticNodeContracts() {
    FSUSBLOG_STATIC_CONTRACT_FILES="$(printf '%s\n' "${STATIC_NODE_CONTRACT_FILES[@]}")" \
        Run "${FSUSBLOG_NODE:-node}" --input-type=module - "$ROOT_DIR/tools/test/run-command-manifest.mjs" "$ROOT_DIR/tests/tools/zero-downtime-rehearsal.test.mjs" <<'NODE'
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
RunApplicationStaticPrechecksPhase() {
    RunCollectParallel application-static-governance-prechecks \
        aeds-policy StaticAedsPolicy \
        background-services StaticBackgroundServices \
        backend-physical-topology StaticBackendPhysicalTopology \
        code-intent StaticCodeIntent \
        custom-rule-platform StaticCustomRulePlatform \
        appsettings-authority StaticAppsettingsAuthority \
        backend-configuration-contract StaticBackendConfigurationContract \
        monolithic-distributed-architecture StaticMonolithicDistributedArchitecture \
        csharp-style StaticCsharpStyle
}

RunTestAssetGovernancePhase() {
    RunCollectParallel test-asset-governance \
        evidence-plan StaticEvidencePlan \
        suite-convergence StaticSuiteConvergence \
        browser-test-migration StaticBrowserTestMigration \
        test-orchestrator StaticTestOrchestrator \
        test-lifecycle StaticTestLifecycle \
        backend-governance StaticBackendGovernance \
        gate-integrity StaticGateIntegrity \
        flaky-registry StaticFlakyRegistry \
        matrix-contract StaticMatrixContract \
        matrix-schema StaticMatrixSchema
    RunCollect retention StaticRetention
}

RunStaticConcurrentPhase() {
    RunApplicationStaticPrechecksPhase
    RunStaticNodeContractsPhase
}

RunStaticNodeContractsPhase() {
    RunCollect node-contracts StaticNodeContracts
}

RunStaticPostVitestPhase() {
    RunCollect retention StaticRetention
}

STATIC_GOVERNANCE_PHASE="${FSUSBLOG_STATIC_GOVERNANCE_PHASE:-${1:-all}}"
case "$STATIC_GOVERNANCE_PHASE" in
    application-prechecks)
        RunApplicationStaticPrechecksPhase
        ;;
    test-assets)
        RunTestAssetGovernancePhase
        ;;
    concurrent-prechecks)
        RunApplicationStaticPrechecksPhase
        ;;
    concurrent)
        RunStaticConcurrentPhase
        ;;
    post-vitest)
        RunStaticPostVitestPhase
        ;;
    node-contracts)
        RunStaticNodeContractsPhase
        ;;
    all)
        RunStaticConcurrentPhase
        RunTestAssetGovernancePhase
        ;;
    *)
        printf '[lane] unknown static governance phase: %s (expected application-prechecks, test-assets, concurrent-prechecks, concurrent, post-vitest, node-contracts, or all)\n' \
            "$STATIC_GOVERNANCE_PHASE" >&2
        exit 2
        ;;
esac
FinishCollect

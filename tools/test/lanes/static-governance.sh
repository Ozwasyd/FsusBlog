#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

StaticEvidencePlan() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-evidence-plan; }
StaticAedsPolicy() { Run "$ROOT_DIR/tools/check-aeds-only-policy.sh"; }
StaticBackgroundServices() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"; }
StaticSuiteConvergence() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"; }
StaticBackendPhysicalTopology() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-physical-topology.mjs" --out "$ROOT_DIR/.tmp/release-evidence/backend-physical-topology.json"; }
StaticBrowserTestMigration() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-browser-test-migration.mjs"; }
StaticTestLifecycle() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-lifecycle.mjs"; Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/native-test-governance.mjs"; }
StaticArticleCoreTestApi() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-core-test-api.mjs"; }
StaticBackendGovernance() { RunTier "static-governance" RunBackendTestGovernanceOnly; }
StaticGateIntegrity() { Run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test; }
StaticFlakyRegistry() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"; }
StaticMatrixContract() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-contract; }
StaticMatrixSchema() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-schema; }
StaticRetention() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-retention.mjs"; }
StaticCodeIntent() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-code-intent.mjs"; }
StaticCustomRulePlatform() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-rule-platform.mjs" --mode full; }
StaticAppsettingsAuthority() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-appsettings-authority.mjs"; }
StaticBackendConfigurationContract() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-backend-configuration-contract.mjs"; }
StaticMonolithicDistributedArchitecture() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-monolithic-distributed-architecture.mjs"; }
StaticCsharpStyle() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/dotnet/check-csharp-style.mjs" --mode full
}
TEST_ASSET_BEHAVIOR_FILES=(
    "$ROOT_DIR/tests/tools/artifact-digest-table.test.mjs"
    "$ROOT_DIR/tests/tools/async-log-pipeline.test.mjs"
    "$ROOT_DIR/tests/tools/cross-stack-receipt-join.test.mjs"
    "$ROOT_DIR/tests/tools/dotnet-build-server-cleanup.test.mjs"
    "$ROOT_DIR/tests/tools/frontend-vitest-rolling-shards.test.mjs"
    "$ROOT_DIR/tests/tools/production-resource-enforcement.test.mjs"
    "$ROOT_DIR/tests/tools/resource-utilization.test.mjs"
    "$ROOT_DIR/tests/tools/run-once.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-priority-score.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-scheduler.test.mjs"
)
StaticTestAssetBehavior() {
    Run "${FSUSBLOG_NODE:-node}" --test "${TEST_ASSET_BEHAVIOR_FILES[@]}"
}
STATIC_NODE_CONTRACT_FILES=(
    "$ROOT_DIR/tests/security/perception-character-v3-pool.test.mjs"
    "$ROOT_DIR/tests/tools/release-id.test.mjs"
    "$ROOT_DIR/tests/tools/release-manifest.test.mjs"
    "$ROOT_DIR/tests/tools/schema-compatibility-coordinate.test.mjs"
    "$ROOT_DIR/tests/tools/public-representation-coordinate.test.mjs"
    "$ROOT_DIR/tests/tools/public-representation-coordinate-carriers.test.mjs"
    "$ROOT_DIR/tests/tools/dotnet-release-metadata.test.mjs"
    "$ROOT_DIR/tests/tools/runtime-publish-profile.test.mjs"
    "$ROOT_DIR/tests/tools/final-image-toolchain-pin.test.mjs"
    "$ROOT_DIR/tests/tools/wasm-artifact-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/zk-source-layout.test.mjs"
    "$ROOT_DIR/tests/tools/zk-artifact-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/release-evidence-model.test.mjs"
    "$ROOT_DIR/tests/tools/security-domain-layout.test.mjs"
    "$ROOT_DIR/tests/tools/security-matrix-catalog.test.mjs"
    "$ROOT_DIR/tests/tools/csharp-entrypoint-ownership.test.mjs"
    "$ROOT_DIR/tests/tools/authoritative-development-docs.test.mjs"
    "$ROOT_DIR/tests/tools/document-lifecycle.test.mjs"
    "$ROOT_DIR/tests/tools/public-design-document-authority.test.mjs"
    "$ROOT_DIR/tests/tools/account-layout-document-authority.test.mjs"
    "$ROOT_DIR/tests/tools/document-topic-retirement.test.mjs"
    "$ROOT_DIR/tests/tools/release-document-convergence.test.mjs"
    "$ROOT_DIR/tests/tools/product-version-governance.test.mjs"
    "$ROOT_DIR/tests/tools/csharp-style.test.mjs"
    "$ROOT_DIR/tests/tools/code-intent.test.mjs"
    "$ROOT_DIR/tests/tools/rule-platform.test.mjs"
    "$ROOT_DIR/tests/tools/appsettings-authority.test.mjs"
    "$ROOT_DIR/tests/tools/backend-configuration-contract.test.mjs"
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
    "$ROOT_DIR/tests/tools/browser-readiness-contract.test.mjs"
    "$ROOT_DIR/tests/tools/browser-capability-contract.test.mjs"
    "$ROOT_DIR/tests/tools/browser-capability-risk.test.mjs"
    "$ROOT_DIR/tests/tools/historical-topology-test-dispositions.test.mjs"
    "$ROOT_DIR/tests/tools/command-manifest-behavior.test.mjs"
    "$ROOT_DIR/tests/tools/command-manifest-test-migration.test.mjs"
    "$ROOT_DIR/tests/tools/backend-build-lock-behavior.test.mjs"
    "$ROOT_DIR/tests/tools/backend-production-build-authority.test.mjs"
    "$ROOT_DIR/tests/tools/backend-production-build-authority-measurement.test.mjs"
    "$ROOT_DIR/tests/tools/changed-critical-mutation.test.mjs"
    "$ROOT_DIR/tests/tools/canonical-hash-source-governance.test.mjs"
    "$ROOT_DIR/tests/tools/runtime-worker-admission.test.mjs"
    "$ROOT_DIR/tests/tools/security-worker-admission.test.mjs"
    "$ROOT_DIR/tests/tools/test-evidence-governance.test.mjs"
    "$ROOT_DIR/tests/tools/flaky-test-governance.test.mjs"
    "$ROOT_DIR/tests/tools/test-evidence-receipt-aggregation.test.mjs"
    "$ROOT_DIR/tests/tools/test-evidence-receipt-authority.test.mjs"
    "$ROOT_DIR/tests/tools/test-evidence-receipt-schema.test.mjs" "$ROOT_DIR/tests/tools/test-observation-ledger.test.mjs"
    "$ROOT_DIR/tests/tools/flaky-observation-lane.test.mjs"
    "$ROOT_DIR/tests/tools/aeds-frame-cost-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/pod-binary-codec-batch-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/test-lifecycle-governance.test.mjs"
    "$ROOT_DIR/tests/tools/test-asset-semantic-renames.test.mjs"
    "$ROOT_DIR/tests/tools/rights-v3-projection.test.mjs"
    "$ROOT_DIR/tests/tools/repository-governance-authority.test.mjs"
    "$ROOT_DIR/tests/tools/privacy-zk-prebuild-projection.test.mjs"
    "$ROOT_DIR/tests/tools/article-core-test-api-governance.test.mjs" "$ROOT_DIR/tests/tools/native-test-governance.test.mjs" "$ROOT_DIR/tests/tools/test-asset-audit.test.mjs" "$ROOT_DIR/tests/tools/governance-suite-plan.test.mjs"
)
StaticNodeContracts() {
    FSUSBLOG_STATIC_CONTRACT_FILES="$(printf '%s\n' "${STATIC_NODE_CONTRACT_FILES[@]}")" \
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-governance-suites.mjs" \
            "$ROOT_DIR/tests/tools/zero-downtime-rehearsal.test.mjs"
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
        test-lifecycle StaticTestLifecycle \
        canonical-node-behavior StaticTestAssetBehavior \
        article-core-test-api StaticArticleCoreTestApi \
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

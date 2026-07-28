#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

StaticEvidencePlan() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-evidence-plan; }
StaticAedsPolicy() { Run "$ROOT_DIR/tools/check-aeds-only-policy.sh"; }
StaticPerceptionCharacterV3Cutover() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/generate-perception-character-v3-release-target.mjs" --check
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/check-perception-character-v3-retirement.mjs"
}
StaticBackgroundServices() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"; }
StaticSuiteConvergence() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"; }
StaticWallClockGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/check-wall-clock-governance.mjs"; }
StaticTemporalProducerBindings() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/verify-temporal-producers.mjs" --kind catalog; }
StaticBackendPhysicalTopology() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-physical-topology.mjs" --out "${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/backend-physical-topology.json"; }
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
StaticLabelGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-github-label-governance.mjs"; }
StaticAppsettingsAuthority() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-appsettings-authority.mjs"; }
StaticBackendConfigurationContract() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-backend-configuration-contract.mjs"; }
StaticMonolithicDistributedArchitecture() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-monolithic-distributed-architecture.mjs"; }
StaticCsharpStyle() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/dotnet/check-csharp-style.mjs" --mode full
}
StaticLineEndings() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/style/line-ending-invariant.mjs"
}
TEST_ASSET_BEHAVIOR_FILES=(
    "$ROOT_DIR/tests/tools/artifact-digest-table.test.mjs"
    "$ROOT_DIR/tests/tools/async-log-pipeline.test.mjs"
    "$ROOT_DIR/tests/tools/backend-coverage-collector-layout.test.mjs"
    "$ROOT_DIR/tests/tools/backend-coverage-pipeline.test.mjs"
    "$ROOT_DIR/tests/tools/behavior-doc-static-admission.test.mjs"
    "$ROOT_DIR/tests/tools/coverage-merge-parallelism.test.mjs"
    "$ROOT_DIR/tests/tools/cross-stack-receipt-join.test.mjs"
    "$ROOT_DIR/tests/tools/content-addressed-build-cache.test.mjs"
    "$ROOT_DIR/tests/tools/dotnet-build-server-cleanup.test.mjs"
    "$ROOT_DIR/tests/tools/no-global-dotnet-build-server-shutdown.test.mjs"
    "$ROOT_DIR/tests/tools/physical-execution-process-tree.test.mjs"
    "$ROOT_DIR/tests/tools/frontend-vitest-rolling-shards.test.mjs"
    "$ROOT_DIR/tests/tools/production-resource-enforcement.test.mjs"
    "$ROOT_DIR/tests/tools/resource-utilization.test.mjs"
    "$ROOT_DIR/tests/tools/run-once.test.mjs"
    "$ROOT_DIR/tests/tools/run-once-fixture-reuse.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-priority-score.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-scheduler.test.mjs"
)
StaticTestAssetBehavior() {
    Run "${FSUSBLOG_NODE:-node}" --test "${TEST_ASSET_BEHAVIOR_FILES[@]}"
}
StaticNodeContracts() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-governance-suites.mjs"
}

# Every concurrent-phase writer owns a distinct artifact path and none reads
# Vitest's live report directory. Retention intentionally stays post-Vitest
# because it scans .tmp/test-results/vitest and must never observe partial JSON.
RunApplicationStaticPrechecksPhase() {
    RunCollectParallel application-static-governance-prechecks \
        aeds-policy StaticAedsPolicy \
        perception-character-v3-cutover StaticPerceptionCharacterV3Cutover \
        background-services StaticBackgroundServices \
        backend-physical-topology StaticBackendPhysicalTopology \
        code-intent StaticCodeIntent \
        custom-rule-platform StaticCustomRulePlatform \
        appsettings-authority StaticAppsettingsAuthority \
        backend-configuration-contract StaticBackendConfigurationContract \
        monolithic-distributed-architecture StaticMonolithicDistributedArchitecture \
        line-endings StaticLineEndings \
        csharp-style StaticCsharpStyle \
        label-governance StaticLabelGovernance
}

RunTestAssetGovernancePhase() {
    RunCollectParallel test-asset-governance \
        evidence-plan StaticEvidencePlan \
        suite-convergence StaticSuiteConvergence \
        wall-clock-governance StaticWallClockGovernance \
        temporal-producer-bindings StaticTemporalProducerBindings \
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

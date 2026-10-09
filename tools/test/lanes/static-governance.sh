#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

StaticEvidencePlan() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-evidence-plan; }
StaticAedsPolicy() { Run "$ROOT_DIR/tools/check-aeds-only-policy.sh"; }
StaticIntegrityDocs() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-integrity-proof-docs.mjs"; }
StaticImplementationDrift() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-doc-implementation-drift.mjs"; }
StaticCurrentSchemaAuthority() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-current-schema-authority.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/current-schema-authority.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/generate-migration-assembly-receipt.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-migration-assembly-boundary.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-schema-allowed-extra-tables.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/schema-allowed-extra-tables.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/generate-schema-allowed-extra-links.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-schema-allowed-extra-links.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/schema-allowed-extra-links.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/migration-assembly-boundary.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/generate-offline-migration-catalog.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-offline-migration-catalog-parity.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/offline-migration-catalog-parity.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-server-migration-cutover.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/server-migration-cutover.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/db/check-migration-terminal-governance.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/migration-terminal-governance.test.mjs"
}
StaticPerceptionCharacterV3Cutover() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/generate-perception-character-v3-release-target.mjs" --check
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/check-perception-character-v3-retirement.mjs"
}
StaticBackgroundServices() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"; }
StaticSuiteConvergence() {
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tools/post-baseline-history.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"
}
StaticWallClockGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/check-wall-clock-governance.mjs"; }
StaticTemporalProducerBindings() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/verify-temporal-producers.mjs" --kind catalog; }
StaticBackendPhysicalTopology() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/architecture/check-backend-physical-topology.mjs" --out "${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/backend-physical-topology.json"; }
StaticBrowserTestMigration() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-browser-test-migration.mjs"; }
StaticTestLifecycle() {
    local retentionAudit="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/test-retention-audit.json"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-lifecycle.mjs" --audit-input "$retentionAudit"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/native-test-governance.mjs"
}
StaticTestReplacementDiff() {
    local base="${FSUSBLOG_TEST_REPLACEMENT_DIFF_BASE:-origin/master}"
    local transactions=()
    mapfile -t transactions < <(git -C "$ROOT_DIR" diff --name-only "$base" HEAD -- 'tests/test-replacement-transactions/*.json')
    if ((${#transactions[@]} > 1)); then
        echo "[test-replacement] multiple current transactions are ambiguous: ${transactions[*]}" >&2
        return 1
    fi
    if ((${#transactions[@]} == 1)); then
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-replacement-transaction.mjs" check-diff "$base" "${transactions[0]}"
    else
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-replacement-transaction.mjs" check-diff "$base"
    fi
}
StaticArticleCoreTestApi() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-core-test-api.mjs"; }
StaticRevisionCompareAuthority() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-revision-compare-authority.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/revision-compare-authority.test.mjs"
}
StaticBackendGovernance() { RunTier "static-governance" RunBackendTestGovernanceOnly; }
StaticGateIntegrity() { Run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test; }
StaticFlakyRegistry() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"; }
StaticMatrixContract() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-contract; }
StaticMatrixSchema() { Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" static-matrix-schema; }
StaticRetention() {
    local retentionAudit="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/test-retention-audit.json"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-retention.mjs" --out "$retentionAudit"
}
StaticTestAssetAudit() {
    local retentionAudit="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}/test-retention-audit.json"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-test-asset-audit.mjs" --phase discovery --audit-input "$retentionAudit"
}
StaticCodeIntent() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-code-intent.mjs"; }
StaticCustomRulePlatform() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-rule-platform.mjs" --mode full; }
StaticLabelGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-github-label-governance.mjs"; }
StaticAppsettingsAuthority() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-appsettings-authority.mjs"; }
StaticBackendConfigurationContract() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/configuration/check-backend-configuration-contract.mjs"; }
StaticMonolithicDistributedArchitecture() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-monolithic-distributed-architecture.mjs"; }
StaticBehaviorMutationGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-behavior-mutation-governance.mjs"; }
StaticPostRuntimeProducerRegistry() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test-matrix/post-runtime-producer-registry.mjs"; }
StaticFixtureMutationRecoveryGovernance() { Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-fixture-mutation-recovery-governance.mjs"; }
StaticArticleEmbedContract() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-embed-contract.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-embed-contract.test.mjs"
}
StaticArticleEmbedAuthoring() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-embed-authoring.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-embed-authoring.test.mjs"
}
StaticArticleEmbedPublication() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-embed-publication.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-embed-publication.test.mjs"
}
StaticArticleEmbedRelations() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-embed-relations.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-embed-relations.test.mjs"
}
StaticBlockAnchorContract() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-block-anchor-contract.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/block-anchor-contract.test.mjs"
}
StaticArticleRelations() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-relations.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-relations.test.mjs"
}
StaticArticleScalePlanGovernance() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/check-article-scale-plan-governance.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-scale-plan-governance.test.mjs"
}
StaticArticleBulkAuthorityGovernance() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-bulk-authorities.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-bulk-authorities.test.mjs"
}
StaticCsharpStyle() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/dotnet/check-csharp-style.mjs" --mode full
}
StaticArticlePropertyDefinitionAuthority() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-article-property-definition-authority.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/article-property-definition-authority.test.mjs"
}
StaticLineEndings() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/style/line-ending-invariant.mjs"
}
StaticCentralPackageManagement() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-central-package-management.mjs" --root "$ROOT_DIR"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-central-package-management.mjs" \
        --fixtures "$ROOT_DIR/tests/fixtures/governance/central-package-management.json"
}
StaticDependencyUpdateSurface() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-update-surface.mjs" \
        --root "$ROOT_DIR" \
        --fixtures "$ROOT_DIR/tests/fixtures/governance/dependency-update-surface.json"
}
StaticDependencyFreshness() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-freshness.mjs" \
        --root "$ROOT_DIR" \
        --fixtures "$ROOT_DIR/tests/fixtures/governance/dependency-freshness.json"
}
StaticDependencyRequiredChecks() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-required-checks.mjs" --root "$ROOT_DIR"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-required-checks.mjs" \
        --fixtures "$ROOT_DIR/tests/fixtures/governance/dependency-required-checks.json"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/dependency-required-checks.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/cross-repository-dependency-acceptance.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/fsusui-release-event.test.mjs"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/fsusui-candidate.test.mjs"
}
StaticDependencyAutomerge() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-automerge.mjs" --root "$ROOT_DIR"
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dependency-automerge.mjs" \
        --fixtures "$ROOT_DIR/tests/fixtures/governance/dependency-automerge.json"
    Run "${FSUSBLOG_NODE:-node}" --test "$ROOT_DIR/tests/tools/dependency-automerge.test.mjs"
}
TEST_ASSET_BEHAVIOR_FILES=(
    "$ROOT_DIR/tests/tools/artifact-digest-table.test.mjs"
    "$ROOT_DIR/tests/tools/async-log-pipeline.test.mjs"
    "$ROOT_DIR/tests/tools/backend-coverage-collector-layout.test.mjs"
    "$ROOT_DIR/tests/tools/backend-coverage-pipeline.test.mjs"
    "$ROOT_DIR/tests/tools/backend-test-governance-cpm.test.mjs"
    "$ROOT_DIR/tests/tools/behavior-doc-static-admission.test.mjs"
    "$ROOT_DIR/tests/tools/behavior-evidence-pre-runtime.test.mjs"
    "$ROOT_DIR/tests/tools/coverage-merge-parallelism.test.mjs"
    "$ROOT_DIR/tests/tools/cross-stack-receipt-join.test.mjs"
    "$ROOT_DIR/tests/tools/content-addressed-build-cache.test.mjs"
    "$ROOT_DIR/tests/tools/dotnet-build-server-cleanup.test.mjs"
    "$ROOT_DIR/tests/tools/evidence-location-contract.test.mjs"
    "$ROOT_DIR/tests/tools/evidence-location-governance.test.mjs"
    "$ROOT_DIR/tests/tools/fixture-mutation-recovery.test.mjs"
    "$ROOT_DIR/tests/tools/linux-cgroup-membership-locator.test.mjs"
    "$ROOT_DIR/tests/tools/no-global-dotnet-build-server-shutdown.test.mjs"
    "$ROOT_DIR/tests/tools/physical-execution-process-tree.test.mjs"
    "$ROOT_DIR/tests/tools/frontend-vitest-rolling-shards.test.mjs"
    "$ROOT_DIR/tests/tools/produce-behavior-test-evidence.test.mjs"
    "$ROOT_DIR/tests/tools/media-negative-corpus.test.mjs"
    "$ROOT_DIR/tests/tools/media-positive-generator.test.mjs"
    "$ROOT_DIR/tests/tools/media-shape-catalog.test.mjs"
    "$ROOT_DIR/tests/tools/production-resource-enforcement.test.mjs"
    "$ROOT_DIR/tests/tools/release-deployment-doc-exactness.test.mjs"
    "$ROOT_DIR/tests/tools/resource-utilization.test.mjs"
    "$ROOT_DIR/tests/tools/run-once.test.mjs"
    "$ROOT_DIR/tests/tools/run-once-fixture-reuse.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-priority-score.test.mjs"
    "$ROOT_DIR/tests/tools/test-matrix-scheduler.test.mjs"
    "$ROOT_DIR/tests/tools/verify-behavior-test-evidence.test.mjs"
)
StaticTestAssetBehavior() {
    (
        # These tests create nested scheduler/coverage repositories. Their
        # fixture identities must come from those repositories rather than the
        # enclosing static-governance tier.
        unset FSUSBLOG_ARTIFACT_DIGEST_TABLE
        unset FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE
        unset FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID
        unset FSUSBLOG_TEST_RUN_ID
        unset FSUSBLOG_TEST_SOURCE_COMMIT
        unset FSUSBLOG_TEST_SOURCE_FINGERPRINT
        Run "${FSUSBLOG_NODE:-node}" --test --test-concurrency=1 "${TEST_ASSET_BEHAVIOR_FILES[@]}"
    )
}
StaticNodeContracts() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-governance-suites.mjs"
}

# Every concurrent-phase writer owns a distinct artifact path and none reads
# Vitest's live report directory. The test-assets phase stays post-Vitest, then
# seals the canonical retention audit before lifecycle and parallel consumers.
RunApplicationStaticPrechecksPhase() {
    RunCollectParallel application-static-governance-prechecks \
        aeds-policy StaticAedsPolicy \
        integrity-docs StaticIntegrityDocs \
        implementation-drift StaticImplementationDrift \
        current-schema-authority StaticCurrentSchemaAuthority \
        perception-character-v3-cutover StaticPerceptionCharacterV3Cutover \
        background-services StaticBackgroundServices \
        backend-physical-topology StaticBackendPhysicalTopology \
        code-intent StaticCodeIntent \
        custom-rule-platform StaticCustomRulePlatform \
        appsettings-authority StaticAppsettingsAuthority \
        backend-configuration-contract StaticBackendConfigurationContract \
        monolithic-distributed-architecture StaticMonolithicDistributedArchitecture \
        behavior-mutation-governance StaticBehaviorMutationGovernance \
        post-runtime-producer-registry StaticPostRuntimeProducerRegistry \
        fixture-mutation-recovery-governance StaticFixtureMutationRecoveryGovernance \
        article-embed-contract StaticArticleEmbedContract \
        article-embed-authoring StaticArticleEmbedAuthoring \
        article-embed-publication StaticArticleEmbedPublication \
        article-embed-relations StaticArticleEmbedRelations \
        block-anchor-contract StaticBlockAnchorContract \
        article-relations StaticArticleRelations \
        article-scale-plan-governance StaticArticleScalePlanGovernance \
        article-bulk-authority-governance StaticArticleBulkAuthorityGovernance \
        article-property-definition-authority StaticArticlePropertyDefinitionAuthority \
        central-package-management StaticCentralPackageManagement \
        dependency-update-surface StaticDependencyUpdateSurface \
        dependency-freshness StaticDependencyFreshness \
        dependency-required-checks StaticDependencyRequiredChecks \
        dependency-automerge StaticDependencyAutomerge \
        line-endings StaticLineEndings \
        csharp-style StaticCsharpStyle \
        label-governance StaticLabelGovernance
}

RunTestAssetGovernancePhase() {
    StaticRetention
    RunCollectParallel test-asset-governance \
        evidence-plan StaticEvidencePlan \
        suite-convergence StaticSuiteConvergence \
        wall-clock-governance StaticWallClockGovernance \
        temporal-producer-bindings StaticTemporalProducerBindings \
        test-asset-audit StaticTestAssetAudit \
        browser-test-migration StaticBrowserTestMigration \
        test-replacement-diff StaticTestReplacementDiff \
        test-lifecycle StaticTestLifecycle \
        revision-compare-authority StaticRevisionCompareAuthority \
        canonical-node-behavior StaticTestAssetBehavior \
        article-core-test-api StaticArticleCoreTestApi \
        backend-governance StaticBackendGovernance \
        gate-integrity StaticGateIntegrity \
        flaky-registry StaticFlakyRegistry \
        matrix-contract StaticMatrixContract \
        matrix-schema StaticMatrixSchema
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

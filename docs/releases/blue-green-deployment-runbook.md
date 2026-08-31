# Blue/Green deployment runbook

## Local validation

```bash
node --test tests/tools/deployment-slots.test.mjs tests/tools/gateway-switch.test.mjs
node tools/run-test-matrix.mjs validate
```

## Current production bundle ordering

<!-- fsus-doc-claim
claimId: browserless-production-correctness.bundle-order
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: release.production-bundle-order
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.production-bundle-order -->
| Key | Value |
| --- | --- |
| bundleIds | ["backend-tests","build-static","frontend-tests","performance-evidence","runtime-browser"] |
| edges | ["backend-tests->performance-evidence","build-static->performance-evidence","frontend-tests->performance-evidence","runtime-browser->performance-evidence"] |
| hasDependencyEdges | true |
| profileId | production |
| topoOrderConstraints | ["after:performance-evidence\|requires:backend-tests","after:performance-evidence\|requires:build-static","after:performance-evidence\|requires:frontend-tests","after:performance-evidence\|requires:runtime-browser"] |
<!-- FSUSBLOG-GENERATED:END release.production-bundle-order -->

## Observed blue/green authority

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.claims-blocked-until-authority-verified
behaviorId: deployment-blue-green-runtime-role
claimType: boolean
factPath: deploymentBlueGreen.claimEligible
render: boolean-negated
-->

Release claims for this behavior stay false until schema and volume protection authorities are observed and ownership leaves conflict-unknown; an unknown or ambiguous active identity fails closed and blocks the operation.

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.blue-green-contract
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: deployment.blue-green-contract
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN deployment.blue-green-contract -->
| Key | Value |
| --- | --- |
| abortedTransitionStatus | failed |
| activeAssetAction | retain |
| activeAssetReasons | ["active","minimum-retention-count"] |
| activeIdentity | ["activeImageDigest","activeReleaseId","activeSlot"] |
| artifactProtectionAuthorityState | observed-in-release-gc-plan-probe |
| authorityModules | {"releaseAssetsGc":{"sourceDigest":"6b81a4b46d4d479479bb37ff85d79ac18a016b4872384f94fcb5fcc7416c02b3","sourcePath":"tools/storage/release-gc.mjs"},"rollout":{"sourceDigest":"cbb0f9a9189c24adb9266a7d11e4ff69f1b40f6ec090d565bdd4788335e17d0b","sourcePath":"tools/deployment/release-rollout-lib.mjs"},"slot":{"sourceDigest":"a8ec1666cf92eee86e02d652b90cdcbedb04f1470d01ab66fa25a37cf7931d73","sourcePath":"tools/deployment/slot-lib.mjs"}} |
| authorityState | conflict-unknown |
| claimEligibilityReasons | ["runtime-ownership-authority-conflict","schema-protection-authority-missing","volume-protection-authority-missing"] |
| claimEligible | false |
| proofIds | ["release-assets.active-release-retained","rollout.failed-stage-recovery-derived","slot.active-stop-rejected","slot.gateway-transition-state-derived","slot.identity-mismatch-rejected"] |
| rollbackRequiredState | rollback_required |
| rolloutFailureState | recovery_required |
| rolloutRecoveryAction | preserve-source-stop-candidate |
| rolloutStages | ["manifest-validate","capacity-preflight","backup-restore-gate","expand-migration","asset-materialize","candidate-start","candidate-readiness","candidate-smoke","compatibility-smoke","gateway-switch","source-drain","active-fence","public-verify","source-stop","release-evidence"] |
| rolloutStateSchema | fsusblog.release-rollout-state.v1 |
| runtimeProtectionAuthorityState | observed-in-slot-state-machine-probe |
| schemaProtectionAuthorityState | not-expressed-by-current-authorities |
| slotStateSchema | fsusblog.deployment-slots.v1 |
| slots | ["blue","green"] |
| stopActiveResult | refusing to stop active slot blue |
| switchState | switching |
| unknownIdentityResult | active release identity does not match slot record |
| volumeProtectionAuthorityState | not-expressed-by-current-authorities |
<!-- FSUSBLOG-GENERATED:END deployment.blue-green-contract -->

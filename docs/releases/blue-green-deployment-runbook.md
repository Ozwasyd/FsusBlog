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
| bundleIds | &#91;"backend-tests","build-static","frontend-tests","performance-evidence","runtime-browser"&#93; |
| edges | &#91;"backend-tests-&#62;performance-evidence","build-static-&#62;performance-evidence","frontend-tests-&#62;performance-evidence","runtime-browser-&#62;performance-evidence"&#93; |
| hasDependencyEdges | true |
| profileId | production |
| topoOrderConstraints | &#91;"after:performance-evidence\|requires:backend-tests","after:performance-evidence\|requires:build-static","after:performance-evidence\|requires:frontend-tests","after:performance-evidence\|requires:runtime-browser"&#93; |
<!-- FSUSBLOG-GENERATED:END release.production-bundle-order -->

## Observed blue/green authority

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.claims-blocked-until-authority-verified
behaviorId: deployment-blue-green-runtime-role
claimType: boolean
factPath: deploymentBlueGreen.claimEligible
render: boolean-negated
-->

`claimEligible` is `false` because the active-resource checks below are synthetic library proofs, not production-current observations. Schema overlap, exact volume topology and runtime ownership remain source-bound, while production volume/schema cleanup and any unknown active identity stay explicitly unsupported and fail closed.

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
| activeArtifactIdentity | {"deploymentGeneration":1,"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseId":"20260101000000-aaaaaaaaaaaa","rolloutId":"runtime-observation-rollout","slot":"blue"} |
| activeAssetAction | retain |
| activeAssetReasons | &#91;"active","minimum-retention-count"&#93; |
| activeIdentity | &#91;"activeImageDigest","activeReleaseId","activeSlot"&#93; |
| artifactProtectionAuthorityState | synthetic-library-proof |
| authorityModules | {"destructiveOperations":{"sourceDigest":"fba219fa1e9371f3c85088be23b8b690b153d9b6ba82c0e040fd29c64b156d10","sourcePath":"tools/deployment/destructive-operation-authority.mjs"},"onlineSchema":{"sourceDigest":"8c76bae9a6da950dae0467944d2e087d269c66fede75bc4f8fab32d2ae6d5e09","sourcePath":"src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs"},"releaseAssetsGc":{"sourceDigest":"49d15878aa51e0eecad609e936402aab8658b5bfb04ac8572e4e4c5822af12d7","sourcePath":"tools/storage/release-gc.mjs"},"rollout":{"sourceDigest":"cbb0f9a9189c24adb9266a7d11e4ff69f1b40f6ec090d565bdd4788335e17d0b","sourcePath":"tools/deployment/release-rollout-lib.mjs"},"slot":{"sourceDigest":"a8ec1666cf92eee86e02d652b90cdcbedb04f1470d01ab66fa25a37cf7931d73","sourcePath":"tools/deployment/slot-lib.mjs"},"topologyAuthority":{"sourceDigest":"5d2caf9a77330028d94a5ff8b92c748e2d4a2af7ffba6c4b32197b6ac37a9ec3","sourcePath":"tools/governance/check-monolithic-distributed-architecture.mjs"}} |
| authorityState | synthetic-library-proof |
| claimEligibilityReasons | &#91;"production-current-active-resource-evidence-absent"&#93; |
| claimEligible | false |
| destructiveAuthority | {"contentDigest":"sha256:bfdce7ca0918af2cc87163d5e804595ac73c4cabc9587927e443f4581379b2aa","schema":"fsusblog.destructive-operation-authority.v1","schemaCleanupStatus":"unsupported","volumeCleanupStatus":"unsupported"} |
| evidenceClass | synthetic-library-proof |
| proofIds | &#91;"release-assets.active-release-retained","rollout.failed-stage-recovery-derived","slot.active-stop-rejected","slot.gateway-transition-state-derived","slot.identity-mismatch-rejected"&#93; |
| rollbackRequiredState | rollback_required |
| rolloutFailureState | recovery_required |
| rolloutRecoveryAction | preserve-source-stop-candidate |
| rolloutStages | &#91;"manifest-validate","capacity-preflight","backup-restore-gate","expand-migration","asset-materialize","candidate-start","candidate-readiness","candidate-smoke","compatibility-smoke","gateway-switch","source-drain","active-fence","public-verify","source-stop","release-evidence"&#93; |
| rolloutStateSchema | fsusblog.release-rollout-state.v1 |
| runtimeProtectionAuthorityState | synthetic-library-proof |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:f786a88f19c4412d0969d9ff43b6b4d57681759e432e6299e8bbbb76c02c0ba4","catalogMetadataCount":148,"claimEligible":true,"concurrentContractFailureCodes":&#91;"schema&#95;contract&#95;backfill&#95;incomplete","schema&#95;contract&#95;backfill&#95;unverified","schema&#95;contract&#95;backup&#95;restore&#95;stale","schema&#95;contract&#95;confirmation&#95;missing","schema&#95;contract&#95;current&#95;release&#95;dependency","schema&#95;contract&#95;exclusive&#95;mode&#95;missing","schema&#95;contract&#95;observation&#95;window","schema&#95;contract&#95;old&#95;writes&#95;enabled","schema&#95;contract&#95;previous&#95;release&#95;dependency","schema&#95;contract&#95;release&#95;window&#95;open","schema&#95;contract&#95;rollback&#95;manifest&#95;open","schema&#95;contract&#95;slot&#95;switch&#95;in&#95;progress"&#93;,"databaseObservationDigest":"sha256:7ef96eb11ea6d87bf071eced3da341ae768a37545ba5aa341a9c23ff625124f9","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":148,"manifestDigest":"sha256:6c65f2699ae955b8119088f7bc22dd783718772bf02a45c520fab1e933e0225a","missingExpandFailureCodes":&#91;"schema&#95;expand&#95;pending"&#93;,"previousRollbackReleaseId":"20261002000000-ee44adbe2f8b","sameReleaseFailureCode":"schema&#95;previous&#95;rollback&#95;release&#95;not&#95;distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20261003000000-ee44adbe2f8b","sourceReleaseManifestDigest":"sha256:adb8749b1042b23011ad0d4167dcf02190b78cfa3814439f84e1a7fdaf1d34b1","targetReadiness":"ready","targetReleaseId":"20261004000000-ee44adbe2f8b","targetReleaseManifestDigest":"sha256:9d25c5b8dc3611ef4108981b661560895bd1cdd83a683a36efac5a296118e500"} |
| schemaProtectionAuthorityState | synthetic-library-proof |
| slotStateSchema | fsusblog.deployment-slots.v1 |
| slots | &#91;"blue","green"&#93; |
| stopActiveResult | refusing to stop active slot blue |
| switchState | switching |
| unknownIdentityResult | active release identity does not match slot record |
| volumeProtectionAuthorityState | synthetic-library-proof |
| volumeScopes | {"operator-shared":&#91;"/app/config/zk","/app/secrets/zk"&#93;,"release-artifact-store":&#91;"/app/release-assets"&#93;,"release-identity":&#91;"/app/release-manifest.json"&#93;,"shared-between-slots":&#91;"/app/data-protection","/app/release-derived","/app/storage"&#93;,"slot-private":&#91;"/app/Logs","/app/data","/app/wwwroot/aot-cache"&#93;} |
| volumeTopology | {"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG&#95;SLOT&#95;LOGS&#95;VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG&#95;ZK&#95;CONFIG&#95;DIR:?Set FSUSBLOG&#95;ZK&#95;CONFIG&#95;DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG&#95;SLOT&#95;DATA&#95;VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG&#95;SHARED&#95;DATA&#95;PROTECTION&#95;VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG&#95;RELEASE&#95;ASSET&#95;STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG&#95;SHARED&#95;RELEASE&#95;DERIVED&#95;VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG&#95;RELEASE&#95;MANIFEST&#95;HOST&#95;PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG&#95;ZK&#95;SECRET&#95;DIR:?Set FSUSBLOG&#95;ZK&#95;SECRET&#95;DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG&#95;SHARED&#95;PUBLIC&#95;ASSETS&#95;VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG&#95;SLOT&#95;AOT&#95;CACHE&#95;VOLUME:?Set slot-specific AOT cache volume}"}} |
<!-- FSUSBLOG-GENERATED:END deployment.blue-green-contract -->

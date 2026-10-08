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
| edges | ["backend-tests-&gt;performance-evidence","build-static-&gt;performance-evidence","frontend-tests-&gt;performance-evidence","runtime-browser-&gt;performance-evidence"] |
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
| activeAssetReasons | ["active","minimum-retention-count"] |
| activeIdentity | ["activeImageDigest","activeReleaseId","activeSlot"] |
| artifactProtectionAuthorityState | synthetic-library-proof |
| authorityModules | {"destructiveOperations":{"sourceDigest":"fba219fa1e9371f3c85088be23b8b690b153d9b6ba82c0e040fd29c64b156d10","sourcePath":"tools/deployment/destructive-operation-authority.mjs"},"onlineSchema":{"sourceDigest":"8c76bae9a6da950dae0467944d2e087d269c66fede75bc4f8fab32d2ae6d5e09","sourcePath":"src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs"},"releaseAssetsGc":{"sourceDigest":"49d15878aa51e0eecad609e936402aab8658b5bfb04ac8572e4e4c5822af12d7","sourcePath":"tools/storage/release-gc.mjs"},"rollout":{"sourceDigest":"cbb0f9a9189c24adb9266a7d11e4ff69f1b40f6ec090d565bdd4788335e17d0b","sourcePath":"tools/deployment/release-rollout-lib.mjs"},"slot":{"sourceDigest":"a8ec1666cf92eee86e02d652b90cdcbedb04f1470d01ab66fa25a37cf7931d73","sourcePath":"tools/deployment/slot-lib.mjs"},"topologyAuthority":{"sourceDigest":"5d2caf9a77330028d94a5ff8b92c748e2d4a2af7ffba6c4b32197b6ac37a9ec3","sourcePath":"tools/governance/check-monolithic-distributed-architecture.mjs"}} |
| authorityState | synthetic-library-proof |
| claimEligibilityReasons | ["production-current-active-resource-evidence-absent"] |
| claimEligible | false |
| destructiveAuthority | {"contentDigest":"sha256:bfdce7ca0918af2cc87163d5e804595ac73c4cabc9587927e443f4581379b2aa","schema":"fsusblog.destructive-operation-authority.v1","schemaCleanupStatus":"unsupported","volumeCleanupStatus":"unsupported"} |
| evidenceClass | synthetic-library-proof |
| proofIds | ["release-assets.active-release-retained","rollout.failed-stage-recovery-derived","slot.active-stop-rejected","slot.gateway-transition-state-derived","slot.identity-mismatch-rejected"] |
| rollbackRequiredState | rollback_required |
| rolloutFailureState | recovery_required |
| rolloutRecoveryAction | preserve-source-stop-candidate |
| rolloutStages | ["manifest-validate","capacity-preflight","backup-restore-gate","expand-migration","asset-materialize","candidate-start","candidate-readiness","candidate-smoke","compatibility-smoke","gateway-switch","source-drain","active-fence","public-verify","source-stop","release-evidence"] |
| rolloutStateSchema | fsusblog.release-rollout-state.v1 |
| runtimeProtectionAuthorityState | synthetic-library-proof |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:f89ed86bb4297bbf8db00834bd8b298126f7f4b2233d6e1b9dd6e94fe288a92f","catalogMetadataCount":145,"claimEligible":true,"concurrentContractFailureCodes":["schema_contract_backfill_incomplete","schema_contract_backfill_unverified","schema_contract_backup_restore_stale","schema_contract_confirmation_missing","schema_contract_current_release_dependency","schema_contract_exclusive_mode_missing","schema_contract_observation_window","schema_contract_old_writes_enabled","schema_contract_previous_release_dependency","schema_contract_release_window_open","schema_contract_rollback_manifest_open","schema_contract_slot_switch_in_progress"],"databaseObservationDigest":"sha256:38f9525b5bb024b047bc635f5ec286fc4f2c423cfb7ad23fbaeb835689dc342e","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":145,"manifestDigest":"sha256:c36fd834f3dbd377cc2f326ead02e5fb28627b6edc4a38285e5690d0d52b0db1","missingExpandFailureCodes":["schema_expand_pending"],"previousRollbackReleaseId":"20260913000000-2383ab932baf","sameReleaseFailureCode":"schema_previous_rollback_release_not_distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20260914000000-2383ab932baf","sourceReleaseManifestDigest":"sha256:90f57d5bbb64c881b1cae8b0779fc606f36f2c3af427524b01549eb20fbe89ba","targetReadiness":"ready","targetReleaseId":"20260915000000-2383ab932baf","targetReleaseManifestDigest":"sha256:d8d43721c7f797d3088e5b477919bb320e1ae89bb616cebcb5cbefd14085b672"} |
| schemaProtectionAuthorityState | synthetic-library-proof |
| slotStateSchema | fsusblog.deployment-slots.v1 |
| slots | ["blue","green"] |
| stopActiveResult | refusing to stop active slot blue |
| switchState | switching |
| unknownIdentityResult | active release identity does not match slot record |
| volumeProtectionAuthorityState | synthetic-library-proof |
| volumeScopes | {"operator-shared":["/app/config/zk","/app/secrets/zk"],"release-artifact-store":["/app/release-assets"],"release-identity":["/app/release-manifest.json"],"shared-between-slots":["/app/data-protection","/app/release-derived","/app/storage"],"slot-private":["/app/Logs","/app/data","/app/wwwroot/aot-cache"]} |
| volumeTopology | {"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}} |
<!-- FSUSBLOG-GENERATED:END deployment.blue-green-contract -->

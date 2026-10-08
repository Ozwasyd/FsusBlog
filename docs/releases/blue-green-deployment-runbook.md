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

`claimEligible` is `false` because the active-resource checks below are synthetic library proofs, not production-current observations. The current-schema code contract, exact volume topology and runtime ownership remain source-bound. Fresh native/database qualification requires the original admitted collector, which remains disconnected; production volume/schema cleanup and unknown active identities fail closed.

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
| authorityModules | {"currentSchemaAdmission":{"sourceDigest":"e76a628d94d1cf2cf4d5b14816eba322933a48177c98b41f2bece7962c0c4806","sourcePath":"src/backend/Infrastructure/SchemaMigration/CurrentSchemaReceiptAdmission.cs"},"destructiveOperations":{"sourceDigest":"fba219fa1e9371f3c85088be23b8b690b153d9b6ba82c0e040fd29c64b156d10","sourcePath":"tools/deployment/destructive-operation-authority.mjs"},"releaseAssetsGc":{"sourceDigest":"49d15878aa51e0eecad609e936402aab8658b5bfb04ac8572e4e4c5822af12d7","sourcePath":"tools/storage/release-gc.mjs"},"rollout":{"sourceDigest":"1349841af0e9be1b6d75545a8987292c630e16d8455f1a4e56773abc4a001416","sourcePath":"tools/deployment/release-rollout-lib.mjs"},"slot":{"sourceDigest":"a8ec1666cf92eee86e02d652b90cdcbedb04f1470d01ab66fa25a37cf7931d73","sourcePath":"tools/deployment/slot-lib.mjs"},"topologyAuthority":{"sourceDigest":"5d2caf9a77330028d94a5ff8b92c748e2d4a2af7ffba6c4b32197b6ac37a9ec3","sourcePath":"tools/governance/check-monolithic-distributed-architecture.mjs"}} |
| authorityState | synthetic-library-proof |
| claimEligibilityReasons | ["production-current-active-resource-evidence-absent"] |
| claimEligible | false |
| currentSchemaContract | {"admissionType":"FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission","codecType":"FsusBlog.Contracts.SchemaMigration.CurrentSchemaReceiptCodec","contractValidated":true,"evidenceClass":"compiled-production-code-model","evidenceStage":"pre-runtime","fixtureArtifactSha256":"30c838d7851be5d80f911b6c23fb8f6c5494a8453440d3b6dd9414353cc6e45f","fixtureContentDigest":"50262e99b2dd08f633602386343947eb0425755398f553b880b190c20804c0c6","fixtureOnly":true,"maximumEncodedBytes":1048576,"nativeQualification":false,"observationDigest":"38bcd22da5134dc6f67850c54f9aed39a499b0da810b3f1f5ed902499ea44c88","positiveControls":["canonical-codec-roundtrip","whole-artifact-admission-contract","artifact-sha-distinct-from-content-seal"],"receiptFormat":"fsusblog.current-schema-receipt.v1","refusalControls":{"content-seal-as-file-sha":"current_receipt_artifact_digest_mismatch","content-seal-drift":"current_receipt_digest_mismatch","database-swap":"current_receipt_live_admission_mismatch","duplicate-checkpoint":"current_receipt_reference_duplicate","duplicate-member":"current_receipt_json_invalid","empty-bytes":"current_receipt_size_invalid","latest-reference":"current_receipt_latest_reference_forbidden","missing-plan":"current_receipt_reference_missing","missing-status":"current_receipt_json_invalid","old-format":"current_receipt_shape_invalid","oversized-bytes":"current_receipt_size_invalid","physical-schema-swap":"current_receipt_live_admission_mismatch","provider-swap":"current_receipt_live_admission_mismatch","rejected-status":"current_receipt_live_admission_mismatch","semantic-mismatch":"current_receipt_postcondition_failed","target-swap":"current_receipt_live_admission_mismatch","unknown-member":"current_receipt_json_invalid","unknown-provider":"current_receipt_provider_unknown","unknown-status":"current_receipt_json_invalid","whole-file-drift":"current_receipt_artifact_digest_mismatch"},"schema":"fsusblog.current-schema-code-contract-observation.v1"} |
| destructiveAuthority | {"contentDigest":"sha256:bfdce7ca0918af2cc87163d5e804595ac73c4cabc9587927e443f4581379b2aa","schema":"fsusblog.destructive-operation-authority.v1","schemaCleanupStatus":"unsupported","volumeCleanupStatus":"unsupported"} |
| evidenceClass | synthetic-library-proof |
| proofIds | ["release-assets.active-release-retained","rollout.failed-stage-recovery-derived","slot.active-stop-rejected","slot.gateway-transition-state-derived","slot.identity-mismatch-rejected"] |
| rollbackRequiredState | rollback_required |
| rolloutFailureState | recovery_required |
| rolloutRecoveryAction | preserve-source-stop-candidate |
| rolloutStages | ["manifest-validate","capacity-preflight","backup-restore-gate","current-schema-admission","asset-materialize","candidate-start","candidate-readiness","candidate-smoke","compatibility-smoke","gateway-switch","source-drain","active-fence","public-verify","source-stop","release-evidence"] |
| rolloutStateSchema | fsusblog.release-rollout-state.v2 |
| runtimeProtectionAuthorityState | synthetic-library-proof |
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

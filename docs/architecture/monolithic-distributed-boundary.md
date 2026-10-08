# Monolithic distributed architecture boundary

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.monolithic-distributed-rationale
behaviorId: deployment-blue-green-runtime-role
claimType: rationale
factPath: topologyDigest
render: rationale-prose
-->

单体分布式（Homogeneous Binary, Heterogeneous Runtime）描述同一套 FsusBlog 程序和唯一业务入口；`single`、`static-role`、`adaptive` 运行形态的跨节点能力继续经过 remote invocation 的 port / adapter 边界。

## Invariants

## Runtime modes

The current producer emits only `fsusblog.runtime-role-observation.v3` with a
closed `currentSchemaContract`. Its `compiled-contract` stage observes the
original production entity and required-recipe owners and the unique
`fsusblog.current-schema-receipt.v1` validation contract. It does not connect to a
database, issue a receipt or claim verified-current status; both
`actualDatabaseObserved` and `nativeClaimEligible` are false. A v2 observation or
retired `schemaOverlap` field is rejected by every required current consumer.

Static admission still requires all compiled extractors, a source-bound minimal
build receipt v3, deterministic artifact replay and zero candidate spawns.
Actual receipt bytes must be read and independently verified against the live
database by `CurrentSchemaReceiptAdmission.VerifyAsync` only after static
admission. The original reader rejects `latest`, non-regular/symlink artifacts,
changed bytes and oversized input; the production verifier reads a fresh native
read-only snapshot and binds the target, database and actual schema. File SHA-256
and the receipt's semantic content digest are separate identities. Historical
plan/apply/checkpoint/backup/recovery/semantic verification remains with the sole
offline issuer, never a second runtime receipt or evaluator.

The generated table below is an older evidence snapshot until the canonical
producer and documentation generator run on the current admitted candidate. It
is not current native database qualification. Role composition semantics and the
existing deployment behavior ID remain unchanged; schema-window readiness is
retired rather than reinterpreted as a current native claim.

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.runtime-roles
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: deployment.runtime-roles
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN deployment.runtime-roles -->
| Key | Value |
| --- | --- |
| artifactDigest | 6f368f84304e46537c0739d3b3181c9a8fcca713d965cd9904c83d2c762648c3 |
| deploymentAuthority | {"application":{"applicationServiceCount":1,"composeCommandOverride":"absent","composeEntrypointOverride":"absent","composeService":"fsusblog.server","dockerTarget":"final","effectivePid1":["./FsusBlog.Server"],"image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","pid1Source":"docker-final-entrypoint-no-compose-override","processEntrypoint":["./FsusBlog.Server"],"project":"src/backend/FsusBlog.Server.csproj","serviceRoster":["fsusblog.server"]},"authorityContentDigest":"sha256:8a366f76e65d059c4810caf777c7edea4b0a29acd8ff382e04d78f9c5a60a311","authoritySchema":"fsusblog.monolithic-distributed-architecture.v2","effectiveCompose":{"allProfileServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"composeImplementation":{"canonicalPath":"/usr/libexec/docker/cli-plugins/docker-compose","digest":"9b7ea0b462981a5159b7ea646bd748f84894b3736c80c9d9fedd35075751e267","version":"2.40.3"},"defaultServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"dockerExecutable":{"canonicalPath":"/usr/local/bin/docker","digest":"7e467a03338a013f15bb617cf60f03c66343c222ba70a554b1e85afe0a99029d","version":"29.1.3"},"modelDigest":"sha256:c8f932ff86cde112940f47594425003b4ebd362605c0b30a83716d8172ed4e61","oracle":"docker-compose-config-json-no-interpolate","oracleVersion":"2.40.3","sourcePath":"ops/docker/docker-compose.production.yml"},"observationDigest":"sha256:9acd4d68e6c7f66089d8f3635db5b3194a6385cf012fd3b2bc84e2843a662ee5","schema":"fsusblog.runtime-role-deployment-observation.v1","sourceDigests":{"dockerfile":{"digest":"4f022bd1c43d451ad221cba1ea130667c5421ddd00940531adbb617f3a3a6444","path":"ops/docker/FsusBlog.Server.Dockerfile"},"policy":{"digest":"0f4b3e9c6c7b0c77ad6a16fca875be40ad7fea4cc6360b7a5d524dc0636ff11d","path":"tests/governance/monolithic-distributed-architecture.json"},"productionCompose":{"digest":"fadf3562069acd3ada9b2cc4a85a0a040cb47a9bff5c60a939e8a74ee7b087df","path":"ops/docker/docker-compose.production.yml"},"project":{"digest":"4a89db0912a05e00d720150cb99106c1a3fc17bc75fbf9f949024e93e0398e71","path":"src/backend/FsusBlog.Server.csproj"}},"volumeTopology":{"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}}} |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | 881af18352277204c247a15f009317e8ae2d6c8bca101e8827c97d4d52cff9cb |
| ownership | {"authorityState":"closed-current","claimEligible":true,"coResidency":"selected-runtime-roles-share-process-container-and-service","container":"one-application-container-per-release-slot","process":"one-fsusblog-server-process-per-application-container","separation":"blue-green-release-slots-not-runtime-role-services","service":"fsusblog.server"} |
| schema | fsusblog.runtime-role-observation.v2 |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:f89ed86bb4297bbf8db00834bd8b298126f7f4b2233d6e1b9dd6e94fe288a92f","catalogMetadataCount":145,"claimEligible":true,"concurrentContractFailureCodes":["schema_contract_backfill_incomplete","schema_contract_backfill_unverified","schema_contract_backup_restore_stale","schema_contract_confirmation_missing","schema_contract_current_release_dependency","schema_contract_exclusive_mode_missing","schema_contract_observation_window","schema_contract_old_writes_enabled","schema_contract_previous_release_dependency","schema_contract_release_window_open","schema_contract_rollback_manifest_open","schema_contract_slot_switch_in_progress"],"databaseObservationDigest":"sha256:38f9525b5bb024b047bc635f5ec286fc4f2c423cfb7ad23fbaeb835689dc342e","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":145,"manifestDigest":"sha256:c36fd834f3dbd377cc2f326ead02e5fb28627b6edc4a38285e5690d0d52b0db1","missingExpandFailureCodes":["schema_expand_pending"],"previousRollbackReleaseId":"20260913000000-2383ab932baf","sameReleaseFailureCode":"schema_previous_rollback_release_not_distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20260914000000-2383ab932baf","sourceReleaseManifestDigest":"sha256:90f57d5bbb64c881b1cae8b0779fc606f36f2c3af427524b01549eb20fbe89ba","targetReadiness":"ready","targetReleaseId":"20260915000000-2383ab932baf","targetReleaseManifestDigest":"sha256:d8d43721c7f797d3088e5b477919bb320e1ae89bb616cebcb5cbefd14085b672"} |
| staticRoleCapabilities | {"audit":["comment.audit"],"content":["media.processor","search.indexer"],"maintenance":["media.processor","scheduler.worker"],"security":["antispam.inference","comment.audit"],"web":["admin.ui","comment.api","search.query","web.api"]} |
| unsupportedCombinations | {"static-role-empty":"runtime_static_roles_required","static-role-unknown":"runtime_static_role_invalid:unknown","unknown-mode":"runtime_mode_invalid:unsupported"} |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-roles -->

## Project and deployment-topology guard

```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

## Distributed Runtime issue boundary

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.distributed-issue-rationale
behaviorId: deployment-blue-green-runtime-role
claimType: rationale
factPath: deploymentBlueGreen.claimEligible
render: rationale-prose
-->

- #110 单体分布式支持：同构全能力节点与动态职责调度
- #111 节点能力注册与集群成员治理
- #112 动态职责调度与自适应负载均衡
- #113 分布式状态控制
- #114 本地 / 远程调用透明切换与模块边界约束
- #115 多节点部署、观测与故障治理

## Current execution classes

<!-- fsus-doc-claim
claimId: browserless-production-correctness.execution-classes
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: testing.execution-classes
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN testing.execution-classes -->
| Key | Value |
| --- | --- |
| byEvidenceClass | {"browser-contract":"correctness","correctness":"correctness","diagnostic":"diagnostic"} |
| qualificationEligible | {"browser-contract":true,"correctness":true,"diagnostic":false} |
| requires | {"browser-contract":["producerId","schedulerRunId","sourceIdentity"],"correctness":["producerId","schedulerRunId","sourceIdentity"]} |
<!-- FSUSBLOG-GENERATED:END testing.execution-classes -->

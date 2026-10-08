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

The required compiled runtime-role observation v3 binds the production current-schema
codec and admission value contract, with explicitly fixture-only deterministic
positive and refusal probes. Its closed `currentSchemaContract` is pre-runtime
`compiled-production-code-model` evidence, never native database qualification.
The original bounded minimal build publishes runtime build receipt v4 and retains
the exact source, assembly bytes, deployment/Compose identity and raw-byte replay.
No native issuer or database service is required or started before static admission.

Actual current-schema qualification belongs to the post-runtime
`deployment-current-schema-admission` behavior and requires the sole v1 receipt
and original independent database verification. A compiled fixture, self-seal,
old overlap/window/Ready material, or missing owner cannot satisfy it. The generated
section below remains unchanged until its original producer is replayed; its old
v2 values are not current v3 evidence or proof that these probes have executed.

## Runtime modes

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
| artifactDigest | 3e54654723efd1e74668cfd56fd6f20bf647666e9753837ed54803e8b368728d |
| currentSchemaContract | {"admissionType":"FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission","codecType":"FsusBlog.Contracts.SchemaMigration.CurrentSchemaReceiptCodec","contractValidated":true,"evidenceClass":"compiled-production-code-model","evidenceStage":"pre-runtime","fixtureArtifactSha256":"30c838d7851be5d80f911b6c23fb8f6c5494a8453440d3b6dd9414353cc6e45f","fixtureContentDigest":"50262e99b2dd08f633602386343947eb0425755398f553b880b190c20804c0c6","fixtureOnly":true,"maximumEncodedBytes":1048576,"nativeQualification":false,"observationDigest":"38bcd22da5134dc6f67850c54f9aed39a499b0da810b3f1f5ed902499ea44c88","positiveControls":["canonical-codec-roundtrip","whole-artifact-admission-contract","artifact-sha-distinct-from-content-seal"],"receiptFormat":"fsusblog.current-schema-receipt.v1","refusalControls":{"content-seal-as-file-sha":"current_receipt_artifact_digest_mismatch","content-seal-drift":"current_receipt_digest_mismatch","database-swap":"current_receipt_live_admission_mismatch","duplicate-checkpoint":"current_receipt_reference_duplicate","duplicate-member":"current_receipt_json_invalid","empty-bytes":"current_receipt_size_invalid","latest-reference":"current_receipt_latest_reference_forbidden","missing-plan":"current_receipt_reference_missing","missing-status":"current_receipt_json_invalid","old-format":"current_receipt_shape_invalid","oversized-bytes":"current_receipt_size_invalid","physical-schema-swap":"current_receipt_live_admission_mismatch","provider-swap":"current_receipt_live_admission_mismatch","rejected-status":"current_receipt_live_admission_mismatch","semantic-mismatch":"current_receipt_postcondition_failed","target-swap":"current_receipt_live_admission_mismatch","unknown-member":"current_receipt_json_invalid","unknown-provider":"current_receipt_provider_unknown","unknown-status":"current_receipt_json_invalid","whole-file-drift":"current_receipt_artifact_digest_mismatch"},"schema":"fsusblog.current-schema-code-contract-observation.v1"} |
| deploymentAuthority | {"application":{"applicationServiceCount":1,"composeCommandOverride":"absent","composeEntrypointOverride":"absent","composeService":"fsusblog.server","dockerTarget":"final","effectivePid1":["./FsusBlog.Server"],"image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","pid1Source":"docker-final-entrypoint-no-compose-override","processEntrypoint":["./FsusBlog.Server"],"project":"src/backend/FsusBlog.Server.csproj","serviceRoster":["fsusblog.server"]},"authorityContentDigest":"sha256:8a366f76e65d059c4810caf777c7edea4b0a29acd8ff382e04d78f9c5a60a311","authoritySchema":"fsusblog.monolithic-distributed-architecture.v2","effectiveCompose":{"allProfileServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"composeImplementation":{"canonicalPath":"/usr/libexec/docker/cli-plugins/docker-compose","digest":"dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372","version":"2.40.3"},"defaultServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"dockerExecutable":{"canonicalPath":"/usr/local/bin/docker","digest":"27f239f97492c434e091a70b41b8796c698f0aa2b6052c6f9c28da4ee7ae888b","version":"28.4.0"},"modelDigest":"sha256:3dbfcdbefb51d8efe6916e59fc120978d7b34010358179b27a9bf64ca3da26f9","oracle":"docker-compose-config-json-no-interpolate","oracleVersion":"2.40.3","sourcePath":"ops/docker/docker-compose.production.yml"},"observationDigest":"sha256:7e603b7405d210f25e0ef5a9595b86c98a4ec201edc73a307181c303194c5d07","schema":"fsusblog.runtime-role-deployment-observation.v1","sourceDigests":{"dockerfile":{"digest":"fb63e343910b0928d8106cda518c48da08ce18ef271f6311273584b9b8c76fe2","path":"ops/docker/FsusBlog.Server.Dockerfile"},"policy":{"digest":"0f4b3e9c6c7b0c77ad6a16fca875be40ad7fea4cc6360b7a5d524dc0636ff11d","path":"tests/governance/monolithic-distributed-architecture.json"},"productionCompose":{"digest":"fadf3562069acd3ada9b2cc4a85a0a040cb47a9bff5c60a939e8a74ee7b087df","path":"ops/docker/docker-compose.production.yml"},"project":{"digest":"750dc43234f15be728a4eff93b1df2690d9efff880ecd8f9446aac726aa0bddc","path":"src/backend/FsusBlog.Server.csproj"}},"volumeTopology":{"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}}} |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | 71c1d4e758a13b77456f2c80bd64a8e5e9ddd62a204c2d59cc3ad18a81cfa662 |
| ownership | {"authorityState":"closed-current","claimEligible":true,"coResidency":"selected-runtime-roles-share-process-container-and-service","container":"one-application-container-per-release-slot","process":"one-fsusblog-server-process-per-application-container","separation":"blue-green-release-slots-not-runtime-role-services","service":"fsusblog.server"} |
| schema | fsusblog.runtime-role-observation.v3 |
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

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
| artifactDigest | e479b5dbabcdd8c523932df0b38849a6266fd92a5177fe24ea0ba2973a31952a |
| deploymentAuthority | {"application":{"applicationServiceCount":1,"composeCommandOverride":"absent","composeEntrypointOverride":"absent","composeService":"fsusblog.server","dockerTarget":"final","effectivePid1":&#91;"./FsusBlog.Server"&#93;,"image":"${FSUSBLOG&#95;IMAGE&#95;REF:?Set immutable repository@sha256 digest from release-manifest.json}","pid1Source":"docker-final-entrypoint-no-compose-override","processEntrypoint":&#91;"./FsusBlog.Server"&#93;,"project":"src/backend/FsusBlog.Server.csproj","serviceRoster":&#91;"fsusblog.server"&#93;},"authorityContentDigest":"sha256:8a366f76e65d059c4810caf777c7edea4b0a29acd8ff382e04d78f9c5a60a311","authoritySchema":"fsusblog.monolithic-distributed-architecture.v2","effectiveCompose":{"allProfileServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG&#95;IMAGE&#95;REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"composeImplementation":{"canonicalPath":"/usr/libexec/docker/cli-plugins/docker-compose","digest":"dba9d98e1ba5bfe11d88c99b9bd32fc4a0624a30fafe68eea34d61a3e42fd372","version":"2.40.3"},"defaultServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG&#95;IMAGE&#95;REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"dockerExecutable":{"canonicalPath":"/usr/local/bin/docker","digest":"27f239f97492c434e091a70b41b8796c698f0aa2b6052c6f9c28da4ee7ae888b","version":"28.4.0"},"modelDigest":"sha256:3dbfcdbefb51d8efe6916e59fc120978d7b34010358179b27a9bf64ca3da26f9","oracle":"docker-compose-config-json-no-interpolate","oracleVersion":"2.40.3","sourcePath":"ops/docker/docker-compose.production.yml"},"observationDigest":"sha256:febf68a7bd716bde2a4605aaf5d733158541378c54fe394369b23b3a2cb02885","schema":"fsusblog.runtime-role-deployment-observation.v1","sourceDigests":{"dockerfile":{"digest":"9e83d5321fd50655bc51686872245740bf59f750d64496624eea341d342990f1","path":"ops/docker/FsusBlog.Server.Dockerfile"},"policy":{"digest":"0f4b3e9c6c7b0c77ad6a16fca875be40ad7fea4cc6360b7a5d524dc0636ff11d","path":"tests/governance/monolithic-distributed-architecture.json"},"productionCompose":{"digest":"fadf3562069acd3ada9b2cc4a85a0a040cb47a9bff5c60a939e8a74ee7b087df","path":"ops/docker/docker-compose.production.yml"},"project":{"digest":"750dc43234f15be728a4eff93b1df2690d9efff880ecd8f9446aac726aa0bddc","path":"src/backend/FsusBlog.Server.csproj"}},"volumeTopology":{"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG&#95;SLOT&#95;LOGS&#95;VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG&#95;ZK&#95;CONFIG&#95;DIR:?Set FSUSBLOG&#95;ZK&#95;CONFIG&#95;DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG&#95;SLOT&#95;DATA&#95;VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG&#95;SHARED&#95;DATA&#95;PROTECTION&#95;VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG&#95;RELEASE&#95;ASSET&#95;STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG&#95;SHARED&#95;RELEASE&#95;DERIVED&#95;VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG&#95;RELEASE&#95;MANIFEST&#95;HOST&#95;PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG&#95;ZK&#95;SECRET&#95;DIR:?Set FSUSBLOG&#95;ZK&#95;SECRET&#95;DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG&#95;SHARED&#95;PUBLIC&#95;ASSETS&#95;VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG&#95;SLOT&#95;AOT&#95;CACHE&#95;VOLUME:?Set slot-specific AOT cache volume}"}}} |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":&#91;"none"&#93;},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":&#91;"none"&#93;},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":&#91;"audit","content","maintenance","security","web"&#93;}} |
| observationDigest | 5481243ec0fcaa9e6b12b3a52fa61f353f664212e2f0378fea465e5ba450e9f2 |
| ownership | {"authorityState":"closed-current","claimEligible":true,"coResidency":"selected-runtime-roles-share-process-container-and-service","container":"one-application-container-per-release-slot","process":"one-fsusblog-server-process-per-application-container","separation":"blue-green-release-slots-not-runtime-role-services","service":"fsusblog.server"} |
| schema | fsusblog.runtime-role-observation.v2 |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:f786a88f19c4412d0969d9ff43b6b4d57681759e432e6299e8bbbb76c02c0ba4","catalogMetadataCount":148,"claimEligible":true,"concurrentContractFailureCodes":&#91;"schema&#95;contract&#95;backfill&#95;incomplete","schema&#95;contract&#95;backfill&#95;unverified","schema&#95;contract&#95;backup&#95;restore&#95;stale","schema&#95;contract&#95;confirmation&#95;missing","schema&#95;contract&#95;current&#95;release&#95;dependency","schema&#95;contract&#95;exclusive&#95;mode&#95;missing","schema&#95;contract&#95;observation&#95;window","schema&#95;contract&#95;old&#95;writes&#95;enabled","schema&#95;contract&#95;previous&#95;release&#95;dependency","schema&#95;contract&#95;release&#95;window&#95;open","schema&#95;contract&#95;rollback&#95;manifest&#95;open","schema&#95;contract&#95;slot&#95;switch&#95;in&#95;progress"&#93;,"databaseObservationDigest":"sha256:7ef96eb11ea6d87bf071eced3da341ae768a37545ba5aa341a9c23ff625124f9","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":148,"manifestDigest":"sha256:6c65f2699ae955b8119088f7bc22dd783718772bf02a45c520fab1e933e0225a","missingExpandFailureCodes":&#91;"schema&#95;expand&#95;pending"&#93;,"previousRollbackReleaseId":"20261002000000-ee44adbe2f8b","sameReleaseFailureCode":"schema&#95;previous&#95;rollback&#95;release&#95;not&#95;distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20261003000000-ee44adbe2f8b","sourceReleaseManifestDigest":"sha256:adb8749b1042b23011ad0d4167dcf02190b78cfa3814439f84e1a7fdaf1d34b1","targetReadiness":"ready","targetReleaseId":"20261004000000-ee44adbe2f8b","targetReleaseManifestDigest":"sha256:9d25c5b8dc3611ef4108981b661560895bd1cdd83a683a36efac5a296118e500"} |
| staticRoleCapabilities | {"audit":&#91;"comment.audit"&#93;,"content":&#91;"media.processor","search.indexer"&#93;,"maintenance":&#91;"media.processor","scheduler.worker"&#93;,"security":&#91;"antispam.inference","comment.audit"&#93;,"web":&#91;"admin.ui","comment.api","search.query","web.api"&#93;} |
| unsupportedCombinations | {"static-role-empty":"runtime&#95;static&#95;roles&#95;required","static-role-unknown":"runtime&#95;static&#95;role&#95;invalid:unknown","unknown-mode":"runtime&#95;mode&#95;invalid:unsupported"} |
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
| requires | {"browser-contract":&#91;"producerId","schedulerRunId","sourceIdentity"&#93;,"correctness":&#91;"producerId","schedulerRunId","sourceIdentity"&#93;} |
<!-- FSUSBLOG-GENERATED:END testing.execution-classes -->

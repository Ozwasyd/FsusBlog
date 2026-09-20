# Monolithic distributed architecture boundary

FsusBlog is **monolithic distributed** (Homogeneous Binary, Heterogeneous Runtime): the repository, build, and deployment always produce one FsusBlog program, with `FsusBlog.Server` as the sole business entry point. Multiple nodes change only which runtime responsibilities each instance performs; content, comments, search, and other modules never become separate business services.

这是一套**单体分布式**边界：仓库、构建和部署始终产出同一套 FsusBlog 程序，`FsusBlog.Server` 是唯一业务入口。跨节点执行通过 remote invocation 的窄 `port / adapter` 边界进入，模块不会固化为独立业务服务。

## Invariants

- One repository, primary application project, application Dockerfile, and integrated frontend/backend production artifact.
- PostgreSQL, Redis, and an optional gateway are infrastructure/deployment layers, not split business sidecars.
- Single-node is the default; every multi-node member still runs the same binary and module set.
- Domain modules express business capabilities without knowing node location, HTTP/gRPC clients, or Redis transport.
- Cross-node execution enters remote invocation only through a narrow port/adapter; callers try local capability first and the runtime decides whether to delegate remotely.

## Runtime modes

The sole runtime-mode authority is the compiled `RuntimeModeOptions` observation. The modes are `single`, `static-role`, and `adaptive`; the generated section below owns responsibility combinations and unsupported combinations, so this document keeps no hand-maintained mode table or second role map.

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
| artifactDigest | 722a88fd22e449fcd404c6138dfb6f7557c1d104f4928fa128a4549566722a3c |
| deploymentAuthority | {"application":{"applicationServiceCount":1,"composeCommandOverride":"absent","composeEntrypointOverride":"absent","composeService":"fsusblog.server","dockerTarget":"final","effectivePid1":["./FsusBlog.Server"],"image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","pid1Source":"docker-final-entrypoint-no-compose-override","processEntrypoint":["./FsusBlog.Server"],"project":"src/backend/FsusBlog.Server.csproj","serviceRoster":["fsusblog.server"]},"authorityContentDigest":"sha256:8a366f76e65d059c4810caf777c7edea4b0a29acd8ff382e04d78f9c5a60a311","authoritySchema":"fsusblog.monolithic-distributed-architecture.v2","effectiveCompose":{"allProfileServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"composeImplementation":{"canonicalPath":"/usr/libexec/docker/cli-plugins/docker-compose","digest":"33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4","version":"5.1.4"},"defaultServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"dockerExecutable":{"canonicalPath":"/usr/bin/docker","digest":"fb7b1ca4b4c579d4a0dbecca8ab6ec9a1045a8bffb984f07347edf7593a3927d","version":"29.5.3"},"modelDigest":"sha256:81a4ece4c58c6545c3745ca4615bb9f49b4397f3d1127c93a9ead69a7f298b0a","oracle":"docker-compose-config-json-no-interpolate","oracleVersion":"5.1.4","sourcePath":"ops/docker/docker-compose.production.yml"},"observationDigest":"sha256:5034954106e38e3fd2c23b7f80fdeeba4f72074c9caa067f0fb4a7029d807923","schema":"fsusblog.runtime-role-deployment-observation.v1","sourceDigests":{"dockerfile":{"digest":"4f022bd1c43d451ad221cba1ea130667c5421ddd00940531adbb617f3a3a6444","path":"ops/docker/FsusBlog.Server.Dockerfile"},"policy":{"digest":"0f4b3e9c6c7b0c77ad6a16fca875be40ad7fea4cc6360b7a5d524dc0636ff11d","path":"tests/governance/monolithic-distributed-architecture.json"},"productionCompose":{"digest":"fadf3562069acd3ada9b2cc4a85a0a040cb47a9bff5c60a939e8a74ee7b087df","path":"ops/docker/docker-compose.production.yml"},"project":{"digest":"4a89db0912a05e00d720150cb99106c1a3fc17bc75fbf9f949024e93e0398e71","path":"src/backend/FsusBlog.Server.csproj"}},"volumeTopology":{"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}}} |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | 433c415a47545ae354b6cb04996157c10432a66695bc89f2a24436c43ca659b3 |
| ownership | {"authorityState":"closed-current","claimEligible":true,"coResidency":"selected-runtime-roles-share-process-container-and-service","container":"one-application-container-per-release-slot","process":"one-fsusblog-server-process-per-application-container","separation":"blue-green-release-slots-not-runtime-role-services","service":"fsusblog.server"} |
| schema | fsusblog.runtime-role-observation.v2 |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:f89ed86bb4297bbf8db00834bd8b298126f7f4b2233d6e1b9dd6e94fe288a92f","catalogMetadataCount":145,"claimEligible":true,"concurrentContractFailureCodes":["schema_contract_backfill_incomplete","schema_contract_backfill_unverified","schema_contract_backup_restore_stale","schema_contract_confirmation_missing","schema_contract_current_release_dependency","schema_contract_exclusive_mode_missing","schema_contract_observation_window","schema_contract_old_writes_enabled","schema_contract_previous_release_dependency","schema_contract_release_window_open","schema_contract_rollback_manifest_open","schema_contract_slot_switch_in_progress"],"databaseObservationDigest":"sha256:38f9525b5bb024b047bc635f5ec286fc4f2c423cfb7ad23fbaeb835689dc342e","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":145,"manifestDigest":"sha256:c36fd834f3dbd377cc2f326ead02e5fb28627b6edc4a38285e5690d0d52b0db1","missingExpandFailureCodes":["schema_expand_pending"],"previousRollbackReleaseId":"20260913000000-2383ab932baf","sameReleaseFailureCode":"schema_previous_rollback_release_not_distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20260914000000-2383ab932baf","sourceReleaseManifestDigest":"sha256:90f57d5bbb64c881b1cae8b0779fc606f36f2c3af427524b01549eb20fbe89ba","targetReadiness":"ready","targetReleaseId":"20260915000000-2383ab932baf","targetReleaseManifestDigest":"sha256:d8d43721c7f797d3088e5b477919bb320e1ae89bb616cebcb5cbefd14085b672"} |
| staticRoleCapabilities | {"audit":["comment.audit"],"content":["media.processor","search.indexer"],"maintenance":["media.processor","scheduler.worker"],"security":["antispam.inference","comment.audit"],"web":["admin.ui","comment.api","search.query","web.api"]} |
| unsupportedCombinations | {"static-role-empty":"runtime_static_roles_required","static-role-unknown":"runtime_static_role_invalid:unknown","unknown-mode":"runtime_mode_invalid:unsupported"} |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-roles -->

## Runtime-role observation contract

The compiled producer emits `fsusblog.runtime-role-observation.v2`, whose
independent JSON Schema is
`config/schemas/runtime-role-observation.schema.json`. Its deployment input is
the separately sealed
`fsusblog.runtime-role-deployment-observation.v1` contract at
`config/schemas/runtime-role-deployment-observation.schema.json`; the input
must remain claim-eligible and bind the current policy, Server project,
production Dockerfile and Compose source digests.

The minimal contract build source identity follows the actual reachable .NET
`ProjectReference` graph. It includes every non-generated compile input,
explicit linked build item, project file, imported `Directory.*` build file and
project `packages.lock.json`. This closure is part of the content-addressed
build key, so a source or lock-file change cannot reuse an older runtime-role
assembly.

The producer accepts `--output` and `--deployment-observation` only as regular
paths physically contained by the current repository root. Absolute paths are
allowed for the build host's repository-contained staging directory; traversal,
`.git`, missing deployment inputs and symlinked path segments fail closed.

All three modes use the same FsusBlog program and artifact. During a transient remote-dependency failure, nodes retain local invalidation and authoritative-data fallback while transport retries; no business artifact switch is required. To disable cluster components completely, set `Runtime:Mode` back to `single` and rolling-restart because hosted-service DI composition is fixed at startup. In `single`, the local publisher branch must register before Redis transport so no remote hot path exists.

## Project and deployment-topology guard

The static guard treats `src/backend/FsusBlog.Server.csproj`, `ops/docker/FsusBlog.Server.Dockerfile`, and the Compose service manifest as authoritative:

- `src/` may contain only one Web/Exe business-entry project; Core/Shared remain libraries.
- `FsusBlog.Server.csproj` must copy frontend dist into its own `wwwroot`; an independent frontend production artifact is forbidden.
- Compose may declare only classified application, gateway, or infrastructure services; a new required business sidecar fails immediately.
- Domain roots may not import HTTP, gRPC, Redis, sockets, or node-location implementations.
- Remote-invocation identifiers may appear only in Interfaces, Contracts, or Infrastructure port/adapter roots.

Run locally:

```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

For a false-positive guard result, keep the existing single-application artifact and roll back the new Compose/project entry. If a remote adapter fails, existing local invalidation and authoritative-data fallback continue without restart; fully disabling cluster capability follows the `single` rolling restart above and changes neither API contracts nor artifact shape.

## Distributed Runtime issue boundary

These issues extend the same application; they do not define fixed service splits:

- #110 monolithic distributed support: homogeneous full-capability nodes and dynamic responsibility scheduling
- #111 node capability registration and cluster-membership governance
- #112 dynamic responsibility scheduling and adaptive load balancing
- #113 distributed state control
- #114 transparent local/remote invocation switching and module-boundary constraints
- #115 multi-node deployment, observability, and failure governance

对应的分布式运行议题标题为：

- #110 单体分布式支持：同构全能力节点与动态职责调度
- #111 节点能力注册与集群成员治理
- #112 动态职责调度与自适应负载均衡
- #113 分布式状态控制
- #114 本地 / 远程调用透明切换与模块边界约束
- #115 多节点部署、观测与故障治理

Capability registration, responsibility scheduling, state coordination, transparent invocation, and failure governance may evolve independently, but all remain subject to one program, one artifact, and one business-entry boundary.
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

# 单体分布式架构边界

FsusBlog 的架构定义是**单体分布式**（Homogeneous Binary, Heterogeneous Runtime）：仓库、构建和部署始终产出同一套 FsusBlog 程序，`FsusBlog.Server` 是唯一业务入口。多节点只改变同一程序实例承担的运行时职责，不把内容、评论、搜索等模块固化成独立业务服务。

## 不变量

- 一个仓库、一个主应用项目、一个应用 Dockerfile 和一个前后端整合的生产发布物。
- PostgreSQL、Redis 和可选网关属于基础设施或部署层，不是拆出的业务 sidecar。
- 单机是默认路径；扩展到多节点时，每个节点仍运行相同二进制和相同模块集合。
- 领域模块只表达业务能力，不感知节点位置、HTTP/gRPC 客户端或 Redis transport。
- 跨节点执行只能通过窄 port / adapter 边界进入 remote invocation；调用方先走本地能力，运行时才决定是否转交远端 adapter。

## 运行模式

运行模式的唯一权威是 compiled `RuntimeModeOptions` observation；模式集合为 `single`、`static-role`、`adaptive`，职责组合与 unsupported combinations 由下方 generated section 表达，正文不再维护手写模式表或第二份 role 映射。

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
| artifactDigest | 51ae6282293bc77665d645762d915c67dcfb239774510a75b8e5e413ca26c5f1 |
| deploymentAuthority | {"application":{"applicationServiceCount":1,"composeCommandOverride":"absent","composeEntrypointOverride":"absent","composeService":"fsusblog.server","dockerTarget":"final","effectivePid1":["./FsusBlog.Server"],"image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","pid1Source":"docker-final-entrypoint-no-compose-override","processEntrypoint":["./FsusBlog.Server"],"project":"src/backend/FsusBlog.Server.csproj","serviceRoster":["fsusblog.server"]},"authorityContentDigest":"sha256:f824d89173f121ceba34c8b39f6eba9789e397d7a436594b9d30d939fa8766ba","authoritySchema":"fsusblog.monolithic-distributed-architecture.v2","effectiveCompose":{"allProfileServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"composeImplementation":{"canonicalPath":"/usr/lib/docker/cli-plugins/docker-compose","digest":"f9ebc6ebdb19d769b793c245a736caaeb198c62587f13b25c660c13b4987f959","version":"5.3.1"},"defaultServices":{"fsusblog.server":{"buildState":"absent","commandState":"absent","entrypointState":"absent","image":"${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}","profileState":"default-active","pullPolicy":"always"}},"dockerExecutable":{"canonicalPath":"/usr/bin/docker","digest":"628af575ee8499596e7d266c221ee6bb74fbc20de3a81dd6fe5106f81e652db4","version":"29.6.2"},"modelDigest":"sha256:49a347e38cedc53a0e670b11a4d50ef56238ab51d40b58c5d491d751957edf0e","oracle":"docker-compose-config-json-no-interpolate","oracleVersion":"5.3.1","sourcePath":"ops/docker/docker-compose.production.yml"},"observationDigest":"sha256:c8d382c924d46b9207ab631cb5688bd11ad3919aa4cf8fd312e65cc38cb2410e","schema":"fsusblog.runtime-role-deployment-observation.v1","sourceDigests":{"dockerfile":{"digest":"10a6192f380c878da0279f9caa1e0ea1137c82797cbb8e89681c6af534a60ec2","path":"ops/docker/FsusBlog.Server.Dockerfile"},"policy":{"digest":"0bea8748c9a26e8199f3dc8a0c5ef593b0e2c56d0d15868bffbb280daa840f68","path":"tests/governance/monolithic-distributed-architecture.json"},"productionCompose":{"digest":"ad32917ea45b11407b72e7c019b7f4e1c956b0549d0b9a361548f46d9de6677d","path":"ops/docker/docker-compose.production.yml"},"project":{"digest":"50ef0b8f7902ef8cdeaa6ed6eb55370abeb9974d4b6db40e538e102a23b03223","path":"src/backend/FsusBlog.Server.csproj"}},"volumeTopology":{"app.Logs":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-logs","target":"/app/Logs","volumeName":"${FSUSBLOG_SLOT_LOGS_VOLUME:?Set slot-specific logs volume}"},"app.config.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_CONFIG_DIR:?Set FSUSBLOG_ZK_CONFIG_DIR to the host ZK config directory}","target":"/app/config/zk"},"app.data":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-slot-data","target":"/app/data","volumeName":"${FSUSBLOG_SLOT_DATA_VOLUME:?Set slot-specific data volume}"},"app.data-protection":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-data-protection","target":"/app/data-protection","volumeName":"${FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME:?Set the shared DataProtection volume explicitly}"},"app.release-assets":{"access":"read-only","protection":"exact-active-release-gc-authority","scope":"release-artifact-store","source":"${FSUSBLOG_RELEASE_ASSET_STORE:?Set the host append-only release asset store}/releases","target":"/app/release-assets"},"app.release-derived":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-release-derived","target":"/app/release-derived","volumeName":"${FSUSBLOG_SHARED_RELEASE_DERIVED_VOLUME:-fsusblog-release-derived}"},"app.release-manifest.json":{"access":"read-only","protection":"identity-bound-read-only","scope":"release-identity","source":"${FSUSBLOG_RELEASE_MANIFEST_HOST_PATH:?Set the validated host release manifest path}","target":"/app/release-manifest.json"},"app.secrets.zk":{"access":"read-only","protection":"outside-release-cleanup","scope":"operator-shared","source":"${FSUSBLOG_ZK_SECRET_DIR:?Set FSUSBLOG_ZK_SECRET_DIR to the host ZK secret directory}","target":"/app/secrets/zk"},"app.storage":{"access":"read-write","protection":"outside-release-cleanup","scope":"shared-between-slots","source":"fsus-storage","target":"/app/storage","volumeName":"${FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME:?Set the migrated shared public-assets volume explicitly}"},"app.wwwroot.aot-cache":{"access":"read-write","protection":"retained-with-slot","scope":"slot-private","source":"fsus-aot-cache","target":"/app/wwwroot/aot-cache","volumeName":"${FSUSBLOG_SLOT_AOT_CACHE_VOLUME:?Set slot-specific AOT cache volume}"}}} |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | 538a734050857415fa6186adc89e277d0fe6b4e585cdb997123c98e5b540bd5c |
| ownership | {"authorityState":"closed-current","claimEligible":true,"coResidency":"selected-runtime-roles-share-process-container-and-service","container":"one-application-container-per-release-slot","process":"one-fsusblog-server-process-per-application-container","separation":"blue-green-release-slots-not-runtime-role-services","service":"fsusblog.server"} |
| schema | fsusblog.runtime-role-observation.v2 |
| schemaOverlap | {"authorityState":"observed-in-current-schema-manifest-probe","catalogDigest":"sha256:4cfff3d2f873942341705c6bec9cb730aa140171d5013f6055f9c54e5c8961c1","catalogMetadataCount":137,"claimEligible":true,"concurrentContractFailureCodes":["schema_contract_backfill_incomplete","schema_contract_backfill_unverified","schema_contract_backup_restore_stale","schema_contract_confirmation_missing","schema_contract_current_release_dependency","schema_contract_exclusive_mode_missing","schema_contract_observation_window","schema_contract_old_writes_enabled","schema_contract_previous_release_dependency","schema_contract_release_window_open","schema_contract_rollback_manifest_open","schema_contract_slot_switch_in_progress"],"databaseObservationDigest":"sha256:39516320afef32f90cbc1d44beaf83408160febbe0c13d749e371e3444312c76","evidenceClass":"current-manifest-catalog-production-provider-model","manifestDescriptorCount":137,"manifestDigest":"sha256:12c465b54f3ebffee134806a745b5db2ee66b0fb5195fd8a5c59926d0d8b10ed","missingExpandFailureCodes":["schema_expand_pending"],"previousRollbackReleaseId":"20260829000000-d2c1834ca672","sameReleaseFailureCode":"schema_previous_rollback_release_not_distinct","schema":"fsusblog.online-schema-overlap-observation.v1","sourceReadiness":"ready","sourceReleaseId":"20260830000000-d2c1834ca672","sourceReleaseManifestDigest":"sha256:01f6c7abdf2ca18e2e29f4ca1290922d50a90e65ddc86ccd9b173a74ae37f845","targetReadiness":"ready","targetReleaseId":"20260831000000-d2c1834ca672","targetReleaseManifestDigest":"sha256:d4761b302906bf9109e70c333929e250e7ce9f5aa77fccc682f8ccc065195d22"} |
| staticRoleCapabilities | {"audit":["comment.audit"],"content":["media.processor","search.indexer"],"maintenance":["media.processor","scheduler.worker"],"security":["antispam.inference","comment.audit"],"web":["admin.ui","comment.api","search.query","web.api"]} |
| unsupportedCombinations | {"static-role-empty":"runtime_static_roles_required","static-role-unknown":"runtime_static_role_invalid:unknown","unknown-mode":"runtime_mode_invalid:unsupported"} |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-roles -->

三种模式使用同一套 FsusBlog 程序和同一发布物。远端依赖临时异常时，节点保留本地失效与权威数据回退，transport 自行重试，不需要切换业务发布物；若要完全关闭集群组件，必须把 `Runtime:Mode` 改回 `single` 并滚动重启，因为 hosted service 的 DI 组合在启动时确定。`single` 模式的本地 publisher 必须先于 Redis transport 注册分支，保证无远程热路径。

## 项目与部署拓扑守卫

静态守卫以 `src/backend/FsusBlog.Server.csproj`、`ops/docker/FsusBlog.Server.Dockerfile` 和 Compose 服务清单为权威：

- `src/` 只能有一个 Web/Exe 业务入口项目；Core/Shared 继续是库。
- `FsusBlog.Server.csproj` 必须把 frontend dist 复制进自身 `wwwroot`，禁止形成独立前端生产发布物。
- Compose 只能声明已分类的 application、gateway 或 infrastructure 服务；新增必需业务 sidecar 会直接失败。
- 领域根不得导入 HTTP、gRPC、Redis、socket 或节点定位实现。
- remote invocation 标识只能出现在 Interfaces、Contracts 或 Infrastructure 的 port/adapter 根。

本地检查：

```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

若守卫误报，先保持现有单应用发布物并回退新增 Compose/project 入口。若远端 adapter 运行异常，现有本地失效与权威数据回退可在不重启的情况下继续服务；完全关闭集群能力则按上文切回 `single` 并滚动重启，不改变 API 契约或发布物形态。

## Distributed Runtime 议题边界

以下议题共同扩展同一应用，而不是定义固定服务拆分：

- #110 单体分布式支持：同构全能力节点与动态职责调度
- #111 节点能力注册与集群成员治理
- #112 动态职责调度与自适应负载均衡
- #113 分布式状态控制
- #114 本地 / 远程调用透明切换与模块边界约束
- #115 多节点部署、观测与故障治理

因此 capability 注册、职责调度、状态协调、透明调用和故障治理可以分别演进，但都必须服从一个程序、一个发布物、一个业务入口的边界。
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

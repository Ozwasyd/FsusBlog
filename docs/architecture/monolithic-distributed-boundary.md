# 单体分布式架构边界

本文件只投影 compiled runtime-role observation 中已表达的模式、职责组合与 ownership 状态。项目名、Dockerfile、Compose service、workflow 或部署截图不得用于推导角色事实；静态 observation 未表达的 process、container、service 与 separation 关系不会由正文补写。

## 运行模式

运行模式的唯一权威是 compiled `RuntimeModeOptions` observation；模式集合、职责组合与 unsupported combinations 由下方 generated section 表达，正文不再维护手写模式表或第二份 role 映射。

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
| artifactDigest | 2daec8debec316450e9c2f1f578755233b908077727302c5044f7eb4388197b1 |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | e1eb2f48af35e82ee05e5733aa4bc3d2b5bb3f9309f2fd5a1463a94452027363 |
| ownership | {"authorityState":"conflict-unknown","coResidency":"local-invocation-only","container":"not-expressed-by-runtime-authority","process":"not-expressed-by-runtime-authority","separation":"not-expressed-by-runtime-authority","service":"not-expressed-by-runtime-authority"} |
| schema | fsusblog.runtime-role-observation.v1 |
| staticRoleCapabilities | {"audit":["comment.audit"],"content":["media.processor","search.indexer"],"maintenance":["media.processor","scheduler.worker"],"security":["antispam.inference","comment.audit"],"web":["admin.ui","comment.api","search.query","web.api"]} |
| unsupportedCombinations | {"static-role-empty":"runtime_static_roles_required","static-role-unknown":"runtime_static_role_invalid:unknown","unknown-mode":"runtime_mode_invalid:unsupported"} |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-roles -->

`authorityState: conflict-unknown` 是 fail-closed 结果，不等价于已证明 monolithic topology。只有 typed authority 补齐并重新生成本节后，后继 release claim 才能消费新的关系结论。

## Conformance diagnostic

现有静态检查可发现 source layout 与 adapter boundary 漂移，但检查入口和文件名不拥有 runtime-role、co-residency 或 separation 事实。

本地检查：

```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

这些检查只提供 conformance diagnostics，不能把 `conflict-unknown` 提升为 verified deployment claim。
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

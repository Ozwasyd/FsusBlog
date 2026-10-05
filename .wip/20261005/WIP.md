# WIP: codex/issue-3056-catalog-enum-closure-20261002

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3056-catalog-enum-closure-20261002`
- 原始 commit：`431dbf949e3bf43a8c7bc15842e1b57ab8dd6f8a`
- 原始 tree：`1365ac6c2f77f64c6481e70292542195901d16b7`
- 与当前 master 的 merge base：`98e490f6d03bafa254b66a9ccb03ee453a012b1a`
- 相关 issue 线索：#3056
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
431dbf949 fix(api): close transport catalog enum validation
Reject undefined mapping kinds and error codes before the existing production catalog can be published. Preserve every registered status and wire value.

Refs: #3056

f60bd8cfe chore(api): bind external status naming
Refs: #3056

e7d88de46 chore(api): consolidate generated authority evidence
Refs: #3056

34f6250d0 docs(api): project typed status authority
Refs: #3056

99bf4859c chore(test): reseal release execution authority
Refs: #3056

bb909eb67 fix(api): bind generated status authority evidence
Refs: #3056

2e9fb0871 fix(api): fail closed unknown error statuses
Refs: #3056

e210a06a4 fix(api): expose typed error status authority
Refs: #3056
```

## 相对原 merge base 的源码差异概况

```text
...eds-status-error-authority-external-naming.json |  57 ++
 ...s-status-error-authority-generated-binding.json |  35 ++
 docs/api.md                                        | 238 ++++----
 docs/api/schemas-and-errors.md                     |  59 +-
 docs/api/stability.md                              |   2 +-
 .../Infrastructure/Binary/BinaryEnvelopePolicy.cs  |  23 +-
 .../Infrastructure/Bootstrap/PublicWebRuntime.cs   |   8 +-
 .../Infrastructure/Filters/BannedUserMiddleware.cs |  17 +-
 .../Middlewares/ApiBinaryResponseMiddleware.cs     |  37 +-
 .../Middlewares/GlobalExceptionMiddleware.cs       |  16 +-
 .../NotificationStreamHandler.cs                   |  12 +-
 .../Infrastructure/Results/AedsJsonResults.cs      |  12 +-
 .../Results/ApiErrorSemanticMapper.cs              | 410 +++++++++++--
 .../Infrastructure/Results/BinaryResults.cs        |  20 +-
 .../Results/EndpointFilterResults.cs               |  11 +-
 .../Infrastructure/Results/MiddlewareResults.cs    |  13 +-
 .../AuthoringEndpoints.ModerationRoutes.cs         |  17 +-
 .../AuthoringEndpoints.OperationsRoutes.cs         |  20 +-
 .../Endpoints/AuthoringEndpoints.WorkflowRoutes.cs |  11 +-
 .../Modules/Endpoints/AuthoringEndpoints.cs        |   4 +-
 .../Endpoints/Binary/BinaryEndpoints.AdminUsers.cs |   2 +-
 .../Binary/BinaryEndpoints.AnonymousCredential.cs  |  33 +-
 .../Binary/BinaryEndpoints.AnonymousGovernance.cs  |   4 +-
 .../Endpoints/Binary/BinaryEndpoints.Articles.cs   |  14 +-
 .../Endpoints/Binary/BinaryEndpoints.Auth.cs       | 125 ++--
 .../Endpoints/Binary/BinaryEndpoints.Comments.cs   |  38 +-
 .../Endpoints/Binary/BinaryEndpoints.Messages.cs   |  57 +-
 .../Binary/BinaryEndpoints.SecurityChallenge.cs    |  19 +-
 .../Binary/BinaryEndpoints.Subscriptions.cs        |  12 +-
 .../Endpoints/Binary/BinaryEndpoints.System.cs     |   8 +-
 .../Endpoints/Binary/BinaryEndpoints.Telemetry.cs  |   4 +-
 .../Endpoints/Binary/BinaryEndpoints.Uploads.cs    |   6 +-
 .../Endpoints/ClusterMembershipEndpoints.cs        |   4 +-
 src/backend/Modules/Endpoints/SecurityEndpoints.cs |   2 +-
 .../Contracts/Validation/fsusblog.openapi.json     | 679 +++++++++++++--------
 tests/backend/Unit/InfraHelperTests.cs             |  53 +-
 .../Unit/ProductionStartupValidatorTests.cs        | 402 ++++++++++++
 .../Unit/RumTelemetryBinaryEndpointTests.cs        | 107 ++++
 .../release-final-execution-target-authority.json  |   8 +-
 tests/tools/behavior-doc-static-admission.test.mjs |  21 +
 ...nfig-error-security-policy-observation.test.mjs | 279 ++++++++-
 .../Program.cs                                     |  87 ++-
 .../CompiledEndpointContractObserver.cs            |  42 +-
 .../FsusBlog.OpenApiObservation/Program.cs         |  72 +++
 .../lib/config-error-security-observation.mjs      |  23 +-
 .../config-error-security-policy/extract.mjs       | 321 +++++++++-
 46 files changed, 2686 insertions(+), 758 deletions(-)
```


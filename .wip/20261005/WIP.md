# WIP: codex/issue-2215-source-observations-20261002

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-source-observations-20261002`
- 原始 commit：`e0eb31b182b45eac3cc1c8f4042559afe09aff2a`
- 原始 tree：`64eaba46bb6c10a0381a87115c93f4f9e4b0de09`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215, #2212, #3529, #3530, #3525, #1604, #2174
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
e0eb31b18 fix(database): refuse unregistered standalone source types
Include standalone base and unfinished shell types in the native unknown-source inventory while retaining implicit arrays and registered historical table row types.

Refs: #2215

99e64ca61 fix(database): observe closed historical sources and full native content
Read actual PostgreSQL catalogs, identity, legacy preconditions and complete typed rows in the same native transaction. Register only explicit empty and fixture-derived historical source shapes. Refuse unavailable provider content capability and delegate native lifecycle to its sole owner.

Refs: #2215

ecf353f7c fix(database): keep historical planning inputs in the migration owner
Move the complete plan, historical observations, backup capture inputs, reader interfaces and codec out of Shared once. Keep only opaque current schema identities required by the receipt boundary. Preserve the original frozen contract commit and do not widen Server dependencies.

Bind fresh/captured/restored complete source content and actual capture/restore dump bytes, separate artifact byte hashes from self-excluded plan digests, and add the sole closed observe-source capture handshake. Genuine source/backup/target/operation owners remain unconfigured and fail closed until integration. No SDK, database, tests, checker or producer executed.

Refs: #2215

Refs: #2212

c47324729 feat(database): define immutable offline migration planning contracts
Bind exact source observations, registry/DAG closure, backup capture and isolated restore observations, and current target/tool identities without invoking legacy phases or database writes. Independently revalidate owner inputs and canonical plan bytes.

This source-only contract delivery does not configure the missing historical source/backup/target evidence owners. CLI plan remains fail-closed pending their genuine read-only integration; contract fixtures do not establish production baselines or three-provider acceptance. No SDK, database, checker, producer, or tests were executed.

Refs: #2215

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
de05fe6f5 fix(test): rebind current fixture selector evidence
Refs: #3525, #1604
d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
```

## 相对原 merge base 的源码差异概况

```text
docs/database-migration.md                         |  70 +++
 src/migration/OfflineMigrationCommandLine.cs       | 125 +++++
 src/migration/OfflineMigrationHost.cs              | 161 +++++++
 src/migration/OfflineMigrationPlan.cs              | 534 +++++++++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 147 ++++++
 src/migration/OfflineMigrationPlanEvidence.cs      |  58 +++
 .../OfflineMigrationSourceFingerprints.cs          | 199 ++++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 472 ++++++++++++++++++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 ++
 .../migration/OfflineMigrationCommandLineTests.cs  |  43 ++
 tests/migration/OfflineMigrationPlanTests.cs       | 332 +++++++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 220 +++++++++
 .../OfflineMigrationSourceObserverTests.cs         | 228 +++++++++
 13 files changed, 2622 insertions(+)
```


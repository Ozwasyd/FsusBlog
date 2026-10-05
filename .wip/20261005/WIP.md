# WIP: codex/issue-3523-startup-disposition-current-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3523-startup-disposition-current-20261003`
- 原始 commit：`2bbd5a1c6032d801edf8d917b6adab9011c4ee2b`
- 原始 tree：`81a75543d38c82b695a1c221b9951fc4fb73ad83`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3523, #3524, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
2bbd5a1c6 fix(test): bind MySQL startup disposition source inputs
Declare the exact authored seed and fixture in both existing matrix cache and physical producer inputs. Preserve selectors, retry gates and unchanged generated products.

Refs: #3523

139fd99b9 fix(governance): bind MySQL startup health disposition to original source
Reuse the reviewed exact-source seed and original scanner/provider ownership, regenerate only the disposition registry, and preserve every existing disposition. This does not grant current MySQL or SDK acceptance.

Refs: #3523

Refs: #3524

89f0838a0 fix(database): restore scoped MySQL typed DDL source repair
Reuse the reviewed development source, tests and current documents from 4007bf3e968170af2feced6b632fb34fb87ff460 on the exact b19 baseline without importing its generated receipts or unrelated governance history. This source-only commit does not qualify current execution or issue acceptance. The explicit registry seed, original producers, canonical service admission and real current-provider gates remain pending; historical 58/58 results are not current evidence.

Refs: #3523

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
de05fe6f5 fix(test): rebind current fixture selector evidence
Refs: #3525, #1604
d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
98e490f6d feat(contracts): bind typed AEDS endpoint observation
Refs: #3178
```

## 相对原 merge base 的源码差异概况

```text
...ssue-3523-startup-health-generated-binding.json |  13 +
 config/testing/retry-disposition-registry.json     |  24 +-
 docs/database-migration.md                         |  22 ++
 docs/schema-migrations/typed-ddl-primitives.json   |  14 +-
 docs/testing.md                                    |  28 ++
 src/migration/SchemaMigrationDdlPrimitives.cs      |  97 ++++++-
 tests/matrix.yml                                   |   2 +
 tests/migration/MigrationAssemblyBoundaryTests.cs  |  13 +-
 tests/migration/MySqlDdlExecutionTests.cs          | 194 +++++++++++++
 tests/migration/MySqlDdlFixture.cs                 | 208 ++++++++++++++
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |  79 +++++-
 tests/migration/schema-ddl-provider-snapshots.json |   6 +-
 tests/tools/hidden-retry-governance.test.mjs       | 187 +++++++++++-
 tools/test/generate-retry-disposition-registry.mjs |   7 +-
 tools/test/retry-disposition-seeds.mjs             | 313 +++++++++++++++++++++
 tools/test/run-matrix-governance-once.sh           |   2 +
 16 files changed, 1185 insertions(+), 24 deletions(-)
```


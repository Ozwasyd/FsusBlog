# WIP: codex/issue-3523-mysql-ddl-current

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3523-mysql-ddl-current`
- 原始 commit：`4007bf3e968170af2feced6b632fb34fb87ff460`
- 原始 tree：`ada2992b9929bafd50c378c231eeab761516bdcb`
- 与当前 master 的 merge base：`d653afbde02b75814d8384777886b10419fb38a1`
- 相关 issue 线索：#3523, #3524, #2174, #3178, #3511, #3060, #3510, #3118, #3119
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4007bf3e9 fix(database): execute MySQL typed DDL with exact index ownership
Use selected-database metadata and guarded prepared DDL for ensure/create/drop.
Preserve case-sensitive table ambiguity and shared string literal values.
Add real-engine tests and current semantics documentation without changing
historical descriptors, their fingerprints or PostgreSQL/SQLite snapshots.

This is a local development candidate, not terminal production qualification.
Canonical Migration inventory and execution remain pending under #3524.
Required matrix, independent review and standard PR acceptance remain open.

Refs: #3523

d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
98e490f6d feat(contracts): bind typed AEDS endpoint observation
Refs: #3178
d3658ecdd fix(governance)!: close terminal zero-legacy scanner (#3511)
Refs: #3060
BREAKING CHANGE: Final consistency reports now require the closed zero-legacy scan shape and an independently recomputed repository scan.
1c59bdb65 Merge pull request #3510 from Ozwasyd/codex/issue-3118-projection-reseal
fix(test): bind content projection to semantic fragments
4258dd302 fix(test): bind content projection to semantic fragments
Exclude compiler and producer implementation metadata from the per-owner source digest while retaining exact Roslyn extraction and generated authority binding.

Refs: #3118

6f66a287e Merge pull request #3119 from Ozwasyd/codex/issue-3118-content-field-projection
fix(test): bind fixture projection to field semantics
cb2d33401 fix(test): bind fixture projection to field semantics
Refs: #3118
```

## 相对原 merge base 的源码差异概况

```text
.../migration-assembly-binding.json                |  10 +-
 .../migration-assembly-receipt.json                |  32 ++--
 config/testing/retry-disposition-registry.json     |  24 ++-
 docs/database-migration.md                         |  22 +++
 docs/schema-migrations/typed-ddl-primitives.json   |  14 +-
 docs/testing.md                                    |  13 ++
 src/migration/SchemaMigrationDdlPrimitives.cs      |  97 +++++++++-
 tests/migration/MigrationAssemblyBoundaryTests.cs  |  13 +-
 tests/migration/MySqlDdlExecutionTests.cs          | 194 +++++++++++++++++++
 tests/migration/MySqlDdlFixture.cs                 | 208 +++++++++++++++++++++
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |  79 ++++++--
 tests/migration/schema-ddl-provider-snapshots.json |   6 +-
 tests/tools/hidden-retry-governance.test.mjs       |  24 ++-
 13 files changed, 696 insertions(+), 40 deletions(-)
```


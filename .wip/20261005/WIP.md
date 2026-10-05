# WIP: codex/issue-2236-receipt-binding-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2236-receipt-binding-20261003`
- 原始 commit：`3bea53b459a082ab20d52b7b79f042f34da7c401`
- 原始 tree：`3ce377263325c9b54052bababbff485b05ddfde1`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2236, #3529, #3530, #3525, #1604, #2174
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
3bea53b45 test(shared): preserve article receipt seal and scope refusal controls
Refs: #2236

ebe731760 fix(shared): bind article relation receipt identity and scope actors
Refs: #2236

c38298ba4 chore(governance): bind current issue external naming review
Refs: #2236

9a0465015 feat(contracts): integrate article relation authority on current master
Integrate the original closed contract slice with lifecycle-mask and source-actor binding repairs. Preserve current master registrations and regenerate the original matrix-derived products with their canonical producers. Runtime and independent acceptance remain pending.

Refs: #2236

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
...e-2236-article-relations-generated-binding.json |  16 +
 .../issue-2236-current-external-naming.json        |  48 ++
 config/configuration-ownership.json                |  26 +
 config/contracts/article-relation-catalog.json     |  87 ++
 .../schemas/article-relation-contract.schema.json  | 420 ++++++++++
 config/testing/correctness-attempt-producers.json  |   4 +-
 docs/api/contracts.md                              |  29 +
 docs/testing.generated.md                          |   2 +-
 .../ArticleRelations/ArticleRelationCatalog.cs     | 163 ++++
 .../ArticleRelationContractValidator.cs            | 893 +++++++++++++++++++++
 .../ArticleRelations/ArticleRelationContracts.cs   | 366 +++++++++
 .../ArticleRelations/ArticleRelationDigest.cs      | 366 +++++++++
 tests/backend/Unit/ArticleRelationContractTests.cs | 731 +++++++++++++++++
 tests/coverage-registry.json                       |  24 +
 tests/governance/test-lifecycle-registry.json      |  15 +
 tests/matrix.yml                                   |  10 +
 tests/tools/article-relations.test.mjs             | 262 ++++++
 tools/governance/check-article-relations.mjs       | 440 ++++++++++
 tools/test/lanes/static-governance.sh              |   5 +
 19 files changed, 3904 insertions(+), 3 deletions(-)
```


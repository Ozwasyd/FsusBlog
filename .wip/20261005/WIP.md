# WIP: codex/issue-3524-canonical-inventory-current-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-canonical-inventory-current-20261003`
- 原始 commit：`a72ec71fd4a04c68b78c0261e792f9f10ecd68f7`
- 原始 tree：`dad57c09132445e35a261baf072b88d069b7c621`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a72ec71fd fix(test): bind xUnit extraction to evaluated Compile items
Refs: #3524

9c959b468 fix(test): bind xUnit graph fixture to current Migration rollup case
Refs: #3524

44d422593 fix(test): register independent Migration xUnit compile contexts
Refs: #3524

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
.../tools/support/xunit-configuration-fixture.mjs  | 182 +++++++++++++++++++++
 .../tools/support/xunit-project-graph-fixture.mjs  |   2 +-
 tests/tools/test-inventory.test.mjs                | 179 +++++++++++++++++++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |  48 ++++++
 tools/test-inventory/adapters.mjs                  |  22 +--
 tools/test-inventory/discovery.mjs                 |  55 +++----
 tools/test-inventory/produce.mjs                   |  13 +-
 tools/test-inventory/xunit-projects.mjs            | 103 ++++++++++++
 .../test-inventory/xunit-roslyn-adapter/Program.cs |  35 ++--
 .../XunitAdapterProjectContext.cs                  |  98 ++---------
 .../XunitAdapterReferenceResolution.cs             | 102 +++++++++---
 11 files changed, 658 insertions(+), 181 deletions(-)
```


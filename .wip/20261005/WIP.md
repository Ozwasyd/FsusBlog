# WIP: codex/issue-1950-g1-owner-refusal-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1950-g1-owner-refusal-20261003`
- 原始 commit：`345a9ccd477e2e2d60680800b1376cbc0bf63d9b`
- 原始 tree：`c7c478d9ec02919ef3c9a8ee113f1cc15331e625`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1950, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
345a9ccd4 fix(test): refuse unowned data-scale full provisioning
Refs: #1950

b3eef486a fix(governance): register data-scale runtime naming evidence
Bind only the existing environment-variable exception to the original three changed release lifecycle source owners.

Refs: #1950

787f042b6 fix(release): bind data-scale receipts to lifecycle attempts
Keep the original executor, action budgets and measurement guards. Require v2 owner evidence to match the original data-scale plan attempt, invocation and admitted source/build/fixture, with independent raw verification through measurement and teardown.

This source binding phase does not claim actual managed provisioning or cleanup composition, which remains a separate missing execution-port prerequisite.

Refs: #1950

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
...issue-1950-dedicated-owner-external-naming.json |  23 ++++
 docs/testing.md                                    |   4 +
 tests/tools/data-scale-runtime-isolation.test.mjs  |  62 ++++++++++
 .../release-reliability-lifecycle-actions.test.mjs |  31 ++++-
 tests/tools/release-reliability-lifecycle.test.mjs | 132 +++++++++++++++++++--
 tools/data-scale/runtime-provisioner-live.mjs      |  18 +++
 tools/data-scale/runtime-provisioner.mjs           |   8 ++
 .../test/release-reliability-lifecycle-actions.mjs |  22 +++-
 tools/test/release-reliability-lifecycle.mjs       |   9 +-
 ...verify-release-reliability-lifecycle-action.mjs | 130 +++++++++++++++++++-
 10 files changed, 423 insertions(+), 16 deletions(-)
```


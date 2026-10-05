# WIP: codex/issue-3524-retention-wiring-current-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-retention-wiring-current-20261003`
- 原始 commit：`7e558de5cae0d28df253c8e5ef88ddafc7d2be71`
- 原始 tree：`a2c6c77a2c03f3d31ea31a7df3a4b53acf9efbd5`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3529, #3530, #3525, #1604, #2174, #3178, #3511, #3060, #3510
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
7e558de5c fix(test): register independent Migration retention and lanes
Preserve Server retention and project only independent Migration cases to backend-unit. Register the original two subprocess governance owners and the original MySQL unit and artifact-only fast dependencies without importing unrelated private-scratch changes or generated products.

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
d3658ecdd fix(governance)!: close terminal zero-legacy scanner (#3511)
Refs: #3060
BREAKING CHANGE: Final consistency reports now require the closed zero-legacy scan shape and an independently recomputed repository scan.
1c59bdb65 Merge pull request #3510 from Ozwasyd/codex/issue-3118-projection-reseal
fix(test): bind content projection to semantic fragments
```

## 相对原 merge base 的源码差异概况

```text
tests/governance/test-lifecycle-registry.json | 36 +++++++++++++++++++++++++++
 tests/matrix.yml                              | 27 +++++++++++++++++---
 tools/test-retention/audit.mjs                | 16 ++++++++++--
 3 files changed, 74 insertions(+), 5 deletions(-)
```


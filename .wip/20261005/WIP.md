# WIP: codex/issue-2270-current-expiry-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2270-current-expiry-20261003`
- 原始 commit：`6990c9211745012bc287a04f4c4bda858f059d05`
- 原始 tree：`def656bffad34b47bc8ca6892318affe4d293068`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2270, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
6990c9211 fix(core): refuse diffs expired during completion rereads
Recheck the existing strictly-after expiry boundary after the final exact package reread. Preserve cancellation priority, package identity and all workspace budgets; retain prior source controls and add completion-boundary source fixtures.

Refs: #2270

2acd13e8a fix(core): revalidate memory refusals before publishing
Refs: #2270

47bed493d fix(core): bound revision diff workspace before allocation
Reserve conservative retained and phase-local managed workspace before constructing line and token collections. Recompute peak and actual token accounting in the production verifier without changing source-byte diff or budget thresholds.

Refs: #2270

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
.../issue-2270-current-external-naming.json        |  18 +
 docs/api/article-publication-revisions.md          |   2 +
 src/core/Services/Articles/RevisionSourceDiff.cs   |  89 ++--
 .../Articles/RevisionSourceDiffMemoryBudget.cs     | 145 +++++++
 .../Articles/RevisionSourceDiffReceipts.cs         |   5 +-
 .../Articles/RevisionSourceDiffVerifier.cs         |  12 +-
 .../Articles/RevisionSourceDiffVerifierMemory.cs   |  99 +++++
 .../Articles/RevisionSourceDiffWordInternals.cs    |   9 +-
 .../Articles/RevisionSourceDiffWordMatching.cs     | 159 ++++---
 .../Unit/RevisionSourceDiffMemoryBudgetTests.cs    | 466 +++++++++++++++++++++
 10 files changed, 904 insertions(+), 100 deletions(-)
```


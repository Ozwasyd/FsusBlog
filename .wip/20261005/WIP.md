# WIP: codex/issue-2312-reconciliation-revision-20261003-xajy8w

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2312-reconciliation-revision-20261003-xajy8w`
- 原始 commit：`3c82db8ac551ee8c8ea8e2833dcb6d418f1b3247`
- 原始 tree：`5b5454dee37b651c40e62c04746647974fdce0b7`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2312, #3529, #3530, #3525, #1604, #2174
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
3c82db8ac fix(backend): preserve cancellation during pin authority rechecks
Check the original caller token before mapping a new authority recheck failure to unavailable. Keep every pre-existing stage catch and the bounded snapshot gates unchanged, and add source controls for cancel plus IOException at both new recheck boundaries.

Change-Class: implementation
Refs: #2312

a45448a9a fix(backend): reject stale pin collections after reconciliation
Recheck the original validated pin authority after reconciliation and the last cache await. Changed collections return the existing machine-readable stale result without old cursor or cache references; failures remain unavailable and caller cancellation is preserved. Do not retry or mix fresh pin identities with older permission/article batches. Preserve the sole writer and extend component source controls and PostgreSQL assertions for an explicit fresh read.

Change-Class: implementation
Refs: #2312

d93a96e45 chore(governance): bind current issue external naming review
Refs: #2312

cbc665967 fix(backend): reject invalid pin projection verifier requests
Handle the existing pin owner and request identity validation exception in the independent projection verifier without changing projection digests or successful replay semantics.

Refs: #2312

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
.../issue-2312-current-external-naming.json        |  13 +
 .../Authoring/AuthorArticlePinProjectionService.cs |  58 +++
 .../AuthorArticlePinProjectionVerifier.cs          |   5 +
 .../AuthorArticlePinProjectionIntegrationTests.cs  |  53 ++-
 .../Unit/AuthorArticlePinProjectionTests.cs        | 467 ++++++++++++++++++++-
 5 files changed, 583 insertions(+), 13 deletions(-)
```


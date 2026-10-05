# WIP: codex/issue-3612-current-prose-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3612-current-prose-20261003`
- 原始 commit：`0380feffd21976879f97d8a727115941af7fb841`
- 原始 tree：`4e7f076be941213b1fc66109708366d352827f5e`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3612, #3056, #3529, #3530
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
0380feffd docs(api): carry public error authority prose onto current source
Preserve the current error-mapper documentation, generated sections and compatibility anchors. Carry only the existing operation-status authority claim and ordinary naming manifest; execution gates remain pending.

Refs: #3612

ab3805ebb docs(api): separate moderation errors from plugin heading
Add only the required blank line after the moderation list. Preserve all nine compatibility anchors and report their remaining MD033 findings without a waiver.

Refs: #3056

7ce6253c3 fix(api): bind transport authority review contracts
Retain the exact enumerable mappings and all existing observation controls. Apply the original C# source style to the two affected declarations and bind the four existing external naming surfaces through ordinary issue-scoped evidence.

Refs: #3056

d176db924 test(api): register error observation controls in canonical governance
Refs: #3056

8e5988415 test(api): bind error authority tests to behavior evidence
Refs: #3056

9ce73bc10 fix(api): unify enumerable transport error mappings
Make runtime lookup and compiled observation enumerate the same immutable production mapping while preserving existing wire error values and the independent reverse policy.

Refs: #3056

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
```

## 相对原 merge base 的源码差异概况

```text
...e-3056-transport-authority-external-naming.json | 27 +++++++
 .../issue-3612-external-naming.json                | 12 +++
 docs/api/schemas-and-errors.md                     | 12 ++-
 .../Results/ApiErrorSemanticMapper.cs              | 44 ++++++++---
 tests/backend/Unit/ApiErrorSemanticMapperTests.cs  | 87 ++++++++++++++++++++++
 tests/governance/test-lifecycle-registry.json      | 17 +++--
 ...nfig-error-security-policy-observation.test.mjs | 84 +++++++++++++++++++++
 .../Program.cs                                     | 35 +++++----
 .../config-error-security-policy/extract.mjs       | 66 ++++++++++++++++
 9 files changed, 355 insertions(+), 29 deletions(-)
```


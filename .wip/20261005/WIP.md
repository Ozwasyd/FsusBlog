# WIP: codex/issue-2139-active-identity-repair-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2139-active-identity-repair-20261003`
- 原始 commit：`4ebb6747bcbd452dbd1e91901224175050dd0609`
- 原始 tree：`826ed970c1505a6497999d7c425549340b91eea7`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2139, #3529, #3530, #3525, #1604, #2174, #3178, #3511, #3060
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4ebb6747b fix(backend): check cancellation at authoring ready boundary
Retain the active-package and adapter identity checks, then check caller cancellation immediately before returning Ready. Add the final descriptor lookup cancellation control without changing the stable owned descriptor path.

Refs: #2139

c5fd22ec4 fix(backend): recheck verified authoring execution identities
Recompute typed manifest identity through the original validator and recheck active package and adapter identity after asynchronous owned verification. Preserve the compiled resolver refusal controls and their exact constructor-inspection support.

Refs: #2139

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
```

## 相对原 merge base 的源码差异概况

```text
...139-active-identity-repair-external-naming.json |  12 +
 .../AuthoringExtensionExecutionResolver.cs         |  72 ++-
 .../Unit/AccountSubjectHashProjectionTests.cs      |  31 +
 .../AuthoringExtensionExecutionResolverTests.cs    | 710 ++++++++++++++++++++-
 4 files changed, 809 insertions(+), 16 deletions(-)
```


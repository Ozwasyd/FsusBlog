# WIP: codex/issue-2214-terminal-boundary-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2214-terminal-boundary-20261003`
- 原始 commit：`3d91337bb4ffa20d6f14225d31dd73ec49651684`
- 原始 tree：`ed3706f023e64fec44b9216dcf6b57c79bf2ebb5`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2214, #3529, #3530, #3525, #1604, #2174, #3178
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
3d91337bb test(architecture): reject unresolved migration graph inputs
Close Compile expression/glob, imported assembly identity and symlink-parent bypasses reported by independent review. Preserve the original static-only and terminal acceptance separation.

Refs: #2214

f1976ccb9 test(architecture): preserve terminal checker invocation mode
Keep the original Node-invoked owner file mode unchanged.

Refs: #2214

fcc34ede9 test(architecture): bind migration boundary static observations
Record the declared transitive source graph and observed assets/publish bytes without converting missing provider, mutation or benchmark execution into terminal acceptance. Preserve the ordinary canonical static lane and the current-schema owners.

Refs: #2214

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
docs/database-migration.md                         |  26 +
 tests/tools/migration-terminal-governance.test.mjs | 281 +++++++++-
 tools/db/check-migration-terminal-governance.mjs   | 567 ++++++++++++++++-----
 3 files changed, 743 insertions(+), 131 deletions(-)
```


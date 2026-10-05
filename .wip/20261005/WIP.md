# WIP: codex/issue-2214-friend-declarations-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2214-friend-declarations-20261003`
- 原始 commit：`71c7830cfcb93be491b0eb1c237ac313dcb69157`
- 原始 tree：`07f23ab699b97e833331ca86742c75d9e6a516d0`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2214, #3529
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
71c7830cf fix(architecture): refuse uncertain conditional friend alias scope
Preserve possible assembly friend aliases as unresolved when conditional namespace or brace tokens prevent a bounded lexical scope observation.

Refs: #2214

d66241bfe fix(architecture): preserve assembly friend alias lexical scope
Limit alias visibility to compilation-unit scope and retain namespace-local declarations outside global assembly attribute binding.

Refs: #2214

5413723e5 fix(architecture): resolve declared assembly friend aliases and lists
Preserve the original source-only graph observation and qualification refusal while closing static alias and MSBuild list omissions.

Refs: #2214

8885e06b8 fix(architecture): observe declared cross-boundary assembly friends
Use the existing C# mask to identify actual assembly attribute seams, resolve supported static literal arguments, and retain unresolved declarations as refusals. Bind project and imported InternalsVisibleTo items to the original declared graph without claiming compiled assembly or provider acceptance.

Refs: #2214

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
```

## 相对原 merge base 的源码差异概况

```text
docs/database-migration.md                         |  26 +
 tests/tools/migration-terminal-governance.test.mjs | 697 +++++++++++++++++-
 tools/db/check-migration-terminal-governance.mjs   | 819 ++++++++++++++++++---
 3 files changed, 1420 insertions(+), 122 deletions(-)
```


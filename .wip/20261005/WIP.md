# WIP: codex/issue-3599-workflow-node-binding-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3599-workflow-node-binding-20261003`
- 原始 commit：`2f2322de40b98b40582de8bf9d8d4047dd3579ff`
- 原始 tree：`4143897a3fb2d0a6c1ed65324692cd86eedcbc90`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3599, #3529, #3530
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
2f2322de4 fix(governance): bind matrix owner to parsed workflow steps
Reuse the original shared YAML document parser and bind workflow-wide and validate-matrix ownership to actual job step run values. Non-run scalar text cannot supply executable ownership or references. Preserve all original embedded controls and add non-run literal positive/refusal, actual run-form and malformed structure SOURCE controls. Generated execution authority and current execution gates remain pending; no checker, parser, self-test, producer, SDK or service execution occurred.

Refs: #3599

a3099ba3e fix(governance): reject split folded matrix invocations
Refs: #3599

208dd12a3 fix(governance): reject folded matrix workflow invocations
Refs: #3599

bdd869159 build(governance): preserve execution authority wire keys
Bind the resealed execution-target fixture to its registered JSON wire-key exception without changing the schema.

Refs: #3599

6841a99bb build(governance): reseal gate execution authority
Regenerate the indexed release-final target authority after the gate-integrity checker changes; bind the exact generated fixture digest to the changed checker source.

Refs: #3599

e9d6cb568 fix(governance): bind matrix owner through scheduler entry
Check the unique executable workflow step and matrix tier against the canonical governance producer. Keep negative fixtures for duplicate and bypass routes and document the current CI entry.

Refs: #3599

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
```

## 相对原 merge base 的源码差异概况

```text
.../issue-3599-gate-integrity-external-naming.json |  12 +
 ...ssue-3599-gate-integrity-generated-binding.json |  12 +
 docs/testing.md                                    |   8 +-
 .../release-final-execution-target-authority.json  |   4 +-
 tools/check-gate-integrity.sh                      | 292 +++++++++++++++++----
 5 files changed, 276 insertions(+), 52 deletions(-)
```


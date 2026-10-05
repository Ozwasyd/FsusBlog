# WIP: codex/issue-1915-command-terminal-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1915-command-terminal-20261003`
- 原始 commit：`f79b36ee5d1032750179dc443f30159723062ec9`
- 原始 tree：`fceb425e6c90513f2e0eea9da801fb701c1918f4`
- 与当前 master 的 merge base：`7fc4f1f38cfb48eb8f2a4833d7d3b7f8b985985a`
- 相关 issue 线索：#1915, #2145, #2144, #2143, #2142, #2141, #2140
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
f79b36ee5 fix(backend): reject late authoring command admission and results
Refs: #1915

7fc4f1f38 feat(frontend): integrate extension commands
Project signed closed command metadata into the single FsusUI registry with exact lifecycle, permission, document, revision, selection, abort, and transaction binding.

Refs: #1915

29d3cb4b8 test(backend): govern terminal isolation evidence
Bind every closed authoring registry and terminal domain to exact positive, negative, owner, and current-run evidence without treating simulated checks as production proof.

Refs: #2145

28539f3fd feat(backend): enforce authoring runtime budgets
Apply manifest-bound admission, live measurement, quarantine, and privacy-redacted telemetry to isolated authoring runtimes.

Refs: #2144

22a7373c7 feat(backend): close authoring extension lifecycle
Make lifecycle transitions generation-bound, atomically revoke resources and grants, and keep state migration and deletion scoped and recoverable.

Refs: #2143

04e7860c4 security(backend): close authoring RPC grants
Bind grants and mutation requests to exact runtime, document, scope, revision, consent, and canonical transaction identities.

Security-Disclosure: not-applicable
Refs: #2142

f3df8674c security(backend): tighten authoring service isolation
Close verified service and broker inputs, reject control roots and non-regular files, and add a real detached-child process-tree probe without widening document RPC.

Security-Disclosure: not-applicable
Refs: #2141

f91dd595b security(backend): harden isolated authoring workers
Bind each Wasm launch and receipt to the closed request context, enforce separate message ceilings, and reject shared or unbounded linear memory before execution.

Security-Disclosure: not-applicable
Refs: #2140
```

## 相对原 merge base 的源码差异概况

```text
.../AuthoringCommandContributions.cs               |  25 +++-
 .../Unit/AuthoringCommandContributionTests.cs      | 158 ++++++++++++++++++++-
 2 files changed, 174 insertions(+), 9 deletions(-)
```


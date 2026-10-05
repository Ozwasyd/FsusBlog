# WIP: codex/issue-3636-owning-mount-profile-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3636-owning-mount-profile-20261003`
- 原始 commit：`fe47d66990bce235e4ee8ec10967a7370c5b962d`
- 原始 tree：`8d2ddd145843daf5709760bcc41101275f1920bf`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3636, #3634
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
fe47d6699 fix(backend): preserve native escaped mount whitespace
Accept kernel-escaped whitespace only in native mount identities while preserving strict accounting paths and the fixed owning mount profile.

Refs: #3636

76b6b34a7 fix(backend): bound retained mount identity reads
Use the existing control-output limit before materializing mount identity text and keep owned readers cancellation-aware.

Refs: #3636

4a5ef6ecd fix(backend): reject local-only retained pids event mounts
Bind predispatch accounting to the actual unambiguous writable cgroup2 mount and reject local-only parent event semantics without changing counters or resource budgets.

Refs: #3636

cd6aa759a chore(governance): bind document export delivery naming
Preserve the exact authorized first-failure, cgroup drain and retained-accounting scope when the existing delivery PR targets current master.

Refs: #3636

1b2cb8528 fix(backend): fence cancelled export dispatch recovery
Retain the original manager dispatch reply, bind only the exact numeric start job, and preserve sticky native execution evidence. Qualify never-started cancellation only through retained service and accounting ownership with actual cleanup; unknown dispatch replies remain fail closed. Keep original workload budgets, selectors, assertions and receipt schema unchanged.

Refs: #3636

ddfffc18e fix(backend): preserve cancelled export admission identity
Batch exact prelaunch identity inspection without relaxing refusal checks. Kill an owned dispatched service before bounded recovery of its actual native start identity; retain original workload budgets and failure semantics.

Refs: #3636

a5d209b56 fix(backend): retain exact document export pids accounting
Bind each exact transient service to an empty run-private accounting slice and retain actual native pids counters across child cgroup retirement. Preserve original hard controls, budgets, receipt schema and broker overhead; remove both owned cgroups during cleanup.

Refs: #3636

7bcfcbb46 fix(backend): wait for exact document export cgroup drain
Require both observed zero business processes and empty cgroup population within the unchanged cleanup polling bound. Keep physical cleanup and original resource gates fail closed.

Refs #3634

Change-Class: behavior
```

## 相对原 merge base 的源码差异概况

```text
...cument-export-cgroup-drain-external-naming.json |  20 +
 ...ument-export-first-failure-external-naming.json |  19 +
 ...ument-export-retained-pids-external-naming.json |  20 +
 docs/architecture/overview.md                      |  10 +
 .../DocumentExport/DocumentExportSandbox.cs        |  21 +-
 .../DocumentExportSystemdCgroupAuthority.cs        | 762 +++++++++++++++++++--
 .../Unit/AccountSubjectHashProjectionTests.cs      |  31 +
 .../backend/Unit/DocumentExportCgroupDrainTests.cs |  48 ++
 tests/backend/Unit/DocumentExportContractTests.cs  |  39 +-
 .../Unit/DocumentExportRetainedPidsTests.cs        | 566 +++++++++++++++
 .../Unit/DocumentExportSandboxFailureTests.cs      |  53 ++
 11 files changed, 1523 insertions(+), 66 deletions(-)
```


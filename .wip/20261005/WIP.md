# WIP: codex/issue-3524-live-assert-controls-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-live-assert-controls-20261003`
- 原始 commit：`9b08eaeb7c0e00903298ad5e86d89859fd3dc2db`
- 原始 tree：`9c7c66190aa4d28258d32ce6e02b96f633bad09a`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3527, #3529
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
9b08eaeb7 test(tooling): cover live systemd boundary assertion
Refs: #3524

088a545f8 test(test): restore scheduler recovery caller and refusal controls
Refs: #3524

154cc566c fix(test): retain private launcher authority and floor byte grants
Refs: #3524

c078dad47 fix(test): retain mysql resource leases through exact lifecycle cleanup
Restore the original systemd owner, live process and managed service binding path without granting host authority. Bind reservation accounting to the existing total grant and document retained cleanup; scheduler integration and native qualification remain pending.

Refs: #3524

6a8c01b63 fix(governance): restore the original systemd resource boundary owner
Restore the exact original resource-manager source for independent Migration orchestration. Retain private creation records, live control read-back, original process/service binding and empty-only cleanup; scheduler integration and physical qualification remain pending.

Refs: #3524

Refs: #3527

ad63210c1 fix(test): conserve scheduler grants when partitioning container resources
Restore the original strict reservation partition and downward kernel quantization. Live systemd owner and held-lease integration remain pending, so this pure component does not admit services or grant authority.

Refs: #3524

88a806959 fix(test): restore pinned mysql catalog and retained recovery component
Keep scheduler reservation, service admission and recovery-capability wiring separate; this source component does not qualify an execution.

Refs: #3524

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
```

## 相对原 merge base 的源码差异概况

```text
config/testing/test-execution-service-catalog.json |   36 +
 .../issue-1072-production-resource-enforcement.md  |   29 +-
 .../tools/production-resource-enforcement.test.mjs | 1644 +++++++++++++++++++-
 tools/test-matrix/mysql-fixture-recovery.mjs       |  140 ++
 .../production-resource-enforcement.mjs            |  712 ++++++++-
 .../production-systemd-resource-boundary.mjs       | 1206 ++++++++++++++
 6 files changed, 3689 insertions(+), 78 deletions(-)
```


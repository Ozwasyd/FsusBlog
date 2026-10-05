# WIP: codex/issue-2215-backup-binding-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-backup-binding-20261003`
- 原始 commit：`e5ff9bd42e3fc58a0b0c4430b408e7d81122a5d1`
- 原始 tree：`056a85f8330ca23eb22ec0ec156d1b3e99fd6277`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
e5ff9bd42 refactor(migration): expose original immutable backup planning scope
Refs: #2215

ce694f451 fix(migration): expose original owned backup input capability
Return only the actual opaque process-owned inputs for the retained backup consumer; do not replace authentication or terminal verification with a status flag.

Refs: #2215

ee079925d fix(migration): verify original backup tool read identities
Reuse the sole original file owner terminal guard before admitting tool bytes. Cover same-byte leaf and ancestor replacement, in-place changes and unrelated sibling writes.

Refs: #2215

1d571938a fix(migration): bind original backup tools and invocation scope
Resolve explicit process-owned tool bytes and input paths without reading credentials. Preserve original backup authority and operation deadline.

Refs: #2215

59eb08c31 fix(migration): drain original backup pipes during finite termination
Keep fair actual stdout and stderr consumption active through the original explicit TERM grace and KILL/reap ledger. Retain healthy terminal trap output; consume an already-failed raw pipe only with explicit incomplete-evidence refusal. Preserve primary errors and all existing cancellation assertions, without background copies or a second authority.

Refs: #2215

af7b7fa5d fix(migration): join actual pipe IO within the original invocation owner
Complete the original port implementation with fair nonblocking actual FD supervision, immediate safe first-error stop, per-write actual awaits, and explicit owned raw disposal. Add real kernel output-error and pipe-lifetime source fixtures; no runtime qualification is claimed.

Refs: #2215

2affbcd8e fix(migration): supervise actual backup pipes without detached copy tasks
Read original nonblocking pipe FDs fairly in one owned scope and await each actual raw write. Stop the original producer on the first pipe failure, preserve its safe cause, and close every established pipe independently without treating a timed wait as task termination. Preserve ordinary DR and the original operation deadline.

Refs: #2215

c7168111c feat(migration): invoke original backup drill with owned finite lifecycle
Consume the Host-owned remaining deadline; retain actual launch streams and await owned child/group and pipe terminal. Reuse the sole operations producer and fail closed on cancellation or unverified cleanup. Add migration-only signal refusal and source-only lifecycle fixtures, without a second package authority.

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
...site-backup-source-binding-external-naming.json |  23 +
 docs/operations.md                                 |   6 +
 docs/security/site-backup-envelope.md              |  32 +
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs | 208 ++++++
 .../OfflineMigrationShellBackupDrillProducer.cs    | 557 ++++++++++++++++
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs | 327 ++++++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs | 327 ++++++++++
 tests/tools/backup-envelope-contract.test.mjs      | 355 +++++++++++
 tools/operations/backup-restore-drill.sh           | 709 +++++++++++++++++++--
 tools/operations/backup-site.sh                    | 316 ++++++++-
 tools/operations/restore-site.sh                   | 431 ++++++++++++-
 tools/operations/test-backup-envelope-fixture.sh   |  41 ++
 .../test-backup-restore-drill-fixture.sh           |  17 +
 13 files changed, 3302 insertions(+), 47 deletions(-)
```


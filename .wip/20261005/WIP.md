# WIP: codex/issue-3524-migration-core-current-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-migration-core-current-20261003`
- 原始 commit：`94816b52f5b98b527326d2febbdb32d44785e422`
- 原始 tree：`3281049abf36596c3e5e7fdd65a85f07296e71e9`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3529, #3530
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
94816b52f fix(test): retain MySQL directory cleanup first cause
Keep the parent inspection refusal as the original cause and first aggregate error while reporting an unverified descriptor close. Add an isolated failure control with explicit fixture recovery; preserve all existing Migration evidence and fast-lane assertions.

Refs: #3524

34c0371a5 fix(test): confine MySQL admission to owned directories
Pin non-symlink owned parent directories for private admission I/O and reject changed pathname identities. Preserve the original evidence tests and add parent-link, non-directory and read/write replacement controls; full execution qualification remains pending.

Refs: #3524

a601aed9e fix(test): deliver bound independent Migration execution
Transfer the seven existing canonical Migration build, execution and evidence owners without changing their source semantics. Preserve evaluated Compile inventory and leave shared service and scheduler integration pending.

Refs: #3524

a72ec71fd fix(test): bind xUnit extraction to evaluated Compile items
Refs: #3524

9c959b468 fix(test): bind xUnit graph fixture to current Migration rollup case
Refs: #3524

44d422593 fix(test): register independent Migration xUnit compile contexts
Refs: #3524

b19b3dc71 test(governance): type registry-derived receipt behavior IDs
Refs: #3529
025de17f3 test(governance): align release-final scan fixture with closed contract
Refs: #3530
```

## 相对原 merge base 的源码差异概况

```text
tests/tools/migration-execution-evidence.test.mjs  | 1426 ++++++++++++++++++++
 tests/tools/migration-fast-lane.test.mjs           |  227 ++++
 .../tools/support/xunit-configuration-fixture.mjs  |  182 +++
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   48 +
 tools/test-inventory/adapters.mjs                  |   22 +-
 tools/test-inventory/discovery.mjs                 |   55 +-
 tools/test-inventory/produce.mjs                   |   13 +-
 tools/test-inventory/xunit-projects.mjs            |  103 ++
 .../test-inventory/xunit-roslyn-adapter/Program.cs |   35 +-
 .../XunitAdapterProjectContext.cs                  |   98 +-
 .../XunitAdapterReferenceResolution.cs             |  102 +-
 tools/test/build-migration-tests.mjs               |   88 ++
 tools/test/migration-build-binding.mjs             |  269 ++++
 tools/test/migration-execution-evidence.mjs        |  179 +++
 tools/test/mysql-fixture-admission.mjs             |  351 +++++
 tools/test/run-migration-tests.mjs                 |  511 +++++++
 18 files changed, 3709 insertions(+), 181 deletions(-)
```


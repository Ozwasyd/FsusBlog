# WIP: codex/issue-3524-systemd-managed-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-systemd-managed-20261003`
- 原始 commit：`a18d15b73b65443e190faaf01042793292dad616`
- 原始 tree：`dac4e77854475418e0353c8fd4e085d4d70d43ed`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3656, #3655
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a18d15b73 fix(governance): retain creation cleanup failure details
Keep the complete original finalization observation alongside unresolved creation evidence without replacing the first failure or its independent cleanup cause.

Refs: #3524

6ca0a1b22 fix(governance): retain failed managed creation evidence
Track the actual creation actor before asynchronous handshakes, preserve the first error through the existing finalizer, and retain uncertain sender delivery and control ownership for original durable-owner reconciliation.

Refs: #3524

2f8a925ab fix(governance): restore managed systemd execution admission
Bind original resource and durable process owners before pre-exec release while preserving the owned PrivateTmp namespace and nonrecursive mount guards.

Refs: #3524

d42493bc3 build(test): refresh matrix evidence path source binding
Refs: #3656

a36da7cfd test(test): retain actual private tmp control observations
Refs: #3656

499cd680a build(test): refresh owned tmp execution source bindings
Refs: #3656

130a7d2f4 fix(test): bind private tmp to the owned attempt directory
Refs: #3656

9ebf4321a fix(test): compile Landlock with older UAPI headers
Refs: #3655
```

## 相对原 merge base 的源码差异概况

```text
...e-3652-protected-admission-external-naming.json |  34 +
 ...3652-protected-admission-generated-binding.json |  30 +
 config/testing/correctness-attempt-producers.json  |   4 +-
 docs/testing.md                                    |  12 +
 .../backend-evidence-path-authority.generated.json |   2 +-
 .../release-final-execution-target-authority.json  | 162 +++-
 tests/matrix.yml                                   |   6 +
 tests/tools/behavior-doc-static-admission.test.mjs |  65 ++
 .../tools/execution-envelope-directories.test.mjs  | 346 ++++++++-
 tests/tools/execution-envelope-network.test.mjs    | 171 ++++
 tools/contracts/BehaviorDocRestore.slnx            |   7 +
 tools/docs/prepare-behavior-doc-nuget.mjs          | 251 ++++++
 tools/fact-extractors/test-matrix/extract.mjs      |   4 +-
 tools/run-test-matrix.mjs                          |  33 +-
 tools/test-matrix/production-disk-demand.mjs       |  60 ++
 .../protected-behavior-doc-admission.mjs           | 121 +++
 tools/test/behavior-doc-nuget-preparation.mjs      | 389 ++++++++++
 tools/test/execution-envelope-directories.mjs      | 189 +++--
 tools/test/execution-envelope-network.mjs          |  18 +
 tools/test/native/execution-envelope-landlock.c    |  76 ++
 tools/test/physical-execution-linux-preexec.py     |  37 +
 .../physical-execution-linux-systemd-adapter.mjs   | 856 +++++++++++++++++++--
 .../physical-execution-linux-systemd-bootstrap.mjs |  92 +++
 tools/test/physical-execution-process-tree.mjs     |   2 +
 tools/test/run-deterministic-command.mjs           | 661 +++++++++-------
 25 files changed, 3208 insertions(+), 420 deletions(-)
```


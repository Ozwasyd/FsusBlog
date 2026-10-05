# WIP: codex/issue-3524-dotnet-scratch-selector-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-dotnet-scratch-selector-20261003`
- 原始 commit：`a9c40f8ba6e95880653359880ae6e945cdf42bc3`
- 原始 tree：`d8ecc3e6a3bb94f68d945c55c042a99cc1a3e886`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a9c40f8ba fix(test): preserve preparation terminal during directory finalization
Require each started preparation and business phase to retain its own verified terminal. Pass the existing appropriate raw proof to the original directory guard without fabricating an aggregate or changing business receipt semantics.

Refs: #3524

46a988cf2 refactor(test): prepare nested envelopes in the retained controller owner
Reuse the original directory, environment, network and receipt producers for authenticated preparation. Keep actual preparation tools behind the retained managed owner port; child execution uses only its bound v2 reference.

Refs: #3524

4dde67a56 refactor(test): share original preparation purposes and network bindings
Refs: #3524

8da1510fd test(test): cover retained preparation and async owner refusals
Refs: #3524

7153afb43 fix(test): keep asynchronous network helpers at module scope
Refs: #3524

6591aea9d refactor(test): expose held-owner asynchronous envelope preparation ports
Refs: #3524

013d985f9 fix(test): retain actual run-owned preparation for nested handoff
Refs: #3524

e0aa94c13 fix(test): bind private dotnet scratch in owned correctness producers
Refs: #3524
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
 .../tools/execution-envelope-directories.test.mjs  | 346 +++++++-
 .../tools/execution-envelope-environment.test.mjs  | 260 ++++++
 tests/tools/execution-envelope-network.test.mjs    | 413 ++++++++++
 tools/contracts/BehaviorDocRestore.slnx            |   7 +
 tools/docs/prepare-behavior-doc-nuget.mjs          | 251 ++++++
 tools/fact-extractors/test-matrix/extract.mjs      |   4 +-
 tools/run-test-matrix.mjs                          |  33 +-
 tools/test-matrix/production-disk-demand.mjs       |  60 ++
 .../protected-behavior-doc-admission.mjs           | 121 +++
 tools/test/behavior-doc-nuget-preparation.mjs      | 389 +++++++++
 tools/test/execution-envelope-directories.mjs      | 221 ++++--
 tools/test/execution-envelope-environment.mjs      | 174 +++-
 tools/test/execution-envelope-network.mjs          | 132 ++-
 tools/test/native/execution-envelope-landlock.c    |  76 ++
 tools/test/physical-execution-linux-preexec.py     |  37 +
 .../physical-execution-linux-systemd-adapter.mjs   |  51 +-
 .../physical-execution-linux-systemd-bootstrap.mjs |   1 +
 tools/test/physical-execution-process-tree.mjs     |   2 +
 tools/test/run-deterministic-command.mjs           | 884 +++++++++++++++------
 27 files changed, 3438 insertions(+), 339 deletions(-)
```


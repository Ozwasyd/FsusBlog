# WIP: codex/issue-3638-ast-recovery-20261001

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3638-ast-recovery-20261001`
- 原始 commit：`40b79a087e923ee9bb41ffaa93c52e0d5949b4db`
- 原始 tree：`0fd64a34ddaf1bdf43a3b78cee77fb13505829d6`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3638
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
40b79a087 docs(tooling): clarify mandatory registered input selection
Refs: #3638

e4d949f66 test(tooling): reject registered command input selection bypasses
Refs: #3638

5855fd4c4 fix(tooling): require registered command input admission before exclusions
Bind the canonical native selection policy and prevent required registered input validation from being erased by candidate exclusions, domains, or full-mode hash baselines. Keep unrelated explicit file selection unchanged.

Refs: #3638

2839bb4c3 test(tooling): cover command wrapper input model refusals
Exercise the actual required-tools checker, default and additive taint sources, owner/configuration drift, and original/private compile database binding. Preserve the original 63 test cases unchanged.

Refs: #3638

323391d80 docs(tooling): document closed command wrapper analysis inputs
Refs: #3638

4cb0ed6f2 feat(tooling): bind admitted command wrapper analyzer inputs
Keep the bootstrap model local and nonqualifying. Preserve default taint analysis outside the reviewed translation unit and the original strict compiler command.

Refs: #3638

9d7b45d5c fix(tooling): reject nonregular source replacement without blocking

a9a7d317d fix(tooling): bound wrapper source reads before identity hashing
```

## 相对原 merge base 的源码差异概况

```text
.../command-wrapper-input-registry.json            | 1698 ++++++++++++++++++++
 .../development/command-wrapper-taint-sources.yml  |    6 +
 .../native-tooling-style-enforcement.md            |   10 +
 tests/tools/execution-envelope-network.test.mjs    |  304 +++-
 tests/tools/native-tooling-style.test.mjs          |  470 ++++++
 tools/style/check-native-tooling-style.mjs         |   61 +-
 tools/style/command-wrapper-caller-binding.mjs     |  346 ++++
 tools/style/command-wrapper-compile-binding.mjs    |  466 ++++++
 tools/style/command-wrapper-input-ast.mjs          |  415 +++++
 tools/style/command-wrapper-input-model.mjs        |  222 +++
 tools/test/native/execution-envelope-landlock.c    |  110 +-
 11 files changed, 4072 insertions(+), 36 deletions(-)
```


# WIP: codex/issue-3639-stable-read-recovery

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3639-stable-read-recovery`
- 原始 commit：`5d172ad05181ec4d47d5c281daf468b8c0619bed`
- 原始 tree：`f01c42b865c83a0ca263e32c51ca582b27d4028f`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3639
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
5d172ad05 test(governance): cover canonical pre-read replacement refusals
Preserve the original post-read alias coverage and assert zero or one approved descriptor reads before rejecting first-open or verification-open inode replacement.

Refs: #3639

4c58a64ed fix(governance): reject changed input before descriptor reads
Refs #3639

324703ba1 fix(governance): bind canonical source reads to stable descriptors
Refs #3639

ddbd65205 fix(governance): refuse hardlinked canonical authority inputs
Refs #3639

af8c4e09a chore(testing): regenerate closed digest edge bindings
Refs #3639

c9077e6de fix(governance): close reviewed canonical edge admission gaps
Refuse raw duplicate and escaped registry members. Declare complete fixture input owners and protect every actual style authority path.

Refs: #3639

781577e58 test(governance): register the closed canonical edge owner
Use the original frontend style owner alongside exact edge refusal cases. Retain the frozen consumer as source text so tests do not depend on an unreachable Migration commit.

Refs: #3639

bb5c7108f fix(governance): refuse canonical edge authority substitution
Bind complete style policy inputs and preflight caller source before suppressible diagnostics. Preserve the original style fixture assertions using independent regular authority copies.

Refs: #3639
```

## 相对原 merge base 的源码差异概况

```text
config/development/canonical-digest-edge.json      |  29 ++
 config/development/frontend-style-policy.json      |   2 +
 config/testing/correctness-attempt-producers.json  |   4 +-
 docs/development/frontend-style-enforcement.md     |  53 +++
 .../backend-evidence-path-authority.generated.json |   2 +-
 .../release-final-execution-target-authority.json  | 104 +++-
 tests/matrix.yml                                   |  17 +-
 tests/tools/canonical-digest-edge.test.mjs         | 512 ++++++++++++++++++++
 .../fixtures/canonical-digest-edge/v3-contract.mjs | 289 ++++++++++++
 tests/tools/frontend-style.test.mjs                |  22 +-
 tools/frontend/check-frontend-style.mjs            |  49 +-
 .../style-toolchain/closed-canonical-edge.mjs      | 524 +++++++++++++++++++++
 tools/frontend/style-toolchain/eslint.config.mjs   |  12 +-
 tools/governance/change-contract-registry.mjs      |  18 +-
 14 files changed, 1597 insertions(+), 40 deletions(-)
```


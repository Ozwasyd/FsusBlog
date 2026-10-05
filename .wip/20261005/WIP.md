# WIP: codex/issue-3652-legal-delivery-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3652-legal-delivery-20261003`
- 原始 commit：`e17fa637c433ac350a64c1ad259beffa523a6311`
- 原始 tree：`69871553c4eba3b1675eae4e7785073aa22e2126`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3652
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
e17fa637c fix(test): bind signed offline NuGet restore and canonical products
Refs: #3652

bc84a8170 fix(test): bind offline capacity fixture to repository module root
Refs: #3652

074840c53 fix(test): retain preparation quota and lease for unknown residue
Refs: #3652

5c6807f0b fix(test): retain owned outputs until physical terminal is verified
Refs: #3652

61ab17a5f fix(test): retain protected admission cancellation cause and state
Refs: #3652

bc0f6e698 fix(test): declare offline feed fixture in module scope
Refs: #3652

9ce585c69 fix(test): prepare finite offline NuGet through canonical physical execution
Refs: #3652

358e23ffd fix(test): preserve protected admission receipt binding and async lifetime
Refs: #3652
```

## 相对原 merge base 的源码差异概况

```text
...e-3652-protected-admission-external-naming.json |  34 ++
 ...3652-protected-admission-generated-binding.json |  23 +
 config/testing/correctness-attempt-producers.json  |   4 +-
 docs/testing.md                                    |  10 +
 .../release-final-execution-target-authority.json  | 132 ++++-
 tests/matrix.yml                                   |   6 +
 tests/tools/behavior-doc-static-admission.test.mjs |  65 ++
 .../tools/execution-envelope-directories.test.mjs  | 346 ++++++++++-
 tools/contracts/BehaviorDocRestore.slnx            |   7 +
 tools/docs/prepare-behavior-doc-nuget.mjs          | 249 ++++++++
 tools/fact-extractors/test-matrix/extract.mjs      |   4 +-
 tools/run-test-matrix.mjs                          |  33 +-
 tools/test-matrix/production-disk-demand.mjs       |  60 ++
 .../protected-behavior-doc-admission.mjs           | 121 ++++
 tools/test/behavior-doc-nuget-preparation.mjs      | 372 ++++++++++++
 tools/test/execution-envelope-directories.mjs      | 145 +++--
 tools/test/run-deterministic-command.mjs           | 659 ++++++++++++---------
 17 files changed, 1908 insertions(+), 362 deletions(-)
```


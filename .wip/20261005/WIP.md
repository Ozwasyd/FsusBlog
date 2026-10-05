# WIP: codex/issue-3533-3536-integration-dac4233

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3533-3536-integration-dac4233`
- 原始 commit：`89bbbf76cb2b88a793e83a2939808eb9780f5d78`
- 原始 tree：`9dcdf8f180788b86eebd42c1f5e6d02b5871d35a`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3533, #3612, #3610, #3536, #3537, #3540
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
89bbbf76c docs(api): align public error reference state prose
Keep the current DocClaim body aligned with the compiled typed endpoint observation without changing the observer or generated OpenAPI sections.

Refs: #3612

c0199f601 docs(release): refresh generated authority module digests
Regenerate the release aggregate fact section from a sealed current-master test-matrix observation. This commit remains a local candidate until the separate post-merge repair governance is trusted.

Refs: #3610

84be7a6cb test(governance): probe DocClaim and OpenAPI admission together
Stack the reviewed-source candidate only for local integration, then regenerate exact execution authority and bindings from the combined tree. This is not an isolated PR acceptance claim.

Refs: #3533

dac4233fc fix(contracts): bind OpenAPI minimal receipt on current style base
Replay the exact BehaviorDoc receipt validation on the current OpenAPI style owner and regenerate the release-final authority from its producer.

Refs: #3536

b5bac7336 fix(governance): rebind OpenAPI style evidence on current master
Refs: #3537

Refs: #3540

7d10991c8 chore(governance): bind generated JSON naming surface
Name the exact execution-target fixture in the existing external naming manifest without broadening the registered exception.

Refs: #3537

9a79641fd chore(governance): bind OpenAPI generated authority evidence
Declare the changed OpenAPI source inputs and exact canonical execution target fixture digest for PR validation.

Refs: #3537

Refs: #3540

4d1b78ee0 chore(governance): bind OpenAPI execution target authority
Regenerate the canonical release-final execution target fixture for the changed OpenAPI producer and digest runner without altering its roster.

Refs: #3537

Refs: #3540
```

## 相对原 merge base 的源码差异概况

```text
.git-blame-ignore-revs                             |    3 +
 ...ue-3533-docclaim-collision-external-naming.json |   19 +
 ...-3533-docclaim-collision-generated-binding.json |   12 +
 ...36-openapi-minimal-receipt-external-naming.json |   21 +
 ...-openapi-minimal-receipt-generated-binding.json |   13 +
 ...openapi-execution-target-generated-binding.json |   13 +
 .../issue-3537-openapi-style-external-naming.json  |   28 +
 artifacts/style/openapi-aeds-idempotence.json      |   16 +
 docs/api/schemas-and-errors.md                     |    2 +-
 docs/architecture/repository-layout.md             |    2 +
 docs/releases/release-identity.md                  |    2 +-
 .../release-final-execution-target-authority.json  |   20 +-
 .../behavior-document-consistency-final.test.mjs   |   23 +
 tests/tools/openapi-aeds-observation.test.mjs      |  549 ++++++++-
 tools/contracts/lib/openapi-observation.mjs        |   67 +-
 tools/docs/behavior-doc-static-admission.mjs       |    4 +-
 tools/docs/behavior-document-consistency-final.mjs |    8 +-
 tools/fact-extractors/openapi-aeds/extract.mjs     | 1228 +++++++++++---------
 tools/fact-extractors/runner.mjs                   |   19 +-
 19 files changed, 1446 insertions(+), 603 deletions(-)
```


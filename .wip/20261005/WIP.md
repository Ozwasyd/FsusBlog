# WIP: codex/issue-3536-3537-3540-integration

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3536-3537-3540-integration`
- 原始 commit：`44a9a22df15286c0b4c350b93a334be0ee9eb43a`
- 原始 tree：`318efc5e63848641559e05f207f4b1d52ac19557`
- 与当前 master 的 merge base：`d653afbde02b75814d8384777886b10419fb38a1`
- 相关 issue 线索：#3536, #3537, #3540
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
44a9a22df chore(governance): align OpenAPI integration authority
Merge the updated style and digest boundary candidate, retain the canonical combined execution-target fixture, and bind its generated and naming evidence for the downstream receipt change.

Refs: #3536

Refs: #3537

Refs: #3540

b005415c3 chore(governance): bind generated JSON naming surface
Name the exact execution-target fixture in the existing external naming manifest without broadening the registered exception.

Refs: #3537

a36a3a311 chore(governance): bind OpenAPI generated authority evidence
Declare the changed OpenAPI source inputs and exact canonical execution target fixture digest for PR validation.

Refs: #3537

Refs: #3540

3432dc9b8 chore(governance): bind OpenAPI execution target authority
Regenerate the canonical release-final execution target fixture for the changed OpenAPI producer and digest runner without altering its roster.

Refs: #3537

Refs: #3540

82437ea4d fix(contracts): integrate OpenAPI minimal receipt validation
Preserve the digest-runner dependency injection boundary and bind the execution target authority through its canonical producer.

Refs: #3536

Refs: #3537

Refs: #3540

26110bf93 chore(governance): rebind OpenAPI source evidence
Record the producer naming surface and the two verified formatter passes at the candidate content after digest source-binding tests were added.

Refs: #3537 #3540

ebd4f80e0 fix(contracts): bind OpenAPI digest provider in build receipt
Seal the runner and canonicalization implementation into the observation receipt source set so a stale receipt cannot survive provider or resolution drift. Cover altered resolution, implementation bytes, and a resealed omission.

Refs: #3537 #3540

99b3d654b chore(governance): bind OpenAPI naming surface
Refs: #3537 #3540
```

## 相对原 merge base 的源码差异概况

```text
.git-blame-ignore-revs                             |    3 +
 ...36-openapi-minimal-receipt-external-naming.json |   21 +
 ...-openapi-minimal-receipt-generated-binding.json |   13 +
 ...openapi-execution-target-generated-binding.json |   13 +
 .../issue-3537-openapi-style-external-naming.json  |   28 +
 artifacts/style/openapi-aeds-idempotence.json      |   16 +
 docs/architecture/repository-layout.md             |    2 +
 .../release-final-execution-target-authority.json  |   16 +-
 tests/tools/openapi-aeds-observation.test.mjs      |  549 ++++++++-
 tools/contracts/lib/openapi-observation.mjs        |   67 +-
 tools/docs/behavior-doc-static-admission.mjs       |    4 +-
 tools/fact-extractors/openapi-aeds/extract.mjs     | 1228 +++++++++++---------
 tools/fact-extractors/runner.mjs                   |   19 +-
 13 files changed, 1381 insertions(+), 598 deletions(-)
```


# WIP: codex/issue-3610-3612-3615-3617-ls0tx5

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3610-3612-3615-3617-ls0tx5`
- 原始 commit：`3082712a1535177229209f0458753a722cfa0d59`
- 原始 tree：`9706d803d4ed933a5845119b3f74cfed3c24872b`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3610, #3612, #3615, #3619, #3617
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
3082712a1 docs(api): align public error reference state prose
Keep the current DocClaim body aligned with the compiled typed endpoint observation without changing the observer or generated OpenAPI sections.

Refs: #3612

5d55ba7f2 chore(governance): bind DocClaim execution authority
Refs: #3615

ce25bddb0 docs(release): synchronize aggregate source digests
Refs: #3619

6386ab325 chore(governance): integrate BehaviorDoc prerequisites
Refs: #3615, #3617

c01f92cc3 chore(governance): declare OpenAPI naming authority
Refs: #3617

235aded2b chore(governance): declare DocClaim naming authority
Refs: #3615

3edcce70c fix(governance): bind BehaviorDoc OpenAPI receipt
Seal the minimal host observation and projection in a v2 artifact receipt, then reuse canonical OpenAPI receipt sealing without a second build. Keep exact source, output and rejection checks, and invalidate old caches missing the projection binding. Full admission still requires the independent DocClaim prerequisite and review.

Refs: #3617

2f60ed30e fix(governance): exempt exact rejecting DocClaim guard
Keep real self-proving claim surfaces fail-closed while allowing the existing rejection-only consistency guard. Full BehaviorDoc admission remains blocked by the independent OpenAPI build-identity mismatch.

Refs: #3615
```

## 相对原 merge base 的源码差异概况

```text
.../issue-3615-external-naming.json                |  19 ++++
 .../issue-3615-generated-binding.json              |  12 +++
 .../issue-3617-external-naming.json                |  29 ++++++
 .../openapi-minimal-receipt-generated-binding.json |  17 ++++
 ...havior-doc-static-admission-receipt.schema.json |  78 +++++++++++++++-
 docs/api/schemas-and-errors.md                     |   2 +-
 docs/releases/release-identity.md                  |   2 +-
 docs/testing.md                                    |   2 +-
 .../release-final-execution-target-authority.json  |  54 +++++++----
 tests/tools/behavior-doc-static-admission.test.mjs | 100 ++++++++++++++++++++-
 tests/tools/doc-claim.test.mjs                     |  38 ++++++++
 tests/tools/openapi-aeds-observation.test.mjs      |  36 +++++++-
 .../runtime-role-minimal-v3-contract.test.mjs      |   1 +
 .../support/runtime-role-minimal-v3-fixture.mjs    |  12 +++
 tools/contracts/lib/openapi-observation.mjs        |  27 ++++++
 ...vior-doc-minimal-contract-build-v3-contract.mjs |  23 ++++-
 tools/docs/behavior-doc-minimal-contract-build.mjs |  26 ++++++
 tools/docs/behavior-doc-static-admission.mjs       |  68 +++++++++++++-
 tools/docs/doc-claim.mjs                           |  26 +++++-
 19 files changed, 542 insertions(+), 30 deletions(-)
```


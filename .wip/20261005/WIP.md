# WIP: codex/temporal-exact-epoch-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/temporal-exact-epoch-20261003`
- 原始 commit：`1adc72ab48d47e47c824888c2792653c39969667`
- 原始 tree：`4117f184911af972994788063f5850a6a58568e3`
- 与当前 master 的 merge base：`d653afbde02b75814d8384777886b10419fb38a1`
- 相关 issue 线索：#1601
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1adc72ab4 fix(test): preserve exact millisecond business epoch bindings
Reject precision loss at the existing temporal ingress and report the actual injected instant using the original lossless RFC3339 precision shape. Keep measurement clocks, policy and catalog semantics unchanged; additional Node and backend controls are source-only and have not run.

Refs: #1601

2ccdec9e5 chore(test): keep naming declarations within registered paths
Remove the unneeded declaration for the top-level matrix checker. The existing tools/**/*.mjs naming boundary does not cover that path; do not widen the registry or checker to admit it.

Refs: #1601

a3a3b7196 test(governance): distinguish release evidence rejection cases
Keep the undeclared evidence input fixture and check its existing closed-set
diagnostic. Independently remove a canonical producer tier to retain the
missing-producer rejection boundary without changing the evidence authority.

Declare the checker in the existing tooling naming manifest. No production
validator, matrix, canonical evidence input or generated output is changed.

Refs: #1601

2e1c2504e fix(contracts): classify protected fixture tooling responses
Register existing tooling-only JSON consumers with concrete routes and retirement conditions. Verify environment, secret and caller boundaries through the real endpoint pipeline without changing runtime handlers or the AEDS scanner.

Refs: #1601

8772abb33 build(test): bind remaining producer observation sources
Regenerate the canonical execution authority after complete actual clock validation and same-backend routing changes.

Refs: #1601

6d34c67b3 fix(test): require actual clocks at remaining producer boundaries
Validate complete backend and database observations through preparation and verification, preserve same-backend routing, and recover exact security state on temporal failure.

Refs: #1601

e8f33ab32 build(test): bind audit observation execution sources
Refresh the canonical execution authority after the audit observer and empty-variant integration changes.

Refs: #1601

75859c363 fix(test): bind audit producer actual temporal observations
Validate canonical audit context before preparation and carry the actual backend session observation through verification and independent replay. Admit the catalog-declared empty audit variant only with live zero-record evidence and empty identity sets.

Refs: #1601
```

## 相对原 merge base 的源码差异概况

```text
.../temporal-exact-epoch-external-naming.json      |   14 +
 .../temporal-producer-clock-external-naming.json   |   67 +
 .../temporal-producer-clock-generated-binding.json |   52 +
 .../authoritative-development-docs.json            |    8 +
 config/testing/correctness-attempt-producers.json  |    5 +-
 .../release-final-execution-authority-index.json   |    4 +-
 config/testing/temporal-callsite-dispositions.json |  447 ++++
 config/testing/temporal-producer-bindings.json     |   20 +-
 docs/api/aeds-only-policy.md                       |    9 +
 docs/api/schemas-and-errors.md                     |    2 +-
 docs/releases/release-identity.md                  |    2 +-
 docs/testing.md                                    |   23 +-
 .../Testing/TestTemporalRuntimeContext.cs          |   66 +-
 ...ocalAccountProfilePreferenceFixtureEndpoints.cs |    3 +-
 .../LocalPublicContentFixtureEndpoints.cs          |    6 +-
 .../Services/Fixtures/CommentFixtureSeeder.cs      |    5 +-
 .../Fixtures/CommentModerationFixturePort.cs       |    5 +-
 .../Moderation/ModerationRuntimeStateService.cs    |   59 +-
 ...AccountProfilePreferenceFixturePostgresTests.cs |    6 +-
 .../Unit/AdminSessionTouchPersistenceTests.cs      |  184 ++
 .../backend/Unit/ArticleServiceValidationTests.cs  |   15 +-
 .../backend/Unit/BlacklistServiceMutationTests.cs  |   88 +
 .../CommentModerationFixturePortContractTests.cs   |   25 +-
 .../Unit/LocalFixtureToolingBoundaryTests.cs       |  239 ++
 .../Unit/ModerationDictionaryServiceTests.cs       |    2 +-
 .../Unit/ModerationRuntimeStateServiceTests.cs     |   58 +-
 tests/backend/Unit/TestTemporalContextTests.cs     |  139 ++
 .../Unit/UserSessionJwtAuthenticationTests.cs      |   41 +
 tests/browser-contract/run.mjs                     |   40 +-
 .../release-final-execution-target-authority.json  |  290 ++-
 tests/test-retention-replacements.json             |   71 +
 tests/tools/account-messaging-producer.test.mjs    |   99 +-
 .../account-profile-preference-producer.test.mjs   |   53 +-
 tests/tools/aot-spa-hydration-raw.test.mjs         |  425 ++--
 tests/tools/audit-fixture-producer.test.mjs        |  217 +-
 tests/tools/auth-session-fixture-producer.test.mjs |   89 +-
 .../tools/authoritative-development-docs.test.mjs  |   59 +
 .../browser-contract-observation-raw.test.mjs      |  338 +--
 tests/tools/browser-contract.test.mjs              |   27 +-
 tests/tools/comment-fixture-contract.test.mjs      |  117 +
 tests/tools/data-scale-aeds-payload.test.mjs       |   40 +-
 tests/tools/data-scale-runtime-isolation.test.mjs  |  141 +-
 ...data-scale-temporal-replay.integration.test.mjs |    5 +-
 tests/tools/openapi-aeds-observation.test.mjs      |  343 ++-
 .../tools/post-runtime-producer-registry.test.mjs  |  192 +-
 .../release-final-post-runtime-replay.test.mjs     |   33 +-
 tests/tools/scheduler-owner-identity.test.mjs      |   67 +-
 tests/tools/security-fixture-producer.test.mjs     |  115 +-
 tests/tools/security-fixture-profile-e2e.test.mjs  |    8 +-
 .../browser-contract-observation-fixture.mjs       |  384 ++--
 tests/tools/support/browser-temporal-fixture.mjs   |   41 +
 .../canonical-post-runtime-source-fixture.mjs      |   79 +-
 .../support/esm-fixture-materializer-contracts.mjs |    3 +-
 tests/tools/support/scheduler-cli-fixture.mjs      |  138 ++
 tests/tools/temporal-shape-catalog.test.mjs        |   32 +
 tests/tools/test-evidence-receipt-schema.test.mjs  |  186 +-
 tests/tools/test-matrix-scheduler.test.mjs         |  160 +-
 tests/tools/test-temporal-context.test.mjs         |  145 ++
 .../tools/test-temporal-producer-bindings.test.mjs |  215 +-
 tests/tools/test-wall-clock-governance.test.mjs    |   19 +-
 tools/check-test-matrix.mjs                        |   10 +-
 tools/contracts/aeds-only-policy.allowlist.json    |  100 +
 tools/data-scale/aeds-decoders.mjs                 |   25 +-
 tools/data-scale/product-backend.mjs               |   17 +-
 tools/data-scale/runtime-provisioner-live.mjs      |   58 +-
 tools/data-scale/runtime-provisioner.mjs           |   14 +-
 tools/docs/behavior-document-consistency-final.mjs | 2401 ++++++++++++--------
 tools/fact-extractors/openapi-aeds/extract.mjs     | 1155 +++++-----
 .../release/browser-contract-receipt-contract.mjs  |   59 +-
 tools/release/test-evidence-receipts.mjs           |   52 +-
 .../aot-spa-hydration-observed-facts.mjs           |  326 +--
 tools/test-evidence/aot-spa-hydration-raw.mjs      |  535 +++--
 .../producers/account-messaging-producer.mjs       |   16 +-
 .../account-profile-preference-producer.mjs        |    6 +-
 tools/test-fixtures/producers/audit-producer.mjs   |   30 +-
 .../producers/auth-session-producer.mjs            |   17 +-
 .../producers/backend-temporal-observer.mjs        |   70 +
 tools/test-fixtures/producers/catalog-ports.mjs    |   65 +-
 .../producers/comment-moderation-producer.mjs      |    4 +-
 .../producers/demo-public-producer.mjs             |    6 +-
 .../producers/public-content-producer.mjs          |   30 +-
 .../producers/security-fixture-producer.mjs        |   38 +-
 .../test-matrix/post-runtime-producer-registry.mjs |   37 +-
 tools/test/check-temporal-shape-governance.mjs     |   28 +-
 tools/test/check-wall-clock-governance.mjs         |    2 +
 tools/test/correctness-attempt-producers.mjs       |    3 +
 tools/test/temporal-context-contract.mjs           |  441 ++++
 tools/test/temporal-context.mjs                    |  447 +---
 tools/test/temporal-producer-bindings.mjs          |   47 +-
 tools/test/verify-temporal-producers.mjs           |    2 +
 tools/testing/fixture-catalog.mjs                  |    7 +-
 91 files changed, 8436 insertions(+), 3377 deletions(-)
```


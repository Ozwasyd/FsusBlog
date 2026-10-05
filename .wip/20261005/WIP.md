# WIP: codex/issue-1762-article-preservation-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1762-article-preservation-20261003`
- 原始 commit：`38ce43eb8b0cf6030deee183e6a4a10703d4f739`
- 原始 tree：`61058badeeb25467bc094f9bda1ab495ed9f06ff`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1762
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
38ce43eb8 feat(database): stage preserved article graphs on the caller transaction
Keep historical views in source evidence rather than the current live counter. Bind physical columns to the original invoked owner, re-read complete rows, and retain caller transaction ownership. Source-only component; native integration and original acceptance gates remain pending.

Refs: #1762

f5272d82a feat(database): bind article storage rows to the invoked current schema owner
Refs #1762

aacca946c feat(database): connect article artifact publication to the single publisher
Refs #1762

20efa9ef8 feat(database): publish article preservation artifacts through the owned publisher
Refs #1762

17da4de89 feat(database): bind revision storage encodings to current owners
Use one current pure source for raw content-block addressing, sorted stored tag IDs and responsibility JSON. Preserve production SQL, validation and transaction ownership while exposing exact values to offline write plans.

Refs: #1762

77f3c9bd3 feat(database): capture article inputs and current default policy
Bind known legacy rows to the actual current stored defaults without fabricating historical authoring approval. Keep ordinary authoring validation unchanged and batch source relations in one consistent transaction.

Refs: #1762

174be19d3 fix(shared): retain complete article status mutation owner
Refs #1762

b792a0569 feat(database): project preserved articles through current rules
Refs #1762
```

## 相对原 merge base 的源码差异概况

```text
config/contracts/behavior-fact-extractors.json     |   2 +-
 .../mutation/behavior-mutation-owners.v1.json      |   9 +-
 .../mutation/changed-critical-domains.v1.json      |   3 +-
 docs/api/contracts.md                              |  12 +
 src/backend/Entities/Article.cs                    |  18 +-
 .../Integrity/ArticleResponsibilityManifest.cs     | 102 +---
 .../ArticleResponsibilitySnapshotBuilder.cs        |  17 +-
 .../Integrity/IntegrityProofPipeline.cs            |   1 +
 .../Integrity/IntegrityProofVerification.cs        |   1 +
 .../Projections/ArticleStatusProjection.cs         |   1 +
 .../ArticleDetailAedsArtifactStore.cs              |   1 +
 src/backend/Models/Dtos/AuthoringDtos.cs           |   3 +-
 .../Endpoints/AuthoringEndpoints.WorkflowRoutes.cs |   1 +
 .../Services/ArticlePublicationTransition.cs       |   1 +
 .../ArticleService.CacheAndInvalidation.cs         |   1 +
 .../ArticleService.LifecycleAndReadModels.cs       |   1 +
 src/backend/Services/ArticleService.Mutations.cs   |   1 +
 src/backend/Services/ArticleService.cs             |   1 +
 .../Articles/ArticleCreateMutationAuthority.cs     |   1 +
 .../Articles/ArticleLifecycleTransitionWriter.cs   |   1 +
 .../Articles/ArticlePublicationValidator.cs        |   1 +
 .../Articles/ArticleRevisionContentBlockStore.cs   |  11 +-
 .../Articles/ArticleRevisionPersistence.cs         |   3 +-
 .../Articles/ArticleRightsPolicyPersistence.cs     |   1 +
 .../Articles/ArticleRightsSnapshotBuilder.cs       |  23 +-
 .../Authoring/AuthoringContentTransferService.cs   |   1 +
 .../Authoring/AuthoringDraftLifecycleService.cs    |   1 +
 .../Services/Background/ScheduledPublishWorker.cs  |   1 +
 .../CanonicalArticleLifecycleFixturePort.cs        |   1 +
 .../CanonicalArticlePublicationFixturePort.cs      |   1 +
 .../Fixtures/DataScale/ArticleScalePlan.cs         |   1 +
 .../DataScale/CanonicalArticleGraphFactory.cs      |   1 +
 src/backend/Services/Fixtures/DemoFixtureSeeder.cs |   1 +
 .../Fixtures/PublicContentFixtureSeeder.cs         |   1 +
 src/backend/Services/SystemService.cs              |  41 +-
 src/core/Cache/PodBinaryCodec.Article.cs           |  33 +-
 src/core/Mapping/Models/ReadModels.cs              |  14 +-
 .../Services/Implementations/ArticleCoreService.cs |   1 +
 src/migration/ArticlePreservationPolicyExporter.cs | 161 ++++++
 src/migration/ArticlePreservationProjection.cs     | 189 +++++++
 .../ArticlePreservationSemanticReceipt.cs          |  37 ++
 src/migration/ArticlePreservationSourceReader.cs   | 214 ++++++++
 src/migration/ArticlePreservationStorageProgram.cs | 201 ++++++++
 src/migration/ArticlePreservationStorageWriter.cs  | 446 +++++++++++++++++
 src/migration/ArticlePreservationWritePlan.cs      |  62 +++
 .../Contracts/Articles}/ArticleCanonicalHashV1.cs  |  13 +-
 .../Articles/ArticleCurrentPolicyDefaults.cs       |  27 +
 .../Articles/ArticleProductionNormalizers.cs       |  76 ++-
 .../Articles/ArticleResponsibilityContracts.cs     |  37 ++
 .../Articles/ArticleResponsibilityGovernance.cs    |  71 +++
 .../Articles/ArticleRevisionContentAddress.cs      |  17 +
 .../Articles/ArticleRevisionStorageEncoding.cs     |  22 +
 .../Articles/ArticleRightsCanonicalBinding.cs      |  42 ++
 .../Articles}/ArticleRightsCanonicalHashV1.cs      |  20 +-
 .../Articles/ArticleRightsRequestCoreModel.cs      |  15 +
 .../Articles/ArticleStatusTransitionPolicy.cs      |  41 +-
 .../Contracts/Outputs/PublicSiteAuthorPolicy.cs    |  48 ++
 .../ArticleStatusTransitionIntegrationTests.cs     |   1 +
 ...rticleVaultExecutionPostgresIntegrationTests.cs |   1 +
 ...lArticleLifecycleFixturePortIntegrationTests.cs |   1 +
 ...rticlePublicationFixturePortIntegrationTests.cs |   1 +
 tests/backend/Unit/ArticleCanonicalHashTests.cs    |   1 +
 .../Unit/ArticleCoreServiceCurrentApiTests.cs      |   1 +
 .../Unit/ArticleEndpointServiceCurrentApiTests.cs  |   1 +
 tests/backend/Unit/ArticleEndpointServiceTests.cs  |   1 +
 .../Unit/ArticlePublicationTransitionTests.cs      |   1 +
 .../Unit/ArticleResponsibilityGovernanceTests.cs   |   3 +-
 .../Unit/ArticleResponsibilityVersioningTests.cs   |   1 +
 .../Unit/ArticleRevisionConcurrencyTests.cs        |   1 +
 .../Unit/ArticleRightsCanonicalHashTests.cs        |   1 +
 tests/backend/Unit/ArticleRightsWritePathTests.cs  |   1 +
 tests/backend/Unit/ArticleScalePlanTests.cs        |   1 +
 tests/backend/Unit/ArticleStatusProjectionTests.cs |   1 +
 .../Unit/AuthoringNativeAedsEndpointTests.cs       |   1 +
 .../CanonicalArticleLifecycleFixturePortTests.cs   |   1 +
 .../CanonicalArticlePublicationFixturePortTests.cs |   1 +
 tests/backend/Unit/CoreServiceTests.cs             |   1 +
 .../Unit/IntegrityProofVerificationTests.cs        |   1 +
 tests/backend/Unit/PodBinaryCodecTests.cs          |   1 +
 .../ArticlePreservationProjectionTests.cs          | 550 +++++++++++++++++++++
 .../ArticlePreservationSourceReaderTests.cs        | 133 +++++
 tests/migration/ArticlePreservationStorageTests.cs |  72 +++
 .../ArticlePreservationStorageWriterTests.cs       | 295 +++++++++++
 tests/migration/CurrentArticleContractTests.cs     | 187 +++++++
 .../tools/behavior-mutation-qualification.test.mjs |  83 +++-
 .../canonical-hash-source-governance.test.mjs      |   8 +-
 tests/tools/changed-critical-mutation.test.mjs     |  22 +-
 .../changed-critical-mutation-core-smoke.json      |   2 +-
 .../changed-critical-mutation-selection.json       |   4 +-
 .../fixtures/changed-critical-mutation-smoke.json  |   2 +-
 .../Program.cs                                     |   1 +
 ...eck-canonical-article-publication-authority.mjs |   2 +-
 tools/test-matrix/behavior-mutation-owner.mjs      |   4 +-
 93 files changed, 3160 insertions(+), 283 deletions(-)
```


# WIP: codex/issue-1761-pg-native-tests-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1761-pg-native-tests-20261003`
- 原始 commit：`0b66f60f2ed0e5a2519e0d19e63dc9b958ccdb9b`
- 原始 tree：`345ba1b8e67d4fd0a3c712153e4d4af45e68629d`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1761, #3657, #2215, #2217
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
0b66f60f2 test(database): exercise original nonarticle PostgreSQL capability refusals
Use the existing PostgreSQL fixture and actual original current exporter, structural staging and nonarticle factory. Keep same-count data tampering and the captured sequence floor on the real caller transaction; do not manufacture committed recovery or missing provider owners.

Refs: #1761

d9e402874 merge(test): preserve the lifecycle fixture registration prerequisite
Refs: #1761

0942a4499 fix(test): register and verify the existing lifecycle PostgreSQL fixture
Register the unchanged Collection A class with its thirteen cases and retain the original fixture isolation. Normalize the affected Node source through the original locked ESLint configuration without changing the ten existing controls or weakening the new omission control.

Refs: #3657

b426d5b8b fix(migration): retain original media checkpoint anchors
Refs #2215. Accept only original v1/v2 journal anchors at the whole-byte command boundary; actual full native journal/checkpoint validation remains mandatory. Source-only, no SDK or database execution.

99a3c3ae3 fix(migration): bind accepted media progress before recovery
Refs #2215. Integrate original article/current-contract and non-article recovery source owners, retain strict original provider capabilities, and bind exact accepted progress before Target/Resume observations. Source-only; SDK, database, generated producers and operational qualification are not run.

324032528 feat(migration): compose original native provider source ports
Change-Class: behavior

Refs: #2215, #2217

840e02ec7 feat(migration): compose original retained planning owners
Change-Class: behavior

Refs: #2215

77441c1a3 feat(migration): compose the original retained build inputs
Change-Class: behavior

Refs: #2215

Normal source integration of the original production owner only; compiled capability and current provider execution remain unqualified.
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    3 +
 ...res-lifecycle-registration-external-naming.json |   12 +
 ...site-backup-source-binding-external-naming.json |   23 +
 config/contracts/behavior-fact-extractors.json     |    2 +-
 .../mutation/behavior-mutation-owners.v1.json      |    9 +-
 .../mutation/changed-critical-domains.v1.json      |    3 +-
 docs/api/contracts.md                              |   12 +
 docs/database-migration.md                         |  468 +++++++-
 docs/operations.md                                 |    6 +
 docs/security/site-backup-envelope.md              |   32 +
 docs/testing.md                                    |    2 +-
 src/backend/Entities/Article.cs                    |   18 +-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../Integrity/ArticleResponsibilityManifest.cs     |  102 +-
 .../ArticleResponsibilitySnapshotBuilder.cs        |   17 +-
 .../Integrity/IntegrityProofPipeline.cs            |    1 +
 .../Integrity/IntegrityProofVerification.cs        |    1 +
 .../Projections/ArticleStatusProjection.cs         |    1 +
 .../ArticleDetailAedsArtifactStore.cs              |    1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs |  661 +-----------
 .../CurrentSchemaOwnedProjectionExporter.cs        |   97 ++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |   47 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  192 ++++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../CurrentSchemaRecipeFactExtractor.cs            |  291 +++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   94 +-
 .../SchemaMigration/SchemaModelInspector.cs        |  663 +-----------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |    7 +-
 src/backend/Models/Dtos/AuthoringDtos.cs           |    3 +-
 .../Endpoints/AuthoringEndpoints.WorkflowRoutes.cs |    1 +
 src/backend/Program.cs                             |   35 +
 .../Services/ArticlePublicationTransition.cs       |    1 +
 .../ArticleService.CacheAndInvalidation.cs         |    1 +
 .../ArticleService.LifecycleAndReadModels.cs       |    1 +
 src/backend/Services/ArticleService.Mutations.cs   |    1 +
 src/backend/Services/ArticleService.cs             |    1 +
 .../Articles/ArticleCreateMutationAuthority.cs     |    1 +
 .../Articles/ArticleLifecycleTransitionWriter.cs   |    1 +
 .../Articles/ArticlePublicationValidator.cs        |    1 +
 .../Articles/ArticleRevisionContentBlockStore.cs   |   11 +-
 .../Articles/ArticleRevisionPersistence.cs         |    3 +-
 .../Articles/ArticleRightsPolicyPersistence.cs     |    1 +
 .../Articles/ArticleRightsSnapshotBuilder.cs       |   23 +-
 .../Authoring/AuthoringContentTransferService.cs   |    1 +
 .../Authoring/AuthoringDraftLifecycleService.cs    |    1 +
 .../Services/Background/ScheduledPublishWorker.cs  |    1 +
 .../CanonicalArticleLifecycleFixturePort.cs        |    1 +
 .../CanonicalArticlePublicationFixturePort.cs      |    1 +
 .../Fixtures/DataScale/ArticleScalePlan.cs         |    1 +
 .../DataScale/CanonicalArticleGraphFactory.cs      |    1 +
 src/backend/Services/Fixtures/DemoFixtureSeeder.cs |    1 +
 .../Fixtures/PublicContentFixtureSeeder.cs         |    1 +
 src/backend/Services/SystemService.cs              |   41 +-
 src/core/Cache/PodBinaryCodec.Article.cs           |   33 +-
 src/core/Mapping/Models/ReadModels.cs              |   14 +-
 .../Services/Implementations/ArticleCoreService.cs |    1 +
 src/migration/ArticleMediaPreservation.cs          |  409 +++++++
 .../ArticleMediaPreservationFileSystem.cs          |  409 +++++++
 src/migration/ArticlePreservationPolicyExporter.cs |  161 +++
 src/migration/ArticlePreservationProjection.cs     |  189 ++++
 .../ArticlePreservationSemanticReceipt.cs          |   37 +
 src/migration/ArticlePreservationSourceReader.cs   |  234 ++++
 src/migration/ArticlePreservationStorageProgram.cs |  201 ++++
 src/migration/ArticlePreservationStorageWriter.cs  |  446 ++++++++
 src/migration/ArticlePreservationWritePlan.cs      |   62 ++
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  182 ++++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++++++
 src/migration/FsusBlog.Migration.csproj            |   12 +
 src/migration/MySqlCurrentSchemaCatalogObserver.cs |  249 +++++
 src/migration/OfflineMigrationApplyContracts.cs    |  134 +++
 src/migration/OfflineMigrationApplyEvidence.cs     |  386 +++++++
 .../OfflineMigrationApplyJournalVerifier.cs        |  365 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |   66 ++
 .../OfflineMigrationArticleMediaJournal.cs         |   80 ++
 .../OfflineMigrationArticlePreservationRoute.cs    |  222 ++++
 src/migration/OfflineMigrationArtifactPublisher.cs |   51 +
 src/migration/OfflineMigrationBackupAdmission.cs   |  485 +++++++++
 src/migration/OfflineMigrationCommandLine.cs       |  383 +++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs |  340 ++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         |  494 +++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |   65 ++
 src/migration/OfflineMigrationExecutor.cs          |  508 +++++++++
 src/migration/OfflineMigrationHost.cs              |  525 ++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  155 +++
 .../OfflineMigrationMySqlNativeSession.cs          |  217 ++++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 ++
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 +++
 src/migration/OfflineMigrationPlanEvidence.cs      |  188 ++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 ++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  204 ++++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 +++
 .../OfflineMigrationSourceFingerprints.cs          |  230 ++++
 .../OfflineMigrationSourceObserver.Providers.cs    |  639 +++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    |  545 ++++++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      |  264 +++++
 .../OfflineMigrationSqliteNativeSession.cs         |  301 ++++++
 src/migration/OfflineMigrationStateStore.cs        |  188 ++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |   98 ++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 ++
 src/migration/PgArticlePreservationOperation.cs    |  653 ++++++++++++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   58 +
 src/migration/PgLegacyCurrentSchemaPreparation.cs  |  127 +++
 src/migration/PgLegacyNonArticlePreparation.cs     |  582 ++++++++++
 src/migration/PgLegacyNonArticleRecovery.cs        |  274 +++++
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  717 +++++++++++++
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  238 +++++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  147 +++
 .../Contracts/Articles}/ArticleCanonicalHashV1.cs  |   13 +-
 .../Articles/ArticleCurrentPolicyDefaults.cs       |   27 +
 .../Articles/ArticleProductionNormalizers.cs       |   76 +-
 .../Articles/ArticleResponsibilityContracts.cs     |   37 +
 .../Articles/ArticleResponsibilityGovernance.cs    |   71 ++
 .../Articles/ArticleRevisionContentAddress.cs      |   17 +
 .../Articles/ArticleRevisionStorageEncoding.cs     |   22 +
 .../Articles/ArticleRightsCanonicalBinding.cs      |   42 +
 .../Articles}/ArticleRightsCanonicalHashV1.cs      |   20 +-
 .../Articles/ArticleRightsRequestCoreModel.cs      |   15 +
 .../Articles/ArticleStatusTransitionPolicy.cs      |   41 +-
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../Contracts/Outputs/PublicSiteAuthorPolicy.cs    |   48 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |   27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      |  362 +++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |   15 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  |  167 +++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |   60 ++
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |   37 +
 .../Contracts/Schema/SchemaExpressionModel.cs      |   31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs |  185 ++++
 .../Schema/SchemaPhysicalTypeProjection.cs         |  111 ++
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++++
 .../Fixtures/postgres-test-collections.json        |   10 +-
 .../ArticleStatusTransitionIntegrationTests.cs     |    1 +
 ...rticleVaultExecutionPostgresIntegrationTests.cs |    1 +
 ...lArticleLifecycleFixturePortIntegrationTests.cs |    1 +
 ...rticlePublicationFixturePortIntegrationTests.cs |    1 +
 .../PgLegacyNonArticleRecoveryIntegrationTests.cs  |  154 +++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 tests/backend/Unit/ArticleCanonicalHashTests.cs    |    1 +
 .../Unit/ArticleCoreServiceCurrentApiTests.cs      |    1 +
 .../Unit/ArticleEndpointServiceCurrentApiTests.cs  |    1 +
 tests/backend/Unit/ArticleEndpointServiceTests.cs  |    1 +
 .../Unit/ArticlePublicationTransitionTests.cs      |    1 +
 .../Unit/ArticleResponsibilityGovernanceTests.cs   |    3 +-
 .../Unit/ArticleResponsibilityVersioningTests.cs   |    1 +
 .../Unit/ArticleRevisionConcurrencyTests.cs        |    1 +
 .../Unit/ArticleRightsCanonicalHashTests.cs        |    1 +
 tests/backend/Unit/ArticleRightsWritePathTests.cs  |    1 +
 tests/backend/Unit/ArticleScalePlanTests.cs        |    1 +
 tests/backend/Unit/ArticleStatusProjectionTests.cs |    1 +
 .../Unit/AuthoringNativeAedsEndpointTests.cs       |    1 +
 .../CanonicalArticleLifecycleFixturePortTests.cs   |    1 +
 .../CanonicalArticlePublicationFixturePortTests.cs |    1 +
 tests/backend/Unit/CoreServiceTests.cs             |    1 +
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  225 ++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  556 ++++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  293 +++++
 .../Unit/IntegrityProofVerificationTests.cs        |    1 +
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 ++
 tests/backend/Unit/PodBinaryCodecTests.cs          |    1 +
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |   41 +-
 tests/migration/ArticleMediaPreservationTests.cs   |  418 ++++++++
 .../ArticlePreservationProjectionTests.cs          |  550 ++++++++++
 .../ArticlePreservationSourceReaderTests.cs        |  133 +++
 tests/migration/ArticlePreservationStorageTests.cs |   72 ++
 .../ArticlePreservationStorageWriterTests.cs       |  295 +++++
 tests/migration/CurrentArticleContractTests.cs     |  187 ++++
 .../CurrentSchemaBootstrapCompilerTests.cs         |  190 ++++
 .../CurrentSchemaStorageProjectionTests.cs         |   46 +
 .../MySqlCurrentSchemaCatalogObserverTests.cs      |  165 +++
 .../migration/OfflineMigrationApplyCommandTests.cs |  713 +++++++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1126 ++++++++++++++++++++
 ...fflineMigrationArticlePreservationRouteTests.cs |  285 +++++
 .../OfflineMigrationBackupAdmissionTests.cs        |  488 +++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   74 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  316 ++++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  500 +++++++++
 ...flineMigrationCurrentSchemaMediaBindingTests.cs |  153 +++
 .../OfflineMigrationFingerprintCommandTests.cs     |   83 ++
 ...lineMigrationHostRetentionConfigurationTests.cs |   66 ++
 .../OfflineMigrationMySqlNativeSessionTests.cs     |  135 +++
 ...neMigrationOwnedPlanningAuthorityReaderTests.cs |  157 +++
 tests/migration/OfflineMigrationPlanTests.cs       |  477 +++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs |  278 +++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |   59 +
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs |  302 ++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs |  327 ++++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  463 ++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs |  189 ++++
 .../OfflineMigrationSourceObserverTests.cs         |  560 ++++++++++
 .../OfflineMigrationSqliteDatabaseIdentityTests.cs |  214 ++++
 .../OfflineMigrationSqliteNativeSessionTests.cs    |  310 ++++++
 .../OfflineMigrationVerifyCommandTests.cs          |  297 ++++++
 tests/migration/OwnedRetainedMigrationToolTests.cs |   60 ++
 .../PgArticlePreservationOperationTests.cs         |  229 ++++
 .../PgArticlePreservationRecoveryBindingTests.cs   |   52 +
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |   76 ++
 .../PgLegacyCurrentSchemaPreparationTests.cs       |   89 ++
 .../PgLegacyNonArticlePreparationTests.cs          |  176 +++
 tests/migration/PgLegacyNonArticleRecoveryTests.cs |  132 +++
 tests/tools/backup-envelope-contract.test.mjs      |  355 ++++++
 .../tools/behavior-mutation-qualification.test.mjs |   83 +-
 .../canonical-hash-source-governance.test.mjs      |    8 +-
 tests/tools/changed-critical-mutation.test.mjs     |   22 +-
 .../tools/check-postgres-test-collections.test.mjs |  182 ++--
 .../changed-critical-mutation-core-smoke.json      |    2 +-
 .../changed-critical-mutation-selection.json       |    4 +-
 .../fixtures/changed-critical-mutation-smoke.json  |    2 +-
 tests/tools/migration-retained-inputs.test.mjs     |  324 ++++++
 tests/tools/production-build-artifacts.test.mjs    |   16 +-
 tools/ci/migration-retained-inputs.mjs             |  168 +++
 tools/ci/production-build-artifacts.mjs            |   17 +
 .../Program.cs                                     |    1 +
 ...eck-canonical-article-publication-authority.mjs |    2 +-
 tools/operations/backup-restore-drill.sh           |  709 +++++++++++-
 tools/operations/backup-site.sh                    |  316 +++++-
 tools/operations/restore-site.sh                   |  431 +++++++-
 tools/operations/test-backup-envelope-fixture.sh   |   41 +
 .../test-backup-restore-drill-fixture.sh           |   17 +
 tools/test-matrix/behavior-mutation-owner.mjs      |    4 +-
 tools/test/lanes/production-build-artifacts.sh     |   45 +-
 230 files changed, 33922 insertions(+), 1756 deletions(-)
```


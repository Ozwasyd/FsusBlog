# WIP: codex/issue-2215-provider-source-union-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-provider-source-union-20261003`
- 原始 commit：`4f33a36b0cd8c18994e39ddb31cb7507ecb246bd`
- 原始 tree：`42e02e9f8dac5404179df2d9b4a2c98b2ec265c8`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215, #2217, #1762, #1761
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
4f33a36b0 fix(database): integrate owned article source read closure
Refs #2215, #2217, #1762. Preserve current physical schema closure and ordinary provider cleanup; bind whole MySQL reads to creator cancellation and actual initial database. Source-only, no SDK or native database qualification.

31571a9b1 fix(database): integrate current physical schema source closure
Refs #2215, #2217, #1761. Preserve the original Host and native source lifecycle; integrate frozen current v4/control/sequence and MySQL measured physical inputs. Source-only: provider expected profiles, locked restore, SDK and actual database qualification remain pending.

823153549 feat(migration): compose original article planning in the Host deadline
Refs #2215, #1762. Source-only same-session producer/route integration. Actual provider operations, original input configuration, locked producers and native qualification remain pending; no SDK or database execution.

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
 ...site-backup-source-binding-external-naming.json |   23 +
 config/contracts/behavior-fact-extractors.json     |    2 +-
 .../mutation/behavior-mutation-owners.v1.json      |    9 +-
 .../mutation/changed-critical-domains.v1.json      |    3 +-
 docs/api/contracts.md                              |   12 +
 docs/architecture/repository-layout.md             |   22 +-
 docs/database-migration.md                         |  556 +++++++++-
 docs/operations.md                                 |    6 +
 docs/security/site-backup-envelope.md              |   32 +
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
 .../CurrentSchemaRecipeFactExtractor.cs            |  292 +++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   94 +-
 .../SchemaMigration/SchemaModelInspector.cs        |  663 +-----------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   17 +-
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
 src/migration/ArticlePreservationProducer.cs       |  341 ++++++
 src/migration/ArticlePreservationProjection.cs     |  189 ++++
 .../ArticlePreservationSemanticReceipt.cs          |   37 +
 src/migration/ArticlePreservationSourceReader.cs   |  288 +++++
 src/migration/ArticlePreservationStorageProgram.cs |  201 ++++
 src/migration/ArticlePreservationStorageWriter.cs  |  446 ++++++++
 src/migration/ArticlePreservationWritePlan.cs      |   62 ++
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  184 ++++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++++++
 src/migration/FsusBlog.Migration.csproj            |   12 +
 .../MySqlArticlePreservationSourceReader.cs        |   48 +
 src/migration/MySqlCurrentSchemaCatalogObserver.cs |  249 +++++
 .../MySqlCurrentSchemaPhysicalObserver.cs          |  199 ++++
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
 src/migration/OfflineMigrationHost.cs              |  566 +++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  257 +++++
 .../OfflineMigrationMySqlNativeSession.cs          |  408 +++++++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 ++
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 +++
 src/migration/OfflineMigrationPlanEvidence.cs      |  208 ++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 ++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  208 ++++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 +++
 .../OfflineMigrationSourceFingerprints.cs          |  230 ++++
 .../OfflineMigrationSourceObserver.Providers.cs    |  639 +++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    |  545 ++++++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      |  264 +++++
 .../OfflineMigrationSqliteNativeSession.cs         |  301 ++++++
 src/migration/OfflineMigrationStateStore.cs        |  138 +++
 src/migration/OfflineMigrationVerifyEvidence.cs    |   98 ++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 ++
 src/migration/PgArticlePreservationOperation.cs    |  653 ++++++++++++
 src/migration/PgCurrentSchemaBootstrapOperation.cs |  272 +++++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   57 +
 src/migration/PgLegacyCurrentSchemaPreparation.cs  |  127 +++
 src/migration/PgLegacyNonArticlePreparation.cs     |  582 ++++++++++
 src/migration/PgLegacyNonArticleRecovery.cs        |  274 +++++
 .../SqliteArticlePreservationSourceReader.cs       |  132 +++
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  795 ++++++++++++++
 .../Schema/PgCurrentSchemaControlShape.cs          |   79 ++
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  266 +++++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  155 +++
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
 .../Schema/CurrentSchemaCanonicalAuthority.cs      |  425 ++++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |   20 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  |  228 ++++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |   62 ++
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |  156 +++
 .../Contracts/Schema/SchemaExpressionModel.cs      |   31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs |  236 ++++
 .../Schema/SchemaPhysicalTypeProjection.cs         |  111 ++
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++++
 .../ArticleStatusTransitionIntegrationTests.cs     |    1 +
 ...rticleVaultExecutionPostgresIntegrationTests.cs |    1 +
 ...lArticleLifecycleFixturePortIntegrationTests.cs |    1 +
 ...rticlePublicationFixturePortIntegrationTests.cs |    1 +
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
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  395 +++++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  584 ++++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  366 +++++++
 .../Unit/IntegrityProofVerificationTests.cs        |    1 +
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 ++
 tests/backend/Unit/PodBinaryCodecTests.cs          |    1 +
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |  215 +++-
 tests/migration/ArticleMediaPreservationTests.cs   |  418 ++++++++
 .../migration/ArticlePreservationProducerTests.cs  |  196 ++++
 .../ArticlePreservationProjectionTests.cs          |  550 ++++++++++
 .../ArticlePreservationSourceReaderTests.cs        |  133 +++
 tests/migration/ArticlePreservationStorageTests.cs |   72 ++
 .../ArticlePreservationStorageWriterTests.cs       |  295 +++++
 tests/migration/CurrentArticleContractTests.cs     |  187 ++++
 .../CurrentSchemaBootstrapCompilerTests.cs         |  221 ++++
 .../CurrentSchemaStorageProjectionTests.cs         |   46 +
 .../MySqlArticlePreservationSourceReaderTests.cs   |  181 ++++
 .../MySqlCurrentSchemaCatalogObserverTests.cs      |  165 +++
 .../MySqlCurrentSchemaPhysicalObserverTests.cs     |  218 ++++
 .../migration/OfflineMigrationApplyCommandTests.cs |  713 +++++++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1126 ++++++++++++++++++++
 .../OfflineMigrationArticlePlanningTests.cs        |  109 ++
 ...fflineMigrationArticlePreservationRouteTests.cs |  285 +++++
 .../OfflineMigrationBackupAdmissionTests.cs        |  488 +++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   74 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  316 ++++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  500 +++++++++
 ...flineMigrationCurrentSchemaMediaBindingTests.cs |  153 +++
 .../OfflineMigrationFingerprintCommandTests.cs     |   83 ++
 ...lineMigrationHostRetentionConfigurationTests.cs |   66 ++
 .../OfflineMigrationMySqlNativeSessionTests.cs     |  363 +++++++
 ...neMigrationOwnedPlanningAuthorityReaderTests.cs |  157 +++
 tests/migration/OfflineMigrationPlanTests.cs       |  554 ++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs |  278 +++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |   59 +
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs |  327 ++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs |  327 ++++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  554 ++++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs |  189 ++++
 .../OfflineMigrationSourceObserverTests.cs         |  560 ++++++++++
 .../OfflineMigrationSqliteDatabaseIdentityTests.cs |  214 ++++
 .../OfflineMigrationSqliteNativeSessionTests.cs    |  310 ++++++
 .../OfflineMigrationVerifyCommandTests.cs          |  297 ++++++
 tests/migration/OwnedRetainedMigrationToolTests.cs |   60 ++
 .../PgArticlePreservationOperationTests.cs         |  229 ++++
 .../PgArticlePreservationRecoveryBindingTests.cs   |   52 +
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |  243 +++++
 .../PgLegacyCurrentSchemaPreparationTests.cs       |   89 ++
 .../PgLegacyNonArticlePreparationTests.cs          |  176 +++
 tests/migration/PgLegacyNonArticleRecoveryTests.cs |  132 +++
 .../SqliteArticlePreservationSourceReaderTests.cs  |   48 +
 tests/tools/backup-envelope-contract.test.mjs      |  355 ++++++
 .../tools/behavior-mutation-qualification.test.mjs |   83 +-
 .../canonical-hash-source-governance.test.mjs      |    8 +-
 tests/tools/changed-critical-mutation.test.mjs     |   22 +-
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
 237 files changed, 37418 insertions(+), 1686 deletions(-)
```


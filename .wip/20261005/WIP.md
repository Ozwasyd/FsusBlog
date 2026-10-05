# WIP: codex/issue-3662-native-complete-source-union-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3662-native-complete-source-union-20261003`
- 原始 commit：`6d10d5e90fedef45edc7f555321cacbf3f40f64e`
- 原始 tree：`dc2e2f0d0fc3c2ccf91e329a1dc2de577c0d14ed`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3662, #2216, #2217, #1761
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
6d10d5e90 fix(build): combine native task packaging with current migration source
Transfer the original finite task packaging and classification catalogue owners without replacing current provider observations, native scopes, portable compiler or Server release APIs. Preserve current ownership documentation and bind the generated product to its original source inputs. Correct the two inherited Store callers to the existing owned read-scope API.

Source-only delivery; current SDK, locked restore, tests, image measurement, native capability factories and whole issue acceptance remain pending.

Refs: #3662

8d12da1fa fix(database): combine original provider scope and cleanup sources
Combine the reviewed writer scope with the complete original provider observer and portable current facts without replacing either authority. Restore the original read-only journal seam and controls, preserve both material identity cleanup implementations, and materialize the four original retained source resources only.

Refs: #2216 #2217 #1761

a42080f02 fix(database): combine original portable and owned-domain source
Combine exact original observer and native dependencies with the portable typed compiler without replacing its current key-case or partial bootstrap boundaries. Preserve original source authorities and keep locked dependency generation and native qualification pending.

Refs: #1761

daa9019b8 test(database): bind portable recipe fixtures to physical column types
Retain the original PostgreSQL typed recipe facts before exercising the portable relational fold. Preserve every existing assertion and require original owner admission on both positive fixture groups.

Refs: #1761

98fde9f48 feat(migration): render closed portable relational effects
Refs: #1761

c55d22db5 feat(migration): integrate original portable compiler source
Refs: #1761

fe370f424 fix(migration): compare native MySQL key names correctly
Refs: #1761

e5b5c0fc2 fix(migration): preserve native MySQL key facts
Refs: #1761
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    3 +
 ...ortable-owned-source-union-external-naming.json |   69 +
 ...16-source-material-cleanup-external-naming.json |   15 +
 ...-2218-historical-fence-end-external-naming.json |   13 +
 ...tive-complete-source-union-external-naming.json |   40 +
 ...ve-complete-source-union-generated-binding.json |   73 +
 config/build/backend-docker-inputs.json            |   33 +-
 docs/architecture/repository-layout.md             |   43 +-
 docs/database-migration.md                         |  431 ++++-
 docs/online-database-migration.md                  |   19 +
 ops/docker/FsusBlog.Server.Dockerfile              |   25 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs |  661 +------
 .../CurrentSchemaOwnedProjectionExporter.cs        |   97 ++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |   47 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  192 +++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../CurrentSchemaRecipeFactExtractor.cs            |  292 ++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   94 +-
 .../SchemaMigration/SchemaModelInspector.cs        |  663 +------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   17 +-
 src/backend/Program.cs                             |   35 +
 src/migration/ArticleMediaPreservation.cs          |  409 +++++
 .../ArticleMediaPreservationFileSystem.cs          |  409 +++++
 src/migration/ArticlePreservationPolicyExporter.cs |  161 ++
 src/migration/ArticlePreservationProducer.cs       |  341 ++++
 src/migration/ArticlePreservationProjection.cs     |  189 ++
 .../ArticlePreservationSemanticReceipt.cs          |   37 +
 src/migration/ArticlePreservationSourceReader.cs   |  288 ++++
 src/migration/ArticlePreservationStorageProgram.cs |  201 +++
 src/migration/ArticlePreservationStorageWriter.cs  |  446 +++++
 src/migration/ArticlePreservationWritePlan.cs      |   62 +
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  184 ++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++
 .../CurrentSchemaPortableBootstrapCompiler.cs      |  235 +++
 src/migration/FsusBlog.Migration.csproj            |   12 +
 src/migration/MySqlCurrentSchemaCatalogObserver.cs |  249 +++
 .../MySqlCurrentSchemaPhysicalObserver.cs          |  199 +++
 src/migration/OfflineMigrationApplyContracts.cs    |  134 ++
 src/migration/OfflineMigrationApplyEvidence.cs     |  386 +++++
 .../OfflineMigrationApplyJournalDialect.cs         |  272 +++
 .../OfflineMigrationApplyJournalVerifier.cs        |  365 ++++
 .../OfflineMigrationApplyNativeSession.cs          |  619 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |   94 +
 .../OfflineMigrationArticleMediaJournal.cs         |   80 +
 .../OfflineMigrationArticlePreservationRoute.cs    |  222 +++
 src/migration/OfflineMigrationArtifactPublisher.cs |   51 +
 src/migration/OfflineMigrationBackupAdmission.cs   |  485 ++++++
 .../OfflineMigrationCatalogEntries.generated.cs    |    6 +-
 .../OfflineMigrationClassificationFacts.cs         | 1811 ++++++++++++++++++++
 src/migration/OfflineMigrationCommandLine.cs       |  383 +++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs |  340 ++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         |  539 ++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |   65 +
 src/migration/OfflineMigrationExecutor.cs          |  507 ++++++
 src/migration/OfflineMigrationHost.cs              |  566 +++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  257 +++
 .../OfflineMigrationMySqlNativeSession.cs          |  408 +++++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 +
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 ++
 src/migration/OfflineMigrationPlanEvidence.cs      |  208 +++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 +++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  208 +++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 ++
 .../OfflineMigrationSourceFingerprints.cs          |  230 +++
 .../OfflineMigrationSourceObserver.Providers.cs    |  872 ++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    |  598 +++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      |  264 +++
 .../OfflineMigrationSqliteNativeSession.cs         |  301 ++++
 src/migration/OfflineMigrationStateStore.cs        |  240 +++
 src/migration/OfflineMigrationVerifyEvidence.cs    |   98 ++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 +
 src/migration/PgArticlePreservationOperation.cs    |  653 +++++++
 src/migration/PgCurrentSchemaBootstrapOperation.cs |  272 +++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   57 +
 src/migration/PgLegacyCurrentSchemaPreparation.cs  |  127 ++
 src/migration/PgLegacyNonArticlePreparation.cs     |  582 +++++++
 src/migration/PgLegacyNonArticleRecovery.cs        |  274 +++
 .../SqliteArticlePreservationSourceReader.cs       |  132 ++
 .../SqliteCurrentSchemaCatalogObserver.cs          |  300 ++++
 .../SqliteCurrentSchemaOwnedTargetObserver.cs      |   73 +
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  795 +++++++++
 .../Schema/PgCurrentSchemaControlShape.cs          |   79 +
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  266 +++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  155 ++
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |   27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      |  649 +++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |   20 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  |  228 +++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |   62 +
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |  193 +++
 .../Contracts/Schema/SchemaExpressionModel.cs      |   31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs |  236 +++
 .../Schema/SchemaPhysicalTypeProjection.cs         |  111 ++
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++
 ...igrationOwnedWriterReadScopeIntegrationTests.cs |  227 +++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 .../Unit/ActiveReleaseFenceDurableWitnessTests.cs  |    5 +-
 .../backend/Unit/ActiveReleaseFencedCommitTests.cs |    7 +-
 .../ArticleDraftServerRevisionMigrationTests.cs    |    7 +-
 .../ArticleMutationIdempotencyMigrationTests.cs    |    7 +-
 .../Unit/ArticleMutationOutboxClaimLeaseTests.cs   |    7 +-
 .../Unit/ArticlePublicationMigrationTests.cs       |   11 +-
 .../Unit/ArticleRevisionRollbackMigrationTests.cs  |    8 +-
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  395 +++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  584 +++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  366 ++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 +
 .../Unit/SchemaCompatibilityCoordinateTests.cs     |   66 +-
 tests/backend/Unit/SchemaMigrationRegistryTests.cs |   19 +-
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |   41 +-
 .../CurrentSchemaBootstrapCompilerTests.cs         |  221 +++
 .../CurrentSchemaPortableBootstrapCompilerTests.cs |  294 ++++
 .../CurrentSchemaStorageProjectionTests.cs         |  400 +++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1473 ++++++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   43 +
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  161 ++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  716 ++++++++
 .../OfflineMigrationOwnedWriterReadScopeTests.cs   |   97 ++
 tests/migration/OfflineMigrationPlanTests.cs       |  384 +++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  351 ++++
 .../OfflineMigrationSourceMaterialCleanupTests.cs  |  212 +++
 .../PgCurrentSchemaBootstrapOperationTests.cs      |   64 +
 .../PgCurrentSchemaCatalogObserverTests.cs         |   44 +
 .../PgCurrentSchemaEffectObserverTests.cs          |   77 +
 .../PgCurrentSchemaExpressionParserTests.cs        |  162 ++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |  243 +++
 .../SqliteCurrentSchemaOwnedTargetObserverTests.cs |  271 +++
 tests/tools/backend-docker-input-closure.test.mjs  |  187 +-
 tests/tools/current-schema-authority.test.mjs      |   51 +-
 tests/tools/final-image-toolchain-pin.test.mjs     |   18 +
 .../offline-migration-catalog-parity.test.mjs      |    2 +-
 tests/tools/production-build-artifacts.test.mjs    |   62 +-
 tools/build-final-image.sh                         |   45 +-
 tools/ci/migration-retained-inputs.mjs             |  168 ++
 tools/ci/production-build-artifacts.mjs            |   64 +
 tools/db/check-current-schema-authority.mjs        |   51 +-
 .../db/check-offline-migration-catalog-parity.mjs  |    4 +-
 tools/db/generate-offline-migration-catalog.mjs    |   19 +-
 tools/docker/backend-input-closure.mjs             |  168 +-
 tools/docker/backend-input-environment.mjs         |    7 +-
 152 files changed, 32876 insertions(+), 1440 deletions(-)
```


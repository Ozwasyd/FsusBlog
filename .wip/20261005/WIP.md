# WIP: codex/issue-2216-writer-cap-union-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2216-writer-cap-union-20261003`
- 原始 commit：`ff1d79667f3ad7ee780160cab8954307ca95b785`
- 原始 tree：`d9985a278087d0ebb4cdf3880fae5a9fd8569a04`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2216, #2217, #3662, #2215
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
ff1d79667 fix(database): combine original writer scope source dependencies
Restore the reviewed native apply baseline and owned read scope on the current issuer source union. Reuse the original measured MySQL identity material and preserve public source admission, native journal guards, and pending SQLite continuity.

Refs: #2216

e41f8107a feat(database): bind original native schema control dependencies
Refs: #2217

b306c2e95 feat(database): compose original owned provider verification sources
Import exact MySQL and SQLite native read owners and their direct fixtures, original catalog and held-file dependencies, and the sole StateStore owned MySQL read overload. Preserve raw writer RR admission, original Host and all prior verification cases. Add only original package references; Shared physical/control model integration and native acceptance remain pending.

Refs: #2217

34d1d25d7 fix(database): bind current migration document naming
Use the existing css-like-contract exception for the exact current document only. Preserve the four source bindings and original registry.

Refs: #2217

c305dac6f feat(database): consume existing current receipts through owned verification
Extend the original verify stage with explicit original receipt path and whole SHA, mutually exclusive with publication. Re-enter the original full independent issuer through actual provider read contexts, await creator cleanup and recheck original artifact bytes before returning the original v1 receipt. No new receipt, runtime admission or publisher is introduced.

Refs: #3662

1463bd191 fix(database): bind original verification naming surfaces
Use the registered environment-variable exception and enumerate the four changed original source surfaces. No registry, algorithm or verification result is changed.

Refs: #2217

30bc16486 fix(database): dispatch verification through owned provider reads
Keep original receipt and full journal, checkpoint, schema and DAG validation. Require original creator-linked read contexts for non-PostgreSQL providers; plain connections and missing owners remain refusals. Native helper integration, compilation and actual three-provider acceptance remain pending.

Refs: #2217

840e02ec7 feat(migration): compose original retained planning owners
Change-Class: behavior

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    3 +
 ...2217-cross-provider-verify-external-naming.json |   42 +
 ...site-backup-source-binding-external-naming.json |   23 +
 docs/database-migration.md                         |  464 +++++-
 docs/operations.md                                 |    6 +
 docs/security/site-backup-envelope.md              |   32 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs |  661 +--------
 .../CurrentSchemaOwnedProjectionExporter.cs        |   97 ++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |   47 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  192 +++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../CurrentSchemaRecipeFactExtractor.cs            |  291 ++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   94 +-
 .../SchemaMigration/SchemaModelInspector.cs        |  663 +--------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |    7 +-
 src/backend/Program.cs                             |   35 +
 src/migration/ArticleMediaPreservation.cs          |  409 ++++++
 .../ArticleMediaPreservationFileSystem.cs          |  409 ++++++
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  182 +++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++++
 src/migration/FsusBlog.Migration.csproj            |   12 +
 src/migration/MySqlCurrentSchemaCatalogObserver.cs |  249 ++++
 .../MySqlCurrentSchemaPhysicalObserver.cs          |  199 +++
 src/migration/OfflineMigrationApplyContracts.cs    |  134 ++
 src/migration/OfflineMigrationApplyEvidence.cs     |  337 +++++
 .../OfflineMigrationApplyJournalDialect.cs         |  272 ++++
 .../OfflineMigrationApplyJournalVerifier.cs        |  365 +++++
 .../OfflineMigrationApplyNativeSession.cs          |  619 ++++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |   94 ++
 .../OfflineMigrationArticleMediaJournal.cs         |   80 ++
 src/migration/OfflineMigrationArtifactPublisher.cs |   51 +
 src/migration/OfflineMigrationBackupAdmission.cs   |  485 +++++++
 src/migration/OfflineMigrationCommandLine.cs       |  405 ++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs |  340 +++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         |  684 +++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |   67 +
 src/migration/OfflineMigrationExecutor.cs          |  507 +++++++
 src/migration/OfflineMigrationHost.cs              |  596 +++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  157 +++
 .../OfflineMigrationMySqlNativeSession.cs          |  401 ++++++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 ++
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 ++
 src/migration/OfflineMigrationPlanEvidence.cs      |  188 +++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 ++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  204 +++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 +++
 .../OfflineMigrationSourceFingerprints.cs          |  197 +++
 .../OfflineMigrationSourceObserver.Providers.cs    |   82 ++
 src/migration/OfflineMigrationSourceObserver.cs    |  458 ++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      |  264 ++++
 .../OfflineMigrationSqliteNativeSession.cs         |  432 ++++++
 src/migration/OfflineMigrationStateStore.cs        |  240 ++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  166 +++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 ++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   58 +
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  795 +++++++++++
 .../Schema/PgCurrentSchemaControlShape.cs          |   79 ++
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  266 ++++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  155 ++
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |   27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      |  632 +++++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |   20 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  |  228 +++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |   62 +
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |  193 +++
 .../Contracts/Schema/SchemaExpressionModel.cs      |   31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs |  236 ++++
 .../Schema/SchemaPhysicalTypeProjection.cs         |  111 ++
 .../CurrentSchemaReceiptContracts.cs               |  316 +++++
 ...igrationOwnedWriterReadScopeIntegrationTests.cs |  227 +++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  225 +++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  556 ++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  293 ++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 ++
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |   41 +-
 tests/migration/ArticleMediaPreservationTests.cs   |  418 ++++++
 .../CurrentSchemaBootstrapCompilerTests.cs         |  190 +++
 .../CurrentSchemaStorageProjectionTests.cs         |   46 +
 .../MySqlCurrentSchemaCatalogObserverTests.cs      |  165 +++
 .../MySqlCurrentSchemaPhysicalObserverTests.cs     |  218 +++
 .../migration/OfflineMigrationApplyCommandTests.cs |  525 +++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1473 ++++++++++++++++++++
 .../OfflineMigrationBackupAdmissionTests.cs        |  488 +++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   92 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  316 +++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  580 ++++++++
 ...flineMigrationCurrentSchemaMediaBindingTests.cs |  153 ++
 .../OfflineMigrationFingerprintCommandTests.cs     |   83 ++
 ...lineMigrationHostRetentionConfigurationTests.cs |   66 +
 .../OfflineMigrationMySqlNativeSessionTests.cs     |  373 +++++
 ...neMigrationOwnedPlanningAuthorityReaderTests.cs |  157 +++
 .../OfflineMigrationOwnedWriterReadScopeTests.cs   |   97 ++
 tests/migration/OfflineMigrationPlanTests.cs       |  477 +++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs |  278 ++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |   59 +
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs |  302 ++++
 ...fflineMigrationShellBackupDrillProducerTests.cs |  327 +++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  463 ++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs |  189 +++
 .../OfflineMigrationSourceObserverTests.cs         |  229 +++
 .../OfflineMigrationSqliteDatabaseIdentityTests.cs |  214 +++
 .../OfflineMigrationSqliteNativeSessionTests.cs    |  426 ++++++
 .../OfflineMigrationStateStoreOwnedReadTests.cs    |  101 ++
 .../OfflineMigrationVerifyCommandTests.cs          |  495 +++++++
 tests/migration/OwnedRetainedMigrationToolTests.cs |   60 +
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |   76 +
 tests/tools/backup-envelope-contract.test.mjs      |  355 +++++
 tests/tools/migration-retained-inputs.test.mjs     |  324 +++++
 tests/tools/production-build-artifacts.test.mjs    |   16 +-
 tools/ci/migration-retained-inputs.mjs             |  168 +++
 tools/ci/production-build-artifacts.mjs            |   17 +
 tools/operations/backup-restore-drill.sh           |  709 +++++++++-
 tools/operations/backup-site.sh                    |  316 ++++-
 tools/operations/restore-site.sh                   |  431 +++++-
 tools/operations/test-backup-envelope-fixture.sh   |   41 +
 .../test-backup-restore-drill-fixture.sh           |   17 +
 tools/test/lanes/production-build-artifacts.sh     |   45 +-
 130 files changed, 30644 insertions(+), 1400 deletions(-)
```


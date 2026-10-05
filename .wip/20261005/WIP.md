# WIP: codex/issue-2217-original-naming-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2217-original-naming-20261003`
- 原始 commit：`1463bd191ea878bd18b0551cfc326c27eb89f5fc`
- 原始 tree：`3f94ca308d2110389381e53be9787cd3d5489d83`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2217, #2215, #1762
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1463bd191 fix(database): bind original verification naming surfaces
Use the registered environment-variable exception and enumerate the four changed original source surfaces. No registry, algorithm or verification result is changed.

Refs: #2217

30bc16486 fix(database): dispatch verification through owned provider reads
Keep original receipt and full journal, checkpoint, schema and DAG validation. Require original creator-linked read contexts for non-PostgreSQL providers; plain connections and missing owners remain refusals. Native helper integration, compilation and actual three-provider acceptance remain pending.

Refs: #2217

840e02ec7 feat(migration): compose original retained planning owners
Change-Class: behavior

Refs: #2215

77441c1a3 feat(migration): compose the original retained build inputs
Change-Class: behavior

Refs: #2215

Normal source integration of the original production owner only; compiled capability and current provider execution remain unqualified.

0ff2c25ea fix(migration): share the native PostgreSQL database identity
Refs #2215

fd7740a6b feat(database): bind host preflight to original media owners
Integrate exact original Core media journal and required media owner source, bind all compiled provider operations before reading First, and preserve original transactional/CAS controls. Declare same-source AngleSharp 1.5.0 and Markdig dependencies without patching locks or claiming runtime qualification. Actual article/legacy and complete provider factories remain pending.

Change-Class: behavior

Refs: #2215

Refs: #1762

b640b379f feat(database): compose original retained host authority
Use one original retained evidence authority for planning and locked apply/verify after the original resolver verifies actual tool/input bytes. Missing ports and cancellation refuse before observations; complete toolchain and provider qualification remain pending.

Change-Class: behavior

Refs: #2215

ad4b1ce73 fix(database): retain structured source fingerprint failures
Preserve exact redacted observation differences through the original closed matcher and Host commands, after the native owner awaits cleanup. Keep cleanup uncertainty higher priority, actual matching and original refusal rows intact. Import the original same-process retained authority without claiming tool or database qualification.

Change-Class: behavior

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    2 +
 ...2217-cross-provider-verify-external-naming.json |   15 +
 ...site-backup-source-binding-external-naming.json |   23 +
 docs/database-migration.md                         |  445 +++++++-
 docs/operations.md                                 |    6 +
 docs/security/site-backup-envelope.md              |   32 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
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
 src/backend/Program.cs                             |   35 +
 src/migration/ArticleMediaPreservation.cs          |  409 +++++++
 .../ArticleMediaPreservationFileSystem.cs          |  409 +++++++
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  182 ++++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++++++
 src/migration/FsusBlog.Migration.csproj            |   10 +
 src/migration/OfflineMigrationApplyContracts.cs    |  134 +++
 src/migration/OfflineMigrationApplyEvidence.cs     |  337 ++++++
 .../OfflineMigrationApplyJournalVerifier.cs        |  365 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |   66 ++
 .../OfflineMigrationArticleMediaJournal.cs         |   80 ++
 src/migration/OfflineMigrationArtifactPublisher.cs |   51 +
 src/migration/OfflineMigrationBackupAdmission.cs   |  485 +++++++++
 src/migration/OfflineMigrationCommandLine.cs       |  386 +++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs |  251 +++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         |  632 +++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |   67 ++
 src/migration/OfflineMigrationExecutor.cs          |  508 +++++++++
 src/migration/OfflineMigrationHost.cs              |  525 ++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  155 +++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 ++
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 +++
 src/migration/OfflineMigrationPlanEvidence.cs      |  188 ++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 ++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  204 ++++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 +++
 .../OfflineMigrationSourceFingerprints.cs          |  197 ++++
 src/migration/OfflineMigrationSourceObserver.cs    |  458 ++++++++
 src/migration/OfflineMigrationStateStore.cs        |  188 ++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  121 +++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 ++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   58 +
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  717 +++++++++++++
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  238 +++++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  147 +++
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
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
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  225 ++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  556 ++++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  293 +++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 ++
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |   41 +-
 tests/migration/ArticleMediaPreservationTests.cs   |  418 ++++++++
 .../CurrentSchemaBootstrapCompilerTests.cs         |  190 ++++
 .../CurrentSchemaStorageProjectionTests.cs         |   46 +
 .../migration/OfflineMigrationApplyCommandTests.cs |  525 +++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1126 ++++++++++++++++++++
 .../OfflineMigrationBackupAdmissionTests.cs        |  488 +++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   92 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  161 +++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  580 ++++++++++
 ...flineMigrationCurrentSchemaMediaBindingTests.cs |  153 +++
 .../OfflineMigrationFingerprintCommandTests.cs     |   83 ++
 ...lineMigrationHostRetentionConfigurationTests.cs |   66 ++
 ...neMigrationOwnedPlanningAuthorityReaderTests.cs |  157 +++
 tests/migration/OfflineMigrationPlanTests.cs       |  477 +++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs |  278 +++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |   59 +
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs |  302 ++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs |  327 ++++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  463 ++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs |  189 ++++
 .../OfflineMigrationSourceObserverTests.cs         |  229 ++++
 .../OfflineMigrationVerifyCommandTests.cs          |  341 ++++++
 tests/migration/OwnedRetainedMigrationToolTests.cs |   60 ++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |   76 ++
 tests/tools/backup-envelope-contract.test.mjs      |  355 ++++++
 tests/tools/migration-retained-inputs.test.mjs     |  324 ++++++
 tests/tools/production-build-artifacts.test.mjs    |   16 +-
 tools/ci/migration-retained-inputs.mjs             |  168 +++
 tools/ci/production-build-artifacts.mjs            |   17 +
 tools/operations/backup-restore-drill.sh           |  709 +++++++++++-
 tools/operations/backup-site.sh                    |  316 +++++-
 tools/operations/restore-site.sh                   |  431 +++++++-
 tools/operations/test-backup-envelope-fixture.sh   |   41 +
 .../test-backup-restore-drill-fixture.sh           |   17 +
 tools/test/lanes/production-build-artifacts.sh     |   45 +-
 113 files changed, 24505 insertions(+), 1400 deletions(-)
```


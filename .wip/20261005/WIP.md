# WIP: codex/issue-1761-legacy-target-prepare-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1761-legacy-target-prepare-20261003`
- 原始 commit：`61004e13d14cfed563b0d58e4830d92e7fc2ef75`
- 原始 tree：`5d93c3a5b0b688d1c03d9e19fb250192c4732386`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1761, #2217
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
61004e13d feat(database): stage known legacy schema on the original transaction
Preserve the source owner content codec and strict public profile. Validate the original control owner before phase projection, retain the actual historical domain, and create the complete owned current target without claiming complete legacy conversion or commit authority.

Refs: #1761

22d4ad0c2 fix(database): bind retained current inputs to terminal file identities
Consume the original file owner capture and terminal validation for producer metadata, artifact bytes and retained assembly hashes.

Refs: #1761

572167bcf feat(database): integrate original retained file terminal guard
Refs: #1761

cd37659e0 fix(database): preserve native numeric expression types
Retain PostgreSQL numeric casts and operand types; normalize only proven column-literal storage contexts.

Refs: #1761

aef67475f fix(migration): retain original empty bootstrap entrypoint (Refs #1761)

dff786a7a fix(migration): verify original file identities after reads
Bind the retained descriptor and anchored path to opaque pre-read native metadata. Reuse the sole no-follow walk for terminal verification and preserve original artifact byte limits.

Refs: #2217

a2dd87f27 fix(migration): observe owned current effects and bind PG bootstrap (Refs #1761)

25d0101a8 refactor(database): share original native identity reader internally
Allow the Migration-owned admission path to reuse the same connection and transaction identity reader without copying its query or rebuilding observed identity from a plan.

Refs: #2217
```

## 相对原 merge base 的源码差异概况

```text
docs/architecture/repository-layout.md             |   2 +-
 docs/database-migration.md                         | 314 ++++++++-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |   2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |   1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs | 661 +-----------------
 .../CurrentSchemaOwnedProjectionExporter.cs        |  97 +++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |  47 ++
 .../SchemaMigration/CurrentSchemaReadObserver.cs   | 141 ++++
 .../CurrentSchemaReceiptAdmission.cs               | 102 +++
 .../CurrentSchemaRecipeFactExtractor.cs            | 291 ++++++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |  94 +--
 .../SchemaMigration/SchemaModelInspector.cs        |   3 +-
 ...ntSchemaTestMaterializationCandidateVerifier.cs |   5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   5 +-
 src/backend/Program.cs                             |  35 +
 src/migration/CurrentSchemaBootstrapCompiler.cs    | 308 +++++++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        | 182 +++++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  | 441 ++++++++++++
 src/migration/OfflineMigrationApplyContracts.cs    | 119 ++++
 .../OfflineMigrationApplyJournalVerifier.cs        | 261 ++++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |  46 ++
 src/migration/OfflineMigrationCommandLine.cs       | 148 ++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs | 251 +++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         | 478 +++++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |  65 ++
 src/migration/OfflineMigrationExecutor.cs          | 427 ++++++++++++
 src/migration/OfflineMigrationHost.cs              | 252 ++++++-
 src/migration/OfflineMigrationPlan.cs              | 568 ++++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 +++++
 src/migration/OfflineMigrationPlanEvidence.cs      |  58 ++
 .../OfflineMigrationSourceFingerprints.cs          | 232 +++++++
 .../OfflineMigrationSourceObserver.Providers.cs    | 614 +++++++++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 543 +++++++++++++++
 src/migration/OfflineMigrationStateStore.cs        | 175 +++++
 src/migration/PgCurrentSchemaBootstrapOperation.cs | 271 ++++++++
 src/migration/PgCurrentSchemaCatalogObserver.cs    | 708 ++++++++++++++++++++
 src/migration/PgCurrentSchemaEffectObserver.cs     | 228 +++++++
 src/migration/PgCurrentSchemaExpressionParser.cs   | 540 +++++++++++++++
 .../PgCurrentSchemaOwnedTargetObserver.cs          | 178 +++++
 src/migration/PgLegacyCurrentSchemaPreparation.cs  | 125 ++++
 src/shared/Algorithms/ExactDecimalLiteral.cs       |  31 +
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |  27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      | 354 ++++++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |  15 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  | 167 +++++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |  51 ++
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |  37 +
 .../Contracts/Schema/SchemaExpressionModel.cs      |  31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs | 185 +++++
 .../Schema/SchemaPhysicalTypeProjection.cs         | 111 +++
 .../CurrentSchemaReceiptContracts.cs               | 316 +++++++++
 .../Integration/SchemaMigrationIntegrationTests.cs |   1 +
 .../CurrentSchemaOwnedProjectionExporterTests.cs   | 206 ++++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    | 395 +++++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  | 232 +++++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |  83 +++
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |   1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |   1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |  41 +-
 .../CurrentSchemaBootstrapCompilerTests.cs         | 190 ++++++
 .../CurrentSchemaStorageProjectionTests.cs         |  46 ++
 .../migration/OfflineMigrationApplyJournalTests.cs | 741 +++++++++++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |  43 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 161 +++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 ++++++++++++++
 tests/migration/OfflineMigrationPlanTests.cs       | 356 ++++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 351 ++++++++++
 .../OfflineMigrationSourceObserverTests.cs         | 452 +++++++++++++
 .../PgCurrentSchemaBootstrapOperationTests.cs      |  63 ++
 .../PgCurrentSchemaCatalogObserverTests.cs         |  43 ++
 .../PgCurrentSchemaEffectObserverTests.cs          |  76 +++
 .../PgCurrentSchemaExpressionParserTests.cs        | 161 +++++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |  75 +++
 .../PgLegacyCurrentSchemaPreparationTests.cs       |  89 +++
 tests/tools/current-schema-authority.test.mjs      |  51 +-
 tools/db/check-current-schema-authority.mjs        |  51 +-
 77 files changed, 14198 insertions(+), 737 deletions(-)
```


# WIP: codex/issue-2215-retained-readbridge-20261003-pVIfqW

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-retained-readbridge-20261003-pVIfqW`
- 原始 commit：`7a984545120c0baa6b3b14e7bc7b757f348be666`
- 原始 tree：`5b300299e003d9fea94abb78e0490a9f3cf0360a`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215, #1761
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
7a9845451 feat(migration): bind original target invocation to retained tool inputs
Change-Class: behavior

Refs: #2215

Derive Server, Shared and runtime input references from the same original read-only production receipt; compare actual native bytes and original source metadata before using the one original exporter. The opaque Tool4 capability exposes a cancellation-only invocation, never caller assembly paths or expected hashes. SDK, loaded-image incarnation, physical input immutability and complete DAG remain pending.

8d843884e fix(migration): execute the compiled retained reader closure
Change-Class: behavior

Refs: #2215

Execute only the four actual DLL embedded original sources through the fixed Node module linker; no checkout JavaScript is reopened for execution. Preserve original import metadata and reject unknown/dynamic/disconnected dependencies. Keep original process owner and terminal deadline, await cancelled pipe-copy tasks before disposing their destinations, and record actual pipe terminal facts without claiming physical task-tree qualification. SDK/native remain pending.

5e6130683 fix(migration): bind retained reader bytes to the executing tool
Change-Class: behavior

Refs: #2215

Reject stable caller-modified reader source before the sole original process executes it; derive the source-byte identity from original embedded compiler inputs, not caller hashes. Remove ambient Node preload selection. SOURCE tests only; actual SDK and native qualification remain pending.

c39462a9c feat(migration): read original retained tool through the existing process owner
Bind a private retained-tool capability to the fixed original reader, actual sealed source SDK configuration and the executing Migration DLL metadata and bytes. Preserve the original caller token and process terminal owner. SDK and native qualification are not claimed.

Change-Class: behavior

Refs: #2215

c99dc7316 feat(migration): import original retained production input owner
Import exactly the four source blobs reviewed at a39bee531. No SDK, output or database qualification is inherited.

Change-Class: behavior

Refs: #2215

22d4ad0c2 fix(database): bind retained current inputs to terminal file identities
Consume the original file owner capture and terminal validation for producer metadata, artifact bytes and retained assembly hashes.

Refs: #1761

572167bcf feat(database): integrate original retained file terminal guard
Refs: #1761

cd37659e0 fix(database): preserve native numeric expression types
Retain PostgreSQL numeric casts and operand types; normalize only proven column-literal storage contexts.

Refs: #1761
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
 src/migration/CurrentSchemaOwnedTargetProducer.cs  | 704 ++++++++++++++++++++
 src/migration/FsusBlog.Migration.csproj            |   8 +
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
 src/migration/OfflineMigrationStateStore.cs        | 175 +++++
 src/migration/OwnedRetainedMigrationTool.cs        |  87 +++
 src/migration/PgCurrentSchemaBootstrapOperation.cs | 271 ++++++++
 src/migration/PgCurrentSchemaCatalogObserver.cs    | 708 ++++++++++++++++++++
 src/migration/PgCurrentSchemaEffectObserver.cs     | 228 +++++++
 src/migration/PgCurrentSchemaExpressionParser.cs   | 540 +++++++++++++++
 .../PgCurrentSchemaOwnedTargetObserver.cs          | 178 +++++
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
 tests/migration/OwnedRetainedMigrationToolTests.cs |  60 ++
 .../PgCurrentSchemaBootstrapOperationTests.cs      |  63 ++
 .../PgCurrentSchemaCatalogObserverTests.cs         |  43 ++
 .../PgCurrentSchemaEffectObserverTests.cs          |  76 +++
 .../PgCurrentSchemaExpressionParserTests.cs        | 161 +++++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |  75 +++
 tests/tools/current-schema-authority.test.mjs      |  51 +-
 tests/tools/migration-retained-inputs.test.mjs     | 324 +++++++++
 tests/tools/production-build-artifacts.test.mjs    |  16 +-
 tools/ci/migration-retained-inputs.mjs             | 168 +++++
 tools/ci/production-build-artifacts.mjs            |  17 +
 tools/db/check-current-schema-authority.mjs        |  51 +-
 tools/test/lanes/production-build-artifacts.sh     |  45 +-
 79 files changed, 13124 insertions(+), 744 deletions(-)
```


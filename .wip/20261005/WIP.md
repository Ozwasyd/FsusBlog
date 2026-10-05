# WIP: codex/issue-2217-current-native-observer-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2217-current-native-observer-20261003`
- 原始 commit：`c62968fb9447398d25c210f09ecde64ffcbe219c`
- 原始 tree：`4d7ff4acbca1c2d340b29490cad3af1c9a65ecea`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2217, #2211, #3523, #1761, #2216
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
c62968fb9 fix(schema): reject unobserved MySQL partition row vectors
Refs: #2211, #2217, #3523

d6dbbc5e9 fix(schema): retain typed MySQL physical facts without inventing a target
Refs: #2211, #2217, #3523

bf5f047a4 fix(schema): bind original sequence compiler to integrated typed facts
Refs: #1761, #2216, #2217

6cb0e6cd4 fix(schema): integrate current control and typed sequence target facts
Refs: #1761, #2216, #2217

b06a378a9 fix(schema): require native journal constraint ownership
Refs: #1761, #2216, #2217

67689aa25 fix(schema): bind durable apply journal to current control target
Refs: #1761, #2216, #2217

6c802f67f fix(database): delegate original catalog and preserve caller RR ownership
Remove the duplicate Server catalog decoder and keep the original inspector interfaces and expected model bodies. Separate schema evidence borrowing a verified native caller RR transaction from production admission owning its read-only RR snapshot. Preserve the test materializer writer transaction owner.

Refs: #2217

7f19b831d style(database): retain one native observer terminal newline
Refs: #2217
```

## 相对原 merge base 的源码差异概况

```text
docs/architecture/repository-layout.md             |  22 +-
 docs/database-migration.md                         | 397 +++++++++-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |   2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |   1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs | 661 +----------------
 .../CurrentSchemaOwnedProjectionExporter.cs        |  97 +++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |  47 ++
 .../SchemaMigration/CurrentSchemaReadObserver.cs   | 192 +++++
 .../CurrentSchemaReceiptAdmission.cs               | 102 +++
 .../CurrentSchemaRecipeFactExtractor.cs            | 292 ++++++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |  94 +--
 .../SchemaMigration/SchemaModelInspector.cs        | 663 ++---------------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |   5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |  17 +-
 src/backend/Program.cs                             |  35 +
 src/migration/CurrentSchemaBootstrapCompiler.cs    | 308 ++++++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        | 184 +++++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  | 441 ++++++++++++
 src/migration/OfflineMigrationApplyContracts.cs    | 119 +++
 .../OfflineMigrationApplyJournalVerifier.cs        | 261 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |  46 ++
 src/migration/OfflineMigrationCommandLine.cs       | 148 ++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs | 251 +++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         | 478 +++++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |  65 ++
 src/migration/OfflineMigrationExecutor.cs          | 427 +++++++++++
 src/migration/OfflineMigrationHost.cs              | 252 ++++++-
 src/migration/OfflineMigrationPlan.cs              | 568 +++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 ++++
 src/migration/OfflineMigrationPlanEvidence.cs      |  58 ++
 src/migration/OfflineMigrationStateStore.cs        | 138 ++++
 src/migration/PgCurrentSchemaBootstrapOperation.cs | 272 +++++++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |  57 ++
 src/shared/Algorithms/ExactDecimalLiteral.cs       |  31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       | 795 +++++++++++++++++++++
 .../Schema/PgCurrentSchemaControlShape.cs          |  79 ++
 .../Schema/PgCurrentSchemaEffectObserver.cs        | 266 +++++++
 .../Schema/PgCurrentSchemaExpressionParser.cs      | 543 ++++++++++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        | 155 ++++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |  27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      | 425 +++++++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |  20 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  | 228 ++++++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |  62 ++
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   | 156 ++++
 .../Contracts/Schema/SchemaExpressionModel.cs      |  31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs | 236 ++++++
 .../Schema/SchemaPhysicalTypeProjection.cs         | 111 +++
 .../CurrentSchemaReceiptContracts.cs               | 316 ++++++++
 .../Integration/SchemaMigrationIntegrationTests.cs |   1 +
 .../CurrentSchemaOwnedProjectionExporterTests.cs   | 395 ++++++++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    | 584 +++++++++++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  | 366 ++++++++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |  83 +++
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |   1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |   1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    | 215 +++++-
 .../CurrentSchemaBootstrapCompilerTests.cs         | 221 ++++++
 .../CurrentSchemaStorageProjectionTests.cs         |  46 ++
 .../migration/OfflineMigrationApplyJournalTests.cs | 741 +++++++++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |  43 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 161 +++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 +++++++++++++
 tests/migration/OfflineMigrationPlanTests.cs       | 384 ++++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 351 +++++++++
 .../PgCurrentSchemaBootstrapOperationTests.cs      |  64 ++
 .../PgCurrentSchemaCatalogObserverTests.cs         |  44 ++
 .../PgCurrentSchemaEffectObserverTests.cs          |  77 ++
 .../PgCurrentSchemaExpressionParserTests.cs        | 162 +++++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     | 243 +++++++
 tests/tools/current-schema-authority.test.mjs      |  51 +-
 tools/db/check-current-schema-authority.mjs        |  51 +-
 73 files changed, 13788 insertions(+), 1361 deletions(-)
```


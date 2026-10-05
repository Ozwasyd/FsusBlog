# WIP: codex/issue-2217-sqlite-source-integration-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2217-sqlite-source-integration-20261003`
- 原始 commit：`ae65849f40b23f3b29c27502ffd51f470b2dfc76`
- 原始 tree：`4f2f577a4e4d0472529f263a010aa687e92a7700`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2217, #2215
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
ae65849f4 feat(migration): compose actual SQLite source identity capability
Integrate the original native provider sessions, source reads and sole held-file identity bridge without replacing PostgreSQL/MySQL lifecycle or Host authority. Bind SQLite public source observations to the actual same connection/transaction identity before and after full content reads. Declare existing native provider package references; preserve locks pending the original restore producer. Refs: #2217, #2215

Source-only: the optional native FILESTAT bundle capability, dependency restoration and actual native/database tests remain unverified. Current-schema/operation and backup provider capabilities are not granted.

b640b379f feat(database): compose original retained host authority
Use one original retained evidence authority for planning and locked apply/verify after the original resolver verifies actual tool/input bytes. Missing ports and cancellation refuse before observations; complete toolchain and provider qualification remain pending.

Change-Class: behavior

Refs: #2215

ad4b1ce73 fix(database): retain structured source fingerprint failures
Preserve exact redacted observation differences through the original closed matcher and Host commands, after the native owner awaits cleanup. Keep cleanup uncertainty higher priority, actual matching and original refusal rows intact. Import the original same-process retained authority without claiming tool or database qualification.

Change-Class: behavior

Refs: #2215

4295022c2 feat(migration): integrate original retained evidence authority
Refs #2215. Exact original two-source component reuse from d6836d82; same-process real owned backup capability and original planning reader, not a producer or imported plan proof. Retained build/tool producer, full DAG and actual execution remain pending.

55dde15ea feat(migration): connect original retained backup planning port
Refs #2215. Allow the compiled retention owner to preserve its actual original invocation capability across commands in the same process. No cross-process importer, second producer or observed backup from plan JSON.

6a1eee8b5 feat(migration): retain successful original backup invocation
Refs #2215. Add a process-owned opaque capability created only after the bound original producer and complete retained-byte closure succeed. Reuse source/content/age and terminal file predicates. Cross-process import and whole-provider/runtime acceptance remain unavailable.

ae4d78e37 fix(migration): expose original owned backup input capability
Return only the actual opaque process-owned inputs for the retained backup consumer; do not replace authentication or terminal verification with a status flag.

Refs: #2215

514645b45 fix(migration): verify original backup tool read identities
Reuse the sole original file owner terminal guard before admitting tool bytes. Cover same-byte leaf and ancestor replacement, in-place changes and unrelated sibling writes.

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |   1 +
 ...site-backup-source-binding-external-naming.json |  23 +
 docs/database-migration.md                         | 371 +++++++++-
 docs/operations.md                                 |   6 +
 docs/security/site-backup-envelope.md              |  32 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |   2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |   1 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   | 140 ++++
 .../CurrentSchemaReceiptAdmission.cs               | 102 +++
 .../SchemaMigration/SchemaMigrationRunner.cs       |  93 +--
 ...ntSchemaTestMaterializationCandidateVerifier.cs |   4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   4 +-
 src/migration/FsusBlog.Migration.csproj            |   2 +
 src/migration/OfflineMigrationApplyContracts.cs    | 119 ++++
 src/migration/OfflineMigrationApplyEvidence.cs     | 322 +++++++++
 .../OfflineMigrationApplyJournalVerifier.cs        | 266 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |  46 ++
 src/migration/OfflineMigrationArtifactPublisher.cs |  51 ++
 src/migration/OfflineMigrationBackupAdmission.cs   | 485 +++++++++++++
 src/migration/OfflineMigrationCommandLine.cs       | 383 ++++++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs | 340 +++++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         | 478 +++++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |  65 ++
 src/migration/OfflineMigrationExecutor.cs          | 427 ++++++++++++
 src/migration/OfflineMigrationHost.cs              | 525 +++++++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  98 +++
 .../OfflineMigrationMySqlNativeSession.cs          | 196 ++++++
 src/migration/OfflineMigrationPlan.cs              | 564 +++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 ++++
 src/migration/OfflineMigrationPlanEvidence.cs      | 188 +++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     | 434 ++++++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   | 107 +++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs | 204 ++++++
 .../OfflineMigrationShellBackupDrillProducer.cs    | 557 +++++++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  | 172 +++++
 .../OfflineMigrationSourceFingerprints.cs          | 230 ++++++
 .../OfflineMigrationSourceObserver.Providers.cs    | 632 +++++++++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 483 +++++++++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      | 264 +++++++
 .../OfflineMigrationSqliteNativeSession.cs         | 284 ++++++++
 src/migration/OfflineMigrationStateStore.cs        | 175 +++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  98 +++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 +
 .../CurrentSchemaReceiptContracts.cs               | 316 +++++++++
 .../Integration/SchemaMigrationIntegrationTests.cs |   1 +
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    | 394 +++++++++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |  83 +++
 .../migration/OfflineMigrationApplyCommandTests.cs | 422 +++++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 769 +++++++++++++++++++++
 .../OfflineMigrationBackupAdmissionTests.cs        | 488 +++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |  74 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 316 +++++++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 ++++++++++++++
 .../OfflineMigrationFingerprintCommandTests.cs     |  83 +++
 ...lineMigrationHostRetentionConfigurationTests.cs |  66 ++
 .../OfflineMigrationMySqlNativeSessionTests.cs     |  52 ++
 tests/migration/OfflineMigrationPlanTests.cs       | 477 +++++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs | 278 ++++++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |  59 ++
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs | 302 ++++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs | 327 +++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 463 +++++++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs | 189 +++++
 .../OfflineMigrationSourceObserverTests.cs         | 529 ++++++++++++++
 .../OfflineMigrationSqliteDatabaseIdentityTests.cs | 214 ++++++
 .../OfflineMigrationSqliteNativeSessionTests.cs    | 198 ++++++
 .../OfflineMigrationVerifyCommandTests.cs          | 297 ++++++++
 tests/tools/backup-envelope-contract.test.mjs      | 355 ++++++++++
 tools/operations/backup-restore-drill.sh           | 709 ++++++++++++++++++-
 tools/operations/backup-site.sh                    | 316 ++++++++-
 tools/operations/restore-site.sh                   | 431 +++++++++++-
 tools/operations/test-backup-envelope-fixture.sh   |  41 ++
 .../test-backup-restore-drill-fixture.sh           |  17 +
 73 files changed, 17822 insertions(+), 101 deletions(-)
```


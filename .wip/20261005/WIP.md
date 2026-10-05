# WIP: codex/issue-2217-native-typed-failure-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2217-native-typed-failure-20261003`
- 原始 commit：`88298f9c438fc8a872869452489be1590538cdfa`
- 原始 tree：`d6fbf12c8581d24252cbb5f70538fc6f7c2c53cb`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2217, #2215, #1762
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
88298f9c4 fix(migration): retain MySQL creator cancellation custody
Refs #2215, #2217, #1762

4ff99f136 fix(migration): bind MySQL borrowed reads to owned current transaction
Refs #2215, #2217, #1762

cfed9f7e4 refactor(migration): reuse original MySQL borrowed native boundary
Refs: #2215, #2217, #1762

cdca9aa09 feat(migration): observe typed native MySQL physical facts
Refs: #2217

1e86a0577 test(migration): align unknown schema control with typed refusal
Refs: #2217, #2215

680a77d1d fix(migration): preserve native metadata owner and business refusals
Refs: #2217, #2215

be0c1730e feat(migration): connect MySQL catalog to its original native session
Use the same original generic resource scope for source and raw current catalog results, without a synthetic source DTO, additional connection or duplicate cleanup controller. Preserve actual awaited native cleanup and typed fingerprint priority; add pre-connection cancellation/context controls for the real catalog entry. Canonical MySQL projection and allocator support remain independently pending. Refs: #2217, #2215

a7fdb0aa9 feat(migration): read original MySQL catalog and effect observations
Capture actual same-session server/database, native table/column/default/collation/index/constraint/check/reference/trigger/routine/event/view/partition metadata with original complete visibility and bounded reads. Preserve NULL/raw definitions, extra objects and terminal before/after observations. No expected target, allocator realization, effect execution or admission is invented; canonical MySQL projection and independent allocator protocol remain owned and unavailable. Source-only controls are not native/database qualification. Refs: #2217, #2215
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
 src/migration/MySqlCurrentSchemaCatalogObserver.cs | 249 +++++++
 .../MySqlCurrentSchemaPhysicalObserver.cs          | 199 ++++++
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
 .../OfflineMigrationMySqlNativeSession.cs          | 395 +++++++++++
 src/migration/OfflineMigrationPlan.cs              | 564 +++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 ++++
 src/migration/OfflineMigrationPlanEvidence.cs      | 188 +++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     | 434 ++++++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   | 107 +++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs | 204 ++++++
 .../OfflineMigrationShellBackupDrillProducer.cs    | 557 +++++++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  | 172 +++++
 .../OfflineMigrationSourceFingerprints.cs          | 230 ++++++
 .../OfflineMigrationSourceObserver.Providers.cs    | 639 +++++++++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 483 +++++++++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      | 264 +++++++
 .../OfflineMigrationSqliteNativeSession.cs         | 301 ++++++++
 src/migration/OfflineMigrationStateStore.cs        | 175 +++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  98 +++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 +
 .../CurrentSchemaReceiptContracts.cs               | 316 +++++++++
 .../Integration/SchemaMigrationIntegrationTests.cs |   1 +
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    | 394 +++++++++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |  83 +++
 .../MySqlCurrentSchemaCatalogObserverTests.cs      | 165 +++++
 .../MySqlCurrentSchemaPhysicalObserverTests.cs     | 218 ++++++
 .../migration/OfflineMigrationApplyCommandTests.cs | 422 +++++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 769 +++++++++++++++++++++
 .../OfflineMigrationBackupAdmissionTests.cs        | 488 +++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |  74 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 316 +++++++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 ++++++++++++++
 .../OfflineMigrationFingerprintCommandTests.cs     |  83 +++
 ...lineMigrationHostRetentionConfigurationTests.cs |  66 ++
 .../OfflineMigrationMySqlNativeSessionTests.cs     | 331 +++++++++
 tests/migration/OfflineMigrationPlanTests.cs       | 477 +++++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs | 278 ++++++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |  59 ++
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs | 302 ++++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs | 327 +++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 463 +++++++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs | 189 +++++
 .../OfflineMigrationSourceObserverTests.cs         | 560 +++++++++++++++
 .../OfflineMigrationSqliteDatabaseIdentityTests.cs | 214 ++++++
 .../OfflineMigrationSqliteNativeSessionTests.cs    | 310 +++++++++
 .../OfflineMigrationVerifyCommandTests.cs          | 297 ++++++++
 tests/tools/backup-envelope-contract.test.mjs      | 355 ++++++++++
 tools/operations/backup-restore-drill.sh           | 709 ++++++++++++++++++-
 tools/operations/backup-site.sh                    | 316 ++++++++-
 tools/operations/restore-site.sh                   | 431 +++++++++++-
 tools/operations/test-backup-envelope-fixture.sh   |  41 ++
 .../test-backup-restore-drill-fixture.sh           |  17 +
 77 files changed, 19298 insertions(+), 101 deletions(-)
```


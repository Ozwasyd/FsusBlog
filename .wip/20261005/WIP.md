# WIP: codex/issue-2215-retained-authority-20261003-GhaStW

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-retained-authority-20261003-GhaStW`
- 原始 commit：`a39bee531487eb1e0bf7c50bd2b80d822e7a2870`
- 原始 tree：`2dd09535c24d9e7863c25b2843ed17320a08c786`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a39bee531 fix(migration): seal retained before inputs in the original artifact domain
Preserve exact before bytes inside the existing production receipt roster, with actual byte-fixture controls for sealed reading, missing seals and unclaimed or modified artifacts. Preserve the prior source-only checkpoint as rejected producer source.

Change-Class: behavior

Refs: #2215

d6836d820 feat(migration): bind measured retained inputs and native evidence reader
Complete the retained-input measurement and same-process original backup composition source. The preceding partial source checkpoint did not include these new files; preserve it without rewriting history. Actual SDK, native and closed-DAG qualifications remain pending.

Change-Class: behavior

Refs: #2215

66a642739 feat(migration): integrate original retained backup composition
Change-Class: behavior

Refs: #2215

df915ac59 feat(migration): retain original production inputs and backup evidence
Compose the original invocation-only backup capability with same-session identity checks. Measure retained Migration inputs through the original production build owner. Full SDK, native and closed-DAG qualification remains pending.

Change-Class: behavior

Refs: #2215

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
...site-backup-source-binding-external-naming.json |  23 +
 docs/database-migration.md                         | 351 +++++++++-
 docs/operations.md                                 |   6 +
 docs/security/site-backup-envelope.md              |  32 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |   2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |   1 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   | 140 ++++
 .../CurrentSchemaReceiptAdmission.cs               | 102 +++
 .../SchemaMigration/SchemaMigrationRunner.cs       |  93 +--
 ...ntSchemaTestMaterializationCandidateVerifier.cs |   4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   4 +-
 src/migration/OfflineMigrationApplyContracts.cs    | 119 ++++
 src/migration/OfflineMigrationApplyEvidence.cs     | 322 +++++++++
 .../OfflineMigrationApplyJournalVerifier.cs        | 266 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |  46 ++
 src/migration/OfflineMigrationArtifactPublisher.cs |  51 ++
 src/migration/OfflineMigrationBackupAdmission.cs   | 485 +++++++++++++
 src/migration/OfflineMigrationCommandLine.cs       | 383 ++++++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs | 251 +++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         | 478 +++++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |  65 ++
 src/migration/OfflineMigrationExecutor.cs          | 427 ++++++++++++
 src/migration/OfflineMigrationHost.cs              | 490 ++++++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  71 ++
 src/migration/OfflineMigrationPlan.cs              | 568 +++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 ++++
 src/migration/OfflineMigrationPlanEvidence.cs      | 188 +++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     | 421 +++++++++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   | 107 +++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs | 204 ++++++
 .../OfflineMigrationShellBackupDrillProducer.cs    | 557 +++++++++++++++
 .../OfflineMigrationSourceFingerprints.cs          | 199 ++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 472 +++++++++++++
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
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 161 +++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 ++++++++++++++
 tests/migration/OfflineMigrationPlanTests.cs       | 467 +++++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs | 278 ++++++++
 ...flineMigrationRetainedEvidenceAuthorityTests.cs |  59 ++
 ...ineMigrationShellBackupDrillOwnedInputsTests.cs | 302 ++++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs | 327 +++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 463 +++++++++++++
 .../OfflineMigrationSourceObserverTests.cs         | 228 ++++++
 .../OfflineMigrationVerifyCommandTests.cs          | 297 ++++++++
 tests/tools/backup-envelope-contract.test.mjs      | 355 ++++++++++
 tests/tools/migration-retained-inputs.test.mjs     | 195 ++++++
 tools/ci/migration-retained-inputs.mjs             | 144 ++++
 tools/ci/production-build-artifacts.mjs            |  17 +
 tools/operations/backup-restore-drill.sh           | 709 ++++++++++++++++++-
 tools/operations/backup-site.sh                    | 316 ++++++++-
 tools/operations/restore-site.sh                   | 431 +++++++++++-
 tools/operations/test-backup-envelope-fixture.sh   |  41 ++
 .../test-backup-restore-drill-fixture.sh           |  17 +
 tools/test/lanes/production-build-artifacts.sh     |  42 +-
 64 files changed, 15174 insertions(+), 106 deletions(-)
```


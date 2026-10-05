# WIP: codex/issue-1761-sqlite-guard-render-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-1761-sqlite-guard-render-20261003`
- 原始 commit：`5768342122271732451568e3d9d878d9627e1d19`
- 原始 tree：`ea7f4d927db8bdeb3dee86da42af1760316f19f7`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#1761, #2217, #2215, #2216
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
576834212 feat(database): render and match explicit sqlite trigger facts
Retain native failure actions and the complete observed trigger vector without choosing an original current recipe policy.

Refs: #1761

Refs: #2217

52837533b feat(migration): observe closed native SQLite trigger effects
Decode actual unconditional native BEFORE mutation RAISE effects through one Shared algorithm and the original SQLite catalog/session. Preserve distinct actions, literal messages and event identities; refuse unknown or conditional bodies instead of inferring an immutable target from names or raw SQL presence. No provider policy, DDL renderer, target authority or bootstrap grant is invented.

Refs: #1761

a8de5c61f fix(migration): reject coerced SQLite sequence catalog facts
Check native sqlite_sequence name and seq storage types before string or integer conversion. Retain exact integer facts and all original catalog/source fixtures; add actual provider mutation refusals for text, fractional, null and non-text-name storage.

Refs: #1761

1059486d4 feat(migration): observe native SQLite current catalog facts
Measure caller-owned native Serializable SQLite catalogs and effects without defining expected business mappings, committing a unit, or claiming physical incarnation/bootstrap admission. Refuse incomplete, unsupported and bounded-metadata failures; preserve original metadata limits and declare the existing native SQLite dependency.

Refs: #1761

2918359ca fix(migration): retain terminal identity checks for backup inputs
Refs #2215. Reuse the sole anchored file owner before and after actual JSON/hash reads; preserve all original byte checks and evidence closure. Four additional real-filesystem source rows are not runtime qualification.

0fe514f99 fix(migration): verify original file identities after reads
Bind the retained descriptor and anchored path to opaque pre-read native metadata. Reuse the sole no-follow walk for terminal verification and preserve original artifact byte limits.

Refs: #2217

8562a24fe feat(migration): connect sealed apply to offline host
Refs #2215; Refs #2216. Source-only integration: whole artifact hashes, original locked admission and explicit operation/cleanup budgets. Complete provider operations, retained authorities and runtime verification remain pending.

80ffdfefc fix(migration): drain original backup pipes during finite termination
Keep fair actual stdout and stderr consumption active through the original explicit TERM grace and KILL/reap ledger. Retain healthy terminal trap output; consume an already-failed raw pipe only with explicit incomplete-evidence refusal. Preserve primary errors and all existing cancellation assertions, without background copies or a second authority.

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
...site-backup-source-binding-external-naming.json |  23 +
 docs/database-migration.md                         | 368 +++++++++-
 docs/operations.md                                 |   6 +
 docs/security/site-backup-envelope.md              |  28 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |   2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |   1 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   | 140 ++++
 .../CurrentSchemaReceiptAdmission.cs               | 102 +++
 .../SchemaMigration/SchemaMigrationRunner.cs       |  93 +--
 ...ntSchemaTestMaterializationCandidateVerifier.cs |   4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   4 +-
 src/migration/FsusBlog.Migration.csproj            |   1 +
 src/migration/OfflineMigrationApplyContracts.cs    | 119 ++++
 src/migration/OfflineMigrationApplyEvidence.cs     | 322 +++++++++
 .../OfflineMigrationApplyJournalVerifier.cs        | 266 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |  46 ++
 src/migration/OfflineMigrationArtifactPublisher.cs |  51 ++
 src/migration/OfflineMigrationBackupAdmission.cs   | 365 ++++++++++
 src/migration/OfflineMigrationCommandLine.cs       | 383 ++++++++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs | 251 +++++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         | 478 +++++++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |  65 ++
 src/migration/OfflineMigrationExecutor.cs          | 427 ++++++++++++
 src/migration/OfflineMigrationHost.cs              | 490 ++++++++++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  37 +
 src/migration/OfflineMigrationPlan.cs              | 568 +++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 ++++
 src/migration/OfflineMigrationPlanEvidence.cs      | 176 +++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     | 421 +++++++++++
 .../OfflineMigrationShellBackupDrillProducer.cs    | 540 +++++++++++++++
 .../OfflineMigrationSourceFingerprints.cs          | 199 ++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 472 +++++++++++++
 src/migration/OfflineMigrationStateStore.cs        | 175 +++++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  98 +++
 .../SqliteCurrentSchemaCatalogObserver.cs          | 300 ++++++++
 src/migration/SqliteCurrentSchemaEffectObserver.cs |  86 +++
 .../SqliteImmutableTriggerObservation.cs           | 156 +++++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 +
 .../CurrentSchemaReceiptContracts.cs               | 316 +++++++++
 .../Integration/SchemaMigrationIntegrationTests.cs |   1 +
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    | 394 +++++++++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |  83 +++
 .../migration/OfflineMigrationApplyCommandTests.cs | 382 ++++++++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 769 +++++++++++++++++++++
 .../OfflineMigrationBackupAdmissionTests.cs        | 408 +++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |  74 ++
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs | 161 +++++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    | 500 ++++++++++++++
 tests/migration/OfflineMigrationPlanTests.cs       | 467 +++++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs | 278 ++++++++
 ...fflineMigrationShellBackupDrillProducerTests.cs | 327 +++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 463 +++++++++++++
 .../OfflineMigrationSourceObserverTests.cs         | 228 ++++++
 .../OfflineMigrationVerifyCommandTests.cs          | 297 ++++++++
 .../SqliteCurrentSchemaCatalogObserverTests.cs     | 312 +++++++++
 .../SqliteCurrentSchemaEffectObserverTests.cs      | 378 ++++++++++
 tests/tools/backup-envelope-contract.test.mjs      | 355 ++++++++++
 tools/operations/backup-restore-drill.sh           | 709 ++++++++++++++++++-
 tools/operations/backup-site.sh                    | 316 ++++++++-
 tools/operations/restore-site.sh                   | 431 +++++++++++-
 tools/operations/test-backup-envelope-fixture.sh   |  41 ++
 .../test-backup-restore-drill-fixture.sh           |  17 +
 62 files changed, 15052 insertions(+), 101 deletions(-)
```


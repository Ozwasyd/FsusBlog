# WIP: codex/issue-2215-fingerprint-diff-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2215-fingerprint-diff-20261003`
- 原始 commit：`1762b14d4a1a86ace8a5e3a06a99b69ecbfd53b4`
- 原始 tree：`64dfa3e1dc642bd62ea28362b460e99fcfcefdd5`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2215
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1762b14d4 fix(database): preserve redacted source fingerprint differences
Refs: #2215

2589bf5ef fix(migration): retain secondary native cleanup refusals
Keep original operation failure distinct from transaction, connection and adapter cleanup states. Refuse any unverified cleanup before projecting cancellation or returning source/capture results; preserve fixed safe categories without driver text or abandoned disposal tasks.

Refs: #2215

c78a42a16 feat(database): observe native provider source content
Refs: #2215

45baf9d72 test(migration): preserve native cleanup failure across source deadline
Refs #2215. Protocol fixture only; no native execution or release proof.

20d069f00 feat(migration): wire native source and owned planning evidence consumer
Refs #2215. Reuse original source/native owners; require real owned backup-drill admission and complete target closure. No SDK, database or backup execution evidence.

e75352bbb feat(migration): own PostgreSQL native snapshot session
Hold one actual SqlSugar/Npgsql read-only repeatable-read session across full observation and the original dump-terminal handshake. Bind native snapshot time, actual dump FD/path identity and streaming bytes, then re-observe before awaited disposal. Preserve PG-only capability and caller-owned deadline boundaries.

Refs: #2215

a93cd073f fix(database): refuse unregistered standalone source types
Include standalone base and unfinished shell types in the native unknown-source inventory while retaining implicit arrays and registered historical table row types.

Refs: #2215

f535032db fix(database): observe closed historical sources and full native content
Read actual PostgreSQL catalogs, identity, legacy preconditions and complete typed rows in the same native transaction. Register only explicit empty and fixture-derived historical source shapes. Refuse unavailable provider content capability and delegate native lifecycle to its sole owner.

Refs: #2215
```

## 相对原 merge base 的源码差异概况

```text
docs/database-migration.md                         | 136 +++++
 src/migration/OfflineMigrationCommandLine.cs       | 148 +++++
 src/migration/OfflineMigrationHost.cs              | 252 ++++++++-
 src/migration/OfflineMigrationPlan.cs              | 568 +++++++++++++++++++
 src/migration/OfflineMigrationPlanContracts.cs     | 150 +++++
 src/migration/OfflineMigrationPlanEvidence.cs      | 159 ++++++
 .../OfflineMigrationPostgreSqlNativeSession.cs     | 434 +++++++++++++++
 .../OfflineMigrationSourceFingerprintException.cs  | 172 ++++++
 .../OfflineMigrationSourceFingerprints.cs          | 230 ++++++++
 .../OfflineMigrationSourceObserver.Providers.cs    | 614 +++++++++++++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    | 481 ++++++++++++++++
 .../CurrentSchemaMigrationIdentityContracts.cs     |  33 ++
 .../migration/OfflineMigrationCommandLineTests.cs  |  43 ++
 tests/migration/OfflineMigrationPlanTests.cs       | 467 ++++++++++++++++
 ...OfflineMigrationPostgreSqlNativeSessionTests.cs | 278 ++++++++++
 .../OfflineMigrationSourceCommandLineTests.cs      | 399 +++++++++++++
 ...lineMigrationSourceFingerprintExceptionTests.cs | 189 +++++++
 .../OfflineMigrationSourceObserverTests.cs         | 468 ++++++++++++++++
 18 files changed, 5220 insertions(+), 1 deletion(-)
```


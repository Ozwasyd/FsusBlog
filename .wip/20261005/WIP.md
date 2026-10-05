# WIP: codex/issue-3524-native-preexec-restore-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-native-preexec-restore-20261003`
- 原始 commit：`82b229643745e7e63380aaca507d416347db1fea`
- 原始 tree：`a145af4647dc92cdf7321c55dd9cf809f694d0f2`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
82b229643 fix(test): restore owned tmp native admission closure
Restore the exact reviewed native alias and pre-exec observations consumed by the managed caller while preserving private namespace, held-descriptor identity and existing write boundaries. No generated output or execution qualification is included.

Refs: #3524

44c0fab0b fix(test): integrate reviewed managed execution source repairs
Bind the latest original adapter, bootstrap and wrapper bytes while preserving unknown settlement and finalizer details. Keep unresolved native, nested and generated closure explicitly not ready; no execution is implied.

Refs: #3524

2d3bd019c fix(test): integrate reviewed scratch and nested source bindings
Apply exact reviewed selectors, original directory capabilities and finite preparation source. Preserve current document changes and explicitly retain unresolved managed physical, nested producer and generated input closure.

Refs: #3524

30b024aab fix(test): integrate reviewed migration recovery and sender sources
Apply exact reviewed retained-layout, original caller controls and sender hunks without restoring rejected physical or wrapper heads. Preserve existing build inputs and all earlier controls; runtime closure and admission remain pending.

Refs: #3524

3a3d6a673 fix(test): integrate reviewed managed migration admission sources
Compose the readonly evidence store and repaired resource and scheduler sources through exact preimage hunks. Preserve earlier catalog controls, private launcher authority and original first-failure ordering; native and canonical execution remain unqualified.

Refs: #3524

eabc72517 fix(test): integrate reviewed migration membership and resource owner
Compose the exact reviewed 225-producer consumer and original systemd owner source without enabling resource admission or importing the rejected held controller. Generated inventories, SDK and native lifecycle remain pending.

Refs: #3524

0c26f15ae fix(test): integrate reviewed MySQL catalog recovery source
Refs #3524. Preserve current resource enforcement and scheduler implementations while composing only the reviewed original catalog, lifecycle recovery component and strict source fixtures. Actual caller, generated admission and runtime qualification remain pending.

6c2bd53e4 fix(test): integrate reviewed MySQL migration source prerequisites
Refs #3524. Bind reviewed retention, producer roster, admitted C# client fixtures and central test dependency by exact frozen owners. Generated projections, service lifecycle caller, SDK restore and all runtime qualification remain pending.
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    1 +
 config/configuration-ownership.json                |    4 +-
 .../testing/physical-execution-process-policy.json |    2 +
 config/testing/test-execution-service-catalog.json |   36 +
 docs/testing.md                                    |    2 +-
 .../issue-1072-production-resource-enforcement.md  |   29 +-
 tests/FsusBlog.ProductionBackend.slnx              |    5 +
 .../backend-production-build-consumers.json        |   10 +
 tests/governance/test-lifecycle-registry.json      |   36 +
 tests/matrix.yml                                   |   27 +-
 tests/migration/FsusBlog.Migration.Tests.csproj    |    1 +
 tests/migration/MySqlDdlClient.cs                  |  199 +++
 tests/migration/MySqlDdlClientContractTests.cs     |   87 ++
 tests/migration/MySqlDdlExecutionTests.cs          |  194 +++
 tests/migration/MySqlDdlFixture.cs                 |  101 ++
 tests/migration/MySqlDdlFixtureContractTests.cs    |   51 +
 .../backend-production-build-authority.test.mjs    |   64 +-
 .../content-addressed-evidence-store.test.mjs      |   61 +
 tests/tools/correctness-attempt-migration.test.mjs |   32 +-
 tests/tools/migration-execution-evidence.test.mjs  | 1426 ++++++++++++++++++++
 tests/tools/migration-fast-lane.test.mjs           |  227 ++++
 ...sical-execution-private-dotnet-scratch.test.mjs |  235 ++++
 tests/tools/production-build-layout.test.mjs       |  127 ++
 .../tools/production-resource-enforcement.test.mjs | 1419 ++++++++++++++++++-
 .../tools/support/xunit-configuration-fixture.mjs  |  182 +++
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   48 +
 tools/test-fixtures/services/mysql.mjs             |  777 +++++++++++
 tools/test-inventory/adapters.mjs                  |   22 +-
 tools/test-inventory/discovery.mjs                 |   55 +-
 tools/test-inventory/produce.mjs                   |   13 +-
 tools/test-inventory/xunit-projects.mjs            |  103 ++
 .../test-inventory/xunit-roslyn-adapter/Program.cs |   35 +-
 .../XunitAdapterProjectContext.cs                  |   98 +-
 .../XunitAdapterReferenceResolution.cs             |  102 +-
 .../content-addressed-evidence-store.mjs           |   48 +-
 tools/test-matrix/execution-envelope-policy.mjs    |    9 +-
 tools/test-matrix/mysql-fixture-recovery.mjs       |  140 ++
 tools/test-matrix/production-build-layout.mjs      | 1121 ++++++++++++++-
 .../production-fresh-run-bound-outputs.mjs         |    3 +-
 .../production-resource-enforcement.mjs            |  712 +++++++++-
 .../production-systemd-resource-boundary.mjs       | 1191 ++++++++++++++++
 tools/test-matrix/scheduler.mjs                    |  982 +++++++++++++-
 tools/test-retention/audit.mjs                     |   16 +-
 tools/test/backend-platform-selection.mjs          |   80 +-
 tools/test/behavior-doc-nuget-preparation.mjs      |  389 ++++++
 tools/test/build-migration-tests.mjs               |   88 ++
 tools/test/bundles/run-bundle.mjs                  |   41 +
 .../check-backend-production-build-authority.mjs   |   22 +-
 tools/test/correctness-attempt-migration.mjs       |    4 +-
 tools/test/execution-envelope-directories.mjs      |  189 ++-
 tools/test/execution-envelope-network.mjs          |   29 +
 tools/test/execution-envelope-services.mjs         |  310 ++++-
 tools/test/lanes/_suite-support.sh                 |   39 +-
 tools/test/migration-build-binding.mjs             |  269 ++++
 tools/test/migration-execution-evidence.mjs        |  179 +++
 tools/test/mysql-fixture-admission.mjs             |  351 +++++
 tools/test/native/execution-envelope-landlock.c    |   76 ++
 tools/test/physical-execution-linux-preexec.py     |   37 +
 .../physical-execution-linux-systemd-adapter.mjs   |  856 +++++++++++-
 .../physical-execution-linux-systemd-bootstrap.mjs |   92 ++
 tools/test/physical-execution-nested-channel.mjs   |  604 +++++++++
 tools/test/physical-execution-nested-socket.py     |  140 ++
 .../physical-execution-private-dotnet-scratch.mjs  |  177 +++
 tools/test/physical-execution-process-tree.mjs     |  925 ++++++++++++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++++
 tools/test/run-deterministic-command.mjs           |  670 +++++----
 tools/test/run-migration-tests.mjs                 |  511 +++++++
 ...erate-test-execution-envelope-applicability.mjs |    9 +-
 70 files changed, 15780 insertions(+), 795 deletions(-)
```


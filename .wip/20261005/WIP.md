# WIP: codex/issue-3524-generated-catalogs-20261003-0406

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-generated-catalogs-20261003-0406`
- 原始 commit：`31c7b74805bc72f7694ce1ae5f9e6b5395cb32f7`
- 原始 tree：`540e706b45237c17058b37d07818948a279e52ad`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
31c7b7480 fix(test): materialize reviewed cleanup source closure
Change-Class: implementation

Refs: #3524

13c31b20d fix(test): materialize reviewed preparation source closure
Refs: #3524

77105f938 fix(test): integrate reviewed live manager assertion controls
Refs #3524. SOURCE-only exact fc09/9b08 transfer; preserve original sixty-two controls and f4de producer JSON bytes. No candidate imports, tests, SDK, services or producer rerun.

f4de1a800 fix(test): regenerate migration producer catalogs
Refs: #3524

Original applicability and correctness source producers only; no candidate tests, SDK, services, native qualification or trusted promotion.

f6d187f2e fix(test): integrate reviewed native source and async controls
Refs #3524. SOURCE-only import of exact reviewed 82b native/preexec and 8da component controls; no native, Python, tests, SDK, services or producer execution.

ab3cd76cc docs(test): bind reviewed nested preparation ownership contract
Preserve current testing norms while recording controller-held capabilities, three-phase single-use execution and conservative cleanup obligations. Consumer ports alone remain unqualified and not ready.

Refs: #3524

e95e8a536 fix(test): integrate reviewed asynchronous preparation source ports
Preserve original directory capability retention and explicit selector propagation. Bind only reviewed owner consumers and the direct entry guard; actual private managed callback composition and generated inputs remain not ready.

Refs: #3524

44c0fab0b fix(test): integrate reviewed managed execution source repairs
Bind the latest original adapter, bootstrap and wrapper bytes while preserving unknown settlement and finalizer details. Keep unresolved native, nested and generated closure explicitly not ready; no execution is implied.

Refs: #3524
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    1 +
 ...4-preparation-source-union-external-naming.json |   15 +
 config/configuration-ownership.json                |    4 +-
 config/testing/correctness-attempt-producers.json  |   89 +-
 .../testing/physical-execution-process-policy.json |    2 +
 .../test-execution-envelope-applicability.json     |   12 +-
 config/testing/test-execution-service-catalog.json |   36 +
 docs/testing.md                                    |    6 +-
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
 .../tools/execution-envelope-environment.test.mjs  |  458 ++++++
 tests/tools/execution-envelope-network.test.mjs    |  413 +++++
 tests/tools/migration-execution-evidence.test.mjs  | 1426 +++++++++++++++++
 tests/tools/migration-fast-lane.test.mjs           |  227 +++
 .../physical-execution-nested-channel.test.mjs     |  230 +++
 ...sical-execution-private-dotnet-scratch.test.mjs |  235 +++
 tests/tools/production-build-layout.test.mjs       |  127 ++
 .../tools/production-resource-enforcement.test.mjs | 1644 +++++++++++++++++++-
 tests/tools/run-deterministic-command.test.mjs     |   85 +
 .../tools/support/xunit-configuration-fixture.mjs  |  182 +++
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   48 +
 tools/test-fixtures/services/mysql.mjs             |  777 +++++++++
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
 tools/test-matrix/production-build-layout.mjs      | 1121 ++++++++++++-
 .../production-fresh-run-bound-outputs.mjs         |    3 +-
 .../production-resource-enforcement.mjs            |  712 ++++++++-
 .../production-systemd-resource-boundary.mjs       | 1206 ++++++++++++++
 tools/test-matrix/scheduler.mjs                    |  982 +++++++++++-
 tools/test-retention/audit.mjs                     |   16 +-
 tools/test/backend-platform-selection.mjs          |   80 +-
 tools/test/behavior-doc-nuget-preparation.mjs      |  389 +++++
 tools/test/build-migration-tests.mjs               |   88 ++
 tools/test/bundles/run-bundle.mjs                  |   41 +
 .../check-backend-production-build-authority.mjs   |   22 +-
 tools/test/correctness-attempt-migration.mjs       |    4 +-
 tools/test/execution-envelope-directories.mjs      |  221 ++-
 tools/test/execution-envelope-environment.mjs      |  212 ++-
 tools/test/execution-envelope-network.mjs          |  132 +-
 tools/test/execution-envelope-services.mjs         |  310 +++-
 tools/test/lanes/_suite-support.sh                 |   39 +-
 tools/test/migration-build-binding.mjs             |  269 ++++
 tools/test/migration-execution-evidence.mjs        |  179 +++
 tools/test/mysql-fixture-admission.mjs             |  351 +++++
 tools/test/native/execution-envelope-landlock.c    |   76 +
 tools/test/physical-execution-linux-preexec.py     |   37 +
 .../physical-execution-linux-systemd-adapter.mjs   |  856 +++++++++-
 .../physical-execution-linux-systemd-bootstrap.mjs |   92 ++
 tools/test/physical-execution-nested-channel.mjs   | 1173 ++++++++++++++
 tools/test/physical-execution-nested-socket.py     |  140 ++
 .../physical-execution-private-dotnet-scratch.mjs  |  177 +++
 tools/test/physical-execution-process-tree.mjs     |  925 ++++++++++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++++
 tools/test/run-deterministic-command.mjs           | 1004 +++++++++---
 tools/test/run-matrix-governance-once.sh           |    5 +
 tools/test/run-migration-tests.mjs                 |  511 ++++++
 ...erate-test-execution-envelope-applicability.mjs |    9 +-
 79 files changed, 18602 insertions(+), 774 deletions(-)
```


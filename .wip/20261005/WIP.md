# WIP: codex/issue-3631-source-closure-20260930

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3631-source-closure-20260930`
- 原始 commit：`fc308b553a7e4872ed015a6b70a9fc834ee6a4d9`
- 原始 tree：`17e27efad15cad937bc9d884009005ac2edc8a76`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3631, #3524
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
fc308b553 chore(governance): bind canonical projection fixture source ownership
Bind the completed original fixture owner and regenerate the precise ledger locations and current receipt through their unchanged original producers. Preserve all 512 finding rules, classifications, owners and consumer actions, all 89 consumers, and the independent execution-target source index.

Refs: #3524, #3631

5becd5f17 test(governance): materialize canonical OpenAPI projection fixtures
Write the run-private synthetic projection declared by the existing OpenAPI v2 value contract and bind its actual bytes to the artifact and build receipt. Add independent positive, missing-file and changed-byte refusal coverage. Preserve all thirty-two original case names, options and one hundred thirty-six assertions; no contract, reader firewall or cancellation budget changes.

Refs: #3524, #3631

b1daf7329 chore(governance): bind fixed canonical Migration source closure
Regenerate all affected output through its unchanged original producers and bind all seventeen output references from eight existing manifests. Preserve 101 execution targets, 934 closure files and the exact independent source index. Rebuild the current evidence-location receipt against the actual final ledger instead of preserving an older ledger digest. Shared pure source ownership and full Migration qualification remain open.

Refs: #3524, #3631

fe72f190a chore(governance): bind fixed canonical source formatting
Register the new complete format SHA after the fixed static value source. Both original formatter passes preserve AST, raw tokens and anchored comments, with matching tree digests. The unchanged parent-import owner finding remains unresolved, and no old idempotence evidence or source policy is reused.

Refs: #3524, #3631

e2f589105 style(tooling): format fixed canonical Migration value sources
Change-Class: format-only
Formatter: eslint@10.8.0 :: env FSUSBLOG_STYLE_ROOT=. node tools/frontend/style-toolchain/node_modules/.bin/eslint --config eslint.config.mjs --fix --fix-type layout --format json tests/tools/content-shape-catalog.test.mjs tests/tools/doc-claim.test.mjs tests/tools/execution-envelope-services.test.mjs tests/tools/openapi-aeds-observation.test.mjs tests/tools/physical-execution-private-dotnet-scratch.test.mjs tests/tools/runtime-role-minimal-v3-contract.test.mjs tools/contracts/lib/openapi-observation.mjs tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs tools/docs/behavior-doc-minimal-contract-build.mjs tools/testing/content-shape-catalog.mjs
Idempotence-Evidence: artifacts/style/migration-pr-source-format-idempotence.json
Refs: #3524, #3631

ffff0345c fix(contracts): restore fixed pure value imports
Preserve the original canonical release static dependency contract. Restore the existing canonical digest import without changing assertions, algorithms or source policy.

Refs: #3524, #3631

e873db065 refactor(tooling): preserve source style ownership boundaries
Keep existing module owners, required case assertions and timeout budgets while repairing parent dependency bindings, explicit statement/control tokens and unused local bindings. Preserve the literal dependency closure of the pure runtime-role value reader and clarify that Migration dependency reading may launch read-only Docker cleanup observations.

Refs: #3524

4a374a19a fix(test): bind fast Migration dependency evidence
Refs: #3524
```

## 相对原 merge base 的源码差异概况

```text
.git-blame-ignore-revs                             |    3 +
 Directory.Packages.props                           |    1 +
 .../issue-3524-canonical-external-naming.json      |  119 +
 ...gration-execution-target-generated-binding.json |  104 +
 ...sue-3527-resource-boundary-external-naming.json |   46 +
 ...e-3527-resource-boundary-generated-binding.json |   13 +
 ...1-scheduler-fixture-assets-external-naming.json |   12 +
 ...scheduler-fixture-assets-generated-binding.json |   13 +
 ...heduler-finalizer-fixtures-external-naming.json |   12 +
 ...duler-finalizer-fixtures-generated-binding.json |   12 +
 ...e-3606-behaviordoc-fixture-external-naming.json |   12 +
 ...ue-3606-pinned-dotnet-host-external-naming.json |   30 +
 ...-3606-pinned-dotnet-host-generated-binding.json |   24 +
 ...608-private-dotnet-scratch-external-naming.json |   32 +
 ...8-private-dotnet-scratch-generated-binding.json |   26 +
 .../issue-3612-external-naming.json                |   12 +
 .../issue-3615-external-naming.json                |   19 +
 .../issue-3615-generated-binding.json              |   12 +
 .../issue-3617-external-naming.json                |   29 +
 ...-3622-nuget-lock-ownership-external-naming.json |   20 +
 ...4-dependency-overlay-owner-external-naming.json |   21 +
 .../openapi-minimal-receipt-generated-binding.json |   17 +
 .../migration-assembly-binding.json                |   10 +-
 .../migration-assembly-receipt.json                |   32 +-
 .../migration-pr-source-format-idempotence.json    |   24 +
 .../authoritative-development-docs.json            |    4 +-
 .../development/native-tooling-style-policy.json   |    1 +
 ...havior-doc-static-admission-receipt.schema.json |   78 +-
 ...st-execution-envelope-applicability.schema.json |    1 +
 .../test-execution-service-catalog.schema.json     |  123 +
 config/testing/correctness-attempt-producers.json  |   89 +-
 .../current-run-evidence-location-acceptance.json  |   12 +-
 .../evidence-location-migration-ledger.json        |  190 +-
 .../testing/physical-execution-process-policy.json |    2 +
 .../test-execution-envelope-applicability.json     |   12 +-
 config/testing/test-execution-service-catalog.json |   36 +
 docs/api/schemas-and-errors.md                     |    2 +-
 docs/database-migration.md                         |   22 +
 docs/development/coding-conventions.md             |   10 +
 .../native-tooling-style-enforcement.md            |    8 +
 docs/releases/release-identity.md                  |    2 +-
 docs/schema-migrations/typed-ddl-primitives.json   |   14 +-
 docs/testing.generated.md                          |    8 +-
 docs/testing.md                                    |   75 +-
 docs/testing/content-addressed-evidence-storage.md |   30 +-
 .../issue-1069-run-bound-production-builds.md      |   10 +-
 .../issue-1072-production-resource-enforcement.md  |  409 +-
 src/migration/SchemaMigrationDdlPrimitives.cs      |   97 +-
 tests/FsusBlog.ProductionBackend.slnx              |    5 +
 .../release-final-execution-target-authority.json  | 1577 +++++++-
 .../backend-production-build-consumers.json        |   40 +-
 tests/governance/test-lifecycle-registry.json      |   36 +
 tests/matrix.yml                                   |   30 +-
 tests/migration/FsusBlog.Migration.Tests.csproj    |    1 +
 tests/migration/MigrationAssemblyBoundaryTests.cs  |   13 +-
 tests/migration/MySqlDdlClient.cs                  |  199 +
 tests/migration/MySqlDdlClientContractTests.cs     |   87 +
 tests/migration/MySqlDdlExecutionTests.cs          |  194 +
 tests/migration/MySqlDdlFixture.cs                 |  101 +
 tests/migration/MySqlDdlFixtureContractTests.cs    |   51 +
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |   79 +-
 tests/migration/packages.lock.json                 |   10 +
 tests/migration/schema-ddl-provider-snapshots.json |    6 +-
 .../tools/authoritative-development-docs.test.mjs  |   69 +
 .../backend-production-build-authority.test.mjs    |   64 +-
 tests/tools/behavior-doc-static-admission.test.mjs |  273 +-
 .../content-addressed-evidence-store.test.mjs      |   75 +-
 tests/tools/content-shape-catalog.test.mjs         |   63 +-
 tests/tools/correctness-attempt-migration.test.mjs |   32 +-
 tests/tools/doc-claim.test.mjs                     |  331 +-
 ...sm-fixture-materializer-runtime-assets.test.mjs |   33 +
 tests/tools/evidence-location-governance.test.mjs  |   84 +
 .../tools/execution-envelope-environment.test.mjs  |   26 +
 tests/tools/execution-envelope-network.test.mjs    |   84 +-
 tests/tools/execution-envelope-policy.test.mjs     |   71 +
 tests/tools/execution-envelope-services.test.mjs   | 1579 +++++++-
 tests/tools/hidden-retry-governance.test.mjs       |   44 +
 .../local-production-profile-evidence.test.mjs     |   21 +
 tests/tools/migration-execution-evidence.test.mjs  | 1188 ++++++
 tests/tools/migration-fast-lane.test.mjs           |  227 ++
 tests/tools/native-tooling-style.test.mjs          |   53 +
 tests/tools/openapi-aeds-observation.test.mjs      |  265 +-
 ...sical-execution-private-dotnet-scratch.test.mjs |  235 ++
 .../tools/physical-execution-process-tree.test.mjs |  797 +++-
 .../physical-execution-systemd-sender.test.mjs     |  104 +
 .../tools/post-runtime-producer-registry.test.mjs  |  249 +-
 .../production-capacity-preflight-order.test.mjs   |   82 +-
 .../tools/production-capacity-reservation.test.mjs |  295 +-
 .../tools/production-resource-enforcement.test.mjs | 4189 +++++++++++++++++++-
 tests/tools/run-once-process-identity.test.mjs     |   84 +
 .../runtime-role-minimal-v3-contract.test.mjs      |  255 +-
 tests/tools/scheduler-owner-identity.test.mjs      |  312 +-
 .../support/esm-fixture-materializer-contracts.mjs |  175 +-
 .../support/esm-fixture-materializer-runner.mjs    |   70 +
 tests/tools/support/esm-fixture-materializer.mjs   |  228 +-
 tests/tools/support/posix-cancellation-fixture.mjs |   40 +
 .../support/runtime-role-minimal-v3-fixture.mjs    |   20 +-
 .../scheduler-checkpoint-recovery-probe.mjs        |   12 +
 .../tools/support/xunit-configuration-fixture.mjs  |  139 +
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 +-
 tests/tools/test-matrix-resource-boundary.test.mjs |  890 +++++
 tests/tools/test-matrix-scheduler.test.mjs         |  732 ++--
 tests/tools/xunit-roslyn-adapter.test.mjs          |   41 +
 tools/check-test-matrix.mjs                        |    4 +-
 tools/contracts/lib/openapi-observation.mjs        |   90 +-
 ...vior-doc-minimal-contract-build-v3-contract.mjs |  352 +-
 tools/docs/behavior-doc-minimal-contract-build.mjs | 1128 +++---
 tools/docs/behavior-doc-static-admission.mjs       |   70 +-
 tools/docs/doc-claim.mjs                           |  622 +--
 tools/run-test-matrix.mjs                          |  195 +-
 tools/test-fixtures/services/mysql.mjs             |  777 ++++
 tools/test-inventory/adapters.mjs                  |   22 +-
 tools/test-inventory/discovery.mjs                 |   55 +-
 tools/test-inventory/produce.mjs                   |   13 +-
 tools/test-inventory/xunit-projects.mjs            |  103 +
 .../test-inventory/xunit-roslyn-adapter/Program.cs |   35 +-
 .../XunitAdapterProjectContext.cs                  |   57 +-
 .../XunitAdapterReferenceResolution.cs             |   68 +-
 .../content-addressed-evidence-store.mjs           |   48 +-
 tools/test-matrix/execution-envelope-policy.mjs    |    9 +-
 tools/test-matrix/local-profile.mjs                |   42 +
 tools/test-matrix/mysql-fixture-recovery.mjs       |  140 +
 tools/test-matrix/production-build-layout.mjs      | 1231 +++++-
 tools/test-matrix/production-build-lifecycle.mjs   |   32 +-
 .../production-capacity-reservation.mjs            |  269 +-
 .../production-fresh-run-bound-outputs.mjs         |    3 +-
 .../production-resource-enforcement.mjs            |  694 +++-
 .../production-systemd-resource-boundary.mjs       | 1191 ++++++
 tools/test-matrix/scheduler.mjs                    | 1275 +++++-
 tools/test-retention/audit.mjs                     |   32 +-
 tools/test/backend-platform-selection.mjs          |   80 +-
 tools/test/build-migration-tests.mjs               |   88 +
 tools/test/bundles/run-bundle.mjs                  |   41 +
 .../check-backend-production-build-authority.mjs   |   22 +-
 tools/test/correctness-attempt-migration.mjs       |    4 +-
 tools/test/execution-envelope-network.mjs          |   17 +-
 tools/test/execution-envelope-services.mjs         |  310 +-
 .../test/generate-evidence-location-governance.mjs |   33 +
 tools/test/lanes/_suite-support.sh                 |   39 +-
 tools/test/lanes/static-governance.sh              |    6 +
 tools/test/migration-build-binding.mjs             |  269 ++
 tools/test/migration-execution-evidence.mjs        |  179 +
 tools/test/mysql-fixture-admission.mjs             |  223 ++
 tools/test/native/execution-envelope-landlock.c    |    6 +
 .../physical-execution-linux-systemd-adapter.mjs   |  713 +++-
 .../physical-execution-linux-systemd-bootstrap.mjs |   91 +
 tools/test/physical-execution-nested-channel.mjs   |  584 +++
 tools/test/physical-execution-nested-socket.py     |  140 +
 .../physical-execution-private-dotnet-scratch.mjs  |  177 +
 tools/test/physical-execution-process-tree.mjs     |  864 +++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++
 tools/test/process-identity.mjs                    |   21 +-
 tools/test/run-deterministic-command.mjs           |   15 +-
 tools/test/run-matrix-governance-once.sh           |    5 +
 tools/test/run-migration-tests.mjs                 |  511 +++
 tools/testing/content-shape-catalog.mjs            |  183 +-
 ...erate-test-execution-envelope-applicability.mjs |    9 +-
 158 files changed, 28759 insertions(+), 2733 deletions(-)
```


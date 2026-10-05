# WIP: codex/issue-2217-mysql-owned-issuer-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2217-mysql-owned-issuer-20261003`
- 原始 commit：`6658ab0c2434d4f9b1ca853378c5b5a27ccf0f6d`
- 原始 tree：`374b76ad0269c029207e9eca92d973d02769ac33`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2217, #3662, #2216, #1761
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
6658ab0c2 fix(governance): bind MySQL issuer naming to registered CSharp surfaces
Refs: #2217

66f7d2bb1 feat(database): verify MySQL current receipts through owned snapshots
Refs: #2217

429bb39b3 fix(governance): combine original held and stage value source seams
Transfer the reviewed original private scheduler terminal retention, pre-runtime v2 DATA and final pure value extraction into the current native governance candidate. Preserve original happy admission obligations as SOURCE_PENDING, actual source parsing and all native FAILED claims. Retain both disjoint protocol paragraphs and all original source controls.

Correct the earlier naming diagnosis by removing the erroneous root-document CSS declaration and restoring the original f66 manifest. The original matcher and all registry policy remain unchanged. No checker, candidate module, tests, SDK, native operation or producer was executed.

Refs: #3662

dcf264742 fix(governance): cover registered document naming paths
Append the existing css-like-contract exception for the two changed document paths. Preserve all previous manifest entries, governance and native source bytes and registry policy. Source-only metadata correction; current checker and all runtime qualification remain pending.

Refs: #3662

f66f076c0 fix(governance): combine frozen stage and native source interfaces
Combine the finite reviewed governance, pure stage, dual-producer join and release caller sources with the current native migration parent. Preserve all native providers, ownership boundaries, paired classification inputs and original image source. Resolve the sole document collision by retaining the parent body and the original fixture-only governance paragraph.

Source-only delivery. Registry held-material integration and actual admitted native proof remain unavailable; seven post claims remain CURRENT_FAILED. No tests, SDK, native operation or generator was executed for this candidate.

Refs: #3662

6d10d5e90 fix(build): combine native task packaging with current migration source
Transfer the original finite task packaging and classification catalogue owners without replacing current provider observations, native scopes, portable compiler or Server release APIs. Preserve current ownership documentation and bind the generated product to its original source inputs. Correct the two inherited Store callers to the existing owned read-scope API.

Source-only delivery; current SDK, locked restore, tests, image measurement, native capability factories and whole issue acceptance remain pending.

Refs: #3662

8d12da1fa fix(database): combine original provider scope and cleanup sources
Combine the reviewed writer scope with the complete original provider observer and portable current facts without replacing either authority. Restore the original read-only journal seam and controls, preserve both material identity cleanup implementations, and materialize the four original retained source resources only.

Refs: #2216 #2217 #1761

a42080f02 fix(database): combine original portable and owned-domain source
Combine exact original observer and native dependencies with the portable typed compiler without replacing its current key-case or partial bootstrap boundaries. Preserve original source authorities and keep locked dependency generation and native qualification pending.

Refs: #1761
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    3 +
 .../3662-post-native-routing-external-naming.json  |   30 +
 ...ortable-owned-source-union-external-naming.json |   69 +
 ...16-source-material-cleanup-external-naming.json |   15 +
 ...ue-2217-mysql-owned-issuer-external-naming.json |   13 +
 ...-2218-historical-fence-end-external-naming.json |   13 +
 ...issue-3662-core-once-union-external-naming.json |   64 +
 ...ue-3662-core-refusal-union-external-naming.json |   41 +
 .../issue-3662-final-refusal-external-naming.json  |   29 +
 ...-3662-final-value-contract-external-naming.json |   15 +
 ...62-governance-native-union-external-naming.json |   86 +
 ...eld-pre-final-source-union-external-naming.json |   29 +
 ...tive-complete-source-union-external-naming.json |   40 +
 ...ve-complete-source-union-generated-binding.json |   73 +
 ...sue-3662-post-runtime-join-external-naming.json |   19 +
 ...sue-3662-pre-parse-binding-external-naming.json |   19 +
 ...e-3662-pre-runtime-v2-data-external-naming.json |   20 +
 .../issue-3662-pure-stage-io-external-naming.json  |   18 +
 ...issue-3662-stage-admission-external-naming.json |   32 +
 config/build/backend-docker-inputs.json            |   33 +-
 config/contracts/behavior-contracts.json           |   33 +-
 config/contracts/behavior-fact-extractors.json     |    8 +-
 .../contracts/document-claim-migration-ledger.json |   11 +-
 ...havior-doc-static-admission-receipt.schema.json |   69 +-
 ...r-document-consistency-final-report.schema.json |   47 +-
 ...avior-evidence-post-runtime-receipt.schema.json |   41 +-
 ...havior-evidence-pre-runtime-receipt.schema.json |   34 +-
 .../post-runtime-observation-result.schema.json    |    7 +-
 .../schemas/runtime-role-observation.schema.json   |  222 ++-
 config/testing/post-runtime-producer-registry.json |  183 +-
 .../required-evidence-authority-ledger.json        |    4 +-
 .../monolithic-distributed-boundary.md             |   15 +
 docs/architecture/repository-layout.md             |   43 +-
 docs/database-migration.md                         |  464 ++++-
 docs/development/doc-claim-protocol.md             |   18 +
 docs/online-database-migration.md                  |   19 +
 docs/releases/blue-green-deployment-runbook.md     |   62 +-
 docs/testing.md                                    |    4 +
 ops/docker/FsusBlog.Server.Dockerfile              |   25 +
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../SchemaMigration/CurrentSchemaCanonicalModel.cs |  661 +------
 .../CurrentSchemaOwnedProjectionExporter.cs        |   97 ++
 .../CurrentSchemaOwnedTargetExportCommand.cs       |   47 +
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  192 +++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../CurrentSchemaRecipeFactExtractor.cs            |  292 ++++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   94 +-
 .../SchemaMigration/SchemaModelInspector.cs        |  663 +------
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    5 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |   17 +-
 src/backend/Program.cs                             |   35 +
 src/migration/ArticleMediaPreservation.cs          |  409 +++++
 .../ArticleMediaPreservationFileSystem.cs          |  409 +++++
 src/migration/ArticlePreservationPolicyExporter.cs |  161 ++
 src/migration/ArticlePreservationProducer.cs       |  341 ++++
 src/migration/ArticlePreservationProjection.cs     |  189 ++
 .../ArticlePreservationSemanticReceipt.cs          |   37 +
 src/migration/ArticlePreservationSourceReader.cs   |  288 ++++
 src/migration/ArticlePreservationStorageProgram.cs |  201 +++
 src/migration/ArticlePreservationStorageWriter.cs  |  446 +++++
 src/migration/ArticlePreservationWritePlan.cs      |   62 +
 src/migration/CurrentSchemaBootstrapCompiler.cs    |  308 ++++
 .../CurrentSchemaBootstrapRecipeCompiler.cs        |  184 ++
 src/migration/CurrentSchemaOwnedTargetProducer.cs  |  704 ++++++++
 .../CurrentSchemaPortableBootstrapCompiler.cs      |  235 +++
 src/migration/FsusBlog.Migration.csproj            |   12 +
 src/migration/MySqlCurrentSchemaCatalogObserver.cs |  249 +++
 .../MySqlCurrentSchemaPhysicalObserver.cs          |  199 +++
 src/migration/OfflineMigrationApplyContracts.cs    |  134 ++
 src/migration/OfflineMigrationApplyEvidence.cs     |  386 +++++
 .../OfflineMigrationApplyJournalDialect.cs         |  272 +++
 .../OfflineMigrationApplyJournalVerifier.cs        |  365 ++++
 .../OfflineMigrationApplyNativeSession.cs          |  619 +++++++
 src/migration/OfflineMigrationApplyProtocol.cs     |   94 +
 .../OfflineMigrationArticleMediaJournal.cs         |   80 +
 .../OfflineMigrationArticlePreservationRoute.cs    |  222 +++
 src/migration/OfflineMigrationArtifactPublisher.cs |   51 +
 src/migration/OfflineMigrationBackupAdmission.cs   |  485 ++++++
 .../OfflineMigrationCatalogEntries.generated.cs    |    6 +-
 .../OfflineMigrationClassificationFacts.cs         | 1811 ++++++++++++++++++++
 src/migration/OfflineMigrationCommandLine.cs       |  383 +++++
 .../OfflineMigrationCurrentSchemaArtifactReader.cs |  340 ++++
 .../OfflineMigrationCurrentSchemaIssuer.cs         |  690 ++++++++
 ...flineMigrationCurrentSchemaVerificationPorts.cs |   65 +
 src/migration/OfflineMigrationExecutor.cs          |  507 ++++++
 src/migration/OfflineMigrationHost.cs              |  566 +++++-
 .../OfflineMigrationHostOwnedConfiguration.cs      |  257 +++
 .../OfflineMigrationMySqlNativeSession.cs          |  408 +++++
 ...OfflineMigrationOwnedPlanningAuthorityReader.cs |   90 +
 src/migration/OfflineMigrationPlan.cs              |  564 ++++++
 src/migration/OfflineMigrationPlanContracts.cs     |  150 ++
 src/migration/OfflineMigrationPlanEvidence.cs      |  208 +++
 .../OfflineMigrationPostgreSqlNativeSession.cs     |  434 +++++
 .../OfflineMigrationRetainedEvidenceAuthority.cs   |  107 ++
 .../OfflineMigrationShellBackupDrillOwnedInputs.cs |  208 +++
 .../OfflineMigrationShellBackupDrillProducer.cs    |  557 ++++++
 .../OfflineMigrationSourceFingerprintException.cs  |  172 ++
 .../OfflineMigrationSourceFingerprints.cs          |  230 +++
 .../OfflineMigrationSourceObserver.Providers.cs    |  872 ++++++++++
 src/migration/OfflineMigrationSourceObserver.cs    |  598 +++++++
 .../OfflineMigrationSqliteDatabaseIdentity.cs      |  264 +++
 .../OfflineMigrationSqliteNativeSession.cs         |  301 ++++
 src/migration/OfflineMigrationStateStore.cs        |  240 +++
 src/migration/OfflineMigrationVerifyEvidence.cs    |  124 ++
 src/migration/OwnedRetainedMigrationTool.cs        |   87 +
 src/migration/PgArticlePreservationOperation.cs    |  653 +++++++
 src/migration/PgCurrentSchemaBootstrapOperation.cs |  272 +++
 .../PgCurrentSchemaOwnedTargetObserver.cs          |   57 +
 src/migration/PgLegacyCurrentSchemaPreparation.cs  |  127 ++
 src/migration/PgLegacyNonArticlePreparation.cs     |  582 +++++++
 src/migration/PgLegacyNonArticleRecovery.cs        |  274 +++
 .../SqliteArticlePreservationSourceReader.cs       |  132 ++
 .../SqliteCurrentSchemaCatalogObserver.cs          |  300 ++++
 .../SqliteCurrentSchemaOwnedTargetObserver.cs      |   73 +
 src/shared/Algorithms/ExactDecimalLiteral.cs       |   31 +
 .../Schema/PgCurrentSchemaCatalogObserver.cs       |  795 +++++++++
 .../Schema/PgCurrentSchemaControlShape.cs          |   79 +
 .../Schema/PgCurrentSchemaEffectObserver.cs        |  266 +++
 .../Schema/PgCurrentSchemaExpressionParser.cs      |  543 ++++++
 .../Schema/PgCurrentSchemaNativeObserver.cs        |  155 ++
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../Schema/CurrentSchemaBootstrapInput.cs          |   27 +
 .../Schema/CurrentSchemaCanonicalAuthority.cs      |  649 +++++++
 .../CurrentSchemaCompletePhysicalProjection.cs     |   20 +
 src/shared/Contracts/Schema/CurrentSchemaModel.cs  |  228 +++
 .../Schema/CurrentSchemaOwnedTargetArtifact.cs     |   62 +
 .../Contracts/Schema/CurrentSchemaRecipeFacts.cs   |  193 +++
 .../Contracts/Schema/SchemaExpressionModel.cs      |   31 +
 src/shared/Contracts/Schema/SchemaModelComparer.cs |  236 +++
 .../Schema/SchemaPhysicalTypeProjection.cs         |  111 ++
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++
 ...igrationOwnedWriterReadScopeIntegrationTests.cs |  227 +++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 .../Unit/ActiveReleaseFenceDurableWitnessTests.cs  |    5 +-
 .../backend/Unit/ActiveReleaseFencedCommitTests.cs |    7 +-
 .../ArticleDraftServerRevisionMigrationTests.cs    |    7 +-
 .../ArticleMutationIdempotencyMigrationTests.cs    |    7 +-
 .../Unit/ArticleMutationOutboxClaimLeaseTests.cs   |    7 +-
 .../Unit/ArticlePublicationMigrationTests.cs       |   11 +-
 .../Unit/ArticleRevisionRollbackMigrationTests.cs  |    8 +-
 .../CurrentSchemaOwnedProjectionExporterTests.cs   |  395 +++++
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  584 +++++++
 .../Unit/CurrentSchemaRuntimeRollupTablesTests.cs  |  366 ++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 +
 .../Unit/SchemaCompatibilityCoordinateTests.cs     |   66 +-
 tests/backend/Unit/SchemaMigrationRegistryTests.cs |   19 +-
 .../Unit/SchemaModelComparerExtraLinksTests.cs     |    1 +
 .../SchemaModelComparerRequiredExtraTablesTests.cs |    1 +
 tests/backend/Unit/SchemaModelInspectorTests.cs    |   41 +-
 tests/coverage-registry.json                       |   25 +
 .../CurrentSchemaBootstrapCompilerTests.cs         |  221 +++
 .../CurrentSchemaPortableBootstrapCompilerTests.cs |  294 ++++
 .../CurrentSchemaStorageProjectionTests.cs         |  400 +++++
 .../migration/OfflineMigrationApplyJournalTests.cs | 1473 ++++++++++++++++
 .../migration/OfflineMigrationCommandLineTests.cs  |   43 +
 ...flineMigrationCurrentSchemaArtifactOpenTests.cs |  161 ++
 .../OfflineMigrationCurrentSchemaIssuerTests.cs    |  716 ++++++++
 ...fflineMigrationMySqlCurrentSchemaIssuerTests.cs |  109 ++
 .../OfflineMigrationOwnedWriterReadScopeTests.cs   |   97 ++
 tests/migration/OfflineMigrationPlanTests.cs       |  384 +++++
 .../OfflineMigrationSourceCommandLineTests.cs      |  351 ++++
 .../OfflineMigrationSourceMaterialCleanupTests.cs  |  212 +++
 .../PgCurrentSchemaBootstrapOperationTests.cs      |   64 +
 .../PgCurrentSchemaCatalogObserverTests.cs         |   44 +
 .../PgCurrentSchemaEffectObserverTests.cs          |   77 +
 .../PgCurrentSchemaExpressionParserTests.cs        |  162 ++
 .../PgCurrentSchemaOwnedTargetObserverTests.cs     |  243 +++
 .../SqliteCurrentSchemaOwnedTargetObserverTests.cs |  271 +++
 .../tools/application-runtime-observation.test.mjs |   13 +-
 tests/tools/backend-docker-input-closure.test.mjs  |  187 +-
 tests/tools/behavior-doc-static-admission.test.mjs |  226 ++-
 .../behavior-document-consistency-final.test.mjs   |  373 +++-
 .../tools/behavior-evidence-post-runtime.test.mjs  |  171 +-
 tests/tools/behavior-evidence-pre-runtime.test.mjs |  156 +-
 tests/tools/canonical-release-authorities.test.mjs |  570 +++++-
 ...t-run-evidence-locator-negative-matrix.test.mjs |    4 +-
 .../tools/current-run-evidence-scheduler.test.mjs  |  305 ++++
 tests/tools/current-schema-authority.test.mjs      |   51 +-
 tests/tools/final-image-toolchain-pin.test.mjs     |   18 +
 .../offline-migration-catalog-parity.test.mjs      |    2 +-
 .../tools/post-runtime-producer-registry.test.mjs  |   97 +-
 tests/tools/production-build-artifacts.test.mjs    |   62 +-
 .../tools/release-deployment-observation.test.mjs  |   38 +
 .../release-final-current-run-locator.test.mjs     |    4 +-
 .../release-final-post-runtime-replay.test.mjs     |  105 ++
 tests/tools/release-rollout-evidence.test.mjs      |  227 ++-
 .../tools/runtime-role-contract-boundary.test.mjs  |   95 +-
 .../runtime-role-minimal-v3-contract.test.mjs      |   69 +-
 .../support/behavior-doc-admission-fixture.mjs     |   13 +-
 .../behavior-evidence-pre-runtime-fixture.mjs      |   48 +-
 .../support/post-runtime-candidate-fixture.mjs     |   10 +-
 .../support/pure-release-authority-fixture.mjs     |  111 +-
 .../support/release-authority-test-fixtures.mjs    |    3 +
 .../support/runtime-role-minimal-v3-fixture.mjs    |  142 +-
 tests/tools/test-evidence-receipt-schema.test.mjs  |   31 +-
 tools/build-final-image.sh                         |   45 +-
 tools/ci/migration-retained-inputs.mjs             |  168 ++
 tools/ci/production-build-artifacts.mjs            |   64 +
 .../FsusBlog.RuntimeRoleObservation/Models.cs      |   34 +-
 .../FsusBlog.RuntimeRoleObservation/Program.cs     |  414 ++---
 tools/db/check-current-schema-authority.mjs        |   51 +-
 .../db/check-offline-migration-catalog-parity.mjs  |    4 +-
 tools/db/generate-offline-migration-catalog.mjs    |   19 +-
 ...release-rollout-auxiliary-evidence-contract.mjs |   52 +-
 tools/docker/backend-input-closure.mjs             |  168 +-
 tools/docker/backend-input-environment.mjs         |    7 +-
 ...vior-doc-minimal-contract-build-v3-contract.mjs |   71 +-
 tools/docs/behavior-doc-minimal-contract-build.mjs |   12 +-
 .../behavior-doc-static-admission-contract.mjs     |  244 ++-
 tools/docs/behavior-doc-static-admission.mjs       |   54 +-
 ...r-document-consistency-final-value-contract.mjs |  198 +++
 tools/docs/behavior-document-consistency-final.mjs |  266 ++-
 tools/fact-extractors/post-runtime/candidate.mjs   |   15 +-
 tools/fact-extractors/post-runtime/common.mjs      |   31 +-
 .../post-runtime/evidence-context.mjs              |    4 +-
 tools/fact-extractors/post-runtime/observation.mjs |   15 +-
 tools/fact-extractors/test-matrix/extract.mjs      |   75 +-
 tools/release/check-release-final.mjs              |   45 +-
 tools/release/release-final-domain-evidence.mjs    |   28 +-
 tools/release/release-manifest-value-contract.mjs  |  217 ++-
 tools/release/test-evidence-receipts.mjs           |    4 +-
 tools/test-evidence/blue-green-containment-raw.mjs |   38 +-
 ...anonical-release-authorities-value-contract.mjs |   75 +-
 .../canonical-release-authorities.mjs              |   35 +-
 .../release-authority-bundle-contract.mjs          |  112 +-
 .../release-authority-facts-contract.mjs           |  109 +-
 tools/test-evidence/release-readiness-raw.mjs      |   39 +-
 .../release-readiness-source-support.mjs           |    2 +-
 .../behavior-doc-static-admission-contract.mjs     |    2 +-
 .../test-matrix/behavior-evidence-post-runtime.mjs |  291 +++-
 .../test-matrix/behavior-evidence-pre-runtime.mjs  |  122 +-
 .../test-matrix/post-runtime-producer-registry.mjs |  100 +-
 .../test-matrix/produce-behavior-test-evidence.mjs |    2 +-
 tools/test-matrix/required-evidence-catalog.mjs    |    4 +-
 tools/test-matrix/scheduler.mjs                    |  255 ++-
 .../test-matrix/verify-behavior-test-evidence.mjs  |    2 +-
 237 files changed, 39144 insertions(+), 2467 deletions(-)
```


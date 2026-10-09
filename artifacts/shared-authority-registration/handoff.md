# Canonical authority registration: current source handoff

Related to #3735, #3736, #3738, #2237 and #2324. All remain open. This is ordinary source integration evidence, not schema, runtime or product qualification.

## Published source

Branch: `codex/shared-coordinate-registration-20261009`. Fresh master base: `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`. Minimal root integration commit: `cb53ddb3db115118a168737c4e7f0e59aa42766b`, touching only `RuntimeDomainServiceCollectionExtensions.cs` and the existing `AuthoringCanvasServiceRegistrationTests.cs`.

Exactly supplied producer commits were consumed without conflicts, preserving all sixteen producer files byte-for-byte:

- Coordinate: `5c827c1cf0cd209007b301bac9967fa403066114`, base a281, six files, Draft PR4117. The first source was `fcc0d88555ab40f1563845e4d84d8880a744f2de`.
- Generation/sequence: published `83e1f302b13e0ab3d37d47746365cd57c3ff9174`, tested source `a02f154356858d6199808cdbf8b5a362e44494fd`, seven new files relative to supplied b304 prerequisite. Only the exact new-file delta was consumed; the older entire b304 branch was not imported. The last 83e1 metadata commit has no additional tree delta and was skipped as empty on this branch; byte equality to its seven files was verified.
- Property dependency: `a8e59a12702dc5101927fbcc66d83967984ed597`, base a281, three new files. Compilation/style reports and failed audit/resource preflight remain producer reports; no test pass is invented.

This branch has eighteen changed source/test paths against c04: sixteen supplied files plus the two root-owned integration files. Exact paths, source SHA-256 and supplied commit bindings are in `run-evidence.json`. Frozen Canvas/registry/transport/consumer branches remain unchanged.

## Actual integration

Register one scoped `ArticleRelationSourceCoordinateAuthority` through the existing domain-service owner. Its read/lookup APIs remain zero-write internal coordinate capabilities; DI does not grant permission or provision legacy rows.

Register one `ArticlePropertySavedViewDependencyProvider` in the existing `IAuthorSavedViewDependencyProvider` collection alongside the original category/tag provider. Retain the canonical definition store, dependency catalog and query validator. No second definition store, catalog or provider adapter is introduced. Existing `DuplicateAuthority` aggregation and refusal remain untouched. The supplied property provider reports authorized current metadata projection only; flags and typed operators never establish filter/sort/index readiness.

Extend the original production registration test to resolve that sole coordinate authority, the original definition store and one property provider, then use the real dependency catalog to require `PermissionRevoked` with no request context. This is a prepared unit assertion, not a passed runtime result: the strict original test build failed before test execution.

`ArticleSourceGenerationAuthority` is a static API, so no DI registration or wrapper is added.

## Current commands and outcomes

All commands used .NET SDK10.0.401 and the original `tools/build-with-data-env.sh`; task data/cache paths are recorded. No NuGet audit override, analyzer disable, alternate host or looser rebuild was used.

- `dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode -v minimal`: exit0, with two retained NU1903 warnings for `SQLitePCLRaw.lib.e_sqlite3 2.1.11`, GHSA-2m69-gcr7-jv3q, in Migration and backend testhost.
- `dotnet build tests/backend/FsusBlog.Server.Tests.csproj --no-restore -warnaserror -v minimal`: exit1, summary **1512 errors**. Original project binaries were emitted, but that is not a successful strict build and they were not used to bypass the failure.
- The parsed source diagnostics contain 1488 distinct entries: 1486 on unchanged master/shared baseline paths and two on supplied property unit source. Project-level NU1903 errors are retained separately and raw output is authoritative; parsed counts are not substituted for the build summary. No diagnostic names either root integration file.
- `dotnet format whitespace tests/backend/FsusBlog.Server.Tests.csproj --no-restore --verify-no-changes --include src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs tests/backend/Unit/AuthoringCanvasServiceRegistrationTests.cs --verbosity quiet`: exit0, exactly the two root files.
- Source `git diff --check c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f cb53ddb3db115118a168737c4e7f0e59aa42766b`: exit0.

The source preflight identified nineteen nonempty exact positive unit names: six coordinate authority, one unregistered-definition, one original registration and eleven property cases. Every selected body/helper and its temporal ingress was reviewed; there are no selected collection fixtures/lifecycle hooks or DB/browser/network/native resource requirements. Original executable discovery and all nineteen test bodies are **UNRUN/BLOCKED** after the strict build failure. No held test body ran. All PostgreSQL/HTTP/browser/UX/full frontend/CI/native schema/qualification work is unrun in this root. Producer reports (coordinate7+13 and generation56 including33PG) retain their original source binding and are not rerun/rebound here.

## Exact owner repairs requested

1. **3568 shared dependency owner:** preserve and repair the two NU1903 diagnostics through the original shared package/lock owner. Do not set `NuGetAudit=false`, change warning severity or privately replace the locked package. The advisory is https://github.com/advisories/GHSA-2m69-gcr7-jv3q.
2. **Property worker, three exclusive files:** its unit file has CS8620 at157 (async NSubstitute return infers nonnullable `Task<ArticlePropertyDefinition>` against nullable `Task<ArticlePropertyDefinition?>`) and IDE1006 at16 (`Owner` is a static field lacking `s_`). Have the original worker repair that nullable return and rename/update its shared test-field references; this root does not edit the child files.
3. **3657 resource-classification owner:** supply the original admission/classification for `FsusBlog.Server.Tests.Integration.ArticlePropertySavedViewDependencyProviderIntegrationTests`. The source already uses existing `SchemaMigrationPostgresCollectionA`; the producer reported an unregistered PG-class preflight. No new shard, class mapping or fixture policy is guessed here. The four PG facts remain unrun.
4. **Existing strict baseline owners:** the unchanged project reports existing IDE0055/IDE1006, nullability, platform, member-shadowing and unawaited-call errors under the original strict command. Full diagnostics and raw source paths are published; this root does not reformat or repair other chains' source. Clearing only the new property warnings or audit cannot be presented as clearing the full strict build.

The coordinating parent subsequently supplied a concrete audit handoff: original3568 matched a8e59a inputs to the Migration project/lock from `4a2124d449f45e0cf653a76f0c01adcdca6109de` and backend test lock from `e4ac73dad845c71cc0f12027e3fc65ed0d5923cb`. The original property worker is consuming this minimal closure with fresh audited restores; original3657 owns the precise CollectionA manifest entry. This root did not independently import those fixes. Await the provider's resulting exact SHA/evidence; current failures remain bound to cb53ddb3.

WritingAid persistence already exists in parent-supplied `781309e02b9dfed74de1b8ce147346d30a6d563a`. Earlier absence findings were limited to the checked branches. No second store is created; current wiring awaits original2286/group1's exact current version.

## Sole original writer: 3654

This root did not edit revision/create/lifecycle/outbox/Vault writer files. `ArticleRevisionPersistence.cs` is byte-exact current base, blob/preimage `a21abf8359512862dac05f620944edca56c0d709`. The coordinating parent has reserved the exact shared revision hook to original3654; do not implement it concurrently here.

- After a successful `INSERT RETURNING`, capture actual `ArticleRevisionWriteResult`; dispose the RETURNING reader; then call `ProvisionRevisionAsync(db, articleId, result.Id, cancellationToken)` on the same original native connection/transaction before return/outer commit. Preserve retry, fence, commit and rollback ownership.
- A real import with an authorized contract-supplied portable article identity must call `ProvisionImportedArticleAsync(db, actualInsertedArticleId, suppliedIdentity, cancellationToken)` after the article insert and before the first shared revision hook. The current create Request does not carry that value; no new import contract or guessed identity was invented here. Existing exact imported revisions can use `ProvisionImportedRevisionAsync`.
- For no-new-revision transitions, read the selected exact revision binding with `ReadRevisionAsync` and refuse absent/mismatched bindings. Current/published views of the same revision reuse its persisted identities. No draft/editor-runtime epoch is substituted.
- Generation enrollment must acquire `AcquireMutationLockAsync(db, cancellationToken)` on the actual live ReadCommitted transaction **before any article/advisory lock or article write**. Merely calling it in the later outbox helper is too late. The same SqlSugar client/native transaction must then call `RecordMutationAsync(db, actualInsertedOutbox.EventId, cancellationToken)` after actual event insertion and before commit.
- Original outbox insertion surfaces inspected: `ArticleCreateMutationAuthority.cs`, `ArticleLifecycleTransitionWriter.cs`, `ArticleService.Mutations.cs`; outer transaction surfaces include `ArticleService.cs`, lifecycle/read-model paths and Vault group transaction/writer. One shared revision hook does not by itself cover every source-generation lock/enrollment obligation. Parent assigns those existing hunks to the one original writer; none were implemented here.

Do not replace source-generation counters with coordinate GUIDs, MAX IDs/xmin, timestamps, async delivery order or index generation. Source counters alone do not prove an accepted relation-index baseline.

## Current schema/product registration boundary

The new coordinate entities are auto-discovered by the actual `SchemaModelInspector.GetManagedEntityTypes` and the original `CurrentSchemaEntityExtractor`. Source inspection shows that the SQL definition's three UUID CHECKs, its composite revision-owner FK and other FK links are absent from the supplied entity attributes; the matching `(article_id,id)` unique index is absent from the original `ArticleRevision` entity in `src/backend/Entities/Article.cs`. Current target facts therefore do not yet represent that complete native integrity contract. This is a source gap, not a native-runtime receipt that can be assumed passed.

Current `CurrentSchemaConstraintAttribute` exposes name/kind/columns/reference/expression, while the fuller neutral model contains FK action/schema facts. The real schema owner must supply the required complete current source/recipe registration for these constraints, the unique target and immutable trigger/function effects; no absent action/target capability is silently invented. The module's raw SQL definition remains unregistered, and its original definition test explicitly requires that state. Its sole owner must update that stage-specific assertion when real registration lands.

The documented old Server `OnlineSchemaMigrationCatalog.cs` does not exist in this current source. `SchemaMigrationManifest`/`OfflineMigrationClassificationFacts` and their generated register belong to retained historical custody; the current docs require actual current-source ownership and explicit metadata/validators. This root has not fabricated safety classification, appended a historical row as current readiness, regenerated/resealed a frozen product or executed runtime DDL. Supply the exact current recipe/source API and owner commit before the retained registration/product step can be completed. This boundary remains open; no production migration/backfill or destructive test is authorized or run.

## Acceptance status

#3735: source WIP and current DI increment published; full session/wire/storage/HTTP/CI acceptance remains open. #3736: source WIP published; actual complete composition/types/rendered UX remains open. #3738: source WIP published; original transaction integration and end-to-end acceptance remain open. The expanded Shared assignment remains incomplete; no issue has been accepted by this root's latest source increment. Frozen branch gates, independent verification and the global no-merge phase barrier remain in force.

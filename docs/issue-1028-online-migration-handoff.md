# Issue #1028 integration handoff

The #1028 implementation is integrated with the completed #1027 deployment
lifecycle boundary. Shared readiness code was extended with a minimal patch that
preserves the existing release-storage checks.

## Landed ownership

- `src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationMetadata.cs`
- `src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCompatibility.cs`
- `src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationCoordinator.cs`
- `src/backend/Infrastructure/SchemaMigration/PostgresOnlineSchemaMigrationStateStore.cs`
- `src/backend/Infrastructure/SchemaMigration/AccountSubjectHashBackfillStep.cs`
- `src/backend/Infrastructure/Operations/ProductionHealth.cs`
- `src/backend/Program.cs`
- `tools/db/run-online-migrations.sh`
- `tests/backend/Unit/OnlineSchemaMigrationPolicyTests.cs`
- `tests/backend/Unit/OnlineSchemaMigrationCompatibilityTests.cs`
- `tests/backend/Unit/OnlineSchemaMigrationCoordinatorTests.cs`
- `tests/backend/Integration/AccountSubjectHashMigrationIntegrationTests.cs`
- `tests/backend/Unit/ProductionHealthTests.cs`
- `tests/tools/online-schema-migration-wrapper.test.mjs`
- `tests/backend/online-schema-migration-evidence.json`

## Completed cross-owner integration

1. `ProductionHealth.cs` now reads `OnlineSchemaCompatibilityRuntimeState.Current`.
   A non-ready or missing production report blocks deployment readiness; public
   output adds only `code=schema_incompatible`, while protected detail retains the
   stable issue list and exact release/schema identity.
2. `ServeSchemaCompatibilityRunner` publishes the read-only result and leaves an
   incompatible candidate live for protected diagnostics. It never executes a
   descriptor; readiness remains 503 and the deployment runtime cannot become Ready.
3. `LifecycleHostedBootstrapService.cs` reports the task detail as
   `compatibility_check`, not `non_compensable`.
4. `RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs` needs no edit
   for behavior because `Program.cs` adds the control plane after normal services and
   production registers the read-only runner last.
5. The catalog now explicitly classifies all concurrently added descriptors:
   recovery-passkey and account-subject column work are Expand; account-subject data
   projection is a bounded Backfill with `last_account_id` resume state. The matching
   scoped handler shares the canonical C# hasher, persists coordinator progress and
   validates the format constraint before completion.
6. Protocol/runbook links are present in the central database, production,
   operations and architecture documents.

## Central governance status

The online-schema coverage id, matrix tiers, backend requirements and static Node
owner are already registered. `AccountSubjectHashMigrationIntegrationTests.cs` and
the schema-specific `ProductionHealthTests.cs` methods are already included in the
coverage registry, relevant matrix tiers and backend requirements; no central
evidence append remains pending.

## Validation status

Per the active issue-landing instruction, no test, build, lint, restore, syntax,
profile, or runtime validation was executed while these files were authored. The
later unified validation phase owns compilation, focused tests, PostgreSQL behavior,
wrapper syntax, governance registration, and production fresh-run evidence.

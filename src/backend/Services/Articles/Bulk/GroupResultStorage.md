# Bulk original result storage source

`PostgresArticleBulkGroupResultStore` is dedicated persistence for the existing Bulk
request/plan/frozen-set/actor/policy identity. It is not a command, transaction
reservation, permission authority, result verifier or zero-write producer.

## Original transaction and reports

Writes require the caller's exact active `NpgsqlTransaction` to be the current
original SqlSugar transaction on the same native connection. The store never
begins, commits, rolls back, opens/closes connections or consumes a different
writer transaction. `StageOriginalReportedResultAsync` writes one original report
and verifies same-transaction original outbox/audit coordinates where commands
exist. It returns no business outcome, commit acknowledgement or zero-write proof.

`CaptureBinding` consumes original `ArticleBulkExecutionRequest` and sealed
`ArticleBulkPlan` plus the original producer's GroupIdempotencyKey; it preserves
that key, rather than inventing a key algorithm or importing another owner's
AtomicCommand wrapper. The full execution/plan/frozen items/request/registry/actor/
site/authority/policy/source coordinates are bound by original `ArticleBulkDigest`.
No Vault identity, bundle, table, result or receipt is cloned.

All persisted opaque strings, including frozen member identities, nullable revision/
lifecycle fields and item/side-effect/command/recovery strings, must contain lossless
Unicode scalars before capture hashing, validation hashing and SQL staging. Unpaired
UTF-16 surrogates are rejected, never normalized or replaced with U+FFFD. Valid
surrogate pairs and nullable fields are preserved. Ordinary negative-control source
is in ArticleBulkGroupResultUnicodeTests.cs; those tests remain UNRUN under the
current runtime/test execution hold.

The result row is insert-only through this store. Identical replay preserves the
original row; another payload for the same identity fails. Recovery observations
append under an original-row lock with ordinal/previous-digest CAS and immutable
observation IDs. They never overwrite an original UnknownRecovery report. SQL
constraints and canonical payload validation bind all metadata/digests. They do
not protect against a privileged actor rewriting and resealing the database; the
original independent authority/verifier is still required.

Read methods consume an already-open independent original PostgreSQL scope with
no ambient transaction; they return stored data and at most64 streamed recovery
rows, not an atomic business verdict. Missing data is never evidence of zero
writes. Raw owner-reported outcome/proof/side-effect fields are preserved; storing
or hashing those fields does not verify them. Original signatures, live actor/site/
permissions, whole-set locks, commit/rollback observations, and cache/publication/
search completion must still be validated by their real original producers.

## Migration source and held registration

Only `src/migration/Definitions/ArticleBulkLifecycleResultMigrationDefinitions.cs`
is added, using the existing descriptor/RawSqlStep pattern. It defines
`article_bulk_group_result` and `article_bulk_group_recovery_observation`; there
is no update/delete, Vault link, transaction application or backfill. The source
is unregistered and online-unclassified. PostCodeFirst is execution ordering,
not an online Expand classification. Manifest/catalog/online metadata, current
physical schema/runtime rollups and every frozen generated/qualification output
remain unchanged and HOLD. No DI/default production availability is enabled.

## Required concrete producer integration

The original group owner must provide an admitted original transaction, actual
writer results and exact persisted result data, then independently observe its
commit/abort/unknown outcome and required postcommit obligations. This storage
component cannot repair missing admission by recording a claimed receipt.

- Original draft owner: caller-transaction locked whole-set draft observation
  and revision/rights/dirty-source revalidation, then real original CAS sync in
  AuthoringUseCasePorts.cs/AuthoringDraftLifecycleService.cs. GetDraftAsync has
  no such lock; independent Save/Discard transactions cannot substitute.
- Original Document/Write owner: genuine server document revision/lock
  admission. Frontend registry and Canvas's separate document transaction do
  not grant this capability. No missing API is invented here.
- Original lifecycle admission: current actor/session/site and operation
  permissions for the exact frozen set. Recent-history permission rejects
  archived and is not Restore admission.
- Original result verifier: exact immutable original outcome and recovery
  binding, true rollback observations for zero-write, signed audit/outbox and
  all cache/publication/search obligations. Outbox storage is not completion.

Current source compilation/style cannot replace original database, interruption/
retry/unknown/negative-control/independent verification or full product acceptance.
All database connection/application, runtime/tests/discovery/import/security/privacy
and frozen qualification workloads remain HOLD.

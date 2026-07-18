# Online Database Migration Protocol

FsusBlog production schema changes follow one irreversible ordering:

`Expand -> deploy compatible code -> Backfill -> observe -> Contract`

The production web process is not a migration control plane. `FsusBlog.Server serve`
registers `ServeSchemaCompatibilityRunner` last for `ISchemaMigrationRunner`, so the
existing lifecycle hook becomes a read-only compatibility check. Only an explicit
`migrate` command may acquire the PostgreSQL advisory lock, create control tables,
or execute a descriptor.

The production release control plane has one entry:
`tools/deployment/release-rollout.sh`. It runs an explicit Expand as stage 4 and
hash-binds the result to the rollout state before the candidate starts. Backfill is
resumed explicitly from its durable token. Contract is outside the 15-stage rollout
and can run only after a completed normal release plus its observation/retention and
backup evidence; it must never be inferred from startup or candidate readiness.

## Metadata contract

Every `ISchemaMigrationDescriptor` must have one explicit
`OnlineSchemaMigrationMetadata` entry. The catalog never infers safety from a
migration id, SQL name, or `pre`/`post` wording. Required fields are:

- `Phase`: `Expand`, `Backfill`, or `Contract`.
- `Compatibility`: minimum and maximum release ids that can use the resulting
  schema. Release ids in these ranges use the immutable, ordinally sortable
  timestamp-plus-commit format from the release manifest contract.
- `RequiresExclusiveMode` and `Destructive`.
- `RollbackMode`: compatible code, resume from checkpoint, or backup/restore.
- `EstimatedLockRisk`.
- bounded `BatchSize` and durable `ResumeTokenName` for Backfill.
- `IntroducedAtRelease`, `ContractAfterRelease`, and a minimum observation window.
- named validators/evidence producers.

`OnlineSchemaMigrationPolicy` rejects duplicate/orphaned metadata, missing
classification, invalid compatibility ranges, unsafe Expand work, non-resumable
Backfill work, and Contract work without its release/retention/rollback gates. Drop,
rename, type/tightening, truncate, delete, and other rewrite-shaped SQL is accepted
only as an explicitly destructive Contract.

## Existing migration baseline

All descriptors that existed before this protocol are explicitly enumerated in
`OnlineSchemaMigrationCatalog`. The previous migration runbook classified their
rollback as non-compensable, and many descriptors mix additive, backfill, CodeFirst,
and destructive work. They are therefore classified as:

| property | legacy value |
| --- | --- |
| phase | `Contract` |
| destructive | `true` |
| exclusive mode | `true` |
| rollback | `BackupRestore` |
| online execution | `LegacyBootstrapOnly = true` |
| retention window | 30 days |

This does not authorize the online Contract command to replay them. A pending legacy
descriptor returns `schema_legacy_bootstrap_required`. Provision a fresh database or
upgrade a pre-protocol database from an isolated restore using the historical cold
bootstrap procedure, verify all history checksums, then enter the online protocol.
Production `serve` never guesses this baseline and never runs it.

The concurrently introduced
`20260711-post-recovery-passkey-completion-idempotency` descriptor is not placed in
that legacy bucket: it contains only nullable columns and an additive unique index,
so its explicit metadata is `Expand`, compatible-code rollback, low lock risk, and
online execution enabled. It demonstrates the required classification for new
descriptors without changing the dirty shared registry file.

## Phase rules

### Expand

Expand is additive and N/N-1 compatible. Allowed examples are nullable columns,
new tables, concurrently safe indexes, and new enum values only after old readers
have an unknown-value path. It must not drop, rename, tighten nullability, change
type semantics, rewrite a full table, require exclusive mode, or require
backup/restore rollback.

Structural replacement uses a new structure beside the old one. The compatible
release dual-writes, reads the new value with an old-value fallback, and keeps the
old write path available for rollback until Backfill and observation finish.

### Backfill

Backfill is not part of cold-start readiness. Each Backfill descriptor has a matching
`IOnlineSchemaBackfillHandler`. The coordinator:

1. loads the durable resume token from `__fsus_schema_backfill_progress`;
2. executes at most the configured number of small batches;
3. persists token, processed count, failure count, status, and update time after
   every batch;
4. applies the configured inter-batch delay for a 2-core/2-GB single-slot maintenance target;
5. pauses with `schema_backfill_resume_required` when its run budget is exhausted;
6. records migration completion only after the handler's consistency verifier passes.

A batch that changes neither row count nor resume token fails with
`schema_backfill_no_progress`. A failed verifier produces
`schema_backfill_verification_failed`. Re-running `--phase backfill-resume --id ...`
continues from the last durable token, so interruption, cancellation, or release
replacement does not restart the scan.

That low-resource pacing does not authorize dual-slot deployment. Certified
zero-downtime overlap still requires 4 CPU cores, 6144 MiB memory and 10240 MiB free
disk plus passing overlap/resource evidence; a 2C/2G host remains single-slot.

### Contract

Contract is never selected by startup and never auto-selected by a candidate. Before
any pending Contract descriptor executes, all of these gates must pass together:

- current and previous rollback releases are both newer than
  `ContractAfterRelease` and neither depends on the old structure;
- Backfill is complete and consistency-verified;
- the metadata observation/retention window has elapsed;
- backup and restore-drill evidence is within the configured freshness window;
- no blue/green activation or rollback switch is in progress;
- old-shape writes are disabled;
- the release manifest is sealed against rollback to an old-structure release;
- exclusive mode is active when required;
- destructive execution has a separate explicit confirmation.

After destructive Contract execution, image-only rollback is no longer a recovery
mechanism: removed data or columns cannot be reconstructed by restarting N-1. Keep
the affected write path isolated, restore the verified backup into an isolated
database, and only then pair it with a compatible retained image. Before execution,
stopping the explicit Contract command and retaining the N/N-1 bridge requires no
web-process restart.

The Contract evidence schema is documented in
[Online migration operations](online-database-migration-operations.md).

## Schema history and readiness

Mutating commands share the existing PostgreSQL advisory lock. This serializes
schema writers across candidate releases. The online control plane uses:

- `__fsus_schema_migration_history` for id/checksum/release/success history;
- `__fsus_schema_online_state` for the current schema release marker;
- `__fsus_schema_backfill_progress` for resumable progress and verification time.

Production serve reads these tables without creating or altering them. It fails
closed for a missing history/marker, duplicate or unknown ids, failed entries,
checksum mismatch, schema release outside the immutable release manifest range,
required pending Expand, failed/incompatible Backfill, pending legacy bootstrap, or
an applied Contract incompatible with N/N-1.

Public readiness exposes only `schema_incompatible`; protected diagnostics use the
stable codes below through `OnlineSchemaCompatibilityRuntimeState`:

| condition | protected code |
| --- | --- |
| history absent | `schema_history_missing` |
| duplicate/unknown history | `schema_history_duplicate`, `schema_history_unknown` |
| checksum mismatch | `schema_history_checksum_mismatch` |
| release range mismatch | `schema_release_outside_manifest` |
| required Expand pending | `schema_expand_pending` |
| allowed Backfill pending | `schema_backfill_pending` warning |
| failed/incompatible Backfill | `schema_backfill_failed`, `schema_backfill_incompatible` |
| incompatible applied Contract | `schema_contract_incompatible` |
| pre-protocol migration pending | `schema_legacy_bootstrap_pending` |

## Compatibility matrix

| database state | current release | previous rollback release | serve | action |
| --- | --- | --- | --- | --- |
| required Expand complete | inside range | inside range | ready | deploy compatible code |
| required Expand pending | any | any | not ready | run explicit Expand |
| Backfill pending, bridge healthy | inside range | inside range | ready with warning | resume Backfill |
| Backfill failed | any | any | not ready | repair handler and resume |
| Contract applied | inside range | inside range | ready | continue observation |
| Contract applied | inside range | outside range | not ready | use compatible image; never switch |
| unknown/checksum-mismatched history | any | any | not ready | investigate; do not rewrite history |
| pending legacy descriptor | any | any | not ready | isolated legacy bootstrap/restore |

## Destructive-change checklist

- [ ] Dedicated Contract descriptor; no mixed Expand/Backfill steps.
- [ ] `Destructive = true`, `RollbackMode = BackupRestore`.
- [ ] `IntroducedAtRelease`, `ContractAfterRelease`, and retention window recorded.
- [ ] N and N-1 no longer read or write the old shape.
- [ ] Backfill progress is complete and validator evidence is green.
- [ ] Observation window elapsed with no bridge inconsistencies.
- [ ] Fresh backup was restored and verified in isolation.
- [ ] Deployment state proves no slot switch is in progress.
- [ ] Release manifest forbids rollback to an old-structure release.
- [ ] Old writes disabled; required exclusive mode enabled.
- [ ] Operator supplied `--confirm-destructive` separately from the evidence file.

# Online Database Migration Protocol

## Current runtime and release boundary

The production web process is not a migration control plane. Its sole command
parser rejects `migrate` and the old phase, release-selection, evidence and
confirmation options before host construction. The old Server coordinator,
command host, control-plane registration and PostgreSQL writable state store are
removed rather than retained as compatibility wrappers.

`FsusBlog.Server serve` registers `CurrentSchemaStartupVerifier` through the
runtime lifecycle. Admission consumes the explicit current receipt path, whole
artifact SHA-256 and candidate source revision, then performs the current native
observation. Missing or mismatched inputs fail closed; a historical catalogue,
old compatibility report, release window or pending-Backfill warning is not
readiness authority. The explicit `current-schema-check` command uses the same
read-only verifier without publishing startup admission.

`tools/deployment/release-rollout.sh` consumes the v3 current-only release manifest
and explicit receipt binding. Its current-schema-admission stage does not invoke
offline plan, apply or verify. Those operations belong only to the offline
migration executable and its sealed inputs. A release does not acquire that
authority by parsing command arguments or constructing synthetic test metadata.

After activation, recovery requires a verified matching backup/database pair or
a forward repair; selecting an older image against a changed database is not
rollback. Pre-activation abandonment must retain the source binding and owned
resource cleanup obligations.

The sole historical classification source is now
`src/migration/OfflineMigrationClassificationFacts.cs`. It retains every explicit
descriptor classification, batch/resume setting, validator, rollback/lock-risk
value and historical fence; its validator checks recorded data only. Min/max are
historical scalars, not a Serve compatibility window. No runtime evaluator,
Ready/warning API, previous-release selector or deployment identity parser moves
into Migration. Recorded release values in tests are first validated by the
existing Server `ReleaseId` owner, not reinterpreted by the historical facts API.

The original `generate-offline-migration-catalog.mjs` producer derives the same
four-field table from that single source. Its source-digest binding and the parity
checker remain exact: source custody changes require actual regeneration, never a
hand-edited product or an accepted stale digest. The generator source migration
does not itself establish that regeneration has run. Historical compatibility and
Contract/manifest test identities retain their recorded inputs as current receipt
refusal controls, not as online Ready assertions. Source changes and component
fixtures do not establish native observations, three-provider migration, publish,
crash recovery or deployment qualification.

## Historical online protocol reference — not an executable runtime contract

The following sections retain the former ordering and historical classification
evidence: `Expand -> deploy compatible code -> Backfill -> observe -> Contract`.
Their window, previous-release, command and readiness descriptions are historical
only. They do not restore a Server migration entry point or substitute for the
current contract above.

## Offline historical classification custody

The offline classification producer now reads only
`src/migration/OfflineMigrationClassificationFacts.cs`. The original literal
catalogue retains all fifteen historical fields, validator names, batch/resume
settings, rollback/lock-risk data and scalar fences. Its data validator is not a
Serve admission, deployment identity parser or online readiness evaluator.
`generate-offline-migration-catalog.mjs` projects the original four classification
fields; the original parity consumer binds the exact facts digest and Definitions.
The current classification owner retains the master catalogue and source-bound
product. This integration does not regenerate or overwrite those existing inputs.

This source integration retires the five former Server compatibility owners and
connects the current-only CLI, manifest v3 and compiled RuntimeRole v3/build v4
contracts. It preserves the current master native receipt and catalogue owners.
Source integration and component controls do not establish native receipt
issuance, admitted post-runtime collection, provider qualification, image publish
or deployment acceptance. Those production gates remain pending.

## Metadata contract

Every `ISchemaMigrationDescriptor` must have one explicit
`OnlineSchemaMigrationMetadata` entry. The catalog never infers safety from a
migration id, SQL name, or `pre`/`post` wording. Required fields are:

- `Phase`: `Expand`, `Backfill`, or `Contract`.
- `Compatibility`: a typed `SchemaCompatibilityWindow` whose endpoints are
  canonical compatibility coordinates. A deployable `ReleaseId` maps explicitly
  to the same fixed-width coordinate; min/max fences are coordinates only and can
  never enter deployment identity APIs.
- `RequiresExclusiveMode` and `Destructive`.
- `RollbackMode`: compatible code, resume from checkpoint, or backup/restore.
- `EstimatedLockRisk`.
- bounded `BatchSize` and durable `ResumeTokenName` for Backfill.
- `IntroducedAtCoordinate`, `ContractAfterCoordinate`, and a minimum observation window.
- named validators/evidence producers.

`OnlineSchemaMigrationPolicy` rejects duplicate/orphaned metadata, missing
classification, invalid compatibility ranges, unsafe Expand work, non-resumable
Backfill work, and Contract work without its release/retention/rollback gates. Drop,
rename, type/tightening, truncate, delete, and other rewrite-shaped SQL is accepted
only as an explicitly destructive Contract.

### Identity and ordering boundary

`ReleaseId`, `SchemaCompatibilityCoordinate`, migration id, and schema protocol
version are distinct values. A canonical deployable release and its coordinate use
`YYYYMMDDHHmmss-sha12` in UTC. The only open-ended coordinate sentinels are
`00000000000000-000000000000` and `99999999999999-ffffffffffff`; `ReleaseId.Parse`
rejects both. All window and Contract comparisons go through the coordinate
comparer, which uses ordinal comparison over fixed-width fields and is independent
of locale and host timezone. SHA breaks ties deterministically for releases created
in the same second; that tie-break must not be interpreted as business publication
chronology.

Migration descriptor ids remain opaque identities such as
`20260720-post-comment-mutation-outbox`. Schema protocol versions remain manifest
schema names. Neither is parsed or persisted as a deployed release identity.

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

`20260727-post-distributed-invalidation-delivery-ledger` is an Expand descriptor.
It adds nullable canonical payload, ACK-set, attempt, and compaction columns to the
existing convergence table, then creates the target inbox, explicit topology
retirement, and scope/node/kind reconcile-coverage tables and their unique indexes.
It does not rewrite or constrain legacy state rows online. New code writes only
`pending|partially-acked|complete|terminal-failed`; a legacy unfinished row without
a replayable payload is surfaced as a terminal readiness blocker until an operator
resolves it. Compatible rollback leaves all additive structures in place for the
previous release to ignore.

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

- current and previous rollback `ReleaseId` values are both newer than
  `ContractAfterCoordinate` after explicit coordinate mapping, and neither depends
  on the old structure;
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

- `__fsus_schema_migration_history` for id/checksum/canonical `AppliedByRelease`/success history;
- `__fsus_schema_online_state` for the current schema compatibility coordinate;
- `__fsus_schema_backfill_progress` for resumable progress and verification time.

Historically, production serve read these tables without creating or altering them. It failed
closed for a missing history/marker, duplicate or unknown ids, failed entries,
checksum mismatch, schema coordinate outside the immutable manifest window,
required pending Expand, failed/incompatible Backfill, pending legacy bootstrap, or
an applied Contract incompatible with N/N-1.

The current target shape is not inferred from these history tables or descriptors.
It comes from the provider-neutral canonical current schema described in
[Database Migration Runbook](database-migration.md#canonical-current-schema); the
runtime, generated and migration-target adapters must carry the same sealed source
and content identity before readiness comparison can enter warmup or sampling.

The former compatibility readiness exposed `schema_incompatible`; its historical
protected diagnostic vocabulary was:

| condition | protected code |
| --- | --- |
| history absent | `schema_history_missing` |
| duplicate/unknown history | `schema_history_duplicate`, `schema_history_unknown` |
| checksum mismatch | `schema_history_checksum_mismatch` |
| coordinate window mismatch | `schema_coordinate_outside_manifest` |
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
- [ ] `IntroducedAtCoordinate`, `ContractAfterCoordinate`, and retention window recorded.
- [ ] N and N-1 no longer read or write the old shape.
- [ ] Backfill progress is complete and validator evidence is green.
- [ ] Observation window elapsed with no bridge inconsistencies.
- [ ] Fresh backup was restored and verified in isolation.
- [ ] Deployment state proves no slot switch is in progress.
- [ ] Release manifest forbids rollback to an old-structure release.
- [ ] Old writes disabled; required exclusive mode enabled.
- [ ] Operator supplied `--confirm-destructive` separately from the evidence file.

# Database Migration Runbook

This document is the historical/final-state catalog for legacy descriptors. New
production changes must follow [Online Database Migration Protocol](online-database-migration.md)
and [Online Migration Operations](online-database-migration-operations.md). The only
production release entry is `tools/deployment/release-rollout.sh`: it executes an
explicit Expand before candidate start; production `serve` performs only read-only
compatibility checks. Backfill resumes from durable checkpoints, while Contract is a
separate destructive operation after observation and backup gates.

Do not replay this legacy catalog through the online Contract command. Pre-protocol
descriptors are `LegacyBootstrapOnly` and require an isolated restore/cold bootstrap.
Expand/Backfill can degrade without restarting the web process by retaining the
N/N-1 bridge or pausing the durable token. After destructive Contract, code rollback
cannot recreate removed data: isolate the write path and restore a verified backup
before selecting a compatible retained image/database pair.

## Versioned Legacy Catalog

`SchemaMigrationRegistry` is a thin runtime adapter over the explicit
`SchemaMigrationManifest`; it no longer owns descriptor implementations or a single
ever-growing array. The manifest composes these immutable version catalogs:

| Catalog | Version range | Gap policy | Required previous phase tails |
| --- | --- | --- | --- |
| `legacy-bootstrap-20260418-20260518` | 20260418-20260518 | sparse dates allowed | none |
| `identity-security-20260602-20260621` | 20260602-20260621 | sparse dates allowed | 20260518 pre/post tails |
| `projection-integrity-20260625-20260704` | 20260625-20260704 | sparse dates allowed | 20260621 pre/post tails |
| `current-20260709-20260716` | 20260709-20260716 | sparse dates allowed | 20260629 pre and 20260704 post tails |
| `current-20260719` | 20260719 | sparse dates allowed | 20260716 pre/post tails |
| `current-20260720` | 20260720 | sparse dates allowed | 20260719 pre/post tails |
| `current-20260724` | 20260724 | sparse dates allowed | 20260720 post tail |
| `current-20260725` | 20260725 | sparse dates allowed | 20260724 post tail |
| `current-20260726` | 20260726 | sparse dates allowed | 20260725 post tail |

Catalog boundaries have five explicitly declared gaps: 20260519-20260601,
20260622-20260624, 20260705-20260708, 20260717-20260718, and
20260721-20260723. Startup composition fails before any SQL runs when catalog IDs or
migration IDs repeat, a descriptor is outside its range, declaration order is not
monotonic, a dependency is absent or does not point to the latest earlier migration
in the same phase, or the actual boundaries differ from the declared gaps. The
runner consumes this manifest order directly: all
`PreCodeFirst` descriptors remain ordered by migration ID before all
`PostCodeFirst` descriptors, which preserves the historical execution contract.

Plan fingerprint controls bind the first descriptor definition admitted to master,
preserving every earlier descriptor's ordered ID, phase and checksum. A draft
fingerprint cannot replace that published source. Oracle reconciliation requires
the original PR/merge identity and exact descriptor, transaction, step-order,
SQL-byte and checksum facts; applied history must not be rewritten to fit an oracle.

For [PR #3515](https://github.com/Ozwasyd/FsusBlog/pull/3515), the first published
recent-history definition is master commit `493abaedad77df5f301222405d7904268bb32e75`,
blob `5c473c4ae9d1bd3bfa46d7f968eabfb897ae954a`. The original 145-descriptor plan
remains anchored separately; the complete 146-descriptor plan binds that published
addition and its receipt timestamp/constraint SQL. The older `6d7e8bfa3` draft
fingerprint records source history, not an accepted applied-database checksum.
External draft application, native qualification and complete source-bound assembly
receipt generation remain separate, unverified obligations.

Descriptor implementations live under
`src/migration/Definitions/`; release-range catalogs
live under `src/migration/Catalogs/`. To add a
migration, put its implementation in a focused definition type and register it once
in the catalog whose range owns the ID. A version beyond the current range requires
a new catalog, explicit phase-tail dependencies, and an explicit boundary gap. Do
not append builders or descriptors to `SchemaMigrationRegistry.cs` and do not
reopen `SchemaMigrationRegistry.*.cs` partial files. `migration-doc-lint.mjs` and
`SchemaMigrationCatalogTests.SourceLayout_PreventsLegacyRegistryDescriptorAggregation`
enforce the one-definition/one-catalog rule without code generation or external
tools.

## Migration Assembly Boundary

Legacy descriptors, version catalogs, checksum/history primitives, typed DDL
providers and migration-owned conversion rows compile in the independent
`src/migration/FsusBlog.Migration.csproj` project under the
`FsusBlog.Migration` root namespace. That project targets `net10.0`, references
only `FsusBlog.Shared`, and carries the SqlSugar provider abstraction required to
build and test the PostgreSQL, MySQL and SQLite DDL adapters without loading the
Server or a web host.

The MySQL typed provider resolves add-column and create-index idempotence from
the selected database's metadata, then prepares one admitted DDL statement.
It does not emit MariaDB's `ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF NOT
EXISTS` syntax. A missing target table, missing indexed column or missing
selected database is an error, not a successful ensure. An existing column or
table-scoped index is left unchanged; ensure does not reconcile a different
existing definition.
`DropIndex` resolves the unique owning table in the selected database, quotes
the schema/table identity, and no-ops only when the index is absent. Multiple
owners fail before a drop, including tables whose names differ only by case;
deduplication must compare the constructed identities as binary strings.

MySQL string defaults preserve the shared doubled-quote literal value through
a UTF-8 constant expression, including backslashes under either SQL mode.
Prepared DDL uses the migration connection's reserved
`fsus_schema_ddl_statement` / `@fsus_schema_ddl` session state and clears it
after success; callers must dispose the failed session rather than treating a
failed batch as completed. MySQL DDL may implicitly commit: a descriptor's
`Transactional` flag and preview `BEGIN`/`COMMIT` wrapper do not promise DDL
rollback. Operational plan/apply/verify and backup authority are separate;
these primitive tests do not certify execution of every historical SQL template.

Server production no longer references `FsusBlog.Migration`. Startup loads the
`#2211` current schema projection through `CurrentSchemaStartupVerifier` and
fail-closes on semantic schema mismatch before admission, with zero DDL or backfill. The
online command host refuses descriptor execution from the Server process; the
independent migration assembly remains the owner of legacy catalogs.

Schema DDL and backfill are applied by the offline migration host, an
`Exe` entry point of `src/migration/FsusBlog.Migration.csproj`:

```bash
dotnet FsusBlog.Migration.dll migrate --phase expand|backfill-resume|contract \
    [--id <migration-id>] --release-manifest <path> --env-file <path> \
    [--evidence <path>] [--confirm-destructive] [--dry-run]
```

`tools/db/run-online-migrations.sh` wraps exactly this contract; pass the host
assembly via `--server-dll` (deployment passes
`--migration-server-dll` in `tools/deployment/release-rollout.sh`). Machine
output follows the rollout gate contract: `status` is `ok` / `dry_run` /
`paused` / `failed`, with `phase`, `migrationIds` and `codes`.

The host applies only the `Expand`-classified descriptors of the curated
register (`OnlineSchemaMigrationCatalog` in the Server); the register is
exposed to the host as the generated
`src/migration/OfflineMigrationCatalogEntries.generated.cs` (producer
`tools/db/generate-offline-migration-catalog.mjs`, guarded by
`tools/db/check-offline-migration-catalog-parity.mjs`). Server-side
`CurrentSchemaStartupVerifier` compares the live schema against the CodeFirst
entity projection only; migration-created indexes/constraints are exempted
through the generated
`src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs`
(producer `tools/db/generate-schema-allowed-extra-links.mjs`, guarded by
`tools/db/check-schema-allowed-extra-links.mjs`), so a migrated database still
passes the fail-closed admission check. Visit-log and author-analytics rollup
tables created by PostCodeFirst `EnsureTable` steps
(`daily_read_stats`, `region_read_stats`, `event_type_read_stats`,
`author_daily_read_stats` and sibling author rollups) are required extras:
they are not CodeFirst entities, they must exist, and they are not optional
`s_allowedExtraTables` members. The Server catalog
`CurrentSchemaRuntimeRollupTables` owns the same CREATE TABLE SQL; the extra-tables
checker binds it to those two descriptors. Cold-start legacy
descriptors fail closed with `schema_legacy_bootstrap_required` until the
historical cold-start runner has marked them applied, and the `contract`
phase requires porting the backup-evidence gate, so the host currently fails
closed with `schema_offline_contract_not_supported` instead of executing
destructive work unguarded. `backfill-resume` executes resumable handlers
declared in the migration assembly (for example
`AccountSubjectHashOnlineBackfillHandler`).

The existing offline Expand preflight retains the original conservative destructive
predicate: typed column/table/index drops and column/table renames, plus the full
whitespace-normalized fingerprint of `RawSqlStep`, `BackfillSqlStep` and
`AssertSqlStep` for DROP COLUMN/TABLE/INDEX, RENAME COLUMN/TO, SET NOT NULL,
ALTER COLUMN, TRUNCATE and DELETE FROM. It rejects selected unapplied Expand work
before dry-run output or descriptor execution. The original legacy-bootstrap gate
still runs first; applied and Contract-classified descriptors are not selected.
This predicate does not rewrite SQL, change historical classification or grant a
rollback proof. The existing shared drop-proof requirements and closed Contract
phase remain unchanged; native execution and backup admission still require their
original owners.

The existing descriptor transaction kernel now runs a message raw-session
preflight before `descriptor.Steps[0]` for the historical privacy-retention
descriptor and typed drops of either raw column or its owning table. It borrows
the actual PostgreSQL Read Committed transaction, locks `public.msg_conversation`
then `public.msg_message` against concurrent writes and DDL, revalidates their
catalog identities, and separately counts non-NULL `createdbyadminsessionid` and
`senderadminsessionid`. Both counts must be observed and zero before any step;
nonzero, missing table/column, unknown shape, lock/read failure, RLS or a stale
transaction snapshot refuses the entire descriptor. A missing object is not a
zero-count observation, even when both old columns are already absent; this is
not an idempotent final-shape retirement implementation. Diagnostics contain fixed table/column names and counts,
never raw session values or provider inner exceptions. The existing descriptor
SQL, order, checksums and history are unchanged. This guard does not parse or
authorize arbitrary SQL, and does not certify a descriptor's later writes.

The locks remain owned by that descriptor transaction until commit or rollback;
the adapter connection and transaction identities are checked around every step.
the original offline advisory lock and closed Contract phase are preserved.
This source guard is wired into the legacy descriptor kernel, not the separate
Native-Core Apply or `PgLegacyNonArticlePreparation` transaction owners. It adds
no operation registration, backup authority, execution receipt or physical DROP
admission. DB/lock/count/DROP behavior and complete retirement qualification
remain unverified; source review cannot establish physical retirement safety.

The sole PostgreSQL current catalog reader now inventories public `pg_class`
relations of kinds `r/p/v/m/f` rather than filtering through BASE TABLE rows.
It rejects views, materialized views and foreign tables before column collection,
and refuses a column whose relation was not observed. `ReadTableAsync` retains
its existing selected-table scope; it is not a global admission check. This
changes actual observation only, not the frozen expected target or allowed-extra
relations. The separate offline source observer already inventories those kinds
and is unchanged. Native catalog and full current-schema qualification remain
unverified.

### Immutable offline planning boundary

The separate `plan` command parses an explicit provider, observed instance/database
identity to match, source and isolated restore environment files, original backup
package/manifest/restore-drill references, and a new output path. It does not invoke
legacy phases, apply SQL, write a migration journal, or start the Server. Release,
slot, latest-backup, manual-step and legacy-phase selectors are rejected.

Migration-owned `OfflineMigrationPlanContracts` owns the immutable execution payload;
historical source, backup, step and reader contracts never enter Shared or Server.
Shared `CurrentSchemaMigrationIdentityContracts` contains only opaque current
database/provider/artifact/target/verifier identities needed by the current receipt.
Server consumes that formal receipt and fresh current-schema proof, not executable
plans or migration assemblies. The migration-owned planner matches complete
schema/history/business-shape observations
against a closed, versioned registry with owner, proof tests and entry step. Unknown,
partial and ambiguous observations are rejected with exact differences, not a nearest
baseline. The provider-neutral semantic DAG freezes dependencies, step order, idempotency,
destructiveness, checkpoint policy and all three provider operation references.
Operation semantic digests identify definitions, not actual row-data verification.
The independent plan verifier rebuilds that closure from owner inputs and fresh
observations; merely resealing a modified payload does not authorize it.

Backup admission distinguishes the original database at capture from the isolated
restore database. The original authenticated backup owner must bind package,
manifest and drill bytes to the captured source and independently observed restore;
their complete shapes must match the fresh source. All six original site-package
artifact digests remain required. Shape alone cannot prove current data: the native
source observer must also hash every registered source row and column under the
capture snapshot and independently at fresh plan/restore observation. Equal-length
content changes must invalidate the backup even when schema, counts and business
shape predicates do not change. The actual exported capture snapshot, independently
hashed dump bytes and dump bytes consumed during restore are bound to the original
database artifact; a new session's exported snapshot ID is not compared as if it were
the old session's content identity. Freshness is checked at admission using owner
policy; invocation clock, release, slot, PID and random values do not enter plan
bytes. Receipt capture/restore times are immutable input evidence, not a newly
generated plan timestamp. The migration-owned codec verifies integrity only, not backup,
registry or execution authority. Apply must still revalidate under its exclusive
database lock and use exact journal progress rather than rediscovering steps.

An artifact reference's `Sha256` hashes the complete original file bytes, including
the plan's own digest field. `Plan.ContentDigest` instead hashes the canonical
payload with that self-referential field empty. These identities are distinct;
journal and current-receipt artifact references must not substitute the semantic
seal for the actual file hash or hash normalized bytes as if they were the original.

The same host parses `observe-source --provider <provider> --env-file <path>
--timeout-seconds <canonical-positive-seconds>`. Every new source/capture operation
requires an explicit finite budget before reading credentials or constructing its
native capability. ASCII digits without signs, whitespace or leading zeros are
required; `1..2147483` is the Int32-millisecond representation range, not a business
budget default or a universal verification ceiling. One linked deadline/token
covers environment reading, native observation, dump handshake and output. The
original backup owner keeps its earlier outer deadline and passes its remaining
budget at each launch; `TimeoutSeconds` records that launch's actual budget, not a
renewed outer allowance. Existing v2 disaster-recovery backups do not acquire this
new capture requirement. Console cancellation, SIGTERM/SIGHUP, EOF, faults and
deadline expiry cannot emit completed capture evidence. The awaited native owner
must reach actual transaction/command/connection terminal; a timed wait or a
disposed token alone is not proof of release. Backup child cleanup remains the
original operation owner's bounded lifecycle, not a borrowed test-policy timeout.
PostgreSQL capture additionally requires `--capture-session --dump-output <new
absolute path>`. The observer announces its actual source/exported snapshot before
the dump; `CapturedAt` comes from the native snapshot establishment, not the later
completion of the source scan. First and final evidence bind the same timestamp,
snapshot, full source and launch budget. The original backup owner then runs
`pg_dump --snapshot`. Only the exact stdin line
`DUMP_COMPLETED`, after the dump child is truly terminal, releases the callback;
stdin cannot select a path, source observation, snapshot or hash. The native observer
independently hashes the pre-bound dump, closes its read-only transaction, and only
then the host emits completed capture evidence. EOF, unknown control or cancellation
produces no completed evidence. MySQL/SQLite snapshot capture is explicitly unsupported
until their actual owner capability exists. Stdio contract fixtures are not native
database or backup proof, and the source-observer factory currently also refuses
unconfigured owners rather than interpreting empty input as an empty database.

The migration-owned source-observation component registers the checked-in
`2026-05-17` representative legacy shape, not an already qualified production dump.
Its PostgreSQL path closes the actual catalog, all 49 registered columns and every
row, history and five sequence states under one native read-only snapshot with a
streamed, bounded content encoder. Three-provider shape registration is not proof
of three native implementations: missing MySQL/SQLite full-content/snapshot
capabilities fail closed. The component still needs its unique native-session
owner and genuine producer/provider execution before operational qualification.

`MySqlArticlePreservationSourceReader` connects the existing bounded article reader
to the original `OfflineMigrationMySqlNativeSession` owned-read port. Finite limits,
read budget and source inputs are checked before driver parsing or native I/O. A
linked deadline governs session creation and the borrowed read and remains live
through the awaited original cleanup. It does not interrupt the native disposers;
the reader returns only after successful owned cleanup and a final cancellation
check. The borrowed path accepts only the original live `OwnedReadContext`, retaining
its creator cancellation scope and native transaction checks. Raw driver objects,
isolation labels and caller-created keys cannot grant a MySQL source read. This
wrapper does not capture or authenticate a backup, publish artifacts, register an
Apply operation, or qualify native execution; existing provider gates remain required.

The existing `ArticlePreservationStorageWriter` also exposes a MySQL data-only stage
through the original Apply owner's live read context from its locked read/write Begin.
It revalidates retained target and published inputs, measures InnoDB tables without
triggers, bounds parameterized inserts and set-based two-pointer CAS batches, and
reads back every row and cell, including bounded UTF8 text and microsecond timestamps.
It performs no DDL or allocator repair and cannot register a complete provider route.
Creator-linked cancellation and local scope/connection/transaction checks surround
each awaited command and reader operation. These local checks do not prove a native
transaction epoch. On this single connection, native proof queries run before a
command and after its reader and command disposers return successfully; no second
query runs through a live reader. Failures retain the first cause and cleanup
observations, and unverified disposal cannot yield a successful stage. The original
Apply owner still owns commit, rollback and journal append. PostgreSQL remains the
default data dialect; low-level command fixtures grant no native write capability.

Sealed Apply consumes the exact verified artifact and revalidates source (or
exact journal progress), backup, target, tool and DAG after its exclusive lock,
on the same native transaction/session. Control journal entries are insert-only;
each business unit and its journal append share a database transaction, and forked
state is published only after commit. Resume reads the exact checkpoint's whole
chain, not a latest-row shortcut. Bounded step proofs use O(step-count) memory and
are not a current-schema receipt. Unknown commit or rollback outcomes require
recovery rather than blind replay. The invocation supplies its explicit finite
cleanup budget; primary failure and
cleanup failure are recorded separately, and actual native disposal remains a
separate integration/terminal proof, not a declaration inferred from a token.
Current native Apply is PostgreSQL-only; missing compiled bootstrap/legacy
operations, production admission or non-PG
capabilities refuse before the first write. Legacy Contract guards are unchanged.

The durable native apply journal remains present after completion: no delete or
external-chain handoff is inferred from bounded step proofs or a receipt. Its
single current control definition is `CurrentSchemaControlShape` (seven columns,
four constraints); original Core creation/validation and the full current runtime
projection derive from those facts. PostgreSQL explicit names retain the original
63-byte implicit names without collision fallback. The native primary backing
index and both unique indexes, raw check/default/predicate expressions,
nullability/types/lengths, collation, generation/owned sequences and attached
triggers are measured and compared. A same-name malformed table, additional historical
table, undeclared raw default (including DEFAULT NULL), inheritance, RLS or rule
effects, unavailable backing index or changed control constraint
is not a name-based exemption. PostgreSQL 18's additional native `NOT NULL`
constraint rows are folded into the already measured column nullability only
when each local, enforced, validated, nondeferred row binds exactly one nonnullable
control column without an index, reference, expression or inherited parent. The
complete seven-column roster must match; a missing, duplicate, malformed or unknown
constraint still refuses. This preserves the original four semantic constraints
and does not grant another control-table shape. Server observes
schema facts only; journal JSON, history, sequence/parent seals, media states and
resume remain the original Migration owners' responsibility.

The same sole control facts now also have formal MySQL and SQLite projections:
seven columns, four constraints and three constraint backing indexes. MySQL uses
the native `PRIMARY` name and the exact `utf8mb4_0900_bin` collation already required
by the original journal dialect's create/observe owner; this does not declare a
new server-version baseline or admit an engine lacking that capability. SQLite's
original four-column primary key is not an `INTEGER PRIMARY KEY` rowid alias:
its three `sqlite_autoindex` names follow the sole constraint declaration order,
with `BINARY` keys. SQLite physical `TEXT` has no length modifier, while the original
semantic 64/160-character bounds and source/content identities remain intact.
These descriptions grant neither control-table creation nor a business transaction.

MySQL's physical projection also includes the native unique constraint of each
explicit unique index, without inventing another backing index. Primary-key columns
are physically non-null and marked as key members, as required by native MySQL;
the original logical nullability, owned input bytes and target identity are not
rewritten. Conflicting native key names, multiple primary keys or unknown key
columns refuse rather than silently choosing one input fact.

`ProjectOwnedTarget` can project closed neutral relational facts and typed added
columns, constraints and indexes to MySQL/SQLite without copying entity mappings.
Unsupported defaults/computed or check expressions, business text collation,
allocators, independent sequence semantics, immutable-guard failure scope and
dynamic seed expressions refuse instead of returning a partial current target.
In particular the actual current recipes still require missing non-PG semantics;
the structural projection does not make either complete current bootstrap runnable.
Native DDL/observation, original producer execution, compiled operation registration
and all three-provider acceptance remain pending. No producer output is hand-edited.

The original portable compiler's `CompileOwnedFacts` reuses the existing complete
owner/input binding and current type projector. Closed typed added columns and
unique constraints, together with indexes, are folded into a copied final empty
table before rendering rather than translated into unsupported ALTER syntax.
The producer's input, recipe identities and complete target identity are not
mutated. No second field inventory or control renderer is introduced. Its explicit
`ProducesCompleteCurrentBootstrap = false` describes the partial command result;
it is not an admission or registration flag. Raw CHECK/default/predicate expressions,
unsupported foreign-key semantics, sequence/guard/dynamic seeds and full native
control/bootstrap postconditions remain unavailable, so these commands cannot
qualify a complete current bootstrap. Existing narrowly supported literal default
syntax remains a subset compiler capability, not a new typed-expression authority.

The migration-owned `SqliteCurrentSchemaCatalogObserver` is a read-only SQLite
bootstrap prerequisite, not an approved bootstrap operation. It measures the
caller's original native `Serializable` transaction: main schema SQL (including
checks, views and trigger bodies), generated columns, strict/without-rowid flags,
complete index key/auxiliary facts, foreign keys and violations, and actual
`sqlite_sequence` watermarks. It preserves declared provider types without
inventing a second current entity mapping, changes no pragma and commits nothing.
Attached/temp namespaces, virtual/shadow-table capabilities and incomplete or
oversized metadata are refused, not omitted. Its limits are the original source
observer metadata limits. Native filename is only a namespace observation, never
a database incarnation. The unique current owner still must supply the complete
legal SQLite recipe projection and expected effects; original native incarnation,
apply/DAG registration, backup admission and all-three-provider execution gates
remain required. This component does not admit a legacy database as empty, issue a
current receipt, or qualify a full bootstrap. Cancellation/physical interrupt and
cleanup deadlines remain owned by the caller's native session, not this reader.

`SqliteCurrentSchemaEffectObserver` reuses that same native catalog and the single
`Shared.Algorithms.SqliteImmutableTriggerObserver` decoder. It records the actual
unconditional `BEFORE UPDATE` or `BEFORE DELETE` event, `RAISE` action and exact
literal message; it does not equate `ABORT`, `ROLLBACK`, `FAIL` and `IGNORE`, invent
a two-event trigger, or choose a SQLite policy for the original PostgreSQL guard.
Conditional/narrow events, extra statements and unsupported bodies fail closed.
These are measured effects, not an expected current mapping or a bootstrap grant.
Complete provider recipes, independent sequence semantics and target/DAG admission
remain with their original owners; an empty observed effect vector is not success.

The same closed decoder also renders explicit native trigger facts, escaping names
and literal messages without inventing an action or merging update/delete events.
`ReadAndMatchTriggerFactsAsync` freezes the supplied vector before observation and
compares every actual name, table, event, action and message, rejecting missing,
additional, conditional or different effects in the caller's original transaction.
Duplicate-name admission uses SQLite's ASCII-only case fold; distinct Unicode
case pairs remain separate native names, without normalizing event/action/message.
This comparison does not authenticate expected facts: only the complete original
current provider projection may supply production expectations. The original
PostgreSQL exception does not by itself choose SQLite `ABORT` versus `ROLLBACK`;
no such provider policy, independent allocator, full target or step registration
is granted by this rendering/measurement adapter.

The remote source integration retains the complete catalog/effect SOURCE controls
from #1761 and #2217 under the bounded #3705 integration and the last source commit
`c85ceb9004cbafc545b12c8deb7360fa0a4194a7`. The original strict SQLite sequence storage-type checks remain unchanged; the
shared decoder uses the current `FsusBlog.Shared.Algorithms` owner. Real native
SOURCE controls exposed an existing catalog defect: SQLite 3.49.1 returns NULL
from `SUBSTR` of an empty BLOB, so the original bounded text projection lost the
legitimate empty namespace filename before `RequiredText` could observe it. The
projection now preserves a zero-byte non-NULL value as empty text before taking
the original byte prefix. Actual NULL still remains NULL and is refused by the
original required-field check. The `(MaximumCellCharacters + 1) * 4` byte prefix,
row/character budgets, embedded-NUL refusal, strict sequence checks, original
native connection/transaction and namespace admission remain unchanged.

The supplementary combination of these complete production/control sources and
prebuilt Migration prerequisite dependencies executed all 72 original controls
and seven additional empty/NULL, Unicode, oversized-byte and NUL controls with
79 passes and no skips. The original 57 failures before this fix remain recorded;
no expected result or native fixture was weakened. This source combination does
not prove the canonical candidate Migration assembly/build or required matrix.
Those gates and independent full-provider bootstrap/admission remain separate. No task
service, production receipt or approved SQLite action policy is implied. Rollback
removes this isolated decoder/effect integration and its controls while preserving
the existing catalog reader, owned-domain observer and shared PostgreSQL owners.

The same source assembly also contains the original SQLite owned-domain observer.
It measures the complete catalog on the borrowed original connection/transaction;
only the sole apply control and its native indexes are excluded after the original
whole-shape validator succeeds. Other objects, history, effects and allocator state
remain visible and refuse the empty-domain precondition. The complete observation
is retained alongside its domain view. This helper does not authenticate journal
rows, select an empty source fingerprint, mint an owned writer scope, or register
the portable commands as a complete bootstrap. Public planning/backup observation
and original control creation/admission rules are unchanged.

This source combination retains the original complete MySQL physical-fact model,
comparison and canonical hash/clone closure rather than discarding observed native
metadata. It changes the current model to `fsusblog.current-schema.v4` and the
projection generator to `fsusblog.current-schema-projection.v4`; the reflection
extractor version remains v2. Both composite source/content identities include
the explicit control version and complete sole shape. Previously sealed v2/v3 owned
targets, plans and receipts cannot be reinterpreted, auto-resealed or accepted
through a second version path. A new candidate must invoke the original owned
projection producer and obtain fresh exact authorized source/backup/DAG/target
bindings, apply artifacts and independent current verification. An interrupted
old run retains its original immutable tool/plan/artifacts and whole native chain
for original-version recovery; changing the version is not permission to guess a
checkpoint or re-plan partial effects. Rollback requires those original bindings
and the authenticated backup/recovery procedure, not journal deletion. This
source repair and unexecuted source cases do not establish native crash/resume,
backup, three-provider or deployment qualification.

Completed-Apply plan-binding verification independently hashes the original raw
artifact bytes and rechecks closure against authenticated capture/restore evidence
at the original journal's first admission time. It must not backfill those inputs
from the plan or demand that the now-migrated live database still has its old
shape. Fresh current schema and actual operation postconditions are independently
verified by the current-receipt owner; the pure binding helper is not a receipt
issuer or an execution grant.

The current `CreateOwnedReader` fails with
`schema_offline_plan_evidence_owner_not_configured`: the existing backup manifest
and drill do not yet prove source instance/fingerprint binding, and the current-only
schema observer cannot register historical source shapes. Contract-test observations
are not production registry entries. Until those actual owner capabilities are
integrated and independently verified, no CLI plan is admitted; the existing
`schema_offline_contract_not_supported` guard remains unchanged. The typed contract,
planner and source regressions alone are not three-provider or whole migration
acceptance, and do not authorize applying a deserialized plan.

`artifacts/schema-migration/migration-assembly-receipt.json` records the old/new
project, assembly and namespace identities, every old/new source path and declared
symbol, old/new SHA-256 digests, deleted Server paths, the aggregate content digest
and actual independent build/test results bound to the migration source plus test
input digest. The generated
`artifacts/schema-migration/migration-assembly-binding.json` seals the receipt,
source transition and verification result digests. `tools/db/check-migration-assembly-boundary.mjs` rejects reverse Server
references, linked or duplicate sources, type forwarding/re-export namespaces,
provider copies of the current schema model, shared legacy-only fields, web-hosted
migration tests, graph cycles, dual registration, Server publish leakage, missing
provider/build evidence and receipt or binding tampering.

The same original producer's `--write` operation now requires the canonical
scheduler run/source/namespace, the original admitted Migration build and a live
owned MySQL fixture. It still runs both complete unfiltered commands:
`dotnet build src/migration/FsusBlog.Migration.csproj -c Release --no-restore`
and `dotnet test tests/migration/FsusBlog.Migration.Tests.csproj -c Release --no-restore`.
It writes only private pending receipt/binding and raw command logs. Production
owns these through its `migration-assembly-verification` step in the original
first-attempt output root; backend-unit uses its fixed run-private producer root.
No arbitrary output path, permit JSON, filter or retry-attempt flag is accepted.

After original current-run MySQL cleanup and successful build finalization,
`node tools/db/generate-migration-assembly-receipt.mjs --publish-current-run`
uses that same scheduler environment (and `--backend-unit` for the unit producer)
to verify pending bytes, complete source/test inventories, original owner identity,
actual released build resources and the exact cleaned MySQL admission. Only the
original producer publishes the two registered tracked outputs. Partial pair
publication restores the prior tracked bytes and removes only its identified
staging files; original private logs remain available for diagnosis. Publication
records `qualificationEligible: false`: tracked output changes require a fresh
final-candidate run and independent acceptance. A source-control fixture or a
historical receipt cannot satisfy that native execution requirement.

The fresh final candidate uses `--verify-current-run` after its original cleanup
and finalization to consume the newly executed pending evidence against the
unchanged tracked source/binding. This reads actual current-run pending logs and
full source fingerprints. After asynchronous build/service admission and before
publication or a verified return, the producer re-observes the complete original
source snapshot and rechecks pending/tracked bytes and file identities across that
read window. Shared inputs outside Migration's local inventory must also remain
unchanged. It does not rewrite tracked elapsed-time summaries or
start another publication cycle. Passing this producer read does not replace
full native/domain/CI or independent acceptance.

The PostgreSQL fixture exercises both an empty database and the representative
20260517 historical schema twice. For each starting point, the normalized columns,
indexes, and constraints after the first run must exactly match the second run. It
also retains the data-conversion assertions for article bodies, page content, view
seeds, comment attribution, and history row count. This protects fresh bootstrap,
supported upgrades, and duplicate-run idempotency without a production database or
external migration service.

SqlSugar string `SugarColumn.DefaultValue` values are logical literals, not
pre-quoted SQL fragments. For example, use `DefaultValue = "basic"`, never
`DefaultValue = "'basic'"`; the latter is escaped again during each CodeFirst pass
and changes the database default to a value containing quote characters. The fresh
fixture inserts a `sys_user` row after the second run while omitting these columns
and requires `anonymous_account|basic|active`.

## Canonical Current Schema

### Explicit production current receipt admission

Production startup requires an explicit absolute `SchemaMigration:CurrentReceipt:Path`,
its complete file-byte SHA-256 in `SchemaMigration:CurrentReceipt:Sha256`, and the
candidate assembly's exact nonzero `FsusBlog.SourceCommit` in
`SchemaMigration:CurrentReceipt:CandidateSourceRevision`. These are not `latest`
selectors. The receipt's payload self-digest is separate from its artifact-byte hash;
its verifier source revision is the offline producer identity, not necessarily the
later Server candidate revision.

`CurrentSchemaReceiptCodec` owns the closed `fsusblog.current-schema-receipt.v1`
current-only envelope. Its opaque plan, apply, checkpoint, backup and recovery
references do not load migration histories into the Server. Structural validity,
a self-digest, or a `verified-current` string alone is not fresh database evidence.
`CurrentSchemaReceiptAdmission.VerifyAsync` re-reads the explicitly bound artifact
and the current schema through the original canonical authority, checking the
five-field target identity, actual physical schema digest and native PostgreSQL
`system_identifier` plus database OID/name. Unsupported native observers fail
closed. This route performs no DDL, backfill, journal or migration-history writes.
Only successful startup admission publishes `CurrentSchemaAdmissionState.Current`;
an absent state is never readiness. The same read-only verification API does not
publish readiness when used by an operational consumer.
The receipt JSON must explicitly contain its closed `status`; omission cannot
default to success. Receipt admission failures stop hosted business-service startup
in Development as well as Production, using the fatal admission category rather
than the ordinary development-only bootstrap logging fallback.

The Migration-owned `OfflineMigrationCurrentSchemaIssuer` requires explicit original
plan/apply/checkpoint artifacts and a completed exact native journal. Artifact SHA-256
binds all actual file bytes; `OfflineMigrationJournalAnchor.EntryDigest` binds the
entry payload's separate semantic seal. The verifier streams the entire original
invocation (not a prefix ending at a requested checkpoint), validates every explicit
checkpoint against its native entry, and authenticates the first attempt's UTC
admission time before revalidating the original backup/registry/DAG bindings.
The owned artifact reader opens each explicit absolute published path and reads
its bounded original bytes, checking the whole-file SHA before returning them.
The Linux x64/arm64 file owner walks non-link directories, rejects non-regular
leaves and uses nonblocking, non-following open followed by same-descriptor
regular-file/device/inode validation. FIFO, device, directory or link paths cannot
reach the ordinary synchronous stream open. An unowned native file platform
refuses instead of falling back to generic open. This does not establish an
outer physical deadline for stalled filesystems or replace native terminal proof.
Before returning original bytes, the reader compares the actual FD's complete
device/inode, mode, link count, ownership, size and modification/change timestamps
against its pre-read opaque native observation. It reopens the original path through
the same anchored non-following walk and compares both the leaf and ancestor
identities; equal byte hashes cannot conceal a replaced file or directory chain.
Other original-file consumers reuse this guard with their own existing byte limits.
Relative paths, `latest` discovery, empty or oversized files, cancellation and
changed bytes cannot substitute reconstructed records for original artifacts.

The sole native identity primitive is
`src/shared/Algorithms/IO/NativeRegularFileGuard.cs`. Migration retains its original
artifact-reader facade and refusal codes. The Server's bound receipt reader also
uses this owner before opening a stream, reads the exact observed size plus a
trailing-byte check, and validates the same handle/path identities before returning
bytes. Its receipt budget remains exactly 1 MiB; the existing whole-file SHA and
ordered `CurrentSchemaReceiptCodec` seal validation then run in admission. No
receipt record or JSON status supplies a file identity token. Held database-FD
validation never reopens or closes a database leaf. Sharing this file primitive
does not connect the pending scheduler-admitted post-runtime native collector or
qualify release/deployment acceptance.

Native current schema, instance/database identity, required target postconditions
and checkpoint replay predicates are re-observed on one PostgreSQL repeatable-read,
read-only transaction. The issuer passes its actual native instance/database identity to the current-schema
observer with that exact connection/transaction; an adapter cannot substitute plan
identity or establish a second capture. Its returned identity must match that observation.
Expected/actual fact vectors must close in both directions and agree with the original
committed step proofs; an empty observation, partial
apply, warning, unknown operation or provider cannot produce `verified-current`.
The current target is independently derived from its original owner, never the plan
payload. Only after successful observation and snapshot cleanup does the issuer
return canonical current-receipt bytes with their separate whole-file SHA-256.
`VerifyExistingAsync` consumes an explicit original receipt artifact and re-runs
that native verification before comparing the complete recomputed receipt seal;
it does not accept a caller's success status or re-use its claimed verifier identity.

The normal issuer factory remains deliberately unavailable until original native
current-schema, compiled-operation and authenticated-backup owners are
configured. Missing owners return `current_verify_native_owners_not_configured`
before native access or publication. Validator unit fixtures exercise structural
refusal rules only; they neither issue receipts through fake providers nor replace
the required empty/old database, independent verifier and startup runtime gates.

The test-only materialization receipt remains a separate isolated-run artifact.
Its schema check uses `CurrentSchemaReadObserver`, not an optional production
receipt bypass. Offline receipt issuance additionally requires the original sealed
plan/backup authorities, durable native journal and independent compiled-operation
postcondition observations. Missing providers or operation owners must refuse
issuance; the current-only codec and startup consumer cannot supply those facts.

`CurrentSchemaCanonicalAuthority` in `src/shared/Contracts/Schema/` is the only
neutral current-schema generator, identity hasher, provider projection and
comparer. The Server-owned `CurrentSchemaEntityExtractor` extracts the current
`SugarTable`/`SugarColumn`/`SugarIndex` mapping, inherited
public properties, nullability metadata, defaults, conversions and explicit
current constraints into a provider-neutral semantic model. Duplicate owners,
unknown property types, unsupported converters and incomplete constraints fail
before a projection is accepted. Ignored, navigation and `NotMapped` members never
enter the model.

Runtime reflection, `CurrentSchemaProjection` and the migration target adapter are
independent observations of that sealed model; none reads the migration catalog,
Markdown, test fixtures or a running database to define the target. Their shared
identity binds model, extractor and generator versions plus source and content
SHA-256 digests. PostgreSQL, MySQL and SQLite projections retain this semantic
identity while recording different physical type spellings. The PostgreSQL
projection additionally seals normalized type modifiers and domains, collation,
default and identity/owned-sequence semantics, complete index key ordering,
NULL placement, access method, opclass, collation, INCLUDE, predicate and NULLS
NOT DISTINCT state, plus constraint deferral, validation and foreign-key actions.
PostgreSQL's explicit `timestamp(6)` is normalized only to its equivalent
unspecified default precision; `timestamp(0)` and every other explicit precision
remain distinct and fail exact comparison.
Compiled CLR/ORM `Conversion` remains in the complete logical input and its
source/content identities; it is not inferred from a native database catalog.
The single provider/storage projection admits only the current known converter
vocabulary and compares its physical domain separately. JSON storage type,
nullability, defaults, indexes and constraints remain exact physical facts; a
catalog conversion of `none` is not evidence that the compiled JSON conversion
was absent or replaced. Unknown logical converters refuse projection.
The independent verifier and cold-readiness comparison reject stale identities,
content tampering and exact table, column, physical type, nullability, default,
constraint or index drift.

The read-only `CurrentSchemaOwnedProjectionExporter` uses those same mappings,
binds the compiled source commit and actual Server/Shared assembly bytes, and
references every original current-owned PostgreSQL rollup recipe by its complete
create/additional-SQL digest. SQL remains with `CurrentSchemaRuntimeRollupTables`;
it is not copied into Shared or reconstructed from migration descriptors. A
recipe reference is not its neutral semantic description. The single original
recipe extractor derives columns, types, defaults, constraints and every additional
effect (indexes, sequences, immutable guards/triggers, seed insertion, added columns
and guarded foreign keys) directly from that catalog, without a second business
field list. Unknown source syntax refuses the entire export. Shared holds typed
effects and expression semantics, not provider SQL templates. `WriteArtifactAsync`
publishes a new, non-overwriting `fsusblog.current-schema-owned-target.v1` artifact;
the single neutral target projection binds both the entity facts and all recipe
facts. Missing descriptions still refuse before any command is returned.
The exporter payload is neither an apply grant nor a self-reported current target;
the offline evidence owner must independently bind its original producer, bytes
and complete source closure before consumption. No owned target artifact has
been produced by this source-only change.

The original Server executable exposes `export-current-schema-owned-target
--output <new-absolute-file>` before Web host, DI or database configuration.
`OwnedCurrentSchemaTarget.InvokeOriginalOwnerAsync` invokes that original producer
as a child with the explicit retained assembly and source revision, observes its
actual source metadata/current Shared bytes and before/after producer-file closure,
and retains stdout, stderr, terminal status and original artifact bytes. Its private
capability constructor is reached only after an actual exit-zero invocation and
strict artifact/input/target binding; deserializing caller JSON grants nothing.
The caller/root process owner still owns full process-tree qualification: a child
exit observation is not a canonical task-tree terminal receipt. Actual producer
execution and native acceptance have not been performed for this source component.

The single neutral `ProjectOwnedTarget` folds all original relational recipe facts,
added columns/constraints and indexes into the provider target. It retains the
nonrelational sequence/function/trigger effects and bootstrap seed effects
separately: relational comparison alone does not prove those effects. Seed data
postconditions belong to apply, not to permanent runtime schema identity. Native
expression/effect measurement has one current-only PostgreSQL implementation in
`Shared.Algorithms.Schema`, consumed by both Server and Migration through BCL
`DbConnection`/`DbTransaction`:
complete `pg_get_expr` defaults/checks/index predicates, their bound dependencies,
unowned sequences and function/trigger semantics are observed on the same native
RepeatableRead transaction. Typed expression comparison retains literal bytes,
casts, PostgreSQL numeric operand types and exact decimal identity; only proven
direct integral-column literal comparisons and literal assignments normalize to
the already compared storage domain. Arithmetic operand types are not erased.
Unsupported syntax refuses rather than dropping
checks/defaults. Neutral facts/identity remain in Shared.Contracts; current native
catalog SQL and expression parsing belong to Shared.Algorithms, with no provider
package, legacy mapping or journal payload/history validation. The actual physical
digest still uses the original unmodified native snapshot. The Server reader now
derives the same composite entity-plus-recipe-plus-control target and compares the complete
native effects; this source alignment is not verified physical-schema evidence.

`CurrentSchemaBootstrapCompiler` owns PostgreSQL entity and complete-recipe DDL
compilation from the neutral facts and executes those frozen commands only on
the caller's existing native connection/transaction. It does not open or commit
transactions, write a journal, or replace plan/source/backup admission. Missing
recipe semantics, unsupported defaults/computed capabilities, native provider
capabilities and command drift refuse explicitly. Recipe compilation additionally
requires the exact input digest from an independently verified owned artifact;
producer strings or caller-supplied facts cannot substitute for that evidence.
The original owner ordering (all tables before additional effects) is preserved.
`PgCurrentSchemaBootstrapOperation` and its exact compiled-owner registry provide
a PostgreSQL empty-source component. They consume only an actually invoked owned
target, bind the current Migration assembly bytes, revalidate retained original
input/artifact bytes and execute the full original command closure on the caller
transaction. Producer metadata, retained DLL/artifact reads and the operation's Migration DLL
hash consume the original file owner's same-FD terminal identity validation; a
matching hash does not waive replaced-path or ancestor identity refusal.
Native empty-source and complete target/effect predicates, initial
seed values and unique seed-key cardinalities are independently read before a
complete unit is returned. Replay checks the target and stable seed keys, not
mutable bootstrap values as permanent runtime facts. The original journal owner
validates its control table through the sole current shape on that same
transaction. Only the empty-source predicate separates that validated control
from its business-domain view; final target/issuer/runtime comparison retains the
complete native snapshot and all raw expressions. No journal mapping or payload
parser is copied into Server.
The core retains commit, rollback, journal and original plan/source/backup admission.
The actual empty-source component retains the original empty source profile's
`bootstrap-current-schema` entrypoint; naming it does not admit absent provider
owners, and the historical profile cannot enter this empty-source operation.
This single-provider step is not a complete admissible DAG. Known-legacy target
preparation, MySQL/SQLite execution owners and real
three-provider qualification remain pending. No original producer/native operation
has been executed for this source component. Source cases include original-vs-compiled PostgreSQL
schema/effect parity and immutable guard refusal, but have not been executed for
this source-only component. Entity-subset unit or PostgreSQL fixture cases cannot qualify an empty production database upgrade
or a supported historical database conversion.

The original MySQL catalog query independently awaits its reader and command
disposals, preserving the first query/shape/budget/cancellation failure via the
original exception while recording only fixed immutable cleanup codes. Cleanup
failure after an otherwise successful read still refuses; cancellation is checked
after the complete awaited cleanup. Its SQL descriptors, metadata limits, original
30-second command policy and native session/driver guard are unchanged. Direct
private-query lifecycle SOURCE controls do not qualify native cleanup or a database.
This remote-source integration remains WIP pending canonical Migration validation,
independent native acceptance and complete source-bound assembly receipt generation.
The 19 original SOURCE cases retain exact immutable diagnostic types, fixed values
and ordering. Their comparison explicitly selects string sequence equality; the
original default ImmutableArray overload compared distinct backing-array identities.
A separate four-case overload diagnostic covers equal, reordered, dropped and altered
values. These mocked cleanup controls are not native service qualification.
It does not register a whole MySQL legacy migration operation. Rollback reverts this
catalog-query cleanup change if reader or command custody regresses, retaining the
existing native session guards and metadata budgets.

`PgCurrentSchemaCatalogObserver`, `PgCurrentSchemaEffectObserver` and
`PgCurrentSchemaExpressionParser` are the single current native PostgreSQL
measurement/parser implementation in Shared.Algorithms, not another expected-schema
authority. Their original queries and decoding/comparison semantics are retained;
they use the caller's native connection and RepeatableRead transaction, propagate
cancellation through queries/rows, and never open, commit or capture another session.
Migration retains the original owned-target/journal wrapper. Server's
`CurrentSchemaReadObserver` owns a read-only RepeatableRead transaction and binds
native database identity before and after the complete observation on that same
connection. It derives its composite target from the original entity inspector
and recipe fact extractor, without a producer-identity substitute, and refuses
unknown tables/effects rather than allowing rollup names. Both scopes retain the
original complete native `ComputeObservationDigest` semantics. A migration journal
is not approved by a table-name exception: its original owner's legitimate terminal
runtime contract remains pending. The measurement alone grants nothing; the issuer
still needs its sole session's observed database identity and independently verified
owned target. Source-only parity/refusal cases are not actual PostgreSQL evidence,
and no provider, startup or whole-issue qualification is claimed here.

The original `SchemaModelInspector` current catalog API delegates to that same
Shared reader; its entity extraction, expected projection and validation interface
remain unchanged. Standalone reads own a read-only native RR transaction. Schema
evidence may borrow a caller's actual same-connection RR transaction without
committing or disposing it; unsupported isolation or a detached transaction refuses.
The test-only materializer explicitly starts RR before its own DDL transaction and
uses that schema-evidence path. Production `ReadAdmissionAsync` never borrows a
writer transaction or accepts the unit native-fact seam: it still owns an actual
read-only RR snapshot and fresh database identity observations. These source cases
have not been executed against a native provider.

`tools/db/check-current-schema-authority.mjs` checks both the neutral contract
and original Server extractor, and prevents a second production
extractor, hand-written table inventory, fixture reconstruction or migration
descriptor from becoming current authority. This boundary does not move migration
descriptor SQL or make provider DDL a second current-schema mapping. The migration
assembly extraction above changes compile ownership only; descriptor IDs,
fingerprints, checksums, SQL and execution order remain stable.

Current-owned recipe effects also retain the original independent PostgreSQL
`CREATE SEQUENCE ... AS bigint` configuration as typed facts: start/increment/minimum
1, maximum `Int64.MaxValue`, cache 1, non-cyclic, and not a business-column identity.
The complete recipe/content identity and provider target include these facts;
missing, altered, duplicate or unused sequence arguments refuse. This preserves
the original `nextval` behavior, including permitted gaps, without promising
gapless numbering, commit ordering or stronger crash persistence. MySQL and
SQLite independent-sequence projections remain explicitly unavailable until the
same authority owns their physical allocation protocol and actual verification;
an observed AUTO_INCREMENT column or trigger action does not define that target.

Acceptance runtime bootstrap uses the explicit Server command
`materialize-current-schema-test` only after its isolated PostgreSQL service is
ready and before any runtime application starts. The command is unavailable to the
ordinary `serve` route and requires the exact `Test` environment, an explicit
opt-in, the admitted service envelope's exact `127.0.0.1` PostgreSQL host/port,
the exact `fsusblog` database/user, the `public` search path and a canonical
run-derived receipt path below a physical, non-symlink receipt root. Immediately
before the command, the canonical service observer addresses the admitted
container ID and re-observes the complete Docker/runtime/service identity; on the
same PostgreSQL connection and transaction, the command independently compares
`system_identifier`, database, user and exact server version identity before any
DDL. It accepts only a `public` schema with no relation, routine, standalone type,
domain, operator, conversion, collation, extended-statistics or text-search object,
derives entity types and the
five-field identity through the sole
`CurrentSchemaCanonicalAuthority`, materializes those entity types once, applies
the PostCodeFirst visit-log and author-analytics rollup `EnsureTable` SQL from
`CurrentSchemaRuntimeRollupTables` (without referencing the migration assembly),
then runs the read-only `CurrentSchemaReadObserver`. Missing rollup tables fail closed instead
of remaining optional extras. A partial or stale schema fails before any write.
DDL and verification remain inside one PostgreSQL transaction. Before commit the
producer atomically publishes only a `prepared`, qualification-ineligible staging
receipt; after commit it atomically publishes the no-overwrite `verified` receipt.
A process death in the commit window can therefore leave only noneligible staging
evidence while PostgreSQL rolls back the open transaction. The committed crash
case starts the materializer in an identity-checked isolated process group, kills
that entire group and proves zero surviving candidates before checking rollback.
Publication failure
after commit leaves no eligible receipt and triggers best-effort schema compensation
and receipt cleanup; the full run rejects the nonzero producer exit and does not
claim cleanup succeeded without a fresh catalog observation. An independent
consumer invokes the candidate assembly's explicit test-only, read-only verification
command, which derives the sole canonical authority and a fresh physical PostgreSQL
observation instead of trusting a locally resealed receipt. It then re-reads and
verifies receipt shape, self-digest, run/source/assembly, catalog/envelope/service/
database and canonical identity and publishes the sole run-bound
`current-schema-runtime-ready` terminal. The fixture catalog seals that terminal
into an exact runtime-topology admission and reconsumes both before any runtime
process is spawned. Production `serve` remains a read-only verifier and never
invokes either test command. The committed
`current-schema-bootstrap-integration` lane reruns the empty-schema positive path,
rollback/crash and publication windows, stale-service substitution and physical
column/index/constraint counterexamples on an exclusive pinned PostgreSQL.

## Plugin Registry

`20260724-post-plugin-registry` additively creates `plugin_registry`. The table keeps
the closed Manifest JSON, verified package bytes, SHA-256 digest, install state,
enabled bit, UTC timestamps and monotonic version. A primary key makes plugin IDs
globally unique; check constraints bind enabled state, digest width, lifecycle state
and uninstalled package erasure. Runtime/state and update-order indexes support
bounded startup synchronization across homogeneous nodes.

The migration is transactional and safe to retry. It does not activate or execute
plugins. Rollback keeps the additive table while an N-1 application ignores it;
operators disable affected plugins through the Registry lifecycle without restarting
healthy nodes. Dropping the table is not a rollback path because it destroys package
and lifecycle evidence.

## Taxonomy Description Expand

`20260829-post-taxonomy-descriptions` additively creates nullable
`category.description` and `tag.description` columns as `varchar(500)`. Existing
rows remain `NULL`; no backfill or description index is required. Values are stored
as plain text, and the migration does not change the existing taxonomy name indexes,
public count/projection tables, or CategoryList/TagList wire payloads.

The descriptor is an online Expand with compatible-code rollback. An older release
ignores both columns, so rollback leaves them in place rather than dropping stored
descriptions.

## Author Article Pins Expand

`20260904-post-author-article-pins` is an additive, transactional Post-CodeFirst
Expand. It creates the sole private `author_article_pin_collection` and normalized
`author_article_pin` authority plus append-only receipts and an idempotency ledger.
The collection key is the authenticated admin-principal identity and configured
site scope; each member stores only the stable article ID, server-assigned bounded
order key, collection revisions, request/receipt references and SHA-256 digests.
The pin tables never copy title, slug, content or public ranking fields and never
write article metadata or public counters.

The collection owner has an `ON DELETE CASCADE` principal foreign key. Pin rows do
not hold an article foreign key: permanent article deletion must not be blocked by
a private navigation feature, and permission/lifecycle-safe cleanup is owned by the
downstream read projection. The trusted write boundary still fail-closes before a
new pin when the stable article ID is absent, deleted or in the deleted lifecycle
state. Owner/site advisory transaction locks serialize CAS and idempotency, and
authority snapshots take the same lock so collection revision, count, members and
digest come from one committed state.

No-restart rollback retains these additive tables while an older release ignores
them. Do not drop the ledger during the compatibility window; pause pin callers at
the authenticated server edge and preserve receipts for verification.

## Article Vault Execution Expand

`20260907-post-article-vault-execution` is an additive, transactional
Post-CodeFirst Expand. It creates the server-owned sealed execution-bundle table,
the group idempotency/result ledger, and the terminal execution-result table.
Primary and unique keys bind plan reference, site, Vault, plan digest, group and
result identities; digest checks reject malformed stored seals. Group and terminal
rows reference their sealed bundle with `ON DELETE RESTRICT`, so cleanup cannot
remove the execution authority while auditable outcomes remain.

The canonical article transaction persists a successful group receipt together
with article, revision, relationship, outbox and audit facts. A failed attempt is
recorded only after that transaction has rolled back: its `committed=false` group
receipt contains failed operations without outbox/audit references and is an
idempotency/audit-control fact, not a committed group or article mutation. A
terminal-result write may follow the group commit; replay recovers the immutable
group receipt and does not repeat the canonical writer.

No-restart rollback routes callers to compatible code and leaves all three
additive tables in place. Do not drop sealed bundles or ledgers during the N-1
window, and do not reconstruct missing terminal results by scanning or writing
local Vault files.

## Zero-Downtime Migration Qualification

Release migration qualification is an isolated Test-topology gate around the production
Expand/Backfill/Contract protocol. Its private plan supplies
`target.migrationServerDll` and
`migrationQualification.{scenarioTemplate,timeoutSeconds,expandMigrationId,backfillMigrationId,contractMigrationId}`.
The resolved template always contains exactly these ten scenarios:

| Order | Scenario | Required observation |
| ---: | --- | --- |
| 1 | Expand with old Active | old release is ready before Expand and still serves an AEDS read afterward |
| 2 | Blue/Green concurrent read/write | both direct origins read and perform bounded idempotent bridge writes with exact release headers |
| 3 | Backfill checkpoint/resume | pause is durable, resume token is hash-only, resume completes without row-count regression |
| 4 | Missing Expand | candidate qualification readiness returns 503 `schema_incompatible` |
| 5 | Contract during rollback window | command is rejected with previous-release/rollback-manifest issues |
| 6 | Qualified Contract | destructive command succeeds and a separate marker binds rollout/release with `rollbackCompatible=false` |
| 7 | Migration lock | real PostgreSQL advisory-lock timeout returns `schema_advisory_lock_timeout` |
| 8 | Database disconnect | isolated failed connection returns `schema_database_unavailable` |
| 9 | Partial Backfill failure | failed checkpoint and failure count persist, then resume reaches completed without regression |
| 10 | History integrity | checksum mismatch and unknown history record are both reported with a history hash |

`tools/deployment/rehearsal-schema-qualification-probe.mjs` is the repository-owned
adapter for fault/checkpoint operations. It runs only with
`ASPNETCORE_ENVIRONMENT=Test` and `FSUSBLOG_ROLLOUT_REHEARSAL=1`, rejects production-
like database IDs, and reads only a private env file. Blue/Green HTTP uses application
routes `POST /api/release-evidence/schema-bridge/write` and
`GET /api/release-evidence/schema-qualification/readiness`; these routes are absent
unless `SchemaMigration:QualificationEnabled=true` in the exact `Test` environment,
and still require admin `system.config` plus `fixed_ip`.

Before Contract, no-restart rollback is additive: keep the source Active, stop or
tear down the candidate, retain the bridge, and pause/resume the durable Backfill
checkpoint. During or after a qualified Contract, the marker is authoritative. If
`rollbackCompatible=false`, do not route an old image back to the modified database;
isolate writes and restore a verified backup or apply a forward repair with a
compatible retained release.

## 字段最终态表

## Final-state field table

The table below is the authoritative final-state inventory for legacy identity
columns that are either removed from the physical schema or retained only for an
explicit compatibility purpose. Keep it synchronized with
`src/migration/Definitions/`;
`tools/db/migration-doc-lint.mjs` fails when the definitions, catalogs, manifest,
and this table diverge.

| column | physical | code-mapped | kept-for | dropped-at-version |
| -------- | ---------- | ------------- | ---------- | -------------------- |
| `sys_user.username` | dropped | no | legacy password-login identity only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.password` | dropped | no | legacy password-login credential only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.role` | dropped | no | legacy role authority only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.lastusernameupdatetime` | dropped | no | legacy username rename throttle only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.last_username_update_time` | dropped | no | legacy username rename throttle only | 20260621-post-user-legacy-identity-columns-finalize |
| `sys_user.refreshtoken` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refreshtokenexpirytime` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refresh_token` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.refresh_token_expiry_time` | dropped | no | legacy plaintext refresh-token cleanup only | 20260602-post-user-auth-security-hardening |
| `sys_user.lastloginip` | dropped | no | legacy login observation only | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.lastlogintime` | dropped | no | legacy login observation only | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfasecretencrypted` | dropped | no | migrated to user_mfa_profile.mfa_secret_encrypted | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfapendingsecretencrypted` | dropped | no | migrated to user_mfa_profile.mfa_pending_secret_encrypted | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfapendingcreatedat` | dropped | no | migrated to user_mfa_profile.mfa_pending_created_at | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfaverifiedat` | dropped | no | migrated to user_mfa_profile.mfa_verified_at | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.mfarecoverycodeshash` | dropped | no | migrated to user_mfa_profile.mfa_recovery_codes_hash | 20260621-post-sys-user-security-profile-split-finalize |
| `sys_user.account_subject_hash` | present nullable during rolling expand | yes | stable account subject projection; startup gate requires every row populated | n/a |
| `comment.user_id` | present nullable | yes | explicit public attribution compatibility | n/a |
| `comment.reply_to_user_id` | present nullable | yes | legacy public reply projection | n/a |
| `comment.moderated_by_user_id` | dropped | no | renamed to comment.moderated_by_admin_principal_id | 20260621-pre-comment-moderation-admin-principal-attribution |
| `sys_visit_log.userid` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.user_id` | dropped | no | legacy human-read account binding only | 20260621-post-visit-log-anonymous-attribution-finalize |
| `sys_visit_log.ip` | dropped | no | replaced transitionally by sys_visit_log.ip_hash before full table retirement | 20260621-post-visit-log-ip-anonymization |
| `sys_visit_log` | dropped | no | event-level read trajectory table retired in favor of aggregate-only tables | 20260715-post-read-event-retirement |

## Legacy 20260517 Upgrade

The supported legacy baseline is the PostgreSQL dump profile captured on 2026-05-17. It contains the old tables `article`, `article_tag`, `category`, `comment`, `sys_message`, `sys_systemconfig`, `sys_user`, `sys_user_message`, `sys_visit_log`, and `tag`.

Before running this upgrade in production:

1. Create a full site backup with `tools/operations/backup-site.sh`.
2. Restore the backup or the legacy dump into an isolated PostgreSQL database.
3. Run `tools/db/verify-legacy-upgrade-20260517.sh` with `FSUS_LEGACY_20260517_DUMP_GZ` pointing to the local dump file.
4. Confirm the migration can run twice without duplicate rows in migration history, `article_body`, `article_view_seed`, `msg_conversation`, `msg_message`, or `msg_participant_state`.

The real dump test is not a member of ordinary `Category=Integration` execution.
Its only owner is the local-only `legacy-20260517-real-dump` producer. Before
invoking the verifier, set `FSUS_LEGACY_20260517_DUMP_SHA256` to the SHA-256 of
the decompressed custom dump and pin the local PostgreSQL image with
`FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE` plus
`FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID`. The producer fails before execution
when the enable flag, dump, source commit, or PostgreSQL image identity differs;
after execution it accepts only the exact test's TRX row with restore, two
migration runs, retained legacy counts, and postcondition evidence.

The migration expands safe columns before CodeFirst synchronization:

- `article.title`: `varchar(200)` to `varchar(256)`
- `article.summary`: `varchar(500)` to `varchar(512)`
- `sys_user.username`: legacy shorter length to `varchar(64)` before anonymous identity finalization; the post-CodeFirst finalizer drops this column.

The migration fail-fast checks shrinking fields before applying the current schema:

- `category.name` must be at most 128 characters.
- `tag.name` must be at most 128 characters.
- `sys_systemconfig.key` must be at most 64 characters.
- `sys_systemconfig.value` must be at most 512 characters after legacy `Page_*` and `sys:page:*` entries have moved to `page_content`.

If any shrinking field contains oversized data, the isolated legacy bootstrap fails with a message containing `Legacy 20260517 length check failed`, the table name, column name, affected row count, observed max length, and expected max length. Do not truncate production data in place. Export the offending rows, decide the canonical replacement values, update them explicitly, then rerun the isolated migration.

The upgrade also moves legacy content and messaging structures:

- `article.content` is copied to `article_body.markdown_content`, then the old column is dropped.
- `article.views` is copied to `article_view_seed.legacy_views`.
- `Page_*` and `sys:page:*` entries in `sys_systemconfig` are copied to `page_content`, then removed from `sys_systemconfig`.
- `sys_message` and `sys_user_message` are copied to `msg_conversation`, `msg_message`, and `msg_participant_state`, then the old tables are dropped.
- Message identity is finalized onto `initiatoraccountid`, `senderaccountid`, and `accountid`; `msg_conversation.initiatoruserid`, `msg_message.senderid`, `msg_participant_state.userid`, and the `*_identity_sync` trigger functions are dropped.
- Message schema ownership is recorded in [`message-schema-field-matrix.md`](message-schema-field-matrix.md). New code-first schemas and legacy backfills no longer create or populate the unused `attachmentsmeta` and `muted` fields; the prior messaging-split checksum remains accepted for databases where that historical descriptor already ran. `isinternalnote` remains server-only because it is an account visibility, pagination, and unread-count boundary, while `sourcemessageid` remains the unique system-notification idempotency coordinate.
- plaintext refresh token columns on `sys_user` are nulled and dropped.
- Legacy `sys_visit_log` rows are used only during the same migration transaction to seed aggregate counters, then the entire table and its projection watermark are dropped.

Rollback for this legacy bootstrap path is backup based and its mutation descriptor remains `non_compensable`. Production serve startup now performs read-only schema compatibility checks; it does not execute this legacy mutation path. If an isolated legacy bootstrap or an explicitly approved destructive Contract step fails, keep serving through the compatible image/bridge while it remains valid, or restore the pre-migration site package and database dump according to the online migration runbook.

## Rights V3 Schema Backfill

`20260704-post-article-rights-v3-schema` creates the durable Rights V3 tables documented in [Rights V3 Schema](rights-v3-schema.md):

- `article_rights_policy`
- `article_rights_snapshot`
- `article_rights_proof`

Within the isolated legacy bootstrap, the migration runs after CodeFirst so it can rely on the final `article` and `article_revision` table shapes. It backfills one default policy row for every existing article because historical articles had no editor-authored Rights V3 intent, then creates one rights snapshot for the latest revision of each article that already has revisions. The latest revision is selected by highest `revision_no`, then newest `created_at`, then highest `id`. Snapshot hashes are seeded with `rights-v3:policy-hash:recompute` and `rights-v3:content-hash:recompute`; later Rights V3 canonicalizer/proof work must replace those sentinels before treating the proof as ready.

The backfill is intentionally set-based and guarded by unique indexes, so repeating the isolated legacy bootstrap must keep row counts stable. Articles without revisions get a policy row only and wait for the write path to create their first snapshot. After the migration, create/update writes normalize omitted rights to the same defaults and store policy + revision snapshot + outbox `rightsSnapshotId` in one transaction.

This migration does not write or serve a legacy `rights.aeds` artifact. Public read outputs remain derived artifacts: PublicAOT HTML, article detail AEDS, PublicHotRead, feeds, sitemap, search, and asset manifests must be invalidated or rebuilt through the normal mutation/outbox/projector path after Rights V3 payloads become part of the public frame. Rollback is backup based; a no-restart degradation is to pause Rights V3 proof scheduling/retry while leaving existing public artifacts in place.

## Account Subject Physical Projection Cutover

This section is the sole migration authority for account-subject Expand, resumable backfill, completion queries, and the rolling-schema nullable boundary. The security consumer and failure semantics are in [Account Subject Physical Projection](security.md#account-subject-physical-projection); the permanent startup order is in [Production Startup Protection](architecture.md#production-startup-protection). This migration document does not duplicate request-time authentication rules.

The anonymous-account cutover preserves existing accounts and comments. `20260711-pre-account-subject-hash-expand` adds nullable `sys_user.account_subject_hash` so the old and new binaries can overlap during a rolling deployment. `20260711-post-account-subject-hash-backfill` then scans missing or malformed rows in `id` keyset batches of 256 and computes each digest with the same C# `AccountSubjectHasher` used by account creation. The migration intentionally does not duplicate .NET case-folding in PostgreSQL SQL, and it is non-transactional so an interrupted run resumes from rows that still need projection.

Before activating the new binary:

1. Drain writers running the previous binary, while keeping read traffic available.
2. Confirm both migration ids are successful in `__fsus_schema_migration_history`.
3. Run the exact completion query below; the result must be `0`.

    ```sql
    SELECT COUNT(*)
    FROM sys_user
    WHERE account_subject_hash IS NULL OR account_subject_hash = '';
    ```

4. Also confirm every non-null value matches lowercase SHA-256 hex: `account_subject_hash ~ '^[0-9a-f]{64}$'`.
5. Start the candidate and confirm startup task `accountSubjectHashInvariant=ok` before routing traffic.
6. Create one anonymous account with a public handle and one without a public handle; both rows must receive a physical digest before the account response is returned.

The column remains nullable only for rolling-schema compatibility. It is not optional to the new runtime: token issuance, account-state/blacklist caches, MFA step-up, binary auth and notification admission fail closed when the physical value is absent or malformed. The account snapshot cache namespace is `account:subject-v1:*`, so snapshots written before this projection are never accepted. The permanent startup gate reruns the count/format invariant even after migration history is complete, catching a stale writer that reintroduces null rows.

Rollback does not require a destructive data action. Route traffic back to the previous binary while leaving the additive column in place, correct or backfill affected rows, then retry the candidate. Do not delete projected values or reintroduce account-id-derived runtime fallbacks.

## Retired runtime fallback migrations

The following finalizers are current migration entry points for irreversible cutovers, not request-time compatibility switches:

- `20260709-post-site-subscription-hmac-finalize` fixes subscription identity to `hmac-v1`, isolates `sha256-legacy` rows, and asserts that the legacy count is zero; runtime security semantics are owned by [Authoring, comments, subscriptions, and telemetry](security.md#authoring-comments-subscriptions-and-telemetry).
- `20260418-post-content-cleanup` completes the `article_body` / `ArticleBody.MarkdownContent` read model. If the candidate lacks this history, it must remain out of traffic until the migration is supplied; it must not restore the `a.content` schema probe or `COALESCE` fallback.
- `20260709-post-clear-legacy-public-artifacts` clears legacy ArticleDetail AEDS artifacts once through `ClearLegacyPublicArtifactsStep`. The step is non-compensating and does not re-expose an admin manual-clear action; a missing current artifact uses rights recompute and the supported V3 rebuild.

Production history/count for these migrations remains release evidence; local source, passing tests, or an old issue status cannot replace external observation.

The anonymous account schema keeps `sys_user` as its account container:

- physical `username`, `password`, `role`, `lastusernameupdatetime`, and `last_username_update_time` are dropped by `20260621-post-user-legacy-identity-columns-finalize`; they are not mapped by the `User` entity and must not appear in restored final-state schemas.
- `public_handle` is nullable and uniquely indexed when present.
- `identity_kind` defaults to `anonymous_account`.
- `passkey_enabled`, `recovery_enabled`, and `privacy_initialized_at` record whether the new non-password identity setup has been initialized.
- `anonymous_credential_level` and `anonymous_credential_status` provide a compact projection point for later credential-policy work.

`20260621-pre-sys-user-security-profile-split` creates `user_mfa_profile`, copies existing TOTP secret, pending secret, verified time, and TOTP recovery-code hash out of `sys_user` before CodeFirst sync, then drops `sys_user.lastloginip`, `sys_user.lastlogintime`, and the old `sys_user.mfa*` material columns. `20260621-post-sys-user-security-profile-split-finalize` repeats the old-column drop after legacy post-CodeFirst compatibility migrations, so older descriptors cannot reintroduce pending MFA columns. New login observation remains on `sys_user_session.last_ip` or security/audit event dimensions; `sys_user` must not store raw login IP or last-login timestamps.

Rollback is backup based for dropped `sys_user` columns. A no-restart degradation path is to temporarily stop user-side TOTP mutations at the edge or switch affected sensitive-action policy to require Passkey/Recovery Key step-up while preserving read-only account/session access; do not recreate `lastloginip` or write TOTP material back to `sys_user` in a live schema.

When `FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1` is enabled, application code must not treat legacy `username/password` or `role=admin` as identity, credential, or authority sources for these rows, and must read TOTP material only from `user_mfa_profile`. The legacy identity columns are absent after the finalize migration; rollback is backup based by restoring a pre-finalizer dump into an isolated database.

## Content AssetId Cutover

`20260826-post-content-asset-id-cutover` is an exclusive, transactional one-time Contract migration. In one transaction it creates `content_asset`, `content_asset_reference`, and `content_asset_cleanup_queue`, then enumerates the complete asset set from current articles, drafts, revisions, legacy references, and the public asset root. Each file must have byte length, SHA-256, MIME/extension, and image dimensions recomputed on site; missing files, unresolvable local URL/media, or storage-key/hash conflicts list the locating key and roll back the entire migration.

`20260828-post-authoring-canvas-document` is an additive, transactional
Post-CodeFirst Expand migration. It creates normalized private canvas document,
node, frame membership, edge, receipt, and idempotency tables; closed checks,
owner/site index, document-scoped foreign keys, and digest constraints follow the
[authoring canvas document boundary](architecture/authoring-canvas-document-boundary.md).
This migration does not copy article content, create article/relation/property
foreign keys, or import transient graph positions.

An existing asset record retains its `AssetId`. Otherwise, only a canonical N-format UUID filename reuses that UUID; D-format and other filenames receive a new deterministic ID from the exact storage key and content digest, so a rolled-back attempt generates the same ID on retry. Final reference edges are rebuilt only from current source content. Legacy cleanup due/retry/error states move to the AssetId queue, while assets still referenced at the end are cancelled and returned to `active`. After verification, the migration drops four URL-identity legacy tables; runtime does not dual-write, create view/trigger aliases, or rescan the old structure when a new-table row is missing. Rollback can restore only a verified pre-cutover backup/WAL into an isolated environment; it must not rebuild URL-identity tables in the live schema.

## Read Event Retirement

The older `20260621-*` and `20260715-pre-visit-log-ip-pseudonym-epoch` descriptors remain replayable so an installation can upgrade from any supported history checksum. They are transitional only; `sys_visit_log` is not part of the final schema.

`20260715-pre-read-event-retirement-compat` creates an empty compatibility table when a fresh database has no legacy table, allowing older descriptors to replay deterministically. After all older backfills have run, `20260715-post-read-event-retirement` executes in one transaction:

```sql
UPDATE daily_read_stats SET unique_viewer_estimate = 0;
DELETE FROM region_read_stats;
DELETE FROM author_route_stats;
DELETE FROM author_daily_read_stats;
DROP TABLE IF EXISTS article_view_projection_watermark;
DROP TABLE IF EXISTS sys_visit_log;
```

CodeFirst creates only `article_read_hourly_aggregate` and `read_dwell_daily_aggregate` for the new read path. The processor also increments the existing daily/event-type counters, but no table contains viewer/proof/device/IP/UA identity, route sequence, exact request timestamp, or exact dwell milliseconds.

Rollback without restarting is `HumanReadProof:Mode=paused`: content remains readable while new counting stops. Do not shift traffic to a build that recreates `sys_visit_log`; a destructive rollback requires restoring a verified pre-migration backup into an isolated environment, never into the live schema. Cross-media deletion and backup/WAL verification continue under [historical raw-IP lifecycle](security/ip-anonymization-lifecycle.md), extended to reject event-level read trajectory fields.

## Message Account Principal Finalization

Message center schema finalization removes the migration-only bridge between legacy user ids and anonymous account ids. `20260620-post-message-account-principal` backfills account/admin-principal columns from older message rows, and `20260621-post-message-legacy-identity-columns-finalize` immediately removes the compatibility surface:

```sql
DROP TRIGGER IF EXISTS trg_msg_conversation_identity_sync ON msg_conversation;
DROP TRIGGER IF EXISTS trg_msg_message_identity_sync ON msg_message;
DROP TRIGGER IF EXISTS trg_msg_participant_identity_sync ON msg_participant_state;
DROP FUNCTION IF EXISTS public.fsusblog_msg_conversation_identity_sync();
DROP FUNCTION IF EXISTS public.fsusblog_msg_message_identity_sync();
DROP FUNCTION IF EXISTS public.fsusblog_msg_participant_identity_sync();
ALTER TABLE msg_conversation DROP COLUMN IF EXISTS initiatoruserid;
ALTER TABLE msg_message DROP COLUMN IF EXISTS senderid;
ALTER TABLE msg_participant_state DROP COLUMN IF EXISTS userid;
```

The final message tables must carry account identity only through `msg_conversation.initiatoraccountid`, `msg_message.senderaccountid`, and `msg_participant_state.accountid`; admin-originated rows use the dedicated admin-principal columns. Rollback without restarting the application is backup based. Do not recreate the sync triggers in a live schema; pause message writes at the edge or restore the pre-migration snapshot for forensic analysis.

## Authoring Admin Principal Attribution

Fresh databases create authoring workspace tables directly with the final admin-principal attribution columns:

```sql
article_draft.owner_admin_principal_id
article_revision.created_by_admin_principal_id
```

The legacy columns `article_draft.owner_user_id` and `article_revision.created_by_user_id` are migration-only inputs. `20260621-pre-authoring-admin-principal-attribution` renames them when possible, copies them into the final columns when both shapes exist, drops the old columns, and recreates the durable `idx_article_draft_admin_principal_key` index. A second migration run must leave only the final admin-principal columns.

Rollback without restarting the application is backup based. Do not recreate the old `owner_user_id` or `created_by_user_id` columns in a live schema; pause admin authoring writes or restore the pre-migration snapshot for forensic analysis.

## Comment Attribution Index Finalization

The comment schema keeps `comment.user_id` and `comment.reply_to_user_id` only as explicit compatibility fields for public attribution and legacy reply projection. Admin moderation records use `comment.moderated_by_admin_principal_id`; default anonymous and strong-anonymous comment paths must not query, authorize, or recover comments through account-bound columns.

Fresh databases create `comment.moderated_by_admin_principal_id` directly. Historical `comment.moderated_by_user_id` is accepted only as a migration input: the compatibility migration renames or copies it into `moderated_by_admin_principal_id`, then drops the old column. Final schema validation and integration tests assert the old moderation column is absent after idempotent migration replay.

`20260621-post-comment-attribution-index-finalize` drops the old generic `idx_comment_user_id_desc` index and creates `idx_comment_attributable_public_user_id_desc`:

```sql
CREATE INDEX IF NOT EXISTS idx_comment_attributable_public_user_id_desc
ON comment(user_id, id DESC)
WHERE author_mode = 'public' AND user_id IS NOT NULL;
```

The older `20260418-post-comment-threading-indexes` descriptor is left immutable because applied migration checksums are verified at startup. New or restored databases may briefly create the old index while replaying legacy descriptors, then the finalizer removes it in the same migration run.

Rollback without restarting the application is limited to the database index shape: recreate `idx_comment_user_id_desc` manually only if an emergency query plan regression is confirmed, then remove it again before reenabling anonymous-comment write traffic. Do not use that fallback to reintroduce default anonymous user-bound queries.

## Comment Moderation Queue Lease

`20260720-post-comment-moderation-queue-lease` is an additive, non-transactional post-CodeFirst migration. It creates `comment_moderation_queue_claim` with one current row per comment, hashed claim tokens, owner, lease/SLA timestamps, note, escalation state and monotonic generation. The four indexes are created with `CREATE INDEX CONCURRENTLY`: expired-lease recovery, owner lease lookup, the partial pending/borderline queue index `(create_time, id)`, and the pending-appeal queue index.

The migration is safe to retry. Runtime claim takeover uses `INSERT ... ON CONFLICT ... WHERE` and can replace only released/expired leases or an active lease whose expiry boundary has passed. Deployment gates are: invalid-index check in `pg_index`, queue `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` showing bounded keyset work, and claim conflict/expiry integration tests. Observe index bytes, `n_tup_upd`, dead tuples and autovacuum cadence after rollout; the claim table intentionally isolates lease write amplification from the large `comment` table.

No-restart degradation is to stop issuing new claims at the edge and continue read-only queue inspection while existing leases expire. Rollback drops only the four new indexes concurrently; the additive table remains through the N-1 window so an older process cannot lose in-flight ownership evidence. A later destructive cleanup may drop it only after rollback eligibility ends and a backup is verified.

## Physical terminal graph diagnostics

The existing `tools/db/check-migration-terminal-governance.mjs` diagnostic follows
literal, repository-owned physical `ProjectReference` declarations from Server,
Migration and Shared, rejects transitive forbidden edges and cycles, and binds
complete project and C# source bytes rather than a prefix. Symlinks, escaping or
missing references, conditional/computed declarations and explicit imports cannot
stand in for an evaluated SDK graph. Its targeted literal/constant loading scan
does not prove arbitrary C# semantics, generated code or dynamic runtime loading.

A clean physical graph does not qualify terminal acceptance. The existing CLI
refuses to write an acceptance receipt without evaluated compile/runtime assets,
compiled loading, nonempty published output, independent PostgreSQL/MySQL/SQLite
provider results, mutation results and an evaluable benchmark. Source/model tests
do not supply those observations. These diagnostic changes neither replace the
current migration operation/fact producers nor alter database migration behavior.

# System installation identity

## Source contract

`SystemService` is the sole installation identity owner. `SystemConfig` remains
the storage authority; Package, Graph, SEO and Vault do not mint this identity.
The canonical identifier is `fsus-site:` followed by 64 lowercase hexadecimal
characters from 32 bytes of server cryptographic entropy. It satisfies the
existing ArticleRelation actor validator without deriving authority from a URL.

`ISystemSiteIdentityReader.ReadCurrentSiteIdentityAsync(CancellationToken)` is a
zero-write, uncached read. It takes no identity assertion. Only `Current` exposes
an authoritative identity, schema version, installation generation, mapping
revision and exact active URL scopes. Absence, legacy migration requirement,
ambiguous journals, malformed records and unsupported versions fail closed.
Storage and cancellation failures propagate; they never become a default ID.

## Trusted lifecycle operations

These are in-process methods on the existing SystemService authority, with no
HTTP route and no DI registration added here. The original #3735 owner must bind
the reader to the existing service and review invocation ownership separately.
Possession of arbitrary server code or database administrator privileges is
outside the ordinary editable-configuration threat boundary.

Every mutation requires the caller's actual PostgreSQL READ COMMITTED transaction.
It borrows that transaction, never commits it, takes a table-level storage lock,
and uses an operation savepoint so failure rolls back only its own writes.
Caller cancellation reaches commands; bounded uncancelled savepoint cleanup is
only for preserving the caller transaction after failure. Clients sharing a
single SqlSugar connection must obey its existing single-operation ownership;
independent transactions serialize at PostgreSQL, across processes and restarts.

- `InitializeSiteIdentityAsync(intent, scope, cancellationToken)` accepts only a
  genuinely empty public schema. It locks public tables against writes before
  checking contents. Schema/migration ledgers or seed data that are nonempty
  require explicit migration; no guessed exemption list is used.
- `MigrateLegacySiteIdentityAsync(intent, reviewedLegacyScope, cancellationToken)`
  requires a nonempty legacy deployment with no identity journal. The trusted
  operator explicitly binds one reviewed historical scope. Additional reviewed
  aliases use versioned mapping operations. No URL, database name, fixture,
  imported source or SEO value selects the target identity.
- `ChangeSiteIdentityScopeAsync(intent, expectedGeneration, expectedRevision,
  scope, add, cancellationToken)` appends an exact validated add/remove event.
  It refuses stale coordinates, duplicate adds, absent removals and removal of
  the last scope. URL edits alone leave the identity and mappings unchanged.
- `CloneSiteIdentityAsync(intent, expectedGeneration, expectedRevision,
  independentScope, disposition, cancellationToken)` requires the explicit
  `RetainAsForeign` disposition and a scope never claimed in the retained journal.
  It appends a new installation generation with fresh entropy and records its
  predecessor. All old scoped facts and mapping history remain associated with
  the predecessor, foreign to the new installation; none is rewritten or granted
  to the clone. Reassignment of those facts needs separate compatible migration.

An intent is a nonempty Guid used only for idempotency, not a credential. Exact
replay returns the persisted result; the same intent with changed input refuses.
Different initialization intents cannot replace an existing identity. Replay of
a superseded operation refuses rather than returning a later identity as the
original result. Restoring a backup to continue the installation preserves all
rows and needs no mutation. Clone versus continuation is never inferred.

## Bounded journal

Protected keys use only `SiteIdentity_Installation_0000000001` and
`SiteIdentity_Scope_0000000001_0000000001` forms. Each immutable installation
record stores schema `1`, identity, intent, SHA-256 request digest, creation kind,
predecessor or `-`, and old-fact disposition or `-`, separated by `|`. Each scope
record stores schema `1`, intent, request digest, `Add`/`Remove`, and exact scope.
Keys are at most 46 characters and values at most 512; scopes are capped at 256
ASCII characters and validated absolute HTTP(S) URLs without credentials, query,
fragment, whitespace, controls or the record delimiter. Values are never trimmed
or normalized. All numeric key components must be the canonical ten-digit form.

Parsing checks every retained record, contiguous generations/revisions, intent
uniqueness, predecessor links, schema versions, ID format and legal transitions.
There are at most 16 generations and 1024 scope events per generation. Exhaustion
refuses further mutation and requires reviewed schema evolution; history is never
silently truncated. No runtime DDL or new table/catalog is required.

## Configuration and compatibility boundary

At inspected master `9d72a1c93b297f719d8695a642cdfb1615cf1d51`, the only
SystemConfig runtime writers are `UpdateSeoConfigAsync` and
`UpdateSiteComplianceConfigAsync` in SystemService.cs. Both build closed constant
key sets from typed requests; the binary system routes pass those typed requests.
`UpdatePageContentAsync` writes PageContent, not SystemConfig. There is no generic
arbitrary-key SystemConfig update/delete route in that source. Those ordinary
operations cannot forge, overwrite, delete or reset this protected prefix. A
future generic writer must explicitly exclude the entire prefix before admission.
Privileged offline migration and arbitrary DBA writes are separately trusted and
can damage any installation data; this API does not claim to prevent them.

Existing permission/export URL SiteScope and old records remain unchanged.
An explicit compatible consumer binding must check the authoritative generation
and mapping revision and exact approved scope. The reader is source-ready for
independent Package/Graph security and compatibility review, not proof that the
downstream chain or deployment has been accepted. #3735, #2406, #2418 and #2474
remain open.

## Acceptance work

Operators still owe a reviewed historical-scope inventory and real mapping input,
and an explicit continuation/independent-clone decision for restored deployments.
No production initialization, migration, backfill, deployment, credential or
access allocation is authorized by this source change. Rollback means rolling
back the caller transaction before commit; committed identity history must be
preserved when reverting application code.

The shared documentation owner must register this path in the existing lifecycle
catalog and run its existing generator. This task does not take a write claim on
that shared catalog or generated index.

## Validation

The original `tests/backend/FsusBlog.Server.Tests.csproj` builds with the repository
dependency versions. The source method roster and original xUnit discovery both
contain exactly 19 selected methods: six in SystemSiteIdentityTests and thirteen
in SystemSiteIdentityIntegrationTests. The original PostgreSQL fixture collection
`SchemaMigrationPostgresCollectionB` uses `postgres:18-alpine`; the task run limits
its disposable container to 1 CPU, 512 MiB and 256 processes. All nineteen methods
passed with no failures or skips, and the TRX roster was compared against the exact
source method roster. No substitute persistence harness or broad test selector was
used. These focused results do not establish full-matrix or deployment acceptance.
The original SystemService configuration-loader regression
`ConfigLoadQueries_UseServerSideKeySetsWithoutReadingPrivateConfigRows` was
separately discovered as exactly one method and passed on the same original
PostgreSQL fixture.

The persistence tests cover restart/readback, eight concurrent initializer
transactions, intent collision and superseded replay refusal, caller rollback,
second-insert failure with savepoint recovery, cancellation while actually waiting
on PostgreSQL's storage lock, wrong transaction isolation, storage errors, legacy
content refusal, explicit migration, ordinary SEO/compliance/page edits, mapping
version drift, database field length enforcement, and continuation versus clone.
The unit tests exercise malformed IDs/digests/scopes, unknown versions, oversized
records, orphan/unknown keys, revision gaps, duplicate intents and invalid operator
input. Controlled fixture IDs exist only in unit inputs; production creation uses
server cryptographic entropy.

The document lifecycle check remains blocked by the shared catalog registration
above. The backend test governance check reports stale shared evidence metadata,
an existing mutation-runner root-discovery requirement and existing path-discovery
violations in ArticlePropertyDefinitionAuthorityTests and
DocumentExportBinaryCodecTests. Its relevant input files are unchanged from the
inspected base. These source gates are not reported as passing, and this task does
not edit their shared producers or generated output.
The code-intent checker separately reports a pre-existing unbounded performance
claim in `src/frontend/wasm/aeds/include/font_theme_admin_pods.hpp:338`, an unchanged
file outside this task. The authoritative development-document checker and commit
message checker pass; those results do not waive the failing source gates.

The PostgreSQL collection checker also finds the new integration class missing
from its shared manifest, alongside pre-existing missing classes and estimated
case-count drift (A: 331 declared versus 355 in registered source; B: 458 versus
513). The new class contributes thirteen cases to B. Its owner must register it
and reconcile the original manifest before further test execution; tests were
stopped when this additional shared preflight failure was discovered. The focused
passing run's exact-method discovery count is separate from this shared catalog
failure and cannot qualify it.

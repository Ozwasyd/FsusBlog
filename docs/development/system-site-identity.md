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
revision and exact active URL scopes. `InitializationRequired` reports a canonical
bootstrap awaiting explicit scope input, with no identity authority. Absence, legacy migration requirement,
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

- `InitializeSiteIdentityAsync(intent, scope, cancellationToken)` requires the
  immutable `SiteIdentity_Bootstrap` record issued only by the original
  `PgCurrentSchemaBootstrapOperation` after its actual empty-source admission,
  complete canonical schema creation and mandatory seed checks, in that same
  caller transaction. The record is retained after initialization. A bare empty
  configuration table is insufficient; canonical seeds do not require guessed
  exemptions. Bootstrap records do not contain an installation ID or credential.
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

Protected keys include `SiteIdentity_Bootstrap`, `SiteIdentity_Installation_0000000001` and
`SiteIdentity_Scope_0000000001_0000000001` forms. Each immutable installation
record stores schema `1`, identity, intent, SHA-256 request digest, creation kind,
predecessor or `-`, and old-fact disposition or `-`, separated by `|`. Each scope
record stores schema `1`, intent, request digest, `Add`/`Remove`, and exact scope.
The bootstrap record stores `1|Fresh|sourceRevision|ownedInputDigest|commandDigest`:
source revision is exactly 40 lowercase hexadecimal characters, both digests are
exactly 64. Only the real empty-source component issues it; the generic compiler,
legacy target preparation and runtime startup do not. Fresh roots require this
record; Legacy roots forbid it. Unknown keys and malformed provenance refuse.
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
The reachable capability-gated `PgLegacyNonArticlePreparation.MigrateAsync`
previously imported every non-page SystemConfig row with conflict replacement.
It now refuses any staged-source `SiteIdentity_` record before compiling or
executing imports, including a valid journal or bootstrap record. This generic
legacy import has no continuation/clone lifecycle grant and never silently skips
protected records. Ordinary unprotected configuration remains losslessly copied.
Whole-database continuation restores preserve the journal and provenance together;
independent clones require the explicit guarded SystemService operation. Arbitrary
privileged DBA/server code remains outside this boundary; trusted offline tooling
is still required to obey its explicit lifecycle contract.

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

The document is registered through the original lifecycle catalog and generator.

## Validation

The original `tests/backend/FsusBlog.Server.Tests.csproj` builds against the
repository dependency versions. The source roster remains exactly six unit
methods and thirteen integration methods, with no broad or empty selector.
Integration setup consumes the actual original current-schema producer and
`PgCurrentSchemaBootstrapOperation` on the original disposable PostgreSQL fixture,
including mandatory canonical seeds. Controlled component verifier inputs are
not a production migration-host grant or deployment acceptance.

The repaired tests cover zero-write reads, genuine bootstrap provenance and bare
empty-table refusal, restart/readback, eight concurrent initialization
transactions, intent conflict/superseded replay, caller rollback, second-insert
failure, cancellation while waiting on a real storage lock, wrong isolation,
storage failure, explicit legacy binding, ordinary SEO/compliance/page edits,
version drift, malformed/oversize records and continuation/clone distinctions.
They exercise the original legacy fixture and original staged importer: ordinary
configuration remains lossless, while supplied valid legacy journals and genuine
bootstrap records refuse before import. Restore coverage copies the protected
journal and a representative old scoped fact; it is not a complete database
backup/recovery qualification.

The earlier 19 identity methods plus one original SystemService regression
executed and passed before all required admission checks had succeeded; those
results remain unqualified and do not cover the repaired test bodies. For this
repair, the canonical #3657 manifest closure independently passes its checker
(124 classes, 972 source-estimated cases, A411/B561) and all eleven original Node
controls. Document lifecycle registration and backend source-size checks pass.

The original backend-test-governance preflight now passes after consuming the
reviewed canonical mutation caller validator and the two original test path
fixes. Its evidence-path inventory is refreshed only through the unchanged
original producer; no supplier inventory is copied. These source results do not
qualify runtime execution. After the exact canonical borrowed-range comment
fix, the original code-intent checker also passes (5495 checked files and 19
registered source files).

The real producer fixture consumes the original execution-envelope directory
owner's exported `TMPDIR`, `TMP` and `TEMP` ingress, and refuses missing or
inconsistent ingress. Its artifacts stay under the current attempt's managed
temp root until the original owner records the post-inventory and performs
terminal cleanup. Environment consistency alone is not resource authority; tests
must use the original managed owner, without manufacturing a lease or receipt.
The original read-only resource capability checks refuse this environment:
cgroup v2 is present but its actual delegate root is not writable, and the
original systemd resource transport cannot find `/run/user/1000` (`ENOENT`).
No live managed boundary, container reservation or private attempt directory
authority was issued; explicit environment values cannot replace them.
The repaired 6+13 methods and original regression remain `UNRUN` pending actual
resource admission and
remaining gates. No failing prerequisite is waived or replaced with a harness.

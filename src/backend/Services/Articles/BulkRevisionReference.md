# Original lifecycle writer bulk revision reference source

Exact prerequisite is c1900f2d64b7dcb4d71f9aa78fa93770161a6cf7. Its original
ArticleStatusValues.Inbox, previous_editable_status, Token projection and
PrepareEditableTransitionAsync/CommitEditableTransitionAsync already implement
Draft/Inbox transitions, Inbox archive and Archived restore to the recorded source.
This increment consumes that actual open donor; unmerged is not absent. The separate
Deleted-to-Published RestoreAsync is not substituted. Existing writer source changes
only its partial modifier; all original enum/policy/facade/permissions remain intact.

## Actual source and token owner

No Bulk opaque revision token producer/resolver exists in c190. The read-only
reviewed b2607842642a584781ea2d17d93a48d552c37a3e adapter still parses
ExpectedRevision as a positive integer. Its source is not copied or changed here.
Pin/query projection references are owned by their original projection contracts;
they are not Bulk lifecycle references and are not reinterpreted as admission.

New internal methods live in the sole ArticleLifecycleTransitionWriter partial:
CaptureBulkRevisionReferenceAsync, ResolveBulkRevisionReferenceAfterLockAsync and
PrepareEditableTransitionFromBulkRevisionAsync. No new abstract authority, store,
DI registration, endpoint, available adapter or IArticleBulkPreflightAuthority
replacement is introduced.

Capture reads actual joined article/current article_revision rows on the caller's
exact original NpgsqlTransaction and open native connection. It binds actual article
ID, revision ID/no, both xmin row versions, closed status, isdeleted, nullable
PreviousEditableStatus, content-block pointer, publication pointer and schedule.
A fixed domain/schema/writer identity and the original ArticleBulkDigest encode a
bounded opaque string; nothing parses ExpectedRevision as a long or normalizes it.
Unknown/legacy provenance stays null. It is a deterministic data reference, not a
signature, issue receipt, permission, document lock, side-effect or commit proof.
An actor who knows these facts can compute the same reference; genuine original
plan/frozen-set/admission and independent verification are still required.

Token text deliberately excludes native transaction identity so an authenticated
frozen plan may compare it in a later execution transaction. Locked resolution
rereads exact current facts under FOR UPDATE OF article and FOR SHARE OF revision,
requires identical token text and mints a private service-owned resolution object.
ConditionalWeakTable binds that original object to the exact original SqlSugar
client object, native transaction and observed facts. A fabricated object, different
db/transaction, consumed/failed object or ended native transaction cannot invoke
the preparation path. No borrowed transaction/connection is opened, closed,
committed, rolled back or disposed.

Preparation consumes that object once, reobserves the locked original facts, takes
the real revision ID from the database mapping and invokes the existing c190
PrepareEditableTransitionAsync. Its real original single-article authorization,
CAS/status/provenance/source/asset checks remain active. Returned preparation and
facts are checked again after awaited original checks. Failure/cancellation poisons
the resolution and propagates; this never declares zero writes or native rollback.
The original CommitEditableTransitionAsync remains the sole actual execution path
and retains its same-transaction and current authorization/CAS/policy checks.

This component captures only declared revision/provenance coordinates; it does not
verify all immutable body/policy/audit bytes or resist a privileged DB rewrite and
reseal. Ordinary view writes can change article xmin and therefore invalidate the
reference. Same-transaction writes retain xmin; declared status/pointers/provenance/
schedule fields are checked separately, and full command checks remain original
writer obligations. Caller serializes use of its native scope and locks whole sets
in numeric order; this per-article reader does not grant whole-set admission or
qualify lock concurrency, deadlocks, repeated/interrupted flows or cleanup.

## Held original admission and integration

The original Bulk actor/session/site authority must produce and revalidate actual
Actor.AuthorityDigest and live complete scope. Original operation/dependency
snapshot, frozen-set permissions, draft/document/unsaved-state locks, idempotency,
signed audit and native commit/abort/unknown/postcommit verification remain separate
original-owner inputs. A revision reference or successful single-article preparation
does not supply those facts. Full IArticleBulkPreflightAuthority.ObserveAsync remains
unimplemented/unregistered until those inputs exist; no Permitted=true is fabricated.

The original adapter owner can later consume this exact source by passing the
frozen opaque reference to locked resolution and original preparation, preserving
original plan/actor/operation identity. This task does not patch its adapter, merge
its PR or guess its commit. Actual source/dependency acceptance must be supplied
by the coordinating parent before consumption.

ArticleBulkRevisionReferenceTests adds ordinary opaque identity/provenance/drift/
numeric rejection source controls; UNRUN and uncompiled. All DI, database connection/
application, tests/discovery/import/runtime, frozen schemas/catalogs/fixtures/receipts
and qualification remain HOLD. Static compilation is not native/runtime/operation
acceptance. Original #3735/#3736/#3738 remain WIP.

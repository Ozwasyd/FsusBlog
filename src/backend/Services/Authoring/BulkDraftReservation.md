# Original draft group persistence capability

This source extends the existing AuthoringDraftLifecycleService with internal
LockBulkDraftsAsync and StageBulkDraftMetadataCasAsync. Existing public
IAuthoringDraftLifecycle signatures, Save/Get/Discard semantics, DI registration,
canonical writer, wire contracts and every frozen output stay under their current
owners. No new abstract authority, Vault identity or availability grant is added.

## Actual same-transaction data path

The original group producer passes its exact NpgsqlTransaction and original
ArticleBulkExecutionRequest/ArticleBulkPlan/ArticleBulkPlanAuthority. Integrity,
request self-hash and original execution identity field order are checked; full
actor/site/policy/source/plan/frozen member identity is retained. No replacement
execution key or expected-revision algorithm is invented. Numeric article/admin
IDs must retain the exact canonical original spelling; Unicode scalar identities
are checked before hashing. This binding is not permission or admission.

The concrete draft owner verifies ReferenceEquals against SqlSugar's current
native transaction and the same open native connection before and after awaited
operations. It does not begin/commit/rollback/dispose transactions or open/close
connections. Article rows are locked in numeric order. PostgreSQL SHARE ROW
EXCLUSIVE on article_draft is a conservative whole-table write fence: existing
SaveDraftAsync/InsertDraftAsync/UpdateDraftWithCasAsync, Create persistence,
DiscardDraftAsync and ArticleDeletionKernel writes cannot insert/update/delete a
phantom draft while the native transaction holds it. This serializes unrelated
draft writes; lock contention/deadlocks and scale remain untested. Lock failures
are raw failures, never proof of zero writes.

Draft sets are bounded to10000 rows/16MiB before ORM materialization, with a
second byte/count/owner check afterwards. Foreign-owner drafts reject the group
without exposing private contents. Immutable revision/content/rights/responsibility
packages have a separate aggregate16MiB read budget. Snapshot/reservation data
is private to the original service instance through ConditionalWeakTable; a token
constructed elsewhere or consumed/failed token cannot stage updates. Native
transaction lifetime belongs solely to the real original group owner.

Before any draft CAS, every result must match the captured before article and
current after article/revision/status/schedule/delete coordinates. Original
outbox and canonical-lifecycle audit rows must exist for the real actor/result
references; row existence does not verify signatures or native commit. Full
before/after immutable revision metadata and source are read using the original
ArticleRevisionContentBlockStore.LoadAsync, not merely a content digest. They
must be byte-equal. Same-revision rights policy fields must match; responsibility
business facts must be preserved and a new clone must link to the actual prior
snapshot. Presentation publication snapshot pointers are not used for admission.

A draft advances only if its base revision/status/schedule and full metadata/source
match the locked before revision. Dirty or stale drafts reject, preserving their
bytes. Rights JSON must be the exact complete canonical original serialization
of an explicit custom policy and match all11 snapshot policy fields. Invalid,
duplicate/unknown/missing fields, site mode or noncanonical JSON reject; there is
no catch-and-default normalization. Site mode requires the real site-policy
producer before support can expand. Raw rights/source/client fields are retained.
Only base revision/status/schedule, generated update time and server revision
advance through the original UpdateDraftWithCasAsync. The generated UTC time is
represented at PostgreSQL timestamp microsecond precision. Exact CAS readback is
checked. Partial staging/cancellation/error poisons the token and requires the
original owner to abort/observe its transaction; successful staging is not commit.

## Exact inputs still missing from the original group producer

- ArticleBulkProductionAuthorities.cs: UnavailableArticleBulkPreflightAuthority
  implements IArticleBulkPreflightAuthority.ObserveAsync by throwing. It provides
  no real mapping from opaque ArticleBulkPlanItem.ExpectedRevision to the locked
  article.current_revision_id/revision_no or operation-specific lifecycle facts.
  The original preflight/execution owner must supply and revalidate that exact
  mapping and true whole-set actor/session/site/operation permissions. Merely
  passing a sealed plan or an ambient transaction supplies neither fact.
- AuthoringUseCasePorts.cs: IAuthoringDraftLifecycle.SaveDraftAsync/GetDraftAsync/
  DiscardDraftAsync operate on owner/draft key and server revision; Save/Discard
  own independent transactions. The new internal methods genuinely reuse their
  concrete persistence owner, not those standalone transaction entry points.
- Entities/Article.cs: ArticleDraft has article_id, draft_key, base_revision_id,
  client_revision and server_revision. It has no server article document ID,
  editor/session revision, dirty/unsaved-state epoch, lock/lease ID or ownership
  fence. ClientRevision is caller text, not a verified server document revision.
- AuthoringCanvasDocumentStore.cs: IAuthoringCanvasDocumentStore.GetAsync reads a
  Canvas header. MutateAsync/RequireHeaderAsync/EnsureExpectedRevision CAS the
  authoring_canvas_document revision inside ExecuteTransactionAsync's own
  transaction. AuthoringCanvasOperationEngine is the Canvas operation owner.
  Neither supplies article editor admission in the caller's native transaction.
  The original Document/Write owner must provide a real server observation of
  (article,draft,document,editor session,document revision,unsaved-state epoch,
  lock/lease/fence owner) bound to this original actor/site and exact native scope,
  plus revalidation before commit. No server source/table for these article editor
  facts exists in the checked master29051db2; no placeholder grant is introduced.
- ArticleLifecycleTransitionWriter.Result is concrete writer data, not an opaque
  accepted group/native-commit proof. The original transaction owner must supply
  actual results in this native transaction, preserve original idempotency and
  signed audit obligations (including draft mutation coordinates), stage original
  result storage and independently observe abort/commit/unknown and required
  cache/publication/search completion. Existing CanonicalCommandOwners still
  declares bulk adapters Unavailable; this source changes none of that.

Ordinary AuthoringBulkDraftPreservationTests source adds dirty/full-source/rights
negative controls. It remains UNRUN and uncompiled under the explicit test hold.
Native isolation, concurrent inserts/deletes, interrupted/partial/repeated flows,
readback timestamp parity, audits, permissions and real database acceptance remain
unverified. Compilation/style is SOURCE/STATIC evidence only. No DI, database,
application import, tests/discovery, runtime, schema/catalog generation or frozen
qualification workload is authorized here. #3735/#3736/#3738 remain WIP.

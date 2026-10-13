# Original group locked persisted facts

The unregistered `ArticleBulkEditableLifecycleGroupAuthority` implements a real
persisted prerequisite stage for the existing group contract. `PrepareReserveFactsAsync`
and `RevalidateReserveFactsAsync` read actual original caller, revision and draft
facts in the caller's existing native transaction. They do not return an
`IArticleBulkEditableLifecycleGroupReservation`, create an admission digest or
authorize a whole-set mutation. `MaximumAtomicItems` remains0. The existing
`ReserveAsync` contract explicitly refuses missing document/editor admission
before acquiring any new native resources, invalidates this instance and returns
no reservation/outcome. No DI/availability or adapter registration is added.

## Actual input and native lifetime

The stage requires the original current HttpContextAccessor/context and registered
configuration, PlanAuthority and `IAuthoringDraftLifecycle` instance. Its database
must already hold the same actual open Npgsql connection/ReadCommitted transaction
used by the original caller observation and concrete draft owner. The stage does
not open/replace/start/commit/rollback/dispose a transaction or connection. Ambient
presence and a sealed input are not permission; the accepted caller producer
performs actual original JwtBearer/session/site and native persisted operation
permission reads. Original `article.write` and explicit canonical operation policy
remain distinct; the existing root write rule supplies no Bulk operation bypass.

Only the existing four editable operations and a complete nonempty explicit set
of at most10000 eligible items are supported. The original plan/request binding
checks are reused; original group idempotency identity is checked, not reissued.
Plan item order must exactly equal explicit selection order. Article IDs use their
actual canonical numeric schema; ExpectedRevision is the opaque original writer
reference and is never parsed into a revision ID. Archive retains the adapter's
existing Inbox-only scope. Caller admin/site/operation data must match the entire
command before draft/native content is read.

## Actual locks and readonly output

The accepted4263 draft owner locks real articles in numeric order and obtains its
whole-table `SHARE ROW EXCLUSIVE` draft write fence. Accepted4269's original native
revision query is reused by `ReadLockedBulkRevisionSetAsync`: it locks real
article/revision rows in numeric article order, computes the original reference
from actual revision ID/number/xmin/lifecycle/provenance/content/publication/schedule
fields and compares each frozen opaque reference. Output retains the exact
semantic frozen order, including every original nullable provenance value.
No numeric revision fallback, duplicate item, subset or reordered output is accepted.

The concrete draft owner now rereads/reacquires its article locks and draft write
fence, rather than assuming a previous lock survived caller savepoint activity.
It compares every actual persisted draft field and complete set against its
private original snapshot. Foreign-owner, phantom, removed or changed rows refuse.
It reads the actual current immutable revision/source/rights packages through the
original bounded methods and checks full source/metadata/base/status/schedule and
strict original custom-rights equality before any writer or draft CAS. Dirty,
stale, invalid or unsupported site-policy drafts refuse before mutation; no guessed
default or normalization is used.

Output is concrete readonly row metadata: exact ordered article/revision facts,
actual persisted draft ID/owner/key/base/server/client coordinates/update time and
full persisted-row content identity. Digests identify actual data only. The
original private reservation retains full draft bytes; content is not copied into
a second issuer or exposed for foreign owners. `ClientRevision` is retained caller
text, not a verified document/editor revision. Zero persisted drafts is an actual
persisted count, not proof of no live editor/unsaved state.

Each draft observation has the original separate bounded transient16MiB immutable
package read budget. Budget cleanup completes before restoring reusable state;
it does not accumulate repeated observations or weaken the later original CAS
before/after budget. Original CAS stays with `StageBulkDraftMetadataCasAsync` and
is not executed by this stage.

## Locked revalidation and failure

One instance prepares one original command/native scope. The returned object is
readable data, not another opaque permission token. Private instance custody
requires that exact result, context/command/transaction and full ordered set for
revalidation; fabricated/copied/foreign/repeated preparation refuses. Revision and
draft rows are actually reread/relocked and compared without refreshing the original
facts. Native permission/session/site are then revalidated through the accepted
caller owner. Original JWT not-before/expiry facts are exposed as readonly actual
ticket times, checked against the caller's private original custody and never
accepted from a new constructor/DTO as authority. A final fresh original business
clock check covers both retained JWT and original plan deadlines after the final
blocking caller read, before publishing reusable data.

Failure/cancellation after entering a fact stage poisons this instance; draft and
caller owner failures retain their own original poison semantics. A cancelled
wait before semaphore entry acquires no new scope/resources and does not affect an
in-flight distinct call. There is no automatic retry/refresh that resurrects failed
facts. Actual native locks may remain held after failure. The caller's original
native transaction holder must abort/release and independently observe its outcome;
this data stage never reports cleanup, rollback, zero writes or commit from an
exception, table count, dispose operation or journal absence. A full Reserve refusal
also invalidates any earlier partial facts and grants nothing.

The class is a precondition producer, not an available transaction owner. A complete
original group implementation must own native reservation/release before enabling
the interface or adapter; borrowed data-stage resource lifetime is explicit and
cannot be relabeled as a completed reservation.

## Exact remaining source and acceptance gates

Actual ArticleDraft fields are persisted draft/base/client/server coordinates and
content only. They do not contain article document ID, live editor-session identity,
unsaved-state epoch or lease/fence owner. Canvas owns its separate document/store
transaction. The real article Document/Write or editor-session owner must implement
actual reading and locked revalidation of those missing fields in this original
actor/site/native scope; neither persisted equality nor a default false flag supplies
them. Whole-set article/site/operation/dependency policy, side-effect feasibility,
signed audit/idempotency and durable commit/abort/unknown/postcommit producers also
remain required by the unchanged group reservation contract. No SealPreparation,
RevalidateBeforeCommit, CompleteCommit or Abort receipt is synthesized.

Ordinary source controls are UNRUN/uncompiled. Native isolation/lock ordering,
concurrent inserts/changes, savepoints, ownership/permissions, deadline waiting,
poison/cancellation/repeated/interrupted cleanup, real JWT/HTTP/security/privacy,
memory and full qualification remain HOLD. Static compilation/style and readonly
metadata do not establish those runtime boundaries or chain acceptance.
#3735/#3736/#3738 remain WIP. Rollback is a scoped source revert before activation;
no schema/data/DI/permission or frozen qualification change has been applied.

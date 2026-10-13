# Proposed original same-lease attachment revision transition

Status: BLOCKED at original producer authority binding; no runtime/source API added.
This is a source-stage handoff, not a grant or a change to the current contract.
All tests/runtime/list/discovery/product-import/qualification and frozen-evidence
writes remain HOLD/UNRUN. No package publication, Main/adapter/composition edit,
replacement lease, copied body/history or generic success acknowledgment.

## Exact original sources inspected

- Doc SDK base: 7ab33abd390d0876f0181ffc017e673d44e4ac1b, original PR4228.
- Main terminal bridge: cacd0d2a26ce8706975535716f9c0b79174d2449, PR4238.
- Native terminal owner: 5baf7c26c9a39291539bfe4da1b8d361af2175bd, UI PR944.
- Original issue bodies/comments: Blog2243/2293/2294/2295.

Main's articleDocumentContext.ts blob is exactly the original Doc base blob
055558e540fa0a2e6b6e26f163e983e32a960bde. This is not a stale SDK intake
or a different document authority. Inspecting Git source executed no products.

## Existing transaction and task sequence

The native original applyAttachmentResult creates a terminal application around
the SAME original job/attempt/dispatch, emits applying, releases the actual input,
dispatches through the existing transaction owner, emits transaction/model/source
callbacks, then emits committed with the accepted original transaction event.
The existing native dispatcher owns all position mapping; the SDK must not compute
ranges/deltas or take over the native transaction/history/body.

Main observes the loan through its actual mounted attachment port. Its original
observeNativeTerminal reserves the actual PendingInput and ownedOperations during
applying. consumeTransaction uses the original Writer commitSource, which calls
ArticleDocumentContextAdapter.updateSource(result.value, result.revision). The
SDK cancels every old-revision task before publishing the new context. Therefore
the SAME provider lease is already aborted by committed, and ordinary accept
cannot admit it against its old context. Main correctly records taskCompletion
unavailable and refuses completion; it does not mint a completed replacement.
Aborted/terminal lease custody remains pending until real producer settle().

No retroactive API can safely resurrect that already aborted lease. Reservation
and controlled source publication would have to be installed before this actual
source transition by the original owning callers.

## Narrow capability proposal, NOT implemented

The sole original SDK owner could issue a private single-use reservation against
its actual current attachment lease and a genuine original native application.
The candidate API shape is deliberately conditional on the missing authority:

1. reserveAttachmentRevisionTransition(actualLease, originalNativeApplication):
   require the same live private SDK lease/slot, kind attachment, un-aborted signal,
   authentic current owner/scope, same document/epoch/session/draft coordinates,
   and original native applying custody before any source change. Record actual
   started/before context and original job/item/dispatch/attempt association.
2. updateSourceForAttachmentTransition(reservation, originalTransactionEvent):
   accept only the bound candidate native transaction, expected before revision,
   real after revision and exact source publication. Preserve only this actual
   lease for that single transition; cancel all other old-revision tasks by the
   existing path. Ordinary updateSource remains unchanged and cancels all leases.
3. acceptAttachmentRevisionTransition(reservation, originalCommittedLoan, value):
   authenticate the SAME native application and accepted event, compare exact
   before/after revision, document/epoch, current source/context, public position
   map provenance and all still-current private lease/task/native custody; complete
   the SAME original lease once. Its original request/task/producer/started context
   remain original, completedRevision records the actual after revision. Do not
   globally relax ordinary accept/isCurrent or create a second completed lease.
4. explicit cancellation, supersession, unrelated source/draft change, scope/
   epoch/owner revocation, callback failure, refusal, stale native custody or
   synchronous reentry closes the reservation before any further acceptance.
   A refused transition preserves actual pending obligations/errors and never
   rolls back accepted native content, restores admission or forces settlement.

The method names above are a contract sketch, not callable exported types. A
Doc-only wrapper around arbitrary Boolean callbacks would not satisfy it.

## Concrete original producer gap

UI944 authenticates a loan in markdown-editor.vue's withAttachmentTerminalTransaction
using its private nativeAttachmentTerminalApplication, notifying/loanTaken flags,
exact observation/custody references and actual nativeCustody checks. The public
MarkdownAttachmentTerminalCustody interface contains structural object references
and hasCustody()/isReleasingInput() methods; it carries no public independently
verifiable original issuer/application capability. There is no original SDK binding
to that private native receiver in articleDocumentContext.ts.

Main's ArticleAttachmentTerminalPort is a structural forwarding method owned by
its Writer/mounted editor. Its authentic implementation is real source, but passing
an arbitrary object implementing that shape into the SDK would not establish the
original receiver's authority. Treating a supplied true/hasCustody callback or
transaction metadata as the capability would manufacture the missing grant.

There is also no private original SDK association from this lease to Main's
PendingInput/native capture/job/item/dispatch. That association lives in the
original attachment adapter's private pendingHandles/captured maps. The SDK knows
its exact attachment lease/document, but native metadata alone cannot prove which
of several valid same-document leases is this original pending input.

Finally, the current Main observeNativeTerminal already takes the single native
loan before invoking its callback. Calling the native loan reader again from a
new SDK method inside that callback would fail because application.loanTaken is
already true. Neither a second loan nor a copied observation is a workaround.

The missing producer seam is therefore the real original mounted/native binding
AND the actual pending-entry-to-lease association, carried into the SDK's controlled
revision publication before updateSource. Possible genuine upstream paths are:

- the original native owner exposes an opaque terminal-application capability
  with a verifier tied to its real private application/job/dispatch/transaction,
  and the original attachment owner binds its actual pending lease to it; or
- the real original mounted-owner binding delegates the one authentic loan to
  the SDK, with an original-owner issued association from the actual pending
  entry to the lease, rather than a freely substitutable success callback.

This identifies ownership, not authorization to implement either upstream here.
Doc ownership does not cover Main SFC, attachment adapter, composition or FsusUI
native issuer. No safe-eviction, resource settlement, business completion or
full-ready authority is inferred from UI944's terminal observation.

## Existing contract and preserved behavior

Original2243 item6 requires source-revision admission through FsusUI position map/
rebase or explicit stale failure. Items8/9 reserve native mapping and bind task
context/started-completed revisions. Original2294 items2/5/6 preserve the exact
session/document owner, prohibit copied body/history and retain pending attachment
correctness. No unrelated issue contract, server DocumentId or frozen guard is
changed by this proposal.

The current SDK ordinary updateSource/accept/cancel/dispose/lifetime/task guards
and original interfaces remain byte-identical. No dependent SDK source/type edit
is made until the genuine original producer seam is available and identified.
Source-only proposal diff-check is the only new check; no old compiler/native/
runtime result is promoted to this lane's qualification.

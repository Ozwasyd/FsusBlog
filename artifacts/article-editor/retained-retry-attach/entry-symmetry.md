# Original create/attach/notification/cleanup entry review

This is a SOURCE audit of the original producer. It is not a new authorization,
execution receipt or claim that every cancellation is forbidden in every phase.
No candidate import, test/list/discovery, native/browser or runtime execution.
The exact successor source SHA is bound in the companion source-offer manifest.

## Actual phase predicates

All values below come from the real original private owner/adapter/Registry.
There is no route/hash metadata, second index, external read, caller flag or grant.

- R: Registry membershipRetirementPending, retainedNotificationPending,
  membershipMutationDepth or ownershipTransactionPending.
- O: owner.attachingConsumer, owner.retirementPending,
  owner.retirementActivityDepth, owner.listenerNotificationDepth or original
  authority.ownerRetirementDepth. Owner post retry's activity depth encloses its
  inspection, mandatory native cleanup, consumer invocation and post listeners.
- N: adapter.retirementPending, contextMutationPending,
  contextNotificationDepth or taskCancellationDepth.
- D: adapter.retirementPending, contextNotificationDepth or
  taskCancellationDepth, or that same owner's retirementPending or
  listenerNotificationDepth. D deliberately excludes the outer mandatory cleanup
  activity: the real original owner performs its cancelAll/dispose inside it.
- S: an actual running callback record in the subscription's original Set.

The new readonly retryActive closure in the existing module-private adapter guard
is O only. It lets the actual native retry see original attachment/cleanup frames;
it issues no handle, admits no document, changes no seal and authorizes no cleanup.
Existing notificationActive stays D's owner portion. The public cleanup paths and
pure has predicates are unchanged by this increment.

## Every entry and its actual first guard

| Entry | First guard / effect after admission | Source ownership |
| --- | --- | --- |
| binding.retryInvalidation() | O or N rejects before scope/Registry inspection; then genuine revoked state required before cleanup | Document binding |
| binding.subscribeRetirement(...).retry() | attachingConsumer or retirementPending or retirementActivityDepth or ownerRetirementDepth or N, plus S | Original owner pre record |
| binding.subscribeLifetime(...).retry() | same owner guard as pre, plus S; listenerNotificationDepth is enclosed by retirementActivityDepth | Original owner post record |
| adapter.subscribeContext(...).retry() | N or O via private retryActive, plus S | Original native post record |
| private native pre subscription retry() | N or O via the same retryActive, plus S | Existing private native bridge; no new public issuance |
| subscribeRetainedArticleDocumentRetirement(handle,...).retry() | R or S; authentic original Registry handle/cell only | Original Registry pre record |
| subscribeRetainedArticleDocumentHandle(handle,...).retry() | R or S; authentic original Registry handle/cell only | Original Registry post record |
| adapter.cancelAll(reason) | D before reason validation/task snapshot/abort; private taskCancellationDepth encloses actual task cancellations | Original adapter cleanup |
| adapter.dispose() | D before native retirement/inspection; retained adapter then requires actual Registry state revoked | Original adapter cleanup |
| taskLease.cancel(reason) | reason validation; finished is idempotent; finishing queues actual cancel/abort; ordinary path requires native retirement not pending in finishTask | Original actual lease; no Registry/scope read or session cleanup |
| binding.cancelLifetimeAuthority(seal) | exact private owner/binding custody; delete lifetime token and original membership token | Pure cancellation, no reads/callbacks/cleanup |
| cancelRetainedArticleDocumentMembershipSeal(seal) | exact private WeakMap delete | Pure cancellation |
| callable subscription stop() | pending unsubscribe; delete only if not running and not failed | Original record only; does not settle task/consumer |

All subscription retry rejection records the actual error, preserves first cause
and pending unsubscribe, and occurs before invoking its producer. Successful
callback return cannot clear a nested caught retry failure because dispatch pins
its failure version. This accepted predecessor behavior is unchanged.

## Phase coverage and deliberate cleanup distinctions

| Real phase | Owner pre/post + binding invalidation retry | Native pre/post retry | cancelAll/dispose | Other cancellation entries |
| --- | --- | --- | --- | --- |
| attachment's initial pre signal | owner retirement/global depth | O through owner pre, plus N when native pre | D rejects actual owner/native pre frame | Seal cancellation/stop remain pure; actual lease cancellation retains its existing native-pre guard |
| attachingConsumer: admission readers, create(binding), returned consumer getter, cached attachment validation | attachingConsumer rejects at ENTRY | O retryActive rejects at ENTRY | Existing D applies; cancelAll remains real cleanup; dispose still requires genuine revoked state after pre signal | No new phase-wide ban on pure token/record cancellation or existing actual task cancellation |
| original Registry pre/post/mutation/ownership transaction | actual nested owner notification uses O; no extra cross-realm grant | O/N where actual Document frame exists | Existing D during real Document pre/post callback | Registry subscription retries reject R; no Document-owned attachment flag is injected into Registry |
| native pre signal / context mutation | native N or owner O | N/O | native pre D rejects; native mutation's own cancelAll remains legal | Original task lease finishTask rejects native pre; tokens/stop pure |
| native context post listener | N | N | contextNotificationDepth in D rejects before abort/retirement | Tokens/stop pure; task cancellation is explicit cancellation, not notification retry |
| owner post listener | retirementActivityDepth | O | owner.listenerNotificationDepth in D rejects before cleanup | Tokens/stop pure; lease cancellation does not create a second session cleanup |
| mandatory owner inspection/cancel/dispose before consumer callback | retirementActivityDepth | O | genuine owner operations remain permitted outside D callback frames | No fabricated cleanup acknowledgment or forced settlement |
| actual consumer invalidateDocument getter/function in ordinary notification | retirementActivityDepth | O retryActive | real native cleanup remains permitted by existing D; any nested actual native/owner listener activates D | Original consumer still performs its real resource cleanup; no cleanup port/authority added |
| actual consumer cleanup entered by failed attachment recovery | attachingConsumer | O retryActive | existing D and formal revocation continue to apply | Scope retirement during create must still reach real mandatory cleanup; no blanket attachment cleanup prohibition |
| cleanup's pre signal | original owner retirement/global depth | O/N | D rejects callback reentry | Pure token/record cancellation permitted |
| an actual pending cleanup Promise after the synchronous frame ends | formally revoked retry may run; pending/settled consumer prevents duplicate attempt | only genuine current O/N blocks | existing D/revocation checks | Promise completion alone updates cleanup state; task settlement remains explicit |
| failed cleanup after original frame unwinds | formally revoked retry may reattempt same actual producer | current O/N/S checked | existing D/revocation checks | First/subsequent errors and failed listener custody remain retained |

Registry is an independent original issuer. Its retry predicates are its own R/S;
there is no original Document attachment reservation in Registry. This source does
not invent a shared cross-issuer lock or grant. Genuine upstream mutation/scope
retirement must still notify and clean up during create; only actual owner/native
retry entries observe the existing owner's attachment reservation here.

cancelAll/dispose have a cleanup contract, not a notification-retry contract.
Uniformly rejecting outer attachingConsumer/retirementActivityDepth there would
also reject genuine authority-driven cancellation/disposal during scope retirement
inside create and mandatory cleanup. This increment does not claim such a new ban
or add a privileged bypass token/second cleanup entry. Task lease cancellation and
seal cancellation also remain their original operations, never settlement or
admission restoration. Any broader caller-role restriction requires its genuine
upstream contract; it is not inferred from this audit.

## Written source controls and limits

Two appended original-module cases cover owner pre/post and native retry rejection
inside the real create frame before scope readers/callbacks, original first-error
and pending-unsubscribe custody, real later callback retry, and native retry during
actual consumer cleanup with no duplicated pending Promise. Total59 authority and
20 Registry cases are source-text counts only. Complete original entrance/config/
setup/import preflight remains ../retained-document-authority/preflight.md, with
no runner/config/mock/selector changes. All cases and qualifications remain HOLD.

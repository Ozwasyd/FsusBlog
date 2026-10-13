# Original same-lease attachment revision transition SDK

Status: isolated SOURCE implementation, independent SDK review pending. No
accepted-composite, business request, runtime, readiness or resource qualification.

## Original dependency boundary

Original Doc base: fd68a7f135867a2134e75aa1ca1a921ffb009673 / original7ab33 code.
Original UI issuer: accepted8130a71b4e30441f67fa6183c5cdfa060db87426, UI945.
Original association producer: acceptedb336802021483468e7ae0f9b7ca21ade2f45ad9d,
Main4242. Their source acceptance does not qualify this SDK or its composition.

The old proposal is historical. The actual producers now carry their original
private association/loan/opaque reservation instead of Boolean callback grants.
SDK types import the actual public native types only; no FsusUI product module is
imported at runtime by the Doc implementation. Do not supply an arbitrary reader,
mock, cloned producer/association/issuer, replacement lease or fabricated token.

## Exact source API

All exports are from the original articleDocumentContext module/barrel.

```ts
interface ArticleDocumentAttachmentRevisionAssociation {
    readonly issuer: MarkdownAttachmentTerminalRevisionIssuer;
    readonly reservation: MarkdownAttachmentTerminalRevisionReservation;
    readonly lease: ArticleDocumentTaskLease;
    readonly custody: MarkdownAttachmentTerminalCustody;
}
interface ArticleDocumentAttachmentRevisionProducer {
    reserve(lease: ArticleDocumentTaskLease, custody: MarkdownAttachmentTerminalCustody): ArticleDocumentAttachmentRevisionAssociation | null;
    hasAssociation(association: ArticleDocumentAttachmentRevisionAssociation,
        phase: 'applying' | 'accepted' | 'committed', transaction?: MarkdownEditorTransactionEvent): boolean;
    cancelAssociation(association: ArticleDocumentAttachmentRevisionAssociation): boolean;
}
// Native types above are the existing public FsusUI types, not copied schemas.
// ArticleDocumentAttachmentRevisionTransition is opaque and SDK-private issued.
adapter.reserveAttachmentRevisionTransition(lease, custody, producer); // Token | null
adapter.publishAttachmentRevisionTransition(token, originalTransaction); // ArticleDocumentContext
adapter.acceptAttachmentRevisionTransition(token, originalTransaction, value); // ArticleDocumentTaskAcceptance<T>
adapter.cancelAttachmentRevisionTransition(tokenOrSameOriginalLease, reason?); // boolean
```

The real Main ArticleAttachmentNativeRevisionProducer structurally supplies the
SDK's minimal three-method producer interface; its inspectCleanup/retryCleanup
remain its own additional original duties. reserve is called lazily only when
this original SDK explicitly asks. The SDK never takes a second native loan and
never automatically arms existing Main composition.

## Owning caller binding and phase order

1. Inside the original authentic applying loan, Main identifies the SAME private
   accepted capture/PendingInput.lease/custody. Pass that exact lease, custody and
   original installed producer to reserveAttachmentRevisionTransition. SDK first
   reserves its real private task slot, then calls producer.reserve exactly once.
   Original Main and actual native issuer both verify the original association and
   opaque reservation in applying. SDK checks actual private pending/active lease,
   original before context, attachment kind, un-aborted signal and native identity/
   before revision. A copied token, other adapter/task or already canceled lease
   cannot acquire the SDK private record.
2. UI emits accepted only for the reserved native application, from its private
   accepted transaction observer before public source callbacks. Inside this same
   real accepted loan, pass the actual event to publishAttachmentRevisionTransition.
   SDK invokes original native/owner retirement, uses the existing context creator,
   preserves only this same lease while canceling other old tasks, publishes actual
   revision/content metadata and runs the original context notifications. Scope,
   task, event and native association are rechecked after every external phase.
3. Main must synchronize its original form/source owner with the returned context
   and the same event value before later public source callbacks. Those callbacks
   remain ordinary/idempotent paths; no arbitrary ordinary updateSource call can
   use the exception. Main owns form/maps/entry/transaction observations; SDK does
   not compute position deltas, clone body/history or redispatch a transaction.
4. Inside the same real committed loan, call acceptAttachmentRevisionTransition
   with that same event and original actual result value. The SDK's private permit
   admits only the SAME real lease through its original task finalization/hash/
   envelope publication. Original request/task/producer/started-context identity
   and startedRevision stay original; completedRevision is the actual after revision.
   Native/Main custody, current scope/source/task slot, cancellation and synchronous
   reentry are checked during result preparation and immediately before publication.
5. A successful task envelope is historical after publication. Native association
   withdrawal is a separate duty; a withdrawal failure is reported and retained,
   never rolled back into a replacement/aborted completed lease or acknowledged as
   completed cleanup. Main must retain raw failure and historical task/transaction
   facts rather than seal a contradictory cancelled lifecycle with a completed task.

## Guard symmetry and cancellation custody

Every new SDK entry rejects during an existing SDK operation, native retirement,
context mutation/notification, task cancellation, or actual owner attach/pre/post/
cleanup frame. Reentry taints the current record before throwing, so a caught
nested exception cannot revive acceptance. Wrong phase of a real token also closes
it. Native/association reader throws, including undefined, preserve an explicit
failure object plus first/latest actual causes; no failed record is validated again.

Direct cancellation of the genuine original lease marks SDK custody closed before
abort/finalization callbacks. Ordinary cancelAll/source/draft/switch/dispose keep
existing behavior; unrelated advancement still cancels this lease. Only the private
accepted publication cancels other tasks while preserving its exact selected lease.
Ordinary complete/accept cannot race an armed lease's explicit capability, and are
otherwise unchanged; isCurrent remains its original current-context predicate.

SDK failure attempts original lease cancellation and original association withdrawal
independently. It preserves the primary raw error and all subsequent cleanup errors.
Native withdrawal does not erase an unfinished actual task cancellation. A closed
holder stays in private issuer custody until both actual duties allow removal.
Main can cancel by the same real token or original lease if reserve threw before
its token escaped; this is withdrawal only, never source/completion permission.
No callback/stop/abort/accept path calls settle or manufactures zero pending work.
Actual producer completion/cleanup alone owns the existing explicit lease.settle().

## Source checks and execution holds

Allowed checks are the original full application alias compiler, original strict
production source lint, TypeScript source AST/pure-guard text comparison and Git
source diff checking. Local root /workspace/doc-transition-ui945 is exact8130,
compiler-only; installed original toolchains are reused unchanged. An initial
missing tool path/symlink-as-file lint setup error was repaired by copying the
existing installed toolchain into its normal ignored directory, without installs,
configuration/rule changes, dependency-version changes or test-entry substitution.

No new tests were executed or discovered, and no product module was imported.
The complete original proposed whole-file unit entry/config/setup/import preflight
remains artifacts/article-editor/retained-document-authority/preflight.md. Parent
must separately authorize any execution; use its original full entrances, not new
filters/config/mocks. Source review cases include wrong adapter/lease/phase/token,
same-source articles, real before/after event, caught reader undefined, nested
cancel/source/draft/owner revoke, result hashing/getter failure, post-notification
failure, real pending cleanup and no second completed lease/settlement.

All tests/runtime/list/discovery/product import/browser/mount/native/security/
privacy/receipt/race/DB/storage/qualification and frozen authority/evidence writes
remain HOLD/UNRUN. No Main/attachment adapter/composition/Root/shared Vue/Registry/
server DocumentId/guard config/dependency version edit. No package publication,
merge, issue close or accepted-composite claim. Rollback this isolated SDK increment
until its exact source and the original owning integration are independently reviewed.

## Exact owning Main production offer

production-main-b336.patch and production-source-offer.json bind exact actual Main
b336 before blob055558e540fa0a2e6b6e26f163e983e32a960bde to SDK4781 postimage
8eae29d8c97757a23402941690ce5022f989d7c8. The original generator performs normal
apply-check/apply/applied-diff-check/reverse-check in a task-owned detached exact
Main checkout and verifies every other consumer blob. No Main branch/ref/source
composition is mutated, no composite compiler/runtime or acceptance is inferred.
The donor architecture paragraph is additive; Main's owning documentation must
preserve its whole existing remainder rather than replace it with the older SDK
branch's complete document. Raw standard patch context whitespace remains part
of the publisher artifact diff and is recorded separately, never an aggregate PASS.

# Exact original transition withdrawal observation

Isolated source increment on accepted SDK4288
78a6b8627f56a238e55af3dba851cdbfe66c9d94. Original Main4301 source
67b63670d966cc6a337b44c6246508f9e19aea99 demonstrates the missing confirmation:
its original entry holds transition T; cohort acquisition throws; SDK's original
abort/withdraw genuinely removes T after finishing its duties. Main later gets
false from cancel(T) and retains nativeSdkCleanupPending without a confirmable
same-token path. This branch edits no Main/UI/producer/end/qualification source.

## Narrow API

adapter.hasWithdrawnAttachmentRevisionTransition(originalTransitionToken, sameOriginalLease)
or adapter.hasWithdrawnAttachmentRevisionTransition(sameOriginalLease)
returns true ONLY when this SAME adapter's private withdrawal path recorded that
exact originally issued object after real association withdrawal and any
requested original task cancellation succeeded, and original custody was removed.
Private weak token/lease pairs retain only the original capability references,
not copied body/history, callbacks, receipts or an identifier/session index.
Token properties are not read and no external producer is invoked by the query.

Unknown, copied, foreign-adapter tokens and unconfirmed failed/invalidated tokens
return false. A missing map entry, phase/status string, matching scope/id, false
cancel response or arbitrary stale token is never sufficient. A known withdrawn
original token has a historical fact even after context retirement; this grants
no current permission or revalidation. cancel semantics remain unchanged, so it
can still return false after successful private withdrawal.

The pair is added only at the successful tail of #withdrawAttachmentRevision,
after the SDK-held actual association's producer.cancelAssociation returns true
and its real original task cancellation/completion call confirms. Explicit private
acknowledgements are set only after those original operations return; terminal
envelope status alone is insufficient. Requested cancellation without its real
acknowledgement keeps the original transition holder for retry. A new transition
on the same original lease withdraws its prior confirmation. False/throw,
unconfirmed or still-running selected cancellation cannot add a positive pair.
If producer reserve throws before the actual association reaches SDK custody,
there is no confirmable association withdrawal here; the query remains false and
unconfirmed producer debt cannot be inferred away. Original raw first/latest
causes, including undefined, remain in
their unchanged failure carriers. This is not a new issuer or settlement receipt.

## Original Main caller boundary

After the original cancellation attempt returns false, Main may consult this
query using its SAME private entry.nativeTransition AND entry.lease objects, or
the SAME original lease when the token never escaped reserve. An affirmative fact
can discharge ONLY that transition's SDK withdrawal duty. Do not guess a token,
use a foreign token, infer from holder absence, or silently convert cancellation
throws into success; original run/failure history must retain thrown causes.
The lease path requires the SDK's actually recorded same-token/same-lease pair;
it does not manufacture a token or use holder absence. Foreign/unknown leases,
mismatched token/lease pairs and unconfirmed acquisition remain false.

The cohort holder, cohort cancellation failures, original producer cleanup,
native application-ended observations/blocked cleanup, File/controller duties,
actual upload work and SDK task settle remain independent. A true transition
marker may coexist with any of those debts. Main must keep original entry and
same-handle retry until each actual duty confirms success; no completed envelope,
raw failure history or resource/readiness rule is rewritten here.

## Source controls and preflight

Authored source-review controls, ALL UNRUN:

- Real original token T removed by successful abort/withdraw after cohort reserve
  throws: cancel(T) remains false; this adapter's same-token query true.
- Real transition reserve throws before T escapes but SDK captured its actual
  association and finishes withdrawal/cancellation: same original lease query
  true. A producer throw before association capture remains unconfirmed/false.
- Unknown/copied/foreign token, or mere missing map item: query false.
- Unknown/foreign lease or mismatched original token/lease: query false. A fresh
  transition on that same original lease invalidates any older confirmation.
- Actual association cleanup false/throws undefined: query false until that
  original withdrawal later succeeds; original first/latest undefined remains.
- Requested original task cancellation still running: query false; no settle.
- Transition withdrawal succeeds but cohort/native-end/producer/File work fails:
  transition fact true, other real debts remain visible and independently retry.
- Historical completed envelope remains completed; no replacement lease/context,
  ordinary currentness change, event replay or application-ended grant.
- Source/draft/retire/dispose does not turn unknown tokens into recorded facts;
  genuine historical same-token withdrawal is an observation, not permission.

Original SDK full-entry/config/setup/import preflight remains in contract.md and
the original retained-document preflight. No test is executed/discovered/imported,
no fake native grant or reduced config is introduced. Actual UI957903 source alias
is used only for original complete static compiler/style checks. Every original
runtime/tests/import/discovery/native/security/qualification HOLD stays UNRUN.
